import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, parse, validate } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { $lib } from "../src/lib.js";
import { compileFixture } from "./support/compile-fixture.js";

/**
 * **That the documentation and the code say the same thing, graded in both directions.**
 *
 * Documenting everything that exists still permits a paragraph about something removed, and a
 * paragraph per thing still permits a thing nobody documented, so each list is computed from the
 * code. The README's examples are COMPILED: its `graphql.tsp` against the acceptance suite's spec,
 * and its TypeScript against what that surface emits, so an example that drifted from the API fails
 * here rather than in a reader's editor.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(packageRoot, path), "utf8");
const readme = read("README.md");

/** The fenced blocks of one language, in order. */
function blocks(markdown: string, language: string): string[] {
	return [...markdown.matchAll(new RegExp("^```" + language + "\\n([\\s\\S]*?)^```$", "gm"))].map(
		(match) => match[1] ?? "",
	);
}

/** The module the README's examples import as `./handlers.js`: the consumer's, so declared only. */
const HANDLERS = `import type { Context } from "hono";
import type { GraphQLOperations } from "./generated/graphql.gen.js";
import type { GraphQLDeps } from "./generated/graphql-runtime.gen.js";

export interface Caller {
	readonly subject: string;
}

export declare function handlersFor(c: Context): GraphQLOperations<Caller>;
export declare function verify(authorization: string | undefined): Promise<Caller | null>;
export declare const deps: GraphQLDeps<{ readonly c: Context }, Caller>;
export declare function featuredBookFor(c: Context): Promise<unknown>;
`;

const workDir = join(packageRoot, "test", ".out-readme");
let surfaceDiagnostics: readonly { readonly code: string; readonly severity: string }[] = [];
/** The document `graphqlRequestsOf` writes for the surface's `createBook`, as another tool reads it. */
let writtenCreateBook = "";

beforeAll(async () => {
	rmSync(workDir, { recursive: true, force: true });
	mkdirSync(join(workDir, "spec"), { recursive: true });
	copyFileSync(
		join(packageRoot, "test", "acceptance", "rest.tsp"),
		join(workDir, "spec", "rest.tsp"),
	);
	writeFileSync(join(workDir, "spec", "graphql.tsp"), blocks(readme, "tsp")[0] ?? "");
	const compiled = await compileFixture(join(workDir, "spec"), "graphql", {
		outDir: join(workDir, "generated"),
	});
	surfaceDiagnostics = compiled.diagnostics;
	const read = (
		compiled.program.emitters.find((emitter) => emitter.metadata.name === "typespec-http-graphql")
			?.library.entrypoint?.esmExports as
			| {
					readonly graphqlRequestsOf?: (
						program: unknown,
					) =>
						| readonly { readonly requests: readonly { field: string; document: string }[] }[]
						| undefined;
			  }
			| undefined
	)?.graphqlRequestsOf;
	writtenCreateBook =
		read?.(compiled.program)
			?.flatMap((service) => service.requests)
			.find((request) => request.field === "createBook")?.document ?? "";
	writeFileSync(join(workDir, "handlers.ts"), HANDLERS);
	// A block that names its file in its first line (`// graphql.ts`) is written as that file, so the
	// examples that import it compile against it.
	blocks(readme, "ts").forEach((source, index) => {
		const named = /^\/\/ ([\w-]+\.ts)\n/.exec(source)?.[1];
		writeFileSync(join(workDir, named ?? `example-${index + 1}.ts`), source);
	});
	writeFileSync(
		join(workDir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "es2023",
				lib: ["es2023"],
				module: "nodenext",
				moduleResolution: "nodenext",
				strict: true,
				exactOptionalPropertyTypes: true,
				noUncheckedIndexedAccess: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				noEmit: true,
				skipLibCheck: true,
				types: ["node"],
			},
			include: ["./*.ts"],
		}),
	);
}, 300_000);

