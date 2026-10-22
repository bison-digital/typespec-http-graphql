import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GraphQLSchema, parse } from "graphql";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { operationCost, typeCost } from "../../src/runtime.js";
import { compileFixture } from "../support/compile-fixture.js";
import { typecheckEmitted } from "../support/typecheck-emitted.js";
import { executeThroughYoga } from "../support/yoga.js";

/**
 * **Batched links, through the emitted schema and GraphQL Yoga as the README mounts it.** A page of
 * books reads its authors, and their publishers, each in one call to a batch read of the distinct
 * ids, rather than one call per id.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

interface Book {
	readonly id: string;
	readonly title: string;
	readonly author_id: string;
	readonly editor_ids?: readonly string[];
}

const AUTHORS: Readonly<Record<string, { id: string; name: string; publisher_id: string }>> = {
	a1: { id: "a1", name: "First Author", publisher_id: "p1" },
	a2: { id: "a2", name: "Second Author", publisher_id: "p2" },
	a3: { id: "a3", name: "Third Author", publisher_id: "p1" },
};

let schema: GraphQLSchema;
let outDir = "";
let sdl = "";
let books: readonly Book[];
let calls: { readonly operationId: string; readonly ids: readonly string[] }[];

beforeAll(async () => {
	const compiled = await compileFixture(here, "batch");
	outDir = compiled.outDir;
	sdl = readFileSync(join(compiled.outDir, "schema.graphql"), "utf8");
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
		readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
	};
	const batch =
		<T>(operationId: string, known: (id: string) => T | undefined) =>
		(_caller: unknown, { ids }: { readonly ids: readonly string[] }): T[] => {
			calls.push({ operationId, ids });
			return ids.flatMap((id) => known(id) ?? []);
		};
	const handlers = {
		Books_list: () => ({ status: 200, body: books }),
		Books_read: (_caller: unknown, { id }: { readonly id: string }) => {
			const book = books.find((candidate) => candidate.id === id);
			return book === undefined
				? { status: 404, body: { message: "none" } }
				: { status: 200, body: book };
		},
		Books_batchGet: (caller: unknown, input: { readonly ids: readonly string[] }) => ({
			status: 200,
			body: {
				books: batch("Books_batchGet", (id) => books.find((book) => book.id === id))(caller, input),
			},
		}),
		Authors_batchGet: (caller: unknown, input: { readonly ids: readonly string[] }) => ({
			status: 200,
			body: { authors: batch("Authors_batchGet", (id) => AUTHORS[id])(caller, input) },
		}),
		Publishers_batchGet: (caller: unknown, input: { readonly ids: readonly string[] }) => ({
			status: 200,
			body: batch("Publishers_batchGet", (id) => ({ id, name: `House ${id}` }))(caller, input),
		}),
		Reviews_list: () => ({
			status: 200,
			body: [
				{ id: "r1", subject_type: "book", subject_id: "b1" },
				{ id: "r2", subject_type: "author", subject_id: "a2" },
				{ id: "r3", subject_type: "book", subject_id: "b2" },
				{ id: "r4", subject_type: "author", subject_id: "a1" },
			],
		}),
	};
	schema = generated.createSchema(() => handlers, {
		authorize: () => "allow",
		context: () => ({ subject: "batch" }),
	});
}, 300_000);

beforeEach(() => {
	calls = [];
	books = [
		{ id: "b1", title: "One", author_id: "a1", editor_ids: ["a2", "a3"] },
		{ id: "b2", title: "Two", author_id: "a2" },
		{ id: "b3", title: "Three", author_id: "a1", editor_ids: ["a3"] },
	];
});

const run = (query: string) => executeThroughYoga(schema, { query }, { caller: "reader" });

describe("a batched link", () => {
	it("emits code that typechecks under strict settings and no ambient types", () => {
		const { output, failed } = typecheckEmitted(outDir);
		expect(failed, output).toBe(false);
	}, 120_000);

	it("is the batch's item type, weighed at its calls: one, and one more for a 404 retried", () => {
		expect(sdl).toContain('author: Author @cost(weight: "2")');
		expect(sdl).toContain('editors: [Author] @cost(weight: "5") @listSize(assumedSize: 4)');
		expect(sdl).toContain('publisher: Publisher @cost(weight: "1")');
		const document = parse(`{ book(id: "b1") { author { id } } }`);
		expect(operationCost({ schema, document })).toBe(3);
		expect(typeCost({ schema, document })).toBe(3);
	});

	it("reads a page's authors in one call, and their publishers in one more", async () => {
		const result = await run(
			"{ books { id author { name publisher { name } } editors { name } } }",
		);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			books: [
				{
					id: "b1",
					author: { name: "First Author", publisher: { name: "House p1" } },
					editors: [{ name: "Second Author" }, { name: "Third Author" }],
				},
				{
					id: "b2",
					author: { name: "Second Author", publisher: { name: "House p2" } },
					editors: null,
				},
				{
					id: "b3",
					author: { name: "First Author", publisher: { name: "House p1" } },
					editors: [{ name: "Third Author" }],
				},
			],
		});
		expect(calls).toEqual([
			{ operationId: "Authors_batchGet", ids: ["a1", "a2", "a3"] },
			{ operationId: "Publishers_batchGet", ids: ["p1", "p2"] },
		]);
	});
});

describe("a link chosen by a kind, each arm batched", () => {
	it("reads a page's subjects in one call per kind", async () => {
		const result = await run(
			"{ reviews { id subject { __typename ... on Book { title } ... on Author { name } } } }",
		);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			reviews: [
				{ id: "r1", subject: { __typename: "Book", title: "One" } },
				{ id: "r2", subject: { __typename: "Author", name: "Second Author" } },
				{ id: "r3", subject: { __typename: "Book", title: "Two" } },
				{ id: "r4", subject: { __typename: "Author", name: "First Author" } },
			],
		});
		expect(calls).toEqual([
			{ operationId: "Books_batchGet", ids: ["b1", "b2"] },
			{ operationId: "Authors_batchGet", ids: ["a2", "a1"] },
		]);
		expect(sdl).toContain('subject: ReviewSubject @cost(weight: "2")');
	});
});
