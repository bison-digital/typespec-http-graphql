/**
 * **The fixtures under `test/` that a library refuses, with the errors each must raise.**
 *
 * An emit carries on past a library's error, so this emitter's handling of such a spec is graded,
 * by the suite beside each fixture. Kept in one table because `test/idiom/specifications.test.ts`
 * compiles every fixture under `test/`: each suite and that sweep expect the same errors, and a
 * fixture added that does not compile, with no row here, fails the sweep.
 */
export const REFUSED_FIXTURES: Readonly<Record<string, readonly string[]>> = {
	"results/refused-never": ["typespec-http-zod/never-body"],
	"results/refused-ranges": ["typespec-http-zod/unsupported-status-code-range"],
	"types/refused": [
		"typespec-http-zod/unsatisfiable-encoding",
		"typespec-http-zod/unsupported-type",
		"typespec-http-zod/undeclared-discriminator",
		"typespec-http-zod/duplicate-declaration",
	],
};

/** The errors the fixture at `path` (relative to `test/`, without `.tsp`) must raise: none, unless listed. */
export function refusalsOf(path: string): readonly string[] {
	return REFUSED_FIXTURES[path] ?? [];
}
