import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * **The suites the mutation run reads: those that import `src/` directly**, and never load this
 * emitter from `dist/`.
 *
 * A suite that runs this emitter over a fixture loads it from `dist/`, which Stryker does not
 * mutate, so it cannot see a mutant; and it costs seconds, paid again for every mutant. These suites
 * import the mutated modules themselves. Five of them do compile a `.tsp` (with `noEmit`, then the
 * library's `emitHttpZod`), but only to hand the planning modules a program, so the code they grade
 * is the sandbox's. `pnpm test:mutation` runs Stryker over them; `pnpm test` does not read this
 * config.
 */
export default defineConfig({
	resolve: {
		alias: [{ find: /^graphql$/, replacement: fileURLToPath(import.meta.resolve("graphql")) }],
	},
	test: {
		environment: "node",
		include: [
			"test/runtime/**/*.test.ts",
			"test/results/**/*.test.ts",
			"test/inputs/inputs.test.ts",
			"test/types/**/*.test.ts",
			"test/connections/**/*.test.ts",
			"test/plan/**/*.test.ts",
			"test/limits/limits.test.ts",
		],
		testTimeout: 60_000,
		/**
		 * **No module cache.** Stryker starts one vitest per test-runner process, and every sandbox
		 * reaches this package's `node_modules/.vitest-cache` through a link: a dozen processes
		 * clearing one cache directory at once, after the lockfile changes, fail with `ENOTEMPTY`.
		 */
		fsModuleCache: false,
	},
});
