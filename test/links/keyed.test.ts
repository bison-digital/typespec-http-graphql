import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExecutionResult, type GraphQLSchema, graphql, isObjectType, parse } from "graphql";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { operationCost, typeCost } from "../../src/runtime.js";
import { type CompiledFixture, compileFixture } from "../support/compile-fixture.js";
import { typecheckEmitted } from "../support/typecheck-emitted.js";

/**
 * **A link chosen by a kind, through the emitted schema.** A review is of a book or of an author,
 * and `subject_type` says which `subject_id` is: each review reads only the operation its kind names,
 * one call per review rather than one per possible target.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

interface Review {
	readonly id: string;
	readonly subject_type: "book" | "author" | "series";
	readonly subject_id: string | null;
	readonly subject_ids?: readonly string[];
}

const BOOKS: Readonly<Record<string, { id: string; title: string }>> = {
	b1: { id: "b1", title: "The First" },
	b2: { id: "b2", title: "The Second" },
};
const AUTHORS: Readonly<Record<string, { id: string; name: string }>> = {
	a1: { id: "a1", name: "An Author" },
};

let compiled: CompiledFixture;
let schema: GraphQLSchema;
let sdl = "";
let reviews: readonly Review[];
let calls: string[];

beforeAll(async () => {
	compiled = await compileFixture(here, "keyed");
	sdl = readFileSync(join(compiled.outDir, "schema.graphql"), "utf8");
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
		readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
	};
	const notFound = { status: 404, body: { message: "none" } };
	const handlers = {
		Reviews_read: (_caller: unknown, { id }: { readonly id: string }) => {
			const review = reviews.find((candidate) => candidate.id === id);
			return review === undefined ? notFound : { status: 200, body: review };
		},
		Reviews_list: () => ({ status: 200, body: reviews }),
		Books_read: (_caller: unknown, { id }: { readonly id: string }) => {
			calls.push(`Books_read ${id}`);
			const book = BOOKS[id];
			return book === undefined ? notFound : { status: 200, body: book };
		},
		Authors_read: (_caller: unknown, { authorId }: { readonly authorId: string }) => {
			calls.push(`Authors_read ${authorId}`);
			const author = AUTHORS[authorId];
			return author === undefined ? notFound : { status: 200, body: author };
		},
	};
	schema = generated.createSchema(() => handlers, {
		authorize: () => "allow",
		context: () => ({ subject: "keyed" }),
	});
}, 300_000);

beforeEach(() => {
	calls = [];
	reviews = [
		{ id: "r1", subject_type: "book", subject_id: "b1", subject_ids: ["b1", "b2"] },
		{ id: "r2", subject_type: "book", subject_id: "b2" },
		{ id: "r3", subject_type: "author", subject_id: "a1", subject_ids: ["a1"] },
	];
});

const run = (source: string): Promise<ExecutionResult> =>
	graphql({ schema, source, contextValue: {} });

const SUBJECT = "subject { __typename ... on Book { id title } ... on Author { id name } }";

describe("a link chosen by a kind", () => {
	it("emits code that typechecks under strict settings and no ambient types", () => {
		const { output, failed } = typecheckEmitted(compiled.outDir);
		expect(failed, output).toBe(false);
	}, 120_000);

	it("is a union of its arms' types, in the order they are declared, weighed as one call", () => {
		expect(sdl).toContain('subject: ReviewSubject @cost(weight: "1")');
		expect(sdl).toContain("union ReviewSubject = Book | Author");
	});

	it("calls only the operation each item's kind names: three reviews, three calls", async () => {
		const result = await run(`{ reviews { id ${SUBJECT} } }`);
		expect(result).toEqual({
			data: {
				reviews: [
					{ id: "r1", subject: { __typename: "Book", id: "b1", title: "The First" } },
					{ id: "r2", subject: { __typename: "Book", id: "b2", title: "The Second" } },
					{ id: "r3", subject: { __typename: "Author", id: "a1", name: "An Author" } },
				],
			},
		});
		expect(calls).toEqual(["Books_read b1", "Books_read b2", "Authors_read a1"]);
	});

	it("is null, calling nothing, for a kind no arm names and for an absent bound value", async () => {
		reviews = [
			{ id: "r1", subject_type: "series", subject_id: "s1" },
			{ id: "r2", subject_type: "book", subject_id: null },
		];
		const result = await run(`{ reviews { id ${SUBJECT} } }`);
		expect(result).toEqual({
			data: {
				reviews: [
					{ id: "r1", subject: null },
					{ id: "r2", subject: null },
				],
			},
		});
		expect(calls).toEqual([]);
	});

	it("is null where the arm's read answers 404, its siblings resolving", async () => {
		reviews = [
			{ id: "r1", subject_type: "book", subject_id: "b404" },
			{ id: "r2", subject_type: "author", subject_id: "a1" },
		];
		const result = await run(`{ reviews { id ${SUBJECT} } }`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			reviews: [
				{ id: "r1", subject: null },
				{ id: "r2", subject: { __typename: "Author", id: "a1", name: "An Author" } },
			],
		});
	});

	it("names every operation it may call, and no single one", () => {
		const review = schema.getType("Review");
		if (!isObjectType(review)) throw new Error("Review is no object type");
		const { extensions } = review.getFields()["subject"] ?? {};
		expect(extensions?.["operationIds"]).toEqual(["Books_read", "Authors_read"]);
		expect(extensions?.["operationId"]).toBeUndefined();
	});

	it("costs one call, and its costliest member's objects", () => {
		const document = parse(`{ review(id: "r1") { subject { ... on Book { id } } } }`);
		expect(operationCost({ schema, document })).toBe(2);
		expect(typeCost({ schema, document })).toBe(3);
	});
});

describe("one arm alone", () => {
	it("is a union of its one type, so a later arm adds a member rather than changing the type", () => {
		expect(sdl).toContain('book: ReviewBook @cost(weight: "1")');
		expect(sdl).toContain("union ReviewBook = Book");
	});

	it("calls only for the value it names", async () => {
		const result = await run(`{ reviews { id book { ... on Book { id } } } }`);
		expect(result.data).toEqual({
			reviews: [
				{ id: "r1", book: { id: "b1" } },
				{ id: "r2", book: { id: "b2" } },
				{ id: "r3", book: null },
			],
		});
		expect(calls).toEqual(["Books_read b1", "Books_read b2"]);
	});
});

describe("arms bound to a list", () => {
	it("is a list of the union, weighed at the list's @maxItems", () => {
		expect(sdl).toContain(
			'subjects: [ReviewSubjects] @cost(weight: "3") @listSize(assumedSize: 3)',
		);
		expect(sdl).toContain("union ReviewSubjects = Book | Author");
		const document = parse(`{ review(id: "r1") { subjects { ... on Book { id } } } }`);
		expect(operationCost({ schema, document })).toBe(4);
		expect(typeCost({ schema, document })).toBe(5);
	});

	it("calls the arm its kind names once per value, each item its member", async () => {
		const result = await run(
			`{ reviews { id subjects { __typename ... on Book { id } ... on Author { id } } } }`,
		);
		expect(result.data).toEqual({
			reviews: [
				{
					id: "r1",
					subjects: [
						{ __typename: "Book", id: "b1" },
						{ __typename: "Book", id: "b2" },
					],
				},
				{ id: "r2", subjects: null },
				{ id: "r3", subjects: [{ __typename: "Author", id: "a1" }] },
			],
		});
		expect(calls).toEqual(["Books_read b1", "Books_read b2", "Authors_read a1"]);
	});
});

describe("arms that cannot be members", () => {
	const messagesOf = (code: string): string[] =>
		compiled.messages
			.filter((m) => m.code === `typespec-http-graphql/${code}`)
			.map((m) => m.message);

	it("drops an arm whose result is no object type, and keeps the others", () => {
		expect(messagesOf("link-arm-not-object")).toEqual([
			"The link 'Review.about' calls 'Books_titles', which answers a list, not an object type a union can hold, so that arm is dropped. The operation is still served over HTTP.",
		]);
		expect(sdl).toContain("about: ReviewAbout");
		expect(sdl).toContain("union ReviewAbout = Author");
	});

	it("drops every arm where their arguments differ", () => {
		expect(messagesOf("link-arms-conflict")).toEqual([
			"The links 'Review.found' cannot be one field: their arguments differ, so every one of them is dropped. The operations are still served over HTTP.",
			"The links 'Review.found' cannot be one field: their arguments differ, so every one of them is dropped. The operations are still served over HTTP.",
		]);
		expect(sdl).not.toContain("found");
	});
});
