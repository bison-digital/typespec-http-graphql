import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";
import { readmeBlock } from "../support/readme.js";

/**
 * **The README's "Testing it", graded by running a consumer's own vitest.** A consumer's test builds
 * the generated schema, which vitest transforms, and serves it through GraphQL Yoga, which vitest
 * leaves to Node. Run without a config, graphql 17's `development` build and its default build meet
 * in one request; run with the README's `vitest.config.ts`, verbatim, they do not.
 *
 * Each run is a child vitest of its own, as a consumer runs it, so this suite's own alias cannot
 * mask the fault it grades. If graphql stops shipping two builds, the first arm turns red and the
 * README's paragraph is the thing to delete.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const consumer = join(here, ".out", "consumer");

const CONSUMER_TEST = `import { createYoga } from "graphql-yoga";
import { expect, test } from "vitest";
import { createSchema } from "./generated/graphql.gen.js";

test("serves the generated schema through Yoga", async () => {
	const schema = createSchema(() => ({}) as never, {
		authorize: () => "allow",
		context: () => ({ subject: "consumer" }),
	});
	const yoga = createYoga({ schema, maskedErrors: false });
	const response = await yoga.fetch("http://consumer/graphql", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: "{ __typename }" }),
	});
	expect(await response.json()).toEqual({ data: { __typename: "Query" } });
});
`;

/** The consumer's vitest run under `config`: its exit status and what it printed. */
function vitest(config: string): { readonly status: number | null; readonly output: string } {
	// The child is a consumer's vitest, not a worker of this one.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST") && name !== "TEST"),
	);
	const run = spawnSync(
		join(packageRoot, "node_modules", ".bin", "vitest"),
		["run", "--root", consumer, "--config", join(consumer, config)],
		{ cwd: consumer, encoding: "utf8", env: { ...env, NO_COLOR: "1" } },
	);
	return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

beforeAll(async () => {
	rmSync(consumer, { recursive: true, force: true });
	mkdirSync(consumer, { recursive: true });
	await compileFixture(join(packageRoot, "test", "acceptance"), "main", {
		outDir: join(consumer, "generated"),
	});
	writeFileSync(join(consumer, "yoga.test.ts"), CONSUMER_TEST);
	writeFileSync(
		join(consumer, "bare.config.ts"),
		`import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n`,
	);
	writeFileSync(join(consumer, "vitest.config.ts"), readmeBlock("vitest.config.ts"));
}, 300_000);

describe("a consumer's test of its server under vitest", () => {
	it("meets two copies of graphql-js without the alias", () => {
		const { status, output } = vitest("bare.config.ts");
		expect(status).not.toBe(0);
		expect(output).toContain("from another module or realm");
	}, 120_000);

	it("passes with the README's vitest.config.ts", () => {
		const { status, output } = vitest("vitest.config.ts");
		expect(status, output).toBe(0);
	}, 120_000);
});
