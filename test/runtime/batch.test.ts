import {
	type ExecutionResult,
	graphql,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
} from "graphql";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type CallRuntime, type GraphQLDeps, resolverFor } from "../../src/runtime.js";

/**
 * **A batched link, through graphql-js's own executor, against a hand-built schema.** The schema is
 * what `graphql.gen.ts` writes for a link to a batch read, by hand, so every rule here is the
 * runtime's: which values one call carries, how many calls a document makes, and what each field
 * answers when the batch answers, refuses or fails.
 *
 * **Every document runs against a deadline**, so a batch that is never sent fails here in two seconds
 * rather than when the suite's clock runs out.
 */

const authorSchema = z.object({ id: z.string(), name: z.string(), publisher_id: z.number() });
const publisherSchema = z.object({ id: z.string(), name: z.string() });
const problemSchema = z.object({ message: z.string() });

function call(overrides: Partial<CallRuntime> & Pick<CallRuntime, "operationId">): CallRuntime {
	return {
		kind: "link",
		authentication: "none",
		security: [],
		input: z.looseObject({}),
		arms: [],
		bound: [],
		supplied: {},
		projection: {},
		connection: undefined,
		args: {},
		...overrides,
	};
}

interface Context {
	readonly verdict?: "allow" | "unauthenticated";
}

/** Every batch call made, as the ids each carried. */
let calls: { readonly operationId: string; readonly ids: readonly string[] }[];
/** How each batch answers: every id it knows, a 404 for the chunk if one is unknown, or a failure. */
let mode: "omit" | "atomic" | "fail" | "duplicates";
let books: readonly Readonly<Record<string, unknown>>[];

/** Each author's publisher, by a number the batch read takes as a string. */
const AUTHORS: Readonly<Record<string, number>> = Object.fromEntries(
	Array.from({ length: 130 }, (_, index) => [`a-${index + 1}`, (index % 3) + 1]),
);

function answer(operationId: string, ids: readonly string[], known: (id: string) => unknown) {
	calls.push({ operationId, ids });
	if (mode === "fail") throw new Error(`${operationId} is down`);
	const found = ids.filter((id) => known(id) !== undefined);
	if (mode === "atomic" && found.length < ids.length) {
		return { status: 404, body: { message: "not every id was found" } };
	}
	const items = found.map((id) => known(id));
	// Each item answered a second time, after the first, under another name.
	const again = items.map((item) => ({ ...(item as object), name: "answered again" }));
	return { status: 200, items: mode === "duplicates" ? [...items, ...again] : items };
}

function handlersFor(): object {
	return {
		Authors_batchGet: (_ctx: unknown, { ids }: { readonly ids: readonly string[] }) => {
			const result = answer("Authors_batchGet", ids, (id) => {
				const publisher = AUTHORS[id];
				return publisher === undefined
					? undefined
					: { id, name: `name ${id}`, publisher_id: publisher };
			});
			return "items" in result ? { status: 200, body: { authors: result.items } } : result;
		},
		Publishers_batchGet: (_ctx: unknown, { ids }: { readonly ids: readonly string[] }) => {
			const result = answer("Publishers_batchGet", ids, (id) => ({ id, name: `house ${id}` }));
			return "items" in result ? { status: 200, body: result.items } : result;
		},
		Books_touch: (_ctx: unknown, { id }: { readonly id: string }) => ({
			status: 200,
			body: books.find((book) => book["id"] === id),
		}),
		...Object.fromEntries(
			["Authors_one", "Authors_zero", "Authors_byShop"].map((operationId) => [
				operationId,
				(_ctx: unknown, input: { readonly ids: readonly string[]; readonly shop?: string }) => {
					if (input.shop !== undefined) shops.push(input.shop);
					const result = answer(operationId, input.ids, (id) =>
						AUTHORS[id] === undefined ? undefined : { id, name: `name ${id}` },
					);
					return "items" in result ? { status: 200, body: result.items } : result;
				},
			]),
		),
		// An answer holding what is no item: a null, a string, and an object with no key.
		Authors_messy: (_ctx: unknown, { ids }: { readonly ids: readonly string[] }) => {
			calls.push({ operationId: "Authors_messy", ids });
			return {
				status: 200,
				body: [null, "a-1", { name: "no key" }, ...ids.map((id) => ({ id, name: `name ${id}` }))],
			};
		},
	};
}

/** Every `shop` a batch read by shop was sent. */
let shops: string[];

