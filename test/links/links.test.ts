import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExecutionResult, type GraphQLSchema, graphql, parse } from "graphql";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { operationCost, typeCost } from "../../src/runtime.js";
import { compileFixture } from "../support/compile-fixture.js";

/**
 * **A link bound to a list, and a link to a parameter that narrows its property, through the
 * emitted schema.** A many-to-many shape (`tag_ids: string[]` reading `Tags.read`), and its ids:
 * plain `string` on the response models, `@pattern`-checked on the read.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

interface Product {
	readonly id: string;
	readonly name: string;
	readonly tag_id: string;
	readonly tag_ids?: readonly string[] | null;
}

let schema: GraphQLSchema;
let sdl = "";
let product: Product;
let calls: string[];

beforeAll(async () => {
	const compiled = await compileFixture(here, "main");
	sdl = readFileSync(join(compiled.outDir, "schema.graphql"), "utf8");
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
		readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
	};
	const handlers = {
		Products_read: () => ({ status: 200, body: product }),
		Tags_read: (_caller: unknown, { id }: { readonly id: string }) => {
			calls.push(id);
			if (id === "t-404") return { status: 404, body: { message: "no such tag" } };
			if (id === "t-500") throw new Error("the tag store is down");
			return { status: 200, body: { id, label: `label ${id}` } };
		},
	};
	schema = generated.createSchema(() => handlers, {
		authorize: () => "allow",
		context: () => ({ subject: "links" }),
	});
}, 300_000);

beforeEach(() => {
	calls = [];
	product = { id: "p1", name: "Lamp", tag_id: "t-1", tag_ids: ["t-1", "t-2", "t-1"] };
});

const run = (source: string): Promise<ExecutionResult> =>
	graphql({ schema, source, contextValue: {} });

describe("a link bound to a list", () => {
	it("is a list field of nullable items, costed at the list's @maxItems", () => {
		expect(sdl).toContain('tags: [Tag] @cost(weight: "20") @listSize(assumedSize: 20)');
		const document = parse(`{ product(id: "p1") { tags { id label } } }`);
		// The root's call and the link's twenty; Type Cost: Query, the product and twenty tags.
		expect(operationCost({ schema, document })).toBe(21);
		expect(typeCost({ schema, document })).toBe(22);
	});

	it("calls once per value, through the memo, and answers in the list's order", async () => {
		const result = await run(`{ product(id: "p1") { tags { id label } } }`);
		expect(result).toEqual({
			data: {
				product: {
					tags: [
						{ id: "t-1", label: "label t-1" },
						{ id: "t-2", label: "label t-2" },
						{ id: "t-1", label: "label t-1" },
					],
				},
			},
		});
		expect(calls).toEqual(["t-1", "t-2"]);
	});

	it("answers null for one value's 404 and an error for one value's failure, the rest resolving", async () => {
		product = { ...product, tag_ids: ["t-404", "t-500", "t-2"] };
		const result = await run(`{ product(id: "p1") { name tags { id } } }`);
		expect(result.data).toEqual({ product: { name: "Lamp", tags: [null, null, { id: "t-2" }] } });
		expect(result.errors?.map((error) => [error.message, error.path])).toEqual([
			["the tag store is down", ["product", "tags", 1]],
		]);
	});

	it("is null for a null or absent list, calling nothing, and empty for an empty one", async () => {
		for (const [tagIds, tags] of [
			[null, null],
			[undefined, null],
			[[], []],
		] as const) {
			const { tag_ids: _, ...rest } = product;
			product = tagIds === undefined ? rest : { ...rest, tag_ids: tagIds };
			const result = await run(`{ product(id: "p1") { tags { id } } }`);
			expect(result).toEqual({ data: { product: { tags } } });
		}
		expect(calls).toEqual([]);
	});

	it("refuses one value its parameter refuses as BAD_USER_INPUT at that item", async () => {
		product = { ...product, tag_ids: ["t-1", "not-a-tag"] };
		const result = await run(`{ product(id: "p1") { tags { id } } }`);
		expect(result.data).toEqual({ product: { tags: [{ id: "t-1" }, null] } });
		expect(result.errors?.map((error) => [error.extensions["code"], error.path])).toEqual([
			["BAD_USER_INPUT", ["product", "tags", 1]],
		]);
	});
});

describe("a link to a parameter that narrows its property", () => {
	it("is a field, filled from the property it narrows", async () => {
		expect(sdl).toContain('firstTag: Tag @cost(weight: "1")');
		const result = await run(`{ product(id: "p1") { firstTag { id } } }`);
		expect(result).toEqual({ data: { product: { firstTag: { id: "t-1" } } } });
	});

	it("answers a value that breaks the parameter's pattern BAD_USER_INPUT, its siblings resolving", async () => {
		product = { ...product, tag_id: "p1" };
		const result = await run(`{ product(id: "p1") { name firstTag { id } } }`);
		expect(result.data).toEqual({ product: { name: "Lamp", firstTag: null } });
		expect(result.errors?.map((error) => [error.extensions["code"], error.path])).toEqual([
			["BAD_USER_INPUT", ["product", "firstTag"]],
		]);
		expect(calls).toEqual([]);
	});
});
