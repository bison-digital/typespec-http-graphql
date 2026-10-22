import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture, type CompiledFixture } from "../support/compile-fixture.js";
import { corpusScenarios, packageRoot } from "../support/corpus.js";
import { declareEveryOperation } from "../support/declare-every-operation.js";

/**
 * **The arm that holds the design to "adapter, not proxy".**
 *
 * One handler object, two generated surfaces: the published `typespec-hono` and this package. Each
 * derives a handler's signature from the same `typespec-http-zod` artefacts by the same rules, in
 * separate packages, and nothing but a compile can tell whether they still agree. This is the one
 * point of contact design.md allows between them, and it is a dev-only test.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let compiled: CompiledFixture;

beforeAll(async () => {
	compiled = await compileFixture(here, "main", { outName: "agreement", withServer: true });
}, 900_000);

const COMPILER_OPTIONS = {
	target: "es2023",
	module: "nodenext",
	moduleResolution: "nodenext",
	strict: true,
	exactOptionalPropertyTypes: true,
	noUncheckedIndexedAccess: true,
	noUnusedLocals: true,
	noUnusedParameters: true,
	noEmit: true,
	skipLibCheck: true,
} as const;

/** Run `tsc` over one config, returning what it printed and whether it failed. */
function tsc(config: string): { output: string; failed: boolean } {
	try {
		const output = execFileSync(
			join(packageRoot, "node_modules", ".bin", "tsc"),
			["-p", config, "--ignoreConfig"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		return { output, failed: false };
	} catch (error) {
		const asExec = error as { stdout?: string; stderr?: string };
		return { output: `${asExec.stdout ?? ""}${asExec.stderr ?? ""}`, failed: true };
	}
}

/** Compile the consumer fixture against freshly emitted output. Exit code is the assertion. */
function typecheckConsumer(): { output: string; failed: boolean } {
	const config = join(here, "tsconfig.agreement.json");
	writeFileSync(
		config,
		JSON.stringify(
			{ compilerOptions: COMPILER_OPTIONS, include: ["./consumer.fixture.ts"] },
			null,
			"\t",
		),
	);
	return tsc(config);
}

/** The module specifiers a generated file imports, multi-line imports included. */
function importsOf(file: string): string[] {
	return [
		...readFileSync(file, "utf8").matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)";/gm),
	].map((match) => match[1] ?? "");
}

/**
 * Compile a copy of the consumer fixture with one thing changed, its imports pointed at `outRoot`.
 *
 * Returns what `tsc` said and a way to find a line in the copy, so a variant can assert WHERE it was
 * refused and not only that it was.
 */
function compileVariant(
	name: string,
	source: string,
	outRoot = "../agreement/",
): { output: string; failed: boolean; lineOf: (text: string) => number } {
	const dir = join(here, ".out", name);
	mkdirSync(dir, { recursive: true });
	const variant = source.replaceAll("./.out/agreement/", outRoot);
	writeFileSync(join(dir, "consumer.fixture.ts"), variant);
	const config = join(dir, "tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ["./consumer.fixture.ts"] }),
	);
	const lines = variant.split("\n");
	return {
		...tsc(config),
		lineOf: (text: string): number => lines.findIndex((line) => line.includes(text)) + 1,
	};
}

/** The lines `tsc` reported a given error code on, in the copied fixture. */
function linesWith(output: string, code: string): number[] {
	return [
		...output.matchAll(new RegExp(`consumer\\.fixture\\.ts\\((\\d+),\\d+\\): error ${code}`, "g")),
	].map((match) => Number(match[1]));
}

describe("both surfaces, from one spec, in one program", () => {
	it("compiles clean, and this emitter accepts every declaration", () => {
		expect(compiled.diagnostics.filter((d) => d.code.startsWith("typespec-http-graphql/"))).toEqual(
			[],
		);
	});

	it("emits both surfaces, each with its own runtime and the library's validators", () => {
		for (const file of [
			"graphql.gen.ts",
			"graphql-runtime.gen.ts",
			"schema.graphql",
			"schemas.gen.ts",
		]) {
			expect(existsSync(join(compiled.outDir, file)), file).toBe(true);
		}
		for (const file of ["app.gen.ts", "runtime.gen.ts", "schemas.gen.ts"]) {
			expect(existsSync(join(compiled.serverDir, file)), `hono/${file}`).toBe(true);
		}
	});

	/**
	 * **Independence, by what the emitted code imports.** design.md: the emitted code imports only
	 * `graphql` and the library's `schemas.gen.ts`, beside its own runtime and Zod's types, and never
	 * a sibling's runtime or a framework.
	 */
	it("the GraphQL surface imports only graphql, zod, the library's validators and its own runtime", () => {
		const allowed = new Set(["graphql", "zod", "./schemas.gen.js", "./graphql-runtime.gen.js"]);
		const surface = importsOf(join(compiled.outDir, "graphql.gen.ts"));
		expect(surface.filter((specifier) => !allowed.has(specifier))).toEqual([]);
		expect(surface).toContain("graphql");
		expect(surface).toContain("./schemas.gen.js");
		const runtime = importsOf(join(compiled.outDir, "graphql-runtime.gen.ts"));
		expect(runtime.filter((specifier) => specifier !== "graphql" && specifier !== "zod")).toEqual(
			[],
		);
	});

	it("the validators each surface reads import nothing but zod", () => {
		for (const dir of [compiled.outDir, compiled.serverDir]) {
			expect([...new Set(importsOf(join(dir, "schemas.gen.ts")))]).toEqual(["zod"]);
		}
	});
});

describe("ONE handler object satisfies both surfaces, with no cast", () => {
	it("compiles", () => {
		const { output, failed } = typecheckConsumer();
		expect(output).toBe("");
		expect(failed).toBe(false);
	}, 300_000);

	/**
	 * **The fixture must not be able to cheat.** A cast, a widening helper, or a second handler object
	 * would each make the compile above pass while proving nothing.
	 */
	it("the fixture uses no cast and no widening helper", () => {
		const source = readFileSync(join(here, "consumer.fixture.ts"), "utf8");
		for (const evasion of [
			/as unknown as/,
			/@ts-expect-error/,
			/@ts-ignore/,
			/\bas [A-Z]/,
			/\bany\b/,
		]) {
			expect(evasion.test(source), `fixture contains ${evasion}`).toBe(false);
		}
	});

	it("the fixture declares the handler object exactly once, and passes it to both", () => {
		const source = readFileSync(join(here, "consumer.fixture.ts"), "utf8");
		expect([...source.matchAll(/const operations = \{/g)]).toHaveLength(1);
		expect(source).toContain("registerRoutes(app, () => operations, routeDeps)");
		expect(source).toContain("createSchema(() => operations, graphqlDeps)");
	});

	/**
	 * **The handler object carries no type ANNOTATION**, which is what keeps both surplus-key guards
	 * alive; the arm below measures that rather than assuming it.
	 */
	it("the handler object carries no annotation", () => {
		const source = readFileSync(join(here, "consumer.fixture.ts"), "utf8");
		expect(source).not.toMatch(/const operations: /);
		expect(source).toMatch(/^\} satisfies Operations<Caller>;$/m);
	});

	/**
	 * **Both surplus-key guards survive `satisfies`, measured on the fixture itself.** A handler for an
	 * operation the spec no longer declares must be refused at `registerRoutes` AND at
	 * `createSchema`, not only by `satisfies`' own excess-property check.
	 */
	it("a removed operation is refused by both surfaces, not only by satisfies", () => {
		const source = readFileSync(join(here, "consumer.fixture.ts"), "utf8");
		const anchor = "\tBooks_tag: (_ctx: Caller, input) => ({";
		expect(source).toContain(anchor);
		const { output, failed, lineOf } = compileVariant(
			"agreement-surplus",
			source.replace(
				anchor,
				`\tremovedFromTheSpec: (_ctx: Caller, _input: Record<string, never>) => ({ status: 200 }),\n${anchor}`,
			),
		);
		expect(failed).toBe(true);
		const routes = lineOf("registerRoutes(app, () => operations, routeDeps)");
		const graphql = lineOf("createSchema(() => operations, graphqlDeps)");
		expect(routes).toBeGreaterThan(0);
		expect(graphql).toBeGreaterThan(0);
		expect(output).toMatch(new RegExp(`consumer\\.fixture\\.ts\\(${routes},\\d+\\): error TS2`));
		expect(output).toMatch(new RegExp(`consumer\\.fixture\\.ts\\(${graphql},\\d+\\): error TS2`));
		expect(output).toContain("removedFromTheSpec");
	}, 300_000);

	/**
	 * **Identity catches what assignability cannot.** A copy of the emitted GraphQL surface has the
	 * negotiated `accept` dropped from one handler's input, a narrower input the server's handler
	 * would still accept. `_ExcerptAsJson` must refuse it.
	 */
	it("a handler input that drops the negotiated accept literal is refused by Identical", () => {
		const copy = join(here, ".out", "agreement-accept");
		rmSync(copy, { recursive: true, force: true });
		cpSync(compiled.outDir, copy, { recursive: true });
		const file = join(copy, "graphql.gen.ts");
		const original = readFileSync(file, "utf8");
		const literal = /\s*&\s*\{\s*accept:\s*"application\/json"\s*\}/g;
		// Non-vacuity: the plant has exactly one place to land.
		expect([...original.matchAll(literal)]).toHaveLength(1);
		writeFileSync(file, original.replace(literal, ""));

		const source = readFileSync(join(here, "consumer.fixture.ts"), "utf8");
		const { output, failed, lineOf } = compileVariant(
			"agreement-accept-consumer",
			source,
			"../agreement-accept/",
		);
		expect(failed).toBe(true);
		const declared = lineOf("type _ExcerptAsJson");
		expect(declared).toBeGreaterThan(0);
		// The formatter wraps the assertion, so the error lands on its line or the few after it.
		const refused = linesWith(output, "TS2344");
		expect(
			refused.some((line) => line >= declared && line <= declared + 4),
			output,
		).toBe(true);
	}, 300_000);

	it("asserts identity per operation, not just assignability", () => {
		const source = readFileSync(join(here, "consumer.fixture.ts"), "utf8");
		// Counted by declaration: the formatter wraps a long `MustHold<Identical<` onto two lines.
		const assertions = [...source.matchAll(/^type _[A-Za-z]+ = MustHold</gm)];
		// One per exposed operation, the key set, the operation left out, and the declared set.
		expect(assertions.length).toBeGreaterThanOrEqual(13);
		// Against the caller context the deps establish, so a `C` one side ignored would not be identical.
		expect(source).not.toMatch(
			/\b(?:GraphQLOperations|Operations)\[|keyof (?:GraphQLOperations|Operations)\b(?!<)/,
		);
		expect(source).toContain("declare const routeDeps: RouteDeps<AppEnv, Caller>;");
		expect(source).toContain("declare const graphqlDeps: GraphQLDeps<GraphQLContext, Caller>;");
	});
});

/**
 * **The same agreement over corpus scenarios both emitters accept**, each with every operation
 * declared by `declareEveryOperation`. One hand-written spec is what let two sibling emitters drift
 * before: an empty model contributed `unknown` to a handler's input on one side and `{}` on the
 * other, and only a scenario nobody wrote by hand declared one.
 *
 * Chosen for the input shapes they carry: a named and a spread body, optional bodies, spread
 * parameter groups, `accept` negotiation, precondition headers, and paged lists.
 */
describe("the same agreement, over corpus scenarios", () => {
	const SCENARIOS = [
		"parameters__basic",
		"parameters__body-optionality",
		"parameters__spread",
		"payload__content-negotiation",
		"payload__pageable",
		"special-headers__conditional-request",
	] as const;

	const CONSUMER = `import type { Operations } from "./hono/app.gen.js";
import type { DeclaredOperationId, GraphQLOperations } from "./graphql.gen.js";

type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type MustHold<T extends true> = T;
/** The keys whose entry is not \`true\`, so a failure names the operations it fails on. */
type Failing<M> = { [K in keyof M]: M[K] extends true ? never : K }[keyof M];

interface Caller {
	readonly subject: string;
}
type G = GraphQLOperations<Caller>;
type O = Operations<Caller>;

export type SameDocument = MustHold<Identical<DeclaredOperationId, keyof O>>;
export type NoFieldTheServerLacks = MustHold<Identical<Exclude<keyof G, keyof O>, never>>;
export type SomethingExposed = MustHold<[keyof G] extends [never] ? false : true>;

type Signatures = { [K in keyof G]: K extends keyof O ? Identical<G[K], O[K]> : false };
/** Constrained to \`never\` so \`tsc\` prints the failing keys; \`MustHold<Identical<...>>\` prints only \`false\`. */
type NoneFailing<T extends never> = T;
export type OneSignature = NoneFailing<Failing<Signatures>>;
`;

	const outputRoot = join(packageRoot, "test", ".out-agreement-corpus");
	const scenarios: { name: string; dir: string; declared: number }[] = [];

	beforeAll(async () => {
		rmSync(outputRoot, { recursive: true, force: true });
		const sources = corpusScenarios();
		for (const name of SCENARIOS) {
			const source = sources.find((scenario) => scenario.name === name);
			if (source === undefined) throw new Error(`the corpus no longer declares ${name}`);
			const surface = await declareEveryOperation(source.main, join(outputRoot, name, "spec"));
			const result = await compileFixture(join(outputRoot, name, "spec"), "graphql", {
				outDir: join(outputRoot, name, "emitted"),
				withServer: true,
			});
			scenarios.push({
				name,
				dir: result.outDir,
				declared: surface.declared,
			});
		}
	}, 900_000);

	it("declares every operation of each scenario, and compiles it with both emitters", () => {
		expect(scenarios.map((scenario) => scenario.name)).toEqual([...SCENARIOS]);
		for (const scenario of scenarios) {
			expect(scenario.declared, scenario.name).toBeGreaterThanOrEqual(1);
		}
	});

	it("agrees, operation by operation, in every scenario", () => {
		const disagreements: string[] = [];
		for (const scenario of scenarios) {
			writeFileSync(join(scenario.dir, "agreement.consumer.ts"), CONSUMER);
			const config = join(scenario.dir, "tsconfig.agreement.json");
			writeFileSync(
				config,
				JSON.stringify({
					compilerOptions: {
						target: "es2023",
						lib: ["es2023", "dom"],
						module: "nodenext",
						moduleResolution: "nodenext",
						strict: true,
						exactOptionalPropertyTypes: true,
						noEmit: true,
						skipLibCheck: true,
						types: [],
					},
					include: ["./agreement.consumer.ts"],
				}),
			);
			const { output, failed } = tsc(config);
			if (failed) disagreements.push(`${scenario.name}\n${output}`);
		}
		expect(disagreements, disagreements.join("\n\n")).toEqual([]);
	}, 900_000);
});
