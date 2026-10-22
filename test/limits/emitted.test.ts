import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GraphQLSchema, parse } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { costLimit, operationCost, typeCost, typeCostLimit } from "../../src/runtime.js";
import { compileFixture } from "../support/compile-fixture.js";

/**
 * **`operationCost` and `typeCost` over schemas this emitter wrote**, where each field's cost lives in its
 * `extensions` rather than in SDL, with costs worked by hand from the cost specification's rules as
 * `limits.test.ts` states them. Apart from that suite, which compiles nothing and reads `src/`
 * alone, because it compiles two fixtures.
 */

const costOf = (schema: GraphQLSchema, document: string): number =>
	operationCost({ schema, document: parse(document) });

describe("operationCost over an emitted schema", () => {
	let idiom: GraphQLSchema;
	let extras: GraphQLSchema;

	beforeAll(async () => {
		const here = fileURLToPath(new URL(".", import.meta.url));
		const load = async (dir: string, outDir: string): Promise<GraphQLSchema> => {
			const compiled = await compileFixture(dir, "main", { outDir });
			const module = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
				readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
			};
			return module.createSchema(() => ({}), { authorize: () => "allow", context: () => ({}) });
		};
		idiom = await load(join(here, "..", "idiom"), join(here, ".out", "idiom"));
		extras = await load(join(here, "..", "claims", "extras"), join(here, ".out", "extras"));
	}, 300_000);

	/** `authors` 1, `edges` 1, two edges each with `node` 1, `nodes` 1, `pageInfo` 1. */
	it("sizes a connection's edges and nodes by first", () => {
		const document = `{ authors(first: 2) { edges { cursor node { id } } nodes { id } pageInfo { hasNextPage } } }`;
		expect(costOf(idiom, document)).toBe(6);
	});

	/** `books` 1, `nodes` 1, and fifty nodes by `first`'s default, each with an `author` link, 1. */
	it("reads first's default where the query sends none", () => {
		expect(costOf(idiom, `{ books { nodes { author { name } } } }`)).toBe(52);
	});

	/** `items` has no default page size; `assumedSize`, the page size's maximum, 100, bounds it. */
	it("reads assumedSize where first has no default", () => {
		expect(costOf(extras, `{ items { edges { node { id } } } }`)).toBe(1 + 1 + 100);
	});

	/**
	 * **Field Cost counts calls, Type Cost counts objects, and a client chooses between `nodes` and
	 * `edges`.** Both documents select three books, their authors, and three editors of each.
	 *
	 * - Field Cost through `nodes`: `books` 1, `nodes` 1, and per book `author` 1, `editors` 1 and
	 *   `nodes` 1, which is 11. Through `edges`, each item's `node` costs 1 more at both levels: 23.
	 * - Type Cost through `nodes`: Query 1, the two connections' 1 and 3, three books, three
	 *   authors and nine editors, which is 20. Through `edges` add the three and nine edges: 32.
	 *
	 * So a `costLimit` set between them serves one and refuses the other, while a `typeCostLimit`
	 * below the objects both return refuses both.
	 */
	it("bounds the objects a document returns by Type Cost, through nodes or edges alike", () => {
		const viaNodes = `{ books(first: 3) { nodes { author { editors(first: 3) { nodes { id } } } } } }`;
		const viaEdges = `{ books(first: 3) { edges { node { author { editors(first: 3) { edges { node { id } } } } } } } }`;
		expect([costOf(idiom, viaNodes), costOf(idiom, viaEdges)]).toEqual([11, 23]);
		const typeCostOf = (document: string) => typeCost({ schema: idiom, document: parse(document) });
		expect([typeCostOf(viaNodes), typeCostOf(viaEdges)]).toEqual([20, 32]);

		const request = (document: string) => ({ schema: idiom, document: parse(document) });
		expect(costLimit(15)(request(viaNodes))).toBeUndefined();
		expect(costLimit(15)(request(viaEdges))?.extensions["code"]).toBe("COST_LIMIT_EXCEEDED");
		expect(typeCostLimit(15)(request(viaNodes))?.extensions["code"]).toBe(
			"TYPE_COST_LIMIT_EXCEEDED",
		);
		expect(typeCostLimit(15)(request(viaEdges))?.extensions["code"]).toBe(
			"TYPE_COST_LIMIT_EXCEEDED",
		);
	});

	/** The field 1, the `input` argument 1 as a composite, and the costliest member's link, 1. */
	it("costs a mutation by its input and its costliest member", () => {
		const document = `mutation { createBook(input: { originalLanguage: "en" }) {
			... on Book { author { name } } ... on ConflictProblem { title } } }`;
		expect(costOf(idiom, document)).toBe(3);
	});
});