/** A batched link to `operationId`, its answer the list itself, of the items' `id`s. */
const batchOf = (
	operationId: string,
	bound: CallRuntime["bound"],
	size: number | undefined,
	item: z.ZodType = z.object({ id: z.string(), name: z.string() }),
) =>
	resolverFor(
		call({
			operationId,
			input: z.looseObject({
				ids: z.array(z.string()),
				shop: z
					.string()
					.regex(/^[a-z]+$/)
					.exactOptional(),
				tags: z.array(z.string().regex(/^[a-z]+$/)).exactOptional(),
			}),
			arms: [{ status: 200, schema: z.array(item) }],
			bound,
			batch: { wire: "ids", key: "id", size },
			projection: { "200": { as: "value" } },
		}),
		handlersFor,
		deps,
		{},
	);

const deps: GraphQLDeps<Context, string> = {
	// A context may be no object at all: null, a string.
	authorize: (context) => (context as Context | null)?.verdict ?? "allow",
	context: () => "caller",
};

const authorsBatch = (bound: CallRuntime["bound"]) =>
	resolverFor(
		call({
			operationId: "Authors_batchGet",
			input: z.looseObject({ ids: z.array(z.string().regex(/^a-[0-9]+$/)).max(50) }),
			arms: [
				{ status: 200, schema: z.object({ authors: z.array(authorSchema) }) },
				{ status: 404, schema: problemSchema },
			],
			bound,
			batch: { wire: "ids", key: "id", items: "authors", size: 50 },
			projection: { "200": { as: "value" }, "404": { as: "null" } },
		}),
		handlersFor,
		deps,
		{},
	);

const Publisher = new GraphQLObjectType({
	name: "Publisher",
	fields: { id: { type: new GraphQLNonNull(GraphQLString) }, name: { type: GraphQLString } },
});

const Author = new GraphQLObjectType({
	name: "Author",
	fields: {
		id: { type: new GraphQLNonNull(GraphQLString) },
		name: { type: GraphQLString },
		publisher: {
			type: Publisher,
			resolve: resolverFor(
				call({
					operationId: "Publishers_batchGet",
					input: z.looseObject({ ids: z.array(z.coerce.string()) }),
					arms: [{ status: 200, schema: z.array(publisherSchema) }],
					bound: [{ wire: "ids", parent: "publisher_id" }],
					batch: { wire: "ids", key: "id", items: undefined, size: undefined },
					projection: { "200": { as: "value" } },
				}),
				handlersFor,
				deps,
				{},
			),
		},
	},
});

const Book = new GraphQLObjectType({
	name: "Book",
	fields: {
		id: { type: new GraphQLNonNull(GraphQLString) },
		author: { type: Author, resolve: authorsBatch([{ wire: "ids", parent: "author_id" }]) },
		authors: {
			type: new GraphQLList(Author),
			resolve: authorsBatch([{ wire: "ids", parent: "author_ids", list: true }]),
		},
		publisher: {
			type: Publisher,
			resolve: resolverFor(
				call({
					operationId: "Publishers_batchGet",
					input: z.looseObject({ ids: z.array(z.coerce.string()) }),
					arms: [{ status: 200, schema: z.array(publisherSchema) }],
					bound: [{ wire: "ids", parent: "publisher_id" }],
					batch: { wire: "ids", key: "id" },
					projection: { "200": { as: "value" } },
				}),
				handlersFor,
				deps,
				{},
			),
		},
		oneByOne: {
			type: Author,
			resolve: batchOf("Authors_one", [{ wire: "ids", parent: "author_id" }], 1),
		},
		allAtOnce: {
			type: Author,
			resolve: batchOf("Authors_zero", [{ wire: "ids", parent: "author_id" }], 0),
		},
		taggedAuthor: {
			type: Author,
			args: { tags: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) } },
			resolve: batchOf("Authors_byShop", [{ wire: "ids", parent: "author_id" }], undefined),
		},
		shopAuthor: {
			type: Author,
			resolve: batchOf(
				"Authors_byShop",
				[
					{ wire: "shop", parent: "shop_id" },
					{ wire: "ids", parent: "author_id" },
				],
				undefined,
			),
		},
		messyAuthor: {
			type: Author,
			resolve: batchOf(
				"Authors_messy",
				[{ wire: "ids", parent: "author_id" }],
				undefined,
				z.unknown(),
			),
		},
	},
});