describe("the README's examples compile", () => {
	it("shows one graphql.tsp and the TypeScript that mounts it", () => {
		expect(blocks(readme, "tsp")).toHaveLength(1);
		expect(blocks(readme, "ts").length).toBeGreaterThanOrEqual(3);
	});

	it("shows the surface the acceptance suite serves, verbatim", () => {
		expect(blocks(readme, "tsp")[0]).toBe(read("test/acceptance/graphql.tsp"));
	});

	it("compiles the surface it shows, with no diagnostic", () => {
		expect(surfaceDiagnostics).toEqual([]);
		expect(existsSync(join(workDir, "generated", "graphql.gen.ts"))).toBe(true);
	});

	it("shows a document whose aliases that surface needs, and accepts", () => {
		const shown = blocks(readme, "graphql");
		expect(shown).toHaveLength(1);
		const document = shown[0] ?? "";
		const schema = buildSchema(readFileSync(join(workDir, "generated", "schema.graphql"), "utf8"));
		expect(validate(schema, parse(document)).map((error) => error.message)).toEqual([]);
		const unaliased = document.replace(/^(\s*)\w+: (\w+)$/gm, "$1$2");
		expect(unaliased).not.toBe(document);
		expect(validate(schema, parse(unaliased)).map((error) => error.message)).toEqual([
			'Fields "title" conflict because they return conflicting types "String" and "String!". Use different aliases on the fields to fetch both if this was intentional.',
			'Fields "status" conflict because they return conflicting types "BookStatus!" and "Int!". Use different aliases on the fields to fetch both if this was intentional.',
		]);
	});

	/**
	 * **Each line the README shows is a line the emitter writes, in its order and at its depth**: the
	 * README indents a level by a tab, the emitter by two spaces, so each tab is read as two spaces and
	 * a field shown under the wrong member, or the wrong parent, is not found.
	 */
	it("shows lines of the document that surface writes for createBook, in its order and nesting", () => {
		const shown = (blocks(readme, "graphql")[0] ?? "")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => line.replace(/^\t+/, (tabs) => "  ".repeat(tabs.length)));
		const written = writtenCreateBook.split("\n");
		// Non-vacuity: the surface's createBook selects more than the abridged block shows.
		expect(written.length).toBeGreaterThan(shown.length);
		let next = 0;
		for (const line of shown) {
			const at = written.indexOf(line, next);
			expect(
				at,
				`${line} is not a line of the written document after line ${next}`,
			).toBeGreaterThanOrEqual(0);
			next = at + 1;
		}
	});

	it("compiles every TypeScript example against what that surface emits", () => {
		let output = "";
		try {
			execFileSync(
				join(packageRoot, "node_modules", ".bin", "tsc"),
				["-p", join(workDir, "tsconfig.json"), "--ignoreConfig"],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch (error) {
			const asExec = error as { stdout?: string; stderr?: string };
			output = `${asExec.stdout ?? ""}${asExec.stderr ?? ""}`;
		}
		expect(output.trim(), output).toBe("");
	}, 300_000);
});

describe("the README documents every diagnostic", () => {
	const codes = Object.keys($lib.diagnostics).toSorted();
	const start = readme.indexOf("## Diagnostics");
	const end = readme.indexOf("\n## ", start + 1);
	const section = readme.slice(start, end === -1 ? undefined : end);

	it("names each one in its table, and none that does not exist", () => {
		expect(start).toBeGreaterThan(-1);
		// Cells may be padded: a formatter aligns Markdown tables.
		const documented = [...section.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map(
			(match) => match[1] ?? "",
		);
		expect(documented.toSorted()).toEqual(codes);
		expect(codes.length).toBeGreaterThanOrEqual(17);
	});

	it("says every diagnostic is a warning, and $lib agrees", () => {
		expect(section).toContain("Every diagnostic is a warning");
		const severities = Object.values($lib.diagnostics).map((definition) => definition.severity);
		expect(severities.filter((severity) => severity !== "warning")).toEqual([]);
	});
});

describe("the documentation set holds together", () => {
	it("the README links every document, and every link resolves", () => {
		const linked = [...readme.matchAll(/\]\(((?:docs\/[^)#]+)|CHANGELOG\.md)\)/g)].map(
			(match) => match[1] ?? "",
		);
		for (const doc of [
			"docs/design.md",
			"docs/architecture.md",
			"docs/oracles.md",
			"docs/measurements.md",
			"docs/releasing.md",
			"CHANGELOG.md",
		]) {
			expect(linked).toContain(doc);
		}
		expect(linked.filter((doc) => !existsSync(join(packageRoot, doc)))).toEqual([]);
	});

	it("the design names the version package.json publishes", () => {
		const { version } = JSON.parse(read("package.json")) as { version: string };
		expect(read("docs/design.md")).toMatch(
			new RegExp(
				`^\\*\\*Status:\\*\\* built, as version ${version.replaceAll(".", "\\.")}\\.`,
				"m",
			),
		);
	});

	it("the changelog names the version package.json publishes", () => {
		const { version } = JSON.parse(read("package.json")) as { version: string };
		expect(read("CHANGELOG.md")).toMatch(
			new RegExp(
				`^## \\[${version.replaceAll(".", "\\.")}\\](?: - (?:\\d{4}-\\d{2}-\\d{2}|Unreleased))?$`,
				"m",
			),
		);
	});

	/**
	 * **The rule of `docs/oracles.md`, made mechanical.** Every suite is named by a row, by its file
	 * or by its directory, so a suite added without one is a comparison nobody wrote down; and every
	 * path a row names exists, so a row cannot outlive its suite.
	 */
	it("docs/oracles.md names every test suite, and nothing that is gone", () => {
		const oracles = read("docs/oracles.md");
		const suites: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith(".test.ts")) suites.push(relative(packageRoot, full));
			}
		};
		walk(join(packageRoot, "test"));
		expect(suites.length).toBeGreaterThanOrEqual(20);

		const named = [
			...new Set([...oracles.matchAll(/`(test\/[^`]+)`/g)].map((match) => match[1] ?? "")),
		];
		const covered = (suite: string): boolean =>
			named.some((path) => (path.endsWith("/") ? suite.startsWith(path) : suite === path));
		expect(suites.filter((suite) => !covered(suite))).toEqual([]);
		expect(named.filter((path) => !existsSync(join(packageRoot, path)))).toEqual([]);
	});

	it("docs/architecture.md names every module of src/, and nothing that is gone", () => {
		const modules = readdirSync(join(packageRoot, "src"))
			.filter((name) => name.endsWith(".ts"))
			.toSorted();
		const rows = [...read("docs/architecture.md").matchAll(/^\|\s*`([a-z-]+\.ts)`\s*\|/gm)]
			.map((match) => match[1] ?? "")
			.toSorted();
		expect(rows).toEqual(modules);
	});
});
