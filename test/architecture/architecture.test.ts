import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **The boundaries in design.md's module table, pinned rather than merely tidy once.**
 *
 * One of these is not hygiene: `runtime.ts` is COPIED INTO CONSUMER OUTPUT, so anything it imports
 * becomes an import in their build, and a build-time package or a Node builtin there is a broken
 * deploy, found at deploy time. The rest keep the renderers free of the compiler, so a change to how
 * the program is read cannot change how text is written, and keep the decorators recording only.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const srcDir = join(packageRoot, "src");

/** A module's source as the compiler sees it: block comments and template literals emptied. */
function codeOf(file: string): string {
	const raw = readFileSync(join(srcDir, file), "utf8");
	return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/`(?:[^`\\]|\\.)*`/gs, "``");
}

/** The specifiers a module imports or re-exports from, multi-line statements included. */
function importsOf(file: string): string[] {
	return [...codeOf(file).matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"/gm)].map(
		(match) => match[1] ?? "",
	);
}

const MODULES = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));

/** Every external package a module reaches, following local imports; Node builtins skipped. */
function externalClosure(file: string, seen = new Set<string>()): Set<string> {
	for (const specifier of importsOf(file)) {
		if (specifier.startsWith("./")) {
			const local = specifier.slice(2).replace(/\.js$/, ".ts");
			if (!seen.has(local)) {
				seen.add(local);
				externalClosure(local, seen);
			}
		} else if (!specifier.startsWith("node:")) {
			seen.add(specifier);
		}
	}
	return seen;
}

const externalsOf = (file: string): string[] =>
	[...externalClosure(file)].filter((name) => !name.endsWith(".ts")).toSorted();

const reachesCompiler = (file: string): string[] =>
	externalsOf(file).filter(
		(name) => name.startsWith("@typespec/compiler") || name === "@typespec/http",
	);

describe("the module graph is inspectable at all", () => {
	it("found the modules it grades", () => {
		expect(MODULES.length).toBeGreaterThanOrEqual(15);
		for (const module of [
			"runtime.ts",
			"model.ts",
			"render.ts",
			"sdl.ts",
			"handlers.ts",
			"names.ts",
			"decorators.ts",
			"emitter.ts",
		]) {
			expect(MODULES).toContain(module);
		}
	});

	it("has no import cycle", () => {
		expect(MODULES.filter((file) => externalClosure(file).has(file))).toEqual([]);
	});
});

describe("runtime.ts is consumer code, and must stay that way", () => {
	it("reaches only graphql and zod", () => {
		expect(externalsOf("runtime.ts")).toEqual(["graphql", "zod"]);
	});

	/**
	 * **Zod as a TYPE only.** Under `verbatimModuleSyntax`, `import { type X } from "zod"` still
	 * imports the module at run time; only `import type` is erased.
	 */
	it("imports zod only with import type", () => {
		const zod = [
			...codeOf("runtime.ts").matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+"zod"/gm),
		];
		expect(zod.length).toBeGreaterThanOrEqual(1);
		expect(zod.filter((match) => match[2] === undefined).map((match) => match[0].trim())).toEqual(
			[],
		);
	});

	/**
	 * **And no Node builtin, which the closure above is written not to see**, because `emitter.ts`
	 * reads the filesystem legitimately. In a Worker without `nodejs_compat`, `node:fs` is
	 * `No such module "node:fs"`. `test/socket/` checks the same rule by running it.
	 */
	it("imports no Node builtin", () => {
		expect(importsOf("runtime.ts").filter((name) => name.startsWith("node:"))).toEqual([]);
		// Non-vacuity: a file read as empty reports no builtin either.
		expect(importsOf("runtime.ts").length).toBeGreaterThanOrEqual(2);
	});

	it("imports no other module of this package, so copying it out is lossless", () => {
		expect(importsOf("runtime.ts").filter((specifier) => specifier.startsWith("./"))).toEqual([]);
	});

	it("is the file the emitter copies", () => {
		expect(readFileSync(join(srcDir, "emitter.ts"), "utf8")).toContain(
			'new URL("../../src/runtime.ts", import.meta.url)',
		);
	});
});

describe("the renderers render, and the derivations derive", () => {
	it("model, render, sdl and handlers never reach the TypeSpec compiler, even transitively", () => {
		for (const file of ["model.ts", "render.ts", "sdl.ts", "handlers.ts"]) {
			expect(reachesCompiler(file), file).toEqual([]);
		}
		// Non-vacuity: the closure is being computed.
		expect(externalsOf("sdl.ts")).toContain("graphql");
	});

	it("names.ts is pure: change-case and nothing else", () => {
		expect(importsOf("names.ts")).toEqual(["change-case"]);
	});

	it("the decorators record and never check", () => {
		const decorators = codeOf("decorators.ts");
		expect(decorators).not.toContain("reportDiagnostic");
		expect(importsOf("decorators.ts")).not.toContain("./surface.js");
	});

	it("only the entry point imports the orchestrator", () => {
		const importers = MODULES.filter(
			(file) => file !== "emitter.ts" && importsOf(file).includes("./emitter.js"),
		);
		expect(importers).toEqual(["index.ts"]);
	});
});

describe("facts are declared once", () => {
	/** `coexistence.ts` finds this emitter in the compiler's options by name; a drifted copy finds nothing. */
	it("the package name is a literal in exactly one module", () => {
		const declaring = MODULES.filter((file) =>
			readFileSync(join(srcDir, file), "utf8").includes('"typespec-http-graphql"'),
		);
		expect(declaring).toEqual(["lib.ts"]);
	});

	it("and it is the name package.json publishes", () => {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
			name: string;
		};
		expect(readFileSync(join(srcDir, "lib.ts"), "utf8")).toContain(
			`export const PACKAGE_NAME = "${manifest.name}"`,
		);
	});
});

/**
 * **An oracle's expected side never reads the code it grades.** These modules decide what a suite
 * EXPECTS: names (the vendored upstream pipeline), which operations a corpus scenario declares and
 * under which names, and what a baseline holds. One that imported `src/`, emitted output or the
 * runtime copy would grade the emitter against itself, and stay green whatever the emitter did.
 * New oracle modules join `ORACLE_MODULES` as they arrive.
 */
const ORACLE_MODULES = [
	"test/names/upstream-naming.ts",
	"test/replay/published.ts",
	"test/support/by-code-unit.ts",
	"test/support/declare-every-operation.ts",
	"test/support/instances.ts",
	"test/support/ratchet.ts",
	"test/support/wire-walk.ts",
];

/** Every import an oracle module makes that reaches the code under test or what it emitted. */
function subjectImports(specifiers: readonly string[]): string[] {
	return specifiers.filter(
		(specifier) =>
			/(^|\/)src\//.test(specifier) ||
			/(^|\/)\.out[^/]*\//.test(specifier) ||
			specifier.includes("graphql-runtime.gen") ||
			specifier.includes("graphql.gen") ||
			specifier === "typespec-http-graphql" ||
			specifier.startsWith("typespec-http-graphql/"),
	);
}

const testImportsOf = (file: string): string[] =>
	[
		...readFileSync(join(packageRoot, file), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/gm),
	].map((match) => match[1] ?? match[2] ?? "");

describe("an oracle's expected side never reads the code under test", () => {
	it("reads each oracle module, and each imports something to check", () => {
		for (const file of ORACLE_MODULES.filter((name) => !name.endsWith("by-code-unit.ts"))) {
			expect(testImportsOf(file).length, file).toBeGreaterThan(0);
		}
	});

	it("finds no oracle module importing src/, emitted output or the runtime copy", () => {
		const reaching = ORACLE_MODULES.flatMap((file) =>
			subjectImports(testImportsOf(file)).map((specifier) => `${file}: ${specifier}`),
		);
		expect(reaching).toEqual([]);
	});

	it("can fail: the import declare-every-operation.ts used to make is refused", () => {
		expect(
			subjectImports([
				"../../src/names.js",
				"../.out-corpus/x/emitted/graphql.gen.ts",
				"./graphql-runtime.gen.js",
				"node:fs",
				"../names/upstream-naming.js",
			]),
		).toEqual([
			"../../src/names.js",
			"../.out-corpus/x/emitted/graphql.gen.ts",
			"./graphql-runtime.gen.js",
		]);
	});
});
