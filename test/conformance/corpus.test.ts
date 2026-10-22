import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Program } from "@typespec/compiler";
import { buildSchema, type GraphQLSchema, parse, validate, validateSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";
import {
	corpusScenarios,
	LIBRARY_REFUSES,
	libraryRefusalsOf,
	packageRoot,
} from "../support/corpus.js";
import { declareEveryOperation } from "../support/declare-every-operation.js";
import { openApiVersionsOf } from "../support/openapi-versions.js";
import { ratchet } from "../support/ratchet.js";
import { sdlAgreement } from "../support/sdl-agreement.js";
import { typecheckEmitted } from "../support/typecheck-emitted.js";

/**
 * **Every scenario `@typespec/http-specs` declares, with every operation declared as a field,
 * emitted, COMPILED and VALIDATED.**
 *
 * The package is built against hand-written fixtures, and they are not enough: the corpus carries
 * shapes no hand-written fixture thinks of, and an emitted file that does not typecheck is found
 * there first. The corpus has no `graphql.tsp`, so `declareEveryOperation` writes one per scenario
 * (its docblock says why a test may); every operation is the worst case the emitter can be handed.
 *
 * "Emitted" is not the assertion. Every file is compiled by `tsc` under a consumer's settings, every
 * schema is rebuilt and validated by graphql-js, and the emitter's own `emitted + dropped ===
 * declared` holds for every service or the compile throws.
 *
 * **What each scenario keeps and drops is held to `baseline.json`** by the ratchet
 * (`test/support/ratchet.ts`): a field served or an operation declared is a floor, a dropping or
 * keeping warning a ceiling, and any change either way fails until the file is rewritten, a
 * loosening only with its reason recorded. A change to what the emitter serves from the corpus is
 * then a diff somebody reviews, never a count that quietly moved inside a tolerance, and never a
 * snapshot `-u` rewrote.
 */

const outputRoot = join(packageRoot, "test", ".out-corpus");
const PREFIX = "typespec-http-graphql/";

/** The codes that drop the declaration they are raised against. Every other code keeps it. */
const DROPPING = new Set(
	[
		"invalid-graphql-name",
		"graphql-name-collision",
		"declared-twice",
		"unknown-link-parameter",
		"unknown-link-property",
		"link-type-mismatch",
		"link-not-safe",
		"head-operation",
		"non-json-request",
		"non-object-body",
		"non-json-response",
		"shared-input-key",
		"link-target-unreachable",
	].map((code) => `${PREFIX}${code}`),
);

interface Scenario {
	readonly name: string;
	readonly dir: string;
	readonly versioned: boolean;
	readonly declared: number;
	/** Each root field name `graphql.tsp` declared, to the operation id it names. */
	readonly fields: ReadonlyMap<string, string>;
	readonly diagnostics: readonly { readonly code: string; readonly severity: string }[];
	readonly threw: string | undefined;
	readonly sdl: string | undefined;
	/** Each request `graphqlRequestsOf` writes, read from the copy of this emitter the compiler ran. */
	readonly documents: readonly { readonly field: string; readonly document: string }[];
}

type RequestsOf = (program: unknown) =>
	| readonly {
			readonly requests: readonly { readonly field: string; readonly document: string }[];
	  }[]
	| undefined;

/** The requests the emitter the compiler ran planned for `program`: the seam another tool reads. */
function documentsOf(program: Program): Scenario["documents"] {
	const ref = program.emitters.find((emitter) => emitter.metadata.name === "typespec-http-graphql");
	const read = (
		ref?.library.entrypoint?.esmExports as { graphqlRequestsOf?: RequestsOf } | undefined
	)?.graphqlRequestsOf;
	return (read?.(program) ?? []).flatMap((service) =>
		service.requests.map(({ field, document }) => ({ field, document })),
	);
}

let scenarios: Scenario[] = [];

beforeAll(async () => {
	rmSync(outputRoot, { recursive: true, force: true });
	const collected: Scenario[] = [];
	for (const { name, main } of corpusScenarios()) {
		const spec = join(outputRoot, name, "spec");
		const dir = join(outputRoot, name, "emitted");
		const surface = await declareEveryOperation(main, spec);
		let diagnostics: Scenario["diagnostics"] = [];
		let documents: Scenario["documents"] = [];
		let threw: string | undefined;
		try {
			const compiled = await compileFixture(spec, "graphql", {
				outDir: dir,
				expectedErrors: libraryRefusalsOf(name),
				openApiVersions: openApiVersionsOf(`corpus:${name}`),
			});
			diagnostics = compiled.diagnostics;
			documents = documentsOf(compiled.program);
		} catch (error) {
			threw = error instanceof Error ? error.message : String(error);
		}
		const schema = join(dir, "schema.graphql");
		collected.push({
			name,
			dir,
			versioned: readFileSync(main, "utf8").includes("@versioned"),
			declared: surface.declared,
			fields: surface.fields,
			diagnostics,
			threw,
			sdl: existsSync(schema) ? readFileSync(schema, "utf8") : undefined,
			documents,
		});
	}
	scenarios = collected;
}, 1_800_000);

/** The root fields a schema serves, `_empty` aside: the declarations that became fields. */
function rootFieldsOf(sdl: string | undefined): string[] {
	if (sdl === undefined) return [];
	const schema = buildSchema(sdl);
	return [
		...Object.keys(schema.getQueryType()?.getFields() ?? {}).filter((name) => name !== "_empty"),
		...Object.keys(schema.getMutationType()?.getFields() ?? {}),
	].toSorted();
}

function tally(codes: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const code of codes.toSorted()) counts[code] = (counts[code] ?? 0) + 1;
	return counts;
}