/** Settles after `hops` microtasks, as a handler awaiting cached work does. */
async function afterHops<T>(hops: number, value: T): Promise<T> {
	let settled = Promise.resolve(value);
	for (let hop = 0; hop < hops; hop += 1) settled = settled.then((v) => v);
	return settled;
}

const touch = resolverFor(
	call({
		kind: "mutation",
		operationId: "Books_touch",
		input: z.looseObject({ id: z.string() }),
		arms: [{ status: 200, schema: z.looseObject({ id: z.string() }) }],
		projection: { "200": { as: "value" } },
		args: {},
	}),
	handlersFor,
	deps,
	{},
);

const schema = new GraphQLSchema({
	query: new GraphQLObjectType({
		name: "Query",
		fields: {
			books: { type: new GraphQLList(Book), resolve: () => books },
			early: { type: new GraphQLList(Book), resolve: () => afterHops(1, books.slice(0, 1)) },
			late: { type: new GraphQLList(Book), resolve: () => afterHops(20, books.slice(1, 2)) },
			timed: {
				type: new GraphQLList(Book),
				resolve: () =>
					new Promise((resolve) => {
						setTimeout(() => resolve(books.slice(1, 2)), 10);
					}),
			},
			// The first book again, behind a timer: a later wave asking for a value already answered.
			again: {
				type: new GraphQLList(Book),
				resolve: () =>
					new Promise((resolve) => {
						setTimeout(() => resolve(books.slice(0, 1)), 10);
					}),
			},
		},
	}),
	mutation: new GraphQLObjectType({
		name: "Mutation",
		fields: {
			touchBook: {
				type: Book,
				args: { id: { type: new GraphQLNonNull(GraphQLString) } },
				resolve: touch,
			},
		},
	}),
});

