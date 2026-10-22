import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **The `@typespec/http-specs` corpus, as entry points.**
 *
 * Each `main.tsp` is given by its REAL path. A scenario imports `@typespec/spector` beside
 * `@typespec/http`, and that package is the corpus's dependency, not this package's: it resolves
 * from where pnpm keeps the corpus, and only from there. A generated file that imports the scenario
 * through the `node_modules` symlink would resolve it from this package instead, and fail.
 */

// `../..` because this file lives in `test/support/`, where `..` is `test/` and not the root.
export const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Scenarios the LIBRARY refuses, with the diagnostic it refuses them under. Named rather than
 * counted: a scenario that starts failing for another reason must not be absorbed. Neither is this
 * emitter's doing.
 */
export const LIBRARY_REFUSES: Readonly<Record<string, string>> = {
	"response__status-code-range": "typespec-http-zod/unsupported-status-code-range",
	type__union__discriminated: "typespec-http-zod/undeclared-discriminator",
};

/** The errors compiling a scenario must raise: the library's refusal of it, or none. */
export function libraryRefusalsOf(scenario: string): readonly string[] {
	const code = LIBRARY_REFUSES[scenario];
	return code === undefined ? [] : [code];
}

/** One scenario the corpus declares: a name safe as a directory, and its entry point. */
export interface ScenarioSource {
	readonly name: string;
	readonly main: string;
}

function mainsUnder(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) mainsUnder(full, found);
		else if (entry.name === "main.tsp") found.push(full);
	}
	return found;
}

/** Every scenario the corpus declares, named by its path with `/` spelt `__`, sorted. */
export function corpusScenarios(): ScenarioSource[] {
	const specs = realpathSync(join(packageRoot, "node_modules", "@typespec", "http-specs", "specs"));
	return mainsUnder(specs)
		.map((main) => ({
			name: main
				.slice(specs.length + 1)
				.replace(/\/main\.tsp$/, "")
				.replaceAll("/", "__"),
			main,
		}))
		.toSorted((a, b) => a.name.localeCompare(b.name));
}