const total = (counts: Readonly<Record<string, number>>): number =>
	Object.values(counts).reduce((sum, count) => sum + count, 0);

interface Expectation {
	readonly declared: number;
	readonly fields: number;
	readonly dropped: Readonly<Record<string, number>>;
	readonly kept: Readonly<Record<string, number>>;
	readonly emitted: boolean;
}

function expectationOf(scenario: Scenario): Expectation {
	const ours = scenario.diagnostics.map((d) => d.code).filter((code) => code.startsWith(PREFIX));
	return {
		declared: scenario.declared,
		fields: rootFieldsOf(scenario.sdl).length,
		dropped: tally(ours.filter((code) => DROPPING.has(code))),
		kept: tally(ours.filter((code) => !DROPPING.has(code))),
		emitted: existsSync(join(scenario.dir, "graphql.gen.ts")),
	};
}

const scenarioNamed = (name: string): Scenario => {
	const found = scenarios.find((scenario) => scenario.name === name);
	if (found === undefined) throw new Error(`the corpus no longer declares ${name}`);
	return found;
};

describe("the corpus is large enough to be evidence", () => {
	it("compiled every scenario, with every operation declared", () => {
		expect(scenarios.length).toBeGreaterThanOrEqual(60);
		// Measured at 803 operations over 66 scenarios.
		expect(scenarios.reduce((sum, scenario) => sum + scenario.declared, 0)).toBeGreaterThanOrEqual(
			700,
		);
	});

	/** The emitter throws when `emitted + dropped === declared` fails for a service. */
	it("never makes the emitter throw, so every service accounted for every declaration it owns", () => {
		const threw = scenarios
			.filter((scenario) => scenario.threw !== undefined)
			.map((scenario) => `${scenario.name}: ${scenario.threw}`);
		expect(threw).toEqual([]);
	});

	it("raises errors only where the library refuses the scenario, under the codes named", () => {
		for (const [name, code] of Object.entries(LIBRARY_REFUSES)) {
			expect(
				scenarioNamed(name).diagnostics.map((d) => d.code),
				name,
			).toContain(code);
		}
		const failing = scenarios
			.filter((scenario) => scenario.diagnostics.some((d) => d.severity === "error"))
			.map((scenario) => scenario.name);
		expect(failing.toSorted()).toEqual(Object.keys(LIBRARY_REFUSES).toSorted());
	});
});