/** One document, against a deadline: a batch never sent fails the test, not the suite's clock. */
async function run(source: string, contextValue: unknown = {}): Promise<ExecutionResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("the document did not settle in 2s")), 2_000);
	});
	try {
		return await Promise.race([
			Promise.resolve(graphql({ schema, source, contextValue })),
			deadline,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The issues of a document's first error, which must carry them. */
function issuesOf(
	result: ExecutionResult,
): readonly { readonly path: unknown; readonly wirePath: unknown }[] {
	const issues = result.errors?.[0]?.extensions["issues"];
	if (!Array.isArray(issues)) throw new Error("the document's first error carries no issues");
	return issues as readonly { readonly path: unknown; readonly wirePath: unknown }[];
}

const book = (index: number, author: string | null): Readonly<Record<string, unknown>> => ({
	id: `b-${index}`,
	author_id: author,
});

beforeEach(() => {
	calls = [];
	shops = [];
	mode = "omit";
	books = [book(1, "a-1"), book(2, "a-2"), book(3, "a-1")];
});

describe("a batched link", () => {
	it("calls the batch once for every parent of a wave, with each distinct value once", async () => {
		books = Array.from({ length: 50 }, (_, index) => book(index + 1, `a-${index + 1}`));
		const result = await run("{ books { author { id } } }");
		expect(result.errors).toBeUndefined();
		expect(result.data?.["books"]).toEqual(
			books.map((parent) => ({ author: { id: parent["author_id"] } })),
		);
		expect(calls).toEqual([
			{ operationId: "Authors_batchGet", ids: books.map((parent) => parent["author_id"]) },
		]);
	});

	it("sends a value two parents share once, and answers both", async () => {
		const result = await run("{ books { author { id name } } }");
		expect(result).toEqual({
			data: {
				books: [
					{ author: { id: "a-1", name: "name a-1" } },
					{ author: { id: "a-2", name: "name a-2" } },
					{ author: { id: "a-1", name: "name a-1" } },
				],
			},
		});
		expect(calls).toEqual([{ operationId: "Authors_batchGet", ids: ["a-1", "a-2"] }]);
	});

	it("batches each level of a document once: books' authors, then the authors' publishers", async () => {
		const result = await run("{ books { author { publisher { id name } } } }");
		expect(result.errors).toBeUndefined();
		expect(calls.map((made) => made.operationId)).toEqual([
			"Authors_batchGet",
			"Publishers_batchGet",
		]);
		expect(calls[1]?.ids).toEqual(["1", "2"]);
		expect(result.data?.["books"]).toEqual([
			{ author: { publisher: { id: "1", name: "house 1" } } },
			{ author: { publisher: { id: "2", name: "house 2" } } },
			{ author: { publisher: { id: "1", name: "house 1" } } },
		]);
	});

	it("waits for every resolver of a wave, however many microtasks its parent took", async () => {
		const result = await run("{ early { author { id } } late { author { id } } }");
		expect(result.errors).toBeUndefined();
		expect(calls).toEqual([{ operationId: "Authors_batchGet", ids: ["a-1", "a-2"] }]);
	});

	it("does not wait for a parent that waits on a timer: that is the next wave", async () => {
		const result = await run("{ early { author { id } } timed { author { id } } }");
		expect(result.errors).toBeUndefined();
		expect(calls).toEqual([
			{ operationId: "Authors_batchGet", ids: ["a-1"] },
			{ operationId: "Authors_batchGet", ids: ["a-2"] },
		]);
	});

	it("sends no more values in one call than the batch parameter's @maxItems", async () => {
		books = Array.from({ length: 120 }, (_, index) => book(index + 1, `a-${index + 1}`));
		const result = await run("{ books { author { id } } }");
		expect(result.errors).toBeUndefined();
		expect(calls.map((made) => made.ids.length)).toEqual([50, 50, 20]);
		expect(calls.flatMap((made) => made.ids)).toEqual(books.map((parent) => parent["author_id"]));
	});

	it("answers null for a value the batch answers no item for, and for an absent value, uncalled", async () => {
		books = [book(1, "a-1"), book(2, "a-999"), book(3, null)];
		const result = await run("{ books { author { id } } }");
		expect(result).toEqual({
			data: { books: [{ author: { id: "a-1" } }, { author: null }, { author: null }] },
		});
		expect(calls).toEqual([{ operationId: "Authors_batchGet", ids: ["a-1", "a-999"] }]);
	});

	it("takes the first item a key matches, where the batch answers it twice", async () => {
		mode = "duplicates";
		const result = await run("{ books { author { name } } }");
		expect(result).toEqual({
			data: {
				books: [
					{ author: { name: "name a-1" } },
					{ author: { name: "name a-2" } },
					{ author: { name: "name a-1" } },
				],
			},
		});
		expect(calls).toHaveLength(1);
	});

	it("retries one value at a time a chunk the batch answers 404, so one missing id blanks nothing else", async () => {
		mode = "atomic";
		books = [book(1, "a-1"), book(2, "a-999"), book(3, "a-2")];
		const result = await run("{ books { author { id } } }");
		expect(result).toEqual({
			data: { books: [{ author: { id: "a-1" } }, { author: null }, { author: { id: "a-2" } }] },
		});
		expect(calls.map((made) => made.ids)).toEqual([
			["a-1", "a-999", "a-2"],
			["a-1"],
			["a-999"],
			["a-2"],
		]);
	});

	it("refuses a value its parameter refuses as that field's BAD_USER_INPUT, and sends the rest", async () => {
		books = [book(1, "a-1"), book(2, "not-an-author"), book(3, "a-2")];
		const result = await run("{ books { author { id } } }");
		expect(result.data).toEqual({
			books: [{ author: { id: "a-1" } }, { author: null }, { author: { id: "a-2" } }],
		});
		expect(result.errors?.map((error) => [error.extensions["code"], error.path])).toEqual([
			["BAD_USER_INPUT", ["books", 1, "author"]],
		]);
		expect(calls).toEqual([{ operationId: "Authors_batchGet", ids: ["a-1", "a-2"] }]);
	});

	it("answers UNAUTHENTICATED before it checks any value", async () => {
		books = [book(1, "a-1"), book(2, "not-an-author")];
		const result = await run("{ books { author { id } } }", { verdict: "unauthenticated" });
		expect(result.errors?.map((error) => [error.extensions["code"], error.path])).toEqual([
			["UNAUTHENTICATED", ["books", 0, "author"]],
			["UNAUTHENTICATED", ["books", 1, "author"]],
		]);
		expect(calls).toEqual([]);
	});

	it("answers a failed batch as every waiting field's error", async () => {
		mode = "fail";
		const result = await run("{ books { id author { id } } }");
		expect(result.data).toEqual({
			books: [
				{ id: "b-1", author: null },
				{ id: "b-2", author: null },
				{ id: "b-3", author: null },
			],
		});
		// In the order each value's fields settle, not the order of the list.
		const errors = result.errors?.map((error) => [error.message, error.path] as const);
		expect(errors?.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
			["Authors_batchGet is down", ["books", 0, "author"]],
			["Authors_batchGet is down", ["books", 1, "author"]],
			["Authors_batchGet is down", ["books", 2, "author"]],
		]);
		expect(calls).toHaveLength(1);
	});

	it("matches an item by its key against the value as the parameter parsed it", async () => {
		books = [{ id: "b-1", author_id: "a-1" }];
		const result = await run("{ books { author { publisher { id } } } }");
		expect(result.errors).toBeUndefined();
		// The author's publisher is the number 1, which the parameter parses to the key "1".
		expect(result.data?.["books"]).toEqual([{ author: { publisher: { id: "1" } } }]);
	});

	it("forgets what a request read when a mutation starts, its queue included", async () => {
		const result = await run(
			`mutation { first: touchBook(id: "b-1") { author { id } } second: touchBook(id: "b-3") { author { id } } }`,
		);
		expect(result.errors).toBeUndefined();
		expect(calls).toEqual([
			{ operationId: "Authors_batchGet", ids: ["a-1"] },
			{ operationId: "Authors_batchGet", ids: ["a-1"] },
		]);
	});

	it("calls once per value where the context is no object, with no memo to batch in", async () => {
		const result = await run("{ books { author { id } } }", "anonymous");
		expect(result.errors).toBeUndefined();
		expect(calls.map((made) => made.ids)).toEqual([["a-1"], ["a-2"], ["a-1"]]);
	});
});

describe("a batch's calls", () => {
	it("send one value at a time where the batch parameter takes one", async () => {
		const result = await run("{ books { oneByOne { id } } }");
		expect(result.errors).toBeUndefined();
		expect(calls).toEqual([
			{ operationId: "Authors_one", ids: ["a-1"] },
			{ operationId: "Authors_one", ids: ["a-2"] },
		]);
	});

	it("send every value at once where the batch parameter states no positive size", async () => {
		const result = await run("{ books { allAtOnce { id } } }");
		expect(result.errors).toBeUndefined();
		expect(calls).toEqual([{ operationId: "Authors_zero", ids: ["a-1", "a-2"] }]);
	});

	it("are one per operation in a wave, two batch reads reached at once each sent apart", async () => {
		books = [{ id: "b-1", author_id: "a-1", publisher_id: 2 }];
		const result = await run("{ books { author { id } publisher { id } } }");
		expect(result.errors).toBeUndefined();
		expect(calls.map((made) => made.operationId).toSorted()).toEqual([
			"Authors_batchGet",
			"Publishers_batchGet",
		]);
	});

	it("are one per value of every other input, each sending it", async () => {
		books = [
			{ id: "b-1", author_id: "a-1", shop_id: "north" },
			{ id: "b-2", author_id: "a-2", shop_id: "south" },
			{ id: "b-3", author_id: "a-3", shop_id: "north" },
		];
		const result = await run("{ books { shopAuthor { id } } }");
		expect(result.data?.["books"]).toEqual([
			{ shopAuthor: { id: "a-1" } },
			{ shopAuthor: { id: "a-2" } },
			{ shopAuthor: { id: "a-3" } },
		]);
		expect(calls).toEqual([
			{ operationId: "Authors_byShop", ids: ["a-1", "a-3"] },
			{ operationId: "Authors_byShop", ids: ["a-2"] },
		]);
		expect(shops).toEqual(["north", "south"]);
	});

	it("refuse an input other than the values where it is the input that is wrong, at its own key", async () => {
		books = [{ id: "b-1", author_id: "a-1", shop_id: "North!" }];
		const result = await run("{ books { shopAuthor { id } } }");
		const [error] = result.errors ?? [];
		expect(error?.extensions["code"]).toBe("BAD_USER_INPUT");
		expect(issuesOf(result).map(({ path }) => path)).toEqual([["shop"]]);
		expect(calls).toEqual([]);
	});

	it("refuse a list argument's item at its own index, not as the batch's value", async () => {
		books = [book(1, "a-1")];
		const result = await run('{ books { taggedAuthor(tags: ["Bad!"]) { id } } }');
		expect(issuesOf(result).map(({ wirePath }) => wirePath)).toEqual([["tags", 0]]);
		expect(calls).toEqual([]);
	});

	it("answer a value a later wave asks for again from the memo", async () => {
		const result = await run("{ books { author { id } } again { author { id } } }");
		expect(result.errors).toBeUndefined();
		expect(calls).toEqual([{ operationId: "Authors_batchGet", ids: ["a-1", "a-2"] }]);
	});

	it("pass over what in an answer is no item with a key", async () => {
		const result = await run("{ books { messyAuthor { id } } }");
		expect(result.data?.["books"]).toEqual([
			{ messyAuthor: { id: "a-1" } },
			{ messyAuthor: { id: "a-2" } },
			{ messyAuthor: { id: "a-1" } },
		]);
	});

	it("refuse a value alone, at the bound key and in the operation's words", async () => {
		books = [book(1, "not-an-author")];
		const result = await run("{ books { author { id } } }");
		const [error] = result.errors ?? [];
		expect(error?.message).toBe("The input to Authors_batchGet is not valid");
		expect(issuesOf(result).map(({ path, wirePath }) => ({ path, wirePath }))).toEqual([
			{ path: ["ids"], wirePath: ["ids"] },
		]);
	});
});

describe("a batch's wave", () => {
	const { setImmediate: immediate, setTimeout: timeout } = globalThis;

	it("is awaited with setImmediate where the runtime has it", async () => {
		let used = 0;
		globalThis.setImmediate = ((run: () => void) => {
			used += 1;
			return immediate(run);
		}) as typeof setImmediate;
		try {
			const result = await run("{ books { author { id } } }");
			expect(result.errors).toBeUndefined();
		} finally {
			globalThis.setImmediate = immediate;
		}
		expect(used).toBe(1);
	});

	it("is awaited with setTimeout where there is no setImmediate, as on Workers", async () => {
		let used = 0;
		Reflect.deleteProperty(globalThis, "setImmediate");
		globalThis.setTimeout = ((run: () => void, delay?: number) => {
			if (delay === 0) used += 1;
			return timeout(run, delay);
		}) as typeof setTimeout;
		try {
			const result = await run("{ books { author { id } } }");
			expect(result.errors).toBeUndefined();
		} finally {
			globalThis.setImmediate = immediate;
			globalThis.setTimeout = timeout;
		}
		expect(used).toBe(1);
		expect(calls).toEqual([{ operationId: "Authors_batchGet", ids: ["a-1", "a-2"] }]);
	});

	it("is still sent, on a microtask, where the runtime has neither", async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = timeout(() => reject(new Error("no batch was sent")), 2_000);
		});
		Reflect.deleteProperty(globalThis, "setImmediate");
		Reflect.deleteProperty(globalThis, "setTimeout");
		try {
			const result = await Promise.race([
				Promise.resolve(
					graphql({ schema, source: "{ books { author { id } } }", contextValue: {} }),
				),
				deadline,
			]);
			expect(result.errors).toBeUndefined();
		} finally {
			globalThis.setImmediate = immediate;
			globalThis.setTimeout = timeout;
			clearTimeout(timer);
		}
		expect(calls.flatMap((made) => made.ids).toSorted()).toEqual(["a-1", "a-2"]);
	});
});

