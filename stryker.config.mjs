import { fileURLToPath } from "node:url";

/**
 * Mutation testing, dev-only: `pnpm test:mutation`. Each mutant of the modules below is run against
 * the suites `vitest.mutation.config.ts` names, and `test/mutation/check.test.ts` holds the result to
 * `test/mutation/equivalents.json` and `test/mutation/baseline.json`.
 *
 * The vitest runner is patched (`patches/`) twice. Vitest 5 matches a test name pattern against the
 * suite chain joined by `" > "`, and the runner joined it with spaces, so a per-test run selected no
 * test and every covered mutant was reported survived (stryker-js #6210). A test file that failed as
 * a whole, because the mutant stopped it loading, was read as passing (#6150, #6234; the patch
 * mirrors the open PR #6217). Delete the patch when a release fixes both; `check.test.ts` refuses a
 * survivor that ran no test, so a regression shows.
 *
 * @type {import("@stryker-mutator/api/core").PartialStrykerOptions}
 */
export default {
	testRunner: "vitest",
	// By the path this package resolves it to: pnpm's isolated layout hides it from Stryker's own
	// search, which looks beside Stryker's install rather than this package's.
	plugins: [fileURLToPath(import.meta.resolve("@stryker-mutator/vitest-runner"))],
	vitest: { configFile: "vitest.mutation.config.ts" },
	mutate: [
		"src/runtime.ts",
		"src/results.ts",
		"src/connections.ts",
		"src/inputs.ts",
		"src/types.ts",
	],
	coverageAnalysis: "perTest",
	/**
	 * **A minute before a run counts as hung.** A static mutant reruns every related suite, each
	 * compiling its fixture in `beforeAll`, which the dry run's per-test times leave out; at the
	 * five-second default, 230 mutants of `types.ts` (a scalar's description among them) were reported
	 * timed out, which Stryker counts as detected. A mutant that loops is stopped by its hit limit
	 * long before this.
	 */
	timeoutMS: 60_000,
	/**
	 * **No tsconfig for Stryker to rewrite.** It rewrites a tsconfig's paths that would point outside
	 * its sandbox, and parses the file with TypeScript's JavaScript API, which TypeScript 7 does not
	 * have. This package's tsconfigs point nowhere outside it, and vitest reads none of them, so the
	 * option names no file and the rewrite has nothing to do.
	 */
	tsconfigFile: "stryker-rewrites-no-tsconfig.json",
	reporters: ["clear-text", "json", "progress"],
	jsonReporter: { fileName: "test/mutation/.out/mutation.json" },
	// Kept locally, so a rerun tests only the mutants whose code or tests changed.
	incremental: true,
	incrementalFile: "test/mutation/.out/incremental.json",
	tempDirName: "test/mutation/.out/stryker-tmp",
	cleanTempDir: "always",
};
