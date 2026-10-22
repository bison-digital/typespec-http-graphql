import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertScalarType, GraphQLScalarType, GraphQLSchema, versionInfo } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "./support/compile-fixture.js";
import { executeThroughYoga } from "./support/yoga.js";

/**
 * **graphql-js 17, and only one copy of it: in the peer range, in the tree, in the test's import, in
 * the schema the emitted code builds, and in the server executing it.**
 *
 * The peer range is `^17.0.0`, because graphql 16 offers only the API 17 deprecates and nothing
 * deprecated ships here. A second copy of graphql-js anywhere in the tree would be one a server could
 * load beside the consumer's, and two copies refuse each other's types, so a schema from the wrong
 * copy fails the last two arms outright.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

let schema: GraphQLSchema;

beforeAll(async () => {
	const compiled = await compileFixture(join(packageRoot, "test", "acceptance"), "main", {
		outDir: join(packageRoot, "test", ".out-graphql-major"),
	});
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as unknown as {
		readonly createSchema: (
			handlersFor: () => object,
			deps: { readonly authorize: () => "allow"; readonly context: () => object },
		) => GraphQLSchema;
	};
	schema = generated.createSchema(() => ({}), {
		authorize: () => "allow",
		context: () => ({ subject: "major" }),
	});
}, 300_000);

describe("graphql-js 17", () => {
	it("is the only major the peer range admits", () => {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
			readonly peerDependencies: Readonly<Record<string, string>>;
		};
		expect(manifest.peerDependencies["graphql"]).toBe("^17.0.0");
	});

	it("is the only copy in the dependency tree, production and development", () => {
		const listed = execFileSync("pnpm", ["list", "--depth", "Infinity", "--json"], {
			cwd: packageRoot,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		const found = new Set<string>();
		let visited = 0;
		const walk = (dependencies: unknown): void => {
			if (typeof dependencies !== "object" || dependencies === null) return;
			for (const [name, node] of Object.entries(dependencies)) {
				visited += 1;
				const { version, dependencies: nested } = node as {
					readonly version?: string;
					readonly dependencies?: unknown;
				};
				if (name === "graphql" && version !== undefined) found.add(version);
				walk(nested);
			}
		};
		for (const project of JSON.parse(listed) as readonly Readonly<Record<string, unknown>>[]) {
			walk(project["dependencies"]);
			walk(project["devDependencies"]);
		}
		// The walk reached the transitive tree, not only the manifest's own entries.
		expect(visited).toBeGreaterThan(100);
		expect([...found]).toEqual(["17.0.2"]);
	});

	it("is the major this run loaded", () => {
		expect(versionInfo.major).toBe(17);
	});

	it("is the module the emitted schema and its runtime's scalars were built with", () => {
		expect(schema).toBeInstanceOf(GraphQLSchema);
		expect(assertScalarType(schema.getType("UTCDateTime"))).toBeInstanceOf(GraphQLScalarType);
	});

	it("is the module Yoga executes with", async () => {
		const result = await executeThroughYoga(schema, { query: "{ __typename }" }, {});
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({ __typename: "Query" });
	});
});