describe("a batch's context", () => {
	it("batches on a context value that is a function, as on any object", async () => {
		const result = await run("{ books { author { id } } }", () => undefined);
		expect(result.errors).toBeUndefined();
		expect(calls).toEqual([{ operationId: "Authors_batchGet", ids: ["a-1", "a-2"] }]);
	});

	it("calls once per value where the context is null", async () => {
		const result = await run("{ books { author { id } } }", null);
		expect(result.errors).toBeUndefined();
		expect(calls.map((made) => made.ids)).toEqual([["a-1"], ["a-2"], ["a-1"]]);
	});
});

describe("a batched link bound to a list", () => {
	it("sends every parent's values in one batch, each list answered in its order", async () => {
		books = [
			{ id: "b-1", author_ids: ["a-1", "a-2"] },
			{ id: "b-2", author_ids: ["a-2", null, "a-3"] },
			{ id: "b-3", author_ids: null },
		];
		const result = await run("{ books { authors { id } } }");
		expect(result).toEqual({
			data: {
				books: [
					{ authors: [{ id: "a-1" }, { id: "a-2" }] },
					{ authors: [{ id: "a-2" }, null, { id: "a-3" }] },
					{ authors: null },
				],
			},
		});
		expect(calls).toEqual([{ operationId: "Authors_batchGet", ids: ["a-1", "a-2", "a-3"] }]);
	});
});