describe("every emitted artefact is sound", () => {
	it("builds and validates every schema.graphql with graphql-js", () => {
		const invalid: string[] = [];
		let checked = 0;
		for (const scenario of scenarios) {
			if (scenario.sdl === undefined) continue;
			checked += 1;
			try {
				const errors = validateSchema(buildSchema(scenario.sdl)).map((error) => error.message);
				if (errors.length > 0) invalid.push(`${scenario.name}: ${errors.join("; ")}`);
			} catch (error) {
				invalid.push(`${scenario.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		expect(invalid).toEqual([]);
		// Non-vacuity: a run that wrote no schema would report nothing invalid either.
		expect(checked).toBeGreaterThanOrEqual(55);
	});

	/**
	 * **A schema valid as SDL can still fail to build.** A model named `String` printed a valid
	 * schema.graphql while `createSchema` threw at start-up ("multiple types named String"), so each
	 * scenario's emitted module is imported, built, validated, and its SDL compared with it.
	 */
	it("builds every schema the emitted module builds, and its schema.graphql is that schema", async () => {
		const failures: string[] = [];
		let built = 0;
		for (const scenario of scenarios) {
			const module = join(scenario.dir, "graphql.gen.ts");
			if (scenario.sdl === undefined || !existsSync(module)) continue;
			built += 1;
			try {
				const generated = (await import(module)) as {
					readonly createSchema: (
						handlersFor: (context: object) => object,
						deps: object,
					) => GraphQLSchema;
				};
				const schema = generated.createSchema(() => ({}), {
					authorize: () => "allow",
					context: () => "caller",
				});
				const errors = validateSchema(schema).map((error) => error.message);
				if (errors.length > 0) {
					failures.push(`${scenario.name}: ${errors.join("; ")}`);
					continue;
				}
				const agreement = sdlAgreement(scenario.sdl, schema);
				if (agreement.sdl !== agreement.runtime || agreement.disagreements.length > 0) {
					failures.push(`${scenario.name}: schema.graphql is not the schema createSchema builds`);
				}
			} catch (error) {
				failures.push(
					`${scenario.name}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		expect(failures).toEqual([]);
		// Non-vacuity: a run that built nothing would report no failure either.
		expect(built).toBeGreaterThanOrEqual(55);
	}, 1_800_000);

	/**
	 * **Every request `graphqlRequestsOf` writes is a document the scenario's schema accepts**, a
	 * root field of every shape the corpus has among them: what a tool writing requests for this
	 * surface, a Postman collection, sends.
	 */
	it("writes, for every root field it serves, a document its schema accepts", () => {
		const failures: string[] = [];
		let checked = 0;
		for (const scenario of scenarios) {
			if (scenario.sdl === undefined) continue;
			const schema = buildSchema(scenario.sdl);
			expect(scenario.documents.map((d) => d.field).toSorted(), scenario.name).toEqual(
				rootFieldsOf(scenario.sdl),
			);
			for (const { field, document } of scenario.documents) {
				checked += 1;
				const errors = validate(schema, parse(document));
				if (errors.length > 0)
					failures.push(`${scenario.name} ${field}: ${errors[0]?.message ?? ""}`);
			}
		}
		expect(failures).toEqual([]);
		// Non-vacuity: a corpus that wrote no request would break no rule above.
		expect(checked).toBeGreaterThanOrEqual(200);
	});

	it("typechecks every emitted directory under strict, exactOptionalPropertyTypes, noUnusedLocals and types: []", () => {
		const failures: string[] = [];
		let compiled = 0;
		for (const scenario of scenarios) {
			if (!existsSync(join(scenario.dir, "graphql.gen.ts"))) continue;
			compiled += 1;
			const { output, failed } = typecheckEmitted(scenario.dir);
			if (failed) {
				const first = output.split("\n").find((line) => line.includes("error TS")) ?? output;
				failures.push(`${scenario.name}: ${first.replace(`${scenario.dir}/`, "").trim()}`);
			}
		}
		expect(failures).toEqual([]);
		expect(compiled).toBeGreaterThanOrEqual(55);
	}, 1_800_000);
});

describe("what each scenario keeps and drops", () => {
	/**
	 * **Every declaration is a field or a dropped declaration with its warning**, except one kind: a
	 * declaration on an operation the served version REMOVED. The library emits the latest version,
	 * whose operations are clones the versioning projection makes; the decorators run again on the
	 * clones, so what the latest version keeps is declared there, and what it removed belongs to no
	 * service. Only a versioned scenario may therefore leave declarations unaccounted, and never a
	 * negative number of them.
	 */
	it("accounts for every declaration, but those on operations the served version removed", () => {
		const unaccounted = scenarios
			.filter((scenario) => !(scenario.name in LIBRARY_REFUSES))
			.map((scenario) => {
				const expectation = expectationOf(scenario);
				return {
					scenario,
					missing: expectation.declared - expectation.fields - total(expectation.dropped),
				};
			})
			.filter(({ scenario, missing }) => missing < 0 || (missing > 0 && !scenario.versioned))
			.map(({ scenario, missing }) => `${scenario.name}: ${missing}`);
		expect(unaccounted).toEqual([]);
	});

	/**
	 * **A versioned spec serves its latest version's fields**: what that version removed is gone, what
	 * it added and renamed is there under the current name. A surface matched against the original
	 * operations rather than their clones would serve nothing here at all.
	 */
	it("serves the latest version's operations, through the clones the projection makes", () => {
		/**
		 * A root field is named verbatim from `graphql.tsp`, so the expected names are the ones the
		 * declarations wrote for these operation ids, never a name this package computes.
		 */
		const fieldsFor = (name: string, ids: readonly string[]): string[] => {
			const declared = [...scenarioNamed(name).fields].filter(([, id]) => ids.includes(id));
			expect(declared.map(([, id]) => id).toSorted(), name).toEqual([...ids].toSorted());
			return declared.map(([field]) => field).toSorted();
		};
		expect(rootFieldsOf(scenarioNamed("versioning__removed").sdl)).toEqual(
			fieldsFor("versioning__removed", ["modelV3", "v2"]),
		);
		expect(rootFieldsOf(scenarioNamed("versioning__added").sdl)).toEqual(
			fieldsFor("versioning__added", ["InterfaceV2_v2InInterface", "v1", "v2"]),
		);
		expect(rootFieldsOf(scenarioNamed("versioning__renamedFrom").sdl)).toEqual(
			fieldsFor("versioning__renamedFrom", ["NewInterface_newOpInNewInterface", "newOp"]),
		);
	});

	/**
	 * **The record a reviewer reads.** Per scenario: operations declared, root fields served and
	 * whether `graphql.gen.ts` was written, as floors; each dropping code and each keeping code
	 * (`query-not-safe`, `not-a-connection`, `projected-as-json`) with its count, as ceilings.
	 */
	it("holds what each scenario keeps and drops to the baseline, so a change is a reviewed diff", () => {
		const floors: Record<string, number> = {};
		const ceilings: Record<string, number> = {};
		for (const scenario of scenarios) {
			const expectation = expectationOf(scenario);
			floors[`declared:${scenario.name}`] = expectation.declared;
			floors[`fields:${scenario.name}`] = expectation.fields;
			floors[`emitted:${scenario.name}`] = expectation.emitted ? 1 : 0;
			for (const [code, count] of Object.entries(expectation.dropped)) {
				ceilings[`dropped:${scenario.name}:${code.slice(PREFIX.length)}`] = count;
			}
			for (const [code, count] of Object.entries(expectation.kept)) {
				ceilings[`kept:${scenario.name}:${code.slice(PREFIX.length)}`] = count;
			}
		}
		floors["scenarios"] = scenarios.length;
		floors["declared"] = scenarios.reduce((sum, scenario) => sum + scenario.declared, 0);
		floors["fields"] = scenarios.reduce((sum, scenario) => sum + expectationOf(scenario).fields, 0);
		const { problems } = ratchet(
			join(packageRoot, "test", "conformance", "baseline.json"),
			"The @typespec/http-specs corpus with every operation declared: per scenario, the operations " +
				"declared, the root fields served and whether graphql.gen.ts was written (floors), and each " +
				"warning that dropped or kept a declaration, by code (ceilings). Held by test/support/ratchet.ts.",
			{ floors, ceilings },
		);
		expect(problems).toEqual([]);
	});
});
