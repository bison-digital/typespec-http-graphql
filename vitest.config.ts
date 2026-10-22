import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * The emitter is a build-time tool, not Workers code, plain Node. The suite compiles TypeSpec and
 * shells out to `tsc`, so it needs headroom well past the 5s default.
 *
 * **No `globalSetup`.** Each suite compiles what it needs through its own harness. A `globalSetup`
 * naming a file that does not exist fails the whole run before a single test is collected.
 *
 * **Two projects, split by what a suite COSTS.** `system` holds the corpus and the real workers, most
 * of the wall clock; `unit` holds the rest. `pnpm test` runs both; `pnpm test:unit` is for the edit
 * loop, not the gate.
 *
 * **One graphql-js major.** The peer range is `^17.0.0`: graphql 16 offers only the scalar and
 * default-value API 17 deprecates (`serialize`, `parseValue`, `parseLiteral`, `defaultValue`), and
 * nothing deprecated ships here, so there is no second major to run the suite against.
 */
/**
 * **What a suite writes is never a suite.** `test/testing/` writes a consumer's own `yoga.test.ts`
 * under `.out/` and runs it with the consumer's vitest; collected here as well, it ran while that
 * suite rewrote the directory under it, and failed as often as the two met.
 */
const WRITTEN = [...configDefaults.exclude, "**/.out/**", "**/.out-*/**"];

const SYSTEM = [
	"test/conformance/**/*.test.ts",
	"test/socket/**/*.test.ts",
	"test/verdicts/**/*.test.ts",
	"test/replay/**/*.test.ts",
	"test/relay-client/**/*.test.ts",
	"test/testing/**/*.test.ts",
];

/**
 * **ONE `graphql` for every module a project loads: the file Node itself resolves for `graphql`.**
 *
 * graphql 17 ships several builds behind one name, chosen by export condition: `index.mjs` under
 * `module-sync`, `index.js` under `node` and `require`, and a `__dev__/` copy of each under
 * `development`. Vite resolves the files it transforms (the tests, and the emitted output they import
 * from `.out/`) by its own conditions; a dependency it leaves to Node, GraphQL Yoga, gets Node's. Two
 * copies of graphql-js refuse each other's schemas: every request through Yoga answers
 * `Cannot use GraphQLSchema "{...}" from another module or realm`, which Yoga masks to
 * "Unexpected error.". Aliasing the bare name to the file Node resolves gives every module that one
 * copy, and `test/graphql-major.test.ts` asserts it.
 *
 * A consumer testing its own server under vitest meets it on its first request through Yoga, so the
 * README's "Testing it" gives the same alias.
 */
const graphqlAlias = [
	{ find: /^graphql$/, replacement: fileURLToPath(import.meta.resolve("graphql")) },
];

export default defineConfig({
	resolve: { alias: graphqlAlias },
	test: {
		testTimeout: 180_000,
		projects: [
			{
				resolve: { alias: graphqlAlias },
				test: {
					name: "unit",
					environment: "node",
					include: ["test/**/*.test.ts"],
					// The mutation check grades a report only `pnpm test:mutation` writes.
					exclude: [...SYSTEM, ...WRITTEN, "test/mutation/**"],
					testTimeout: 180_000,
				},
			},
			{
				resolve: { alias: graphqlAlias },
				test: {
					name: "system",
					environment: "node",
					include: SYSTEM,
					exclude: WRITTEN,
					testTimeout: 1_800_000,
				},
			},
		],
	},
});
