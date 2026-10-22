import { defineConfig } from "vitest/config";

/**
 * **The second half of `pnpm test:mutation`: the check over the report Stryker just wrote.** Its own
 * config, because `pnpm test` must not need a mutation report: a fresh clone has none, and making
 * one takes the better part of half an hour.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/mutation/check.test.ts"],
	},
});
