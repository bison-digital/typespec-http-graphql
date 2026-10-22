import {
	type ExecutionResult,
	graphql,
	GraphQLBoolean,
	GraphQLError,
	GraphQLInputObjectType,
	GraphQLInt,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
	type GraphQLResolveInfo,
	GraphQLSchema,
	GraphQLString,
	GraphQLUnionType,
} from "graphql";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type CallRuntime,
	type GraphQLDeps,
	memberTypeOf,
	ResponseContractError,
	resolverFor,
	InputAssemblyError,
	type InputRules,
	SCALARS,
	UndeclaredStatusError,
	UnprojectedStatusError,
	wireField,
} from "../../src/runtime.js";

/**
 * **The resolver pipeline, through graphql-js's own executor, against a hand-built schema.**
 *
 * No emitter is involved: the schema below is what `graphql.gen.ts` would build, written by hand, so
 * every rule here is the runtime's alone. The handlers count their calls, because several of these
 * rules are about calls that must NOT happen as much as about values.
 */

// The contract, as schemas.gen.ts would declare it.
const bookSchema = z.object({
	id: z.string(),
	title: z.string(),
	author_id: z.string().nullable().exactOptional(),
	created_at: z.string(),
});
const authorSchema = z.object({ id: z.string(), name: z.string() });
const pageSchema = z.object({
	items: z.array(bookSchema),
	next_token: z.string().exactOptional(),
});
const problemSchema = z.object({ message: z.string() });

const readInput = z.looseObject({ id: z.string() });
const listInput = z.looseObject({
	"page-size": z.int32().max(50).default(20),
	"page-token": z.string().exactOptional(),
	tag: z.string().nullable().exactOptional(),
});
const authorInput = z.looseObject({ authorId: z.string() });
const pingInput = z.strictObject({});
/** Sealed, as under `seal-object-schemas`, so the supplied `accept` must be declared to pass. */
const createInput = z.strictObject({
	"x-api-version": z.string(),
	title: z.string().min(1),
	author_id: z.string().exactOptional(),
	note: z.string().nullable().exactOptional(),
	labels: z.array(z.object({ display_name: z.string() })).exactOptional(),
	accept: z.literal("application/json"),
});

const BEARER = [{ BearerAuth: [] }] as const;

function call(overrides: Partial<CallRuntime> & Pick<CallRuntime, "operationId">): CallRuntime {
	return {
		kind: "query",
		authentication: "required",
		security: BEARER,
		input: pingInput,
		arms: [],
		bound: [],
		supplied: {},
		projection: {},
		connection: undefined,
		args: {},
		...overrides,
	};
}

/**
 * The `INPUT_RULES` `graphql.gen.ts` would write for the input types below: the wire mapping is code,
 * handed to every resolver, never the schema's `extensions`.
 */
const RULES: InputRules = {
	LabelInput: { displayName: { wire: "display_name" } },
	CreateBookInput: {
		xApiVersion: { wire: "x-api-version" },
		authorId: { wire: "author_id", dropNull: true },
		labels: { dropNull: true },
	},
};

interface Context {
	readonly caller: string | null;
	readonly verdict?: "allow" | "unauthenticated" | "forbidden";
}

/** What each handler answers next, every call each received, and every gate consulted. */
let next: Record<string, (input: Record<string, unknown>) => unknown>;
let calls: { operationId: string; ctx: unknown; input: Record<string, unknown> }[];
let authorized: unknown[];

/** How many handler objects `handlersFor` has built. */
let built = 0;

function handlersFor(_context: Context): object {
	built += 1;
	const handler = (operationId: string) => (ctx: unknown, input: Record<string, unknown>) => {
		calls.push({ operationId, ctx, input });
		const answer = next[operationId];
		if (answer === undefined) throw new Error(`unexpected call to ${operationId}`);
		return answer(input);
	};
	return {
		Books_read: handler("Books_read"),
		Books_list: handler("Books_list"),
		Books_create: handler("Books_create"),
		Authors_read: handler("Authors_read"),
		ping: handler("ping"),
		Notes_annotate: handler("Notes_annotate"),
		Notes_lookup: handler("Notes_lookup"),
		Notes_rename: handler("Notes_rename"),
		Notes_patch: handler("Notes_patch"),
		Outcomes_answer: handler("Outcomes_answer"),
		Outcomes_refuse: handler("Outcomes_refuse"),
		Filters_find: handler("Filters_find"),
		Filters_make: handler("Filters_make"),
	};
}

const deps: GraphQLDeps<Context, string> = {
	authorize: (context, requirements) => {
		authorized.push(requirements);
		return context.verdict ?? "allow";
	},
	context: (context) => context.caller,
};

const Author = new GraphQLObjectType({
	name: "Author",
	fields: {
		id: { type: new GraphQLNonNull(GraphQLString) },
		name: { type: new GraphQLNonNull(GraphQLString) },
	},
});

const Book: GraphQLObjectType = new GraphQLObjectType({
	name: "Book",
	fields: () => ({
		id: { type: new GraphQLNonNull(GraphQLString) },
		title: { type: new GraphQLNonNull(GraphQLString) },
		createdAt: { type: new GraphQLNonNull(GraphQLString), resolve: wireField("created_at") },
		author: {
			type: Author,
			resolve: resolverFor(
				call({
					kind: "link",
					operationId: "Authors_read",
					input: authorInput,
					arms: [
						{ status: 200, schema: authorSchema },
						{ status: 404, schema: problemSchema },
					],
					bound: [{ wire: "authorId", parent: "author_id" }],
					projection: { "200": { as: "value" }, "404": { as: "null" } },
				}),
				handlersFor,
				deps,
				RULES,
			),
		},
	}),
});

const PageInfo = new GraphQLObjectType({
	name: "PageInfo",
	fields: {
		hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
		hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
		startCursor: { type: GraphQLString },
		endCursor: { type: GraphQLString },
	},
});
const BookEdge = new GraphQLObjectType({
	name: "BookEdge",
	fields: { node: { type: new GraphQLNonNull(Book) }, cursor: { type: GraphQLString } },
});
const BookConnection = new GraphQLObjectType({
	name: "BookConnection",
	fields: {
		edges: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(BookEdge))) },
		nodes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Book))) },
		pageInfo: { type: new GraphQLNonNull(PageInfo) },
	},
});

const Conflict = new GraphQLObjectType({
	name: "Conflict",
	fields: { message: { type: new GraphQLNonNull(GraphQLString) } },
});
const CreateBookNoContent = new GraphQLObjectType({
	name: "CreateBookNoContent",
	fields: { success: { type: new GraphQLNonNull(GraphQLBoolean) } },
});
const CreateBookResult = new GraphQLUnionType({
	name: "CreateBookResult",
	types: [Book, Conflict, CreateBookNoContent],
	resolveType: memberTypeOf,
});

const LabelInput = new GraphQLInputObjectType({
	name: "LabelInput",
	fields: {
		displayName: { type: new GraphQLNonNull(GraphQLString) },
	},
});
const CreateBookInput = new GraphQLInputObjectType({
	name: "CreateBookInput",
	fields: {
		xApiVersion: { type: new GraphQLNonNull(GraphQLString) },
		title: { type: new GraphQLNonNull(GraphQLString) },
		authorId: { type: GraphQLString },
		note: { type: GraphQLString },
		labels: { type: new GraphQLList(new GraphQLNonNull(LabelInput)) },
	},
});

const schema = new GraphQLSchema({
	query: new GraphQLObjectType({
		name: "Query",
		fields: {
			book: {
				type: Book,
				args: { id: { type: new GraphQLNonNull(GraphQLString) } },
				resolve: resolverFor(
					call({
						operationId: "Books_read",
						input: readInput,
						arms: [
							{ status: 200, schema: bookSchema },
							{ status: 404, schema: problemSchema },
							{ status: 400, schema: problemSchema },
						],
						projection: {
							"200": { as: "value" },
							"404": { as: "null" },
							"400": { as: "error", code: "BAD_USER_INPUT" },
						},
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
			unboundedBooks: {
				type: BookConnection,
				args: { first: { type: GraphQLInt }, after: { type: GraphQLString } },
				resolve: resolverFor(
					call({
						operationId: "Books_list",
						input: z.looseObject({
							"page-size": z.int32().default(20),
							"page-token": z.string().exactOptional(),
						}),
						arms: [{ status: 200, schema: pageSchema }],
						projection: { "200": { as: "connection" } },
						args: {
							first: { wire: "page-size", dropNull: true },
							after: { wire: "page-token", dropNull: true },
						},
						// A page size with no `@maxValue`: a resume asks for all it skips, unbounded.
						connection: {
							items: "items",
							next: "next_token",
							first: "page-size",
							after: "page-token",
						},
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
			books: {
				type: BookConnection,
				args: {
					first: { type: GraphQLInt },
					after: { type: GraphQLString },
					// `| null` in TypeSpec: an explicit null is a value, so it reaches the request schema.
					tag: { type: GraphQLString },
				},
				resolve: resolverFor(
					call({
						operationId: "Books_list",
						input: listInput,
						arms: [{ status: 200, schema: pageSchema }],
						projection: { "200": { as: "connection" } },
						args: {
							first: { wire: "page-size", dropNull: true },
							after: { wire: "page-token", dropNull: true },
						},
						connection: {
							items: "items",
							next: "next_token",
							first: "page-size",
							after: "page-token",
							// `listInput`'s `page-size` bound, as the plan reads it from `@maxValue(50)`.
							maximum: 50,
						},
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
			ping: {
				type: GraphQLBoolean,
				resolve: resolverFor(
					call({
						operationId: "ping",
						authentication: "none",
						security: [],
						arms: [{ status: 204, schema: undefined }],
						projection: { "204": { as: "true" } },
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
		},
	}),
	mutation: new GraphQLObjectType({
		name: "Mutation",
		fields: {
			createBook: {
				type: CreateBookResult,
				args: {
					input: { type: new GraphQLNonNull(CreateBookInput) },
				},
				resolve: resolverFor(
					call({
						kind: "mutation",
						operationId: "Books_create",
						input: createInput,
						args: { input: { merge: true } },
						arms: [
							{ status: 201, schema: bookSchema },
							{ status: 204, schema: undefined },
							{ status: 302, schema: undefined },
							{ status: 409, schema: problemSchema },
							{
								status: 429,
								schema: problemSchema,
								headers: [{ name: "retry-after", optional: true }],
							},
							{ status: "5XX", schema: problemSchema },
						],
						supplied: { accept: "application/json" },
						projection: {
							"201": { as: "member", type: "Book" },
							"204": { as: "wrap", type: "CreateBookNoContent", hasBody: false },
							"409": { as: "member", type: "Conflict" },
							"429": { as: "error", code: "RATE_LIMITED" },
							"5XX": { as: "error", code: "INTERNAL_SERVER_ERROR" },
						},
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
		},
	}),
});

/**
 * A fresh context object per request, as a server creates one: the memo is keyed on it, so reusing
 * one object across requests would answer a later request from an earlier one's calls.
 */
async function run(
	source: string,
	context: Context = { caller: "alice" },
	variableValues?: Record<string, unknown>,
): Promise<ExecutionResult> {
	return graphql({ schema, source, contextValue: context, variableValues });
}

const book = (id: string, authorId: string | null | undefined) => ({
	id,
	title: `title ${id}`,
	...(authorId === undefined ? {} : { author_id: authorId }),
	created_at: "2026-10-13T00:00:00Z",
});

/** The paths of the Zod issues a BAD_USER_INPUT error carries. */
/** Each issue's path as the client wrote it, and as the handler's input (the REST route) holds it. */
function issuePaths(result: ExecutionResult): unknown[] {
	const issues = result.errors?.[0]?.extensions["issues"];
	return Array.isArray(issues)
		? issues.map((issue: { readonly path: unknown; readonly wirePath: unknown }) => [
				issue.path,
				issue.wirePath,
			])
		: [];
}

function callsTo(operationId: string): number {
	return calls.filter((c) => c.operationId === operationId).length;
}

beforeEach(() => {
	calls = [];
	authorized = [];
	next = {};
});

describe("a root query field", () => {
	it("answers the parsed body, reading a wire key back under its GraphQL name", async () => {
		next["Books_read"] = (input) => ({
			status: 200,
			body: book(String(input["id"]), "t1"),
		});
		const result = await run(`{ book(id: "c1") { id createdAt } }`);
		expect(result).toEqual({
			data: { book: { id: "c1", createdAt: "2026-10-13T00:00:00Z" } },
		});
		expect(calls).toEqual([{ operationId: "Books_read", ctx: "alice", input: { id: "c1" } }]);
		expect(authorized).toEqual([BEARER]);
	});

	it("answers null for a declared 404", async () => {
		next["Books_read"] = () => ({ status: 404, body: { message: "gone" } });
		expect(await run(`{ book(id: "c1") { id } }`)).toEqual({
			data: { book: null },
		});
	});

	it("answers a declared 400 as a top-level BAD_USER_INPUT carrying status and parsed body", async () => {
		next["Books_read"] = () => ({
			status: 400,
			body: { message: "bad id", internal: 1 },
		});
		const result = await run(`{ book(id: "c1") { id } }`);
		expect(result.data).toEqual({ book: null });
		// Strictly: the arm declares no Retry-After, so there is no `retryAfter` key at all.
		expect(result.errors?.map((e) => e.extensions)).toStrictEqual([
			{ code: "BAD_USER_INPUT", status: 400, body: { message: "bad id" } },
		]);
		expect(result.errors?.map((e) => e.message)).toEqual(["Books_read answered 400"]);
	});

	it("answers a bodyless success as true", async () => {
		next["ping"] = () => ({ status: 204 });
		expect(await run(`{ ping }`)).toEqual({ data: { ping: true } });
	});

	it.each([
		["nothing", undefined],
		["null", null],
		["no status", { body: { message: "m" } }],
	])("throws UndeclaredStatusError for a handler answering %s", async (_answer, answer) => {
		next["Books_read"] = () => answer;
		const result = await run(`{ book(id: "c1") { id } }`);
		expect(result.errors?.[0]?.cause).toBeInstanceOf(UndeclaredStatusError);
		expect(result.errors?.[0]?.message).toBe(
			"Books_read answered no status, which its document does not declare",
		);
	});
});

/**
 * **What a handler throws is the server's to answer**, unchanged: design.md's INTERNAL_SERVER_ERROR
 * for a throw, and a `GraphQLError` a handler chose as it chose it. Only the runtime's own
 * request-schema refusal has its issues mapped back to the arguments the client wrote.
 */
describe("a handler's own error", () => {
	const query = `{ book(id: "c1") { id } }`;

	it("reaches the server as the handler threw it, to be masked", async () => {
		const thrown = new Error("the store is down");
		next["Books_read"] = () => {
			throw thrown;
		};
		const result = await run(query);
		expect(result.errors?.[0]?.cause).toBe(thrown);
		expect(result.errors?.[0]?.extensions["code"]).toBeUndefined();
	});

	it("keeps a GraphQLError's own code and issues as the handler wrote them", async () => {
		next["Books_read"] = () => {
			throw new GraphQLError("taken", {
				extensions: { code: "CONFLICT", issues: [{ path: ["id"], message: "taken" }] },
			});
		};
		const result = await run(query);
		expect(result.errors?.map((e) => e.extensions)).toEqual([
			{ code: "CONFLICT", issues: [{ path: ["id"], message: "taken" }] },
		]);
	});

	it("keeps a BAD_USER_INPUT that carries no issues as it is", async () => {
		next["Books_read"] = () => {
			throw new GraphQLError("no such id", { extensions: { code: "BAD_USER_INPUT" } });
		};
		const result = await run(query);
		expect(result.errors?.map((e) => [e.message, e.extensions])).toEqual([
			["no such id", { code: "BAD_USER_INPUT" }],
		]);
	});
});

describe("a link", () => {
	it("calls its operation with the bound property, at the parameter's wire key", async () => {
		next["Books_read"] = () => ({ status: 200, body: book("c1", "t1") });
		next["Authors_read"] = (input) => ({
			status: 200,
			body: { id: input["authorId"], name: "Author one" },
		});
		const result = await run(`{ book(id: "c1") { author { id name } } }`);
		expect(result).toEqual({ data: { book: { author: { id: "t1", name: "Author one" } } } });
		expect(calls.find((c) => c.operationId === "Authors_read")?.input).toEqual({ authorId: "t1" });
	});

	it("is null WITHOUT calling the handler, or anything else, when the bound property is null", async () => {
		next["Books_read"] = () => ({ status: 200, body: book("c1", null) });
		const result = await run(`{ book(id: "c1") { author { id } } }`);
		expect(result).toEqual({ data: { book: { author: null } } });
		expect(callsTo("Authors_read")).toBe(0);
		expect(authorized).toHaveLength(1);
	});

	it("is null WITHOUT calling the handler when the bound property is absent", async () => {
		next["Books_read"] = () => ({ status: 200, body: book("c1", undefined) });
		const result = await run(`{ book(id: "c1") { author { id } } }`);
		expect(result).toEqual({ data: { book: { author: null } } });
		expect(callsTo("Authors_read")).toBe(0);
	});

	/** design.md's deduplication oracle. */
	it("calls once per request for 50 parents with one bound id, and once more for a second request", async () => {
		next["Books_list"] = () => ({
			status: 200,
			body: { items: Array.from({ length: 50 }, (_, i) => book(`c${i}`, "t1")) },
		});
		next["Authors_read"] = (input) => ({
			status: 200,
			body: { id: input["authorId"], name: "Author one" },
		});
		const query = `{ books { nodes { author { name } } } }`;
		const first = await run(query, { caller: "alice" });
		expect(first.errors).toBeUndefined();
		expect(callsTo("Authors_read")).toBe(1);
		const second = await run(query, { caller: "bob" });
		expect(second.errors).toBeUndefined();
		expect(callsTo("Authors_read")).toBe(2);
		// Each request's call ran as its own caller: B was not answered from A's call.
		expect(calls.filter((c) => c.operationId === "Authors_read").map((c) => c.ctx)).toEqual([
			"alice",
			"bob",
		]);
	});

	it("does not merge calls with different inputs", async () => {
		next["Books_list"] = () => ({
			status: 200,
			body: {
				items: [book("c1", "t1"), book("c2", "t2"), book("c3", "t1")],
			},
		});
		next["Authors_read"] = (input) => ({ status: 200, body: { id: input["authorId"], name: "n" } });
		await run(`{ books { nodes { author { id } } } }`);
		expect(callsTo("Authors_read")).toBe(2);
	});
});

describe("a connection", () => {
	interface Page {
		readonly edges: readonly { readonly cursor: string; readonly node: { readonly id: string } }[];
		readonly pageInfo: {
			readonly hasNextPage: boolean;
			readonly hasPreviousPage: boolean;
			readonly startCursor: string | null;
			readonly endCursor: string | null;
		};
	}
	const PAGE = `edges { cursor node { id } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor }`;
	const pageOf = (result: ExecutionResult): Page => (result.data as { books: Page }).books;
	const three = () => ({
		status: 200,
		body: {
			items: [book("c1", null), book("c2", null), book("c3", null)],
			next_token: "n2",
		},
	});

	/**
	 * relay.dev §3.1 and §5.1: every edge has a cursor, and `startCursor`/`endCursor` are the first and
	 * last edges'. A cursor is opaque, so what is asserted is what it does: the page it resumes.
	 */
	it("gives every edge a cursor, and pageInfo the first and last edges'", async () => {
		next["Books_list"] = three;
		const page = pageOf(await run(`{ books { ${PAGE} } }`));
		expect(page.edges.map((edge) => edge.node.id)).toEqual(["c1", "c2", "c3"]);
		const cursors = page.edges.map((edge) => edge.cursor);
		expect(new Set(cursors).size).toBe(3);
		expect(page.pageInfo).toEqual({
			hasNextPage: true,
			hasPreviousPage: false,
			startCursor: cursors[0],
			endCursor: cursors[2],
		});
	});

	it("resumes after the last edge at the backend's next page, and after any other edge within its own page", async () => {
		next["Books_list"] = three;
		const page = pageOf(await run(`{ books { ${PAGE} } }`));
		calls = [];
		await run(`{ books(after: "${page.pageInfo.endCursor ?? ""}") { nodes { id } } }`);
		const middle = await run(`{ books(after: "${page.edges[0]?.cursor ?? ""}") { nodes { id } } }`);
		// The first page again, with no token, its first item skipped.
		expect(calls.map((c) => c.input)).toEqual([
			{ "page-size": 20, "page-token": "n2" },
			{ "page-size": 20 },
		]);
		expect(middle.data).toEqual({ books: { nodes: [{ id: "c2" }, { id: "c3" }] } });
	});

	it("cuts a page longer than first to first, and still says a next page follows (§4.4)", async () => {
		next["Books_list"] = () => ({
			status: 200,
			body: {
				items: [book("c1", null), book("c2", null), book("c3", null)],
			},
		});
		const page = pageOf(await run(`{ books(first: 2) { ${PAGE} } }`));
		expect(page.edges.map((edge) => edge.node.id)).toEqual(["c1", "c2"]);
		expect(page.pageInfo.hasNextPage).toBe(true);
		calls = [];
		const rest = await run(
			`{ books(first: 2, after: "${page.pageInfo.endCursor ?? ""}") { nodes { id } } }`,
		);
		// The same page again, two longer to hold the two skipped, and the one item left.
		expect(calls.map((c) => c.input)).toEqual([{ "page-size": 4 }]);
		expect(rest.data).toEqual({ books: { nodes: [{ id: "c3" }] } });
	});

	/**
	 * **Any `first` the schema accepts follows any cursor the connection issued.** A backend of a
	 * hundred items that honours the page size, with the offset as its token: `first: 50` after the
	 * first edge's cursor would ask for 51, one past `@maxValue(50)`, to hold the edge it skips.
	 * Capped at the maximum, the page holds 49 items, Relay's "at most `first`", and its last edge
	 * goes on at the next page, so walking on returns every item once.
	 */
	it("resumes at the page size's maximum from a cursor partway into a page, losing and repeating nothing", async () => {
		const all = Array.from({ length: 100 }, (_, i) => book(`c${String(i + 1)}`, null));
		next["Books_list"] = (input) => {
			const start = Number(input["page-token"] ?? 0);
			const end = start + Number(input["page-size"]);
			return {
				status: 200,
				body: {
					items: all.slice(start, end),
					...(end < all.length ? { next_token: String(end) } : {}),
				},
			};
		};
		const page = pageOf(await run(`{ books(first: 3) { ${PAGE} } }`));
		calls = [];
		const resumed = await run(
			`{ books(first: 50, after: "${page.edges[0]?.cursor ?? ""}") { ${PAGE} } }`,
		);
		expect(resumed.errors).toBeUndefined();
		expect(calls.map((c) => c.input)).toEqual([{ "page-size": 50 }]);
		const short = pageOf(resumed);
		expect(short.edges.map((edge) => edge.node.id)).toEqual(
			all.slice(1, 50).map((item) => item.id),
		);
		expect(short.pageInfo.hasNextPage).toBe(true);

		const rest = pageOf(
			await run(`{ books(first: 50, after: "${short.pageInfo.endCursor ?? ""}") { ${PAGE} } }`),
		);
		expect(rest.edges.map((edge) => edge.node.id)).toEqual(all.slice(50).map((item) => item.id));
		expect(rest.pageInfo.hasNextPage).toBe(false);
	});

	it("resumes where the page size states no maximum by asking for every item it skips", async () => {
		const all = Array.from({ length: 10 }, (_, i) => book(`u${String(i + 1)}`, null));
		next["Books_list"] = (input) => {
			const start = Number(input["page-token"] ?? 0);
			const end = start + Number(input["page-size"]);
			return {
				status: 200,
				body: {
					items: all.slice(start, end),
					...(end < all.length ? { next_token: String(end) } : {}),
				},
			};
		};
		const first = await run(`{ unboundedBooks(first: 3) { ${PAGE} } }`);
		const page = first.data?.["unboundedBooks"] as
			| { readonly edges: readonly { readonly cursor: string }[] }
			| undefined;
		const cursor = page?.edges[0]?.cursor;
		calls = [];
		const resumed = await run(`{ unboundedBooks(first: 4, after: "${cursor ?? ""}") { ${PAGE} } }`);
		expect(resumed.errors).toBeUndefined();
		expect(calls.map((c) => c.input)).toEqual([{ "page-size": 5 }]);
	});

	it("refuses a first past the maximum by its own name, resuming or not", async () => {
		next["Books_list"] = three;
		const page = pageOf(await run(`{ books { ${PAGE} } }`));
		calls = [];
		const result = await run(
			`{ books(first: 51, after: "${page.edges[0]?.cursor ?? ""}") { nodes { id } } }`,
		);
		expect(result.errors?.map((e) => e.extensions["code"])).toEqual(["BAD_USER_INPUT"]);
		const issues = result.errors?.[0]?.extensions["issues"] as
			| readonly Record<string, unknown>[]
			| undefined;
		expect(issues?.map(({ code, path, wirePath }) => ({ code, path, wirePath }))).toEqual([
			{ code: "too_big", path: ["first"], wirePath: ["page-size"] },
		]);
		expect(calls).toEqual([]);
	});

	it("says there is no next page when the response carries no token, the last edge still a cursor", async () => {
		next["Books_list"] = () => ({
			status: 200,
			body: { items: [book("c1", null)] },
		});
		const page = pageOf(await run(`{ books { ${PAGE} } }`));
		expect(page.pageInfo).toEqual({
			hasNextPage: false,
			hasPreviousPage: false,
			startCursor: page.edges[0]?.cursor,
			endCursor: page.edges[0]?.cursor,
		});
	});

	it("answers an empty page with no edges, and an end cursor while the backend has a next page", async () => {
		next["Books_list"] = () => ({ status: 200, body: { items: [], next_token: "n" } });
		const page = pageOf(await run(`{ books { ${PAGE} } }`));
		expect(page.edges).toEqual([]);
		expect(page.pageInfo.hasNextPage).toBe(true);
		expect(page.pageInfo.startCursor).toBeNull();
		calls = [];
		await run(`{ books(after: "${page.pageInfo.endCursor ?? ""}") { nodes { id } } }`);
		expect(calls.map((c) => c.input)).toEqual([{ "page-size": 20, "page-token": "n" }]);
	});

	it("refuses a negative first as BAD_USER_INPUT, calling nothing (§4.4)", async () => {
		const result = await run(`{ books(first: -1) { nodes { id } } }`);
		expect(result.errors?.map((e) => [e.message, e.extensions])).toEqual([
			[
				"first must not be negative",
				{
					code: "BAD_USER_INPUT",
					issues: [
						{
							code: "too_small",
							path: ["first"],
							wirePath: ["page-size"],
							message: "Relay §4.4: first must be 0 or more",
						},
					],
				},
			],
		]);
		expect(calls).toEqual([]);
	});

	/**
	 * §4.4 refuses only a first below zero: zero asks for no edges, and the page still goes on. Its
	 * `endCursor` resumes where this page began, so the items it cut are not lost (design.md §
	 * Connections), whether or not the backend has a page after it.
	 */
	it.each([
		["a next page", three],
		["no next page", () => ({ status: 200, body: { items: three().body.items } })],
	])(
		"answers a first of zero with no edges, resuming at the items it cut, with %s",
		async (_kind, answer) => {
			next["Books_list"] = answer;
			const result = await run(`{ books(first: 0) { ${PAGE} } }`);
			expect(result.errors).toBeUndefined();
			const page = pageOf(result);
			expect(page.edges).toEqual([]);
			expect(page.pageInfo.hasNextPage).toBe(true);
			calls = [];
			const rest = await run(
				`{ books(after: "${page.pageInfo.endCursor ?? ""}") { nodes { id } } }`,
			);
			expect(calls.map((c) => c.input)).toEqual([{ "page-size": 20 }]);
			expect(rest.data).toEqual({
				books: { nodes: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] },
			});
		},
	);

	/** A null `first` is an absent page size (design.md, Arguments): the page is not sliced. */
	it("reads an explicit null first as no first, answering the page whole", async () => {
		next["Books_list"] = three;
		const result = await run(`{ books(first: null) { nodes { id } } }`);
		expect(result.data).toEqual({
			books: { nodes: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] },
		});
	});

	it("refuses an after that is no cursor of this connection as BAD_USER_INPUT, calling nothing", async () => {
		const result = await run(`{ books(after: "n2") { nodes { id } } }`);
		expect(result.errors?.map((e) => [e.message, e.extensions])).toEqual([
			[
				"after is not a cursor this connection issued",
				{
					code: "BAD_USER_INPUT",
					issues: [
						{
							code: "invalid_format",
							path: ["after"],
							wirePath: ["page-token"],
							message: "not a cursor of this connection",
						},
					],
				},
			],
		]);
		expect(calls).toEqual([]);
	});

	/**
	 * A cursor as this runtime spells one (its doc comment): `[token, skip]` as JSON, each UTF-16 code
	 * unit as two bytes, big-endian, in base64url (RFC 4648 §5). Spelled here with Node's own encoder,
	 * so a refusal below is of the content named, never of a spelling the runtime does not read.
	 */
	const cursorOf = (json: string): string =>
		Buffer.from(json, "utf16le").swap16().toString("base64url");

	it("resumes from a cursor naming a page and a position in it", async () => {
		next["Books_list"] = three;
		const result = await run(`{ books(after: "${cursorOf('["n2",1]')}") { nodes { id } } }`);
		expect(calls.map((c) => c.input)).toEqual([{ "page-size": 20, "page-token": "n2" }]);
		expect(result.data).toEqual({ books: { nodes: [{ id: "c2" }, { id: "c3" }] } });
	});

	/** `["n",1] ` is sixteen bytes; its first fifteen are twenty digits, and `I` is six bits of 0x20. */
	const lastDigitAlone = `${Buffer.from('["n",1] ', "utf16le").swap16().subarray(0, 15).toString("base64url")}I`;
	/** The cursor of `["abcdef",0]`, its ninth digit replaced by standard base64's `+`. */
	const foreignDigit = `${cursorOf('["abcdef",0]').slice(0, 8)}+${cursorOf('["abcdef",0]').slice(9)}`;

	it.each([
		["a skip below zero", cursorOf('["n2",-1]')],
		["a skip that is not whole", cursorOf('["n2",1.5]')],
		["a skip that is a string", cursorOf('["n2","1"]')],
		["a skip past the safe integers", cursorOf('["n2",9007199254740992]')],
		["a token that is not a string", cursorOf("[2,0]")],
		["a third element", cursorOf('["n2",1,0]')],
		["a single element", cursorOf('["n2"]')],
		["an object", cursorOf('{"0":"n2","1":1}')],
		["text that is no JSON", cursorOf("n2")],
		["a digit base64url does not have (RFC 4648 §5)", foreignDigit],
		["a last digit alone, which no base64url ends with", lastDigitAlone],
	])("refuses an after holding %s, calling nothing", async (_content, after) => {
		const result = await run(`{ books(after: "${after}") { nodes { id } } }`);
		expect(result.errors?.map((e) => e.message)).toEqual([
			"after is not a cursor this connection issued",
		]);
		expect(calls).toEqual([]);
	});

	/**
	 * Every length of token, so every way a cursor's bytes end against base64url's three-byte groups,
	 * and a token outside Latin-1, whose code units fill both bytes: each reaches the handler as the
	 * backend gave it.
	 */
	it.each(["a", "ab", "abc", "abcd", "abcde", "abcdef", "€uro", "日本"])(
		"hands the handler the backend's own token %s, resuming from the cursor it issued",
		async (token) => {
			next["Books_list"] = () => ({
				status: 200,
				body: { items: [book("c1", null)], next_token: token },
			});
			const endCursor = pageOf(await run(`{ books { ${PAGE} } }`)).pageInfo.endCursor;
			calls = [];
			const result = await run(`{ books(after: "${endCursor ?? ""}") { nodes { id } } }`);
			expect(result.errors).toBeUndefined();
			expect(calls.map((c) => c.input)).toEqual([{ "page-size": 20, "page-token": token }]);
		},
	);

	/** The list operation with its next token declared a number. */
	const numericTokens = new GraphQLSchema({
		query: new GraphQLObjectType({
			name: "Query",
			fields: {
				books: {
					type: BookConnection,
					resolve: resolverFor(
						call({
							operationId: "Books_list",
							input: listInput,
							arms: [
								{
									status: 200,
									schema: z.object({ items: z.array(bookSchema), next_token: z.number() }),
								},
							],
							projection: { "200": { as: "connection" } },
							connection: {
								items: "items",
								next: "next_token",
								first: "page-size",
								after: "page-token",
							},
						}),
						handlersFor,
						deps,
						RULES,
					),
				},
			},
		}),
	});

	/** A continuation token the backend writes as a number is a token all the same. */
	it("says a next page follows a numeric next token", async () => {
		next["Books_list"] = () => ({
			status: 200,
			body: { items: [book("c1", null)], next_token: 7 },
		});
		const result = await graphql({
			schema: numericTokens,
			source: `{ books { ${PAGE} } }`,
			contextValue: { caller: "alice" },
		});
		expect(result.errors).toBeUndefined();
		expect(pageOf(result).pageInfo.hasNextPage).toBe(true);
		expect(pageOf(result).pageInfo.endCursor).not.toBeNull();
	});

	it("answers no edges after the last edge of the last page", async () => {
		next["Books_list"] = () => ({
			status: 200,
			body: { items: [book("c1", null)] },
		});
		const page = pageOf(await run(`{ books { ${PAGE} } }`));
		calls = [];
		const result = await run(`{ books(after: "${page.pageInfo.endCursor ?? ""}") { ${PAGE} } }`);
		expect(pageOf(result).edges).toEqual([]);
		expect(pageOf(result).pageInfo.hasNextPage).toBe(false);
	});

	/** §5.1: with no edges, and no next page to start, there is no cursor to end on. */
	it("answers an empty last page with null start and end cursors", async () => {
		next["Books_list"] = () => ({ status: 200, body: { items: [] } });
		expect(pageOf(await run(`{ books { ${PAGE} } }`)).pageInfo).toEqual({
			hasNextPage: false,
			hasPreviousPage: false,
			startCursor: null,
			endCursor: null,
		});
	});

	/**
	 * `first` and the cursor's token reach the handler under the query's wire names, and an explicit
	 * `null` on a `dropNull` argument is an absent key, so the default applies.
	 */
	it("fills the paging parameters' wire keys from first and after, defaults applied", async () => {
		next["Books_list"] = three;
		const endCursor = pageOf(await run(`{ books { ${PAGE} } }`)).pageInfo.endCursor ?? "";
		calls = [];
		await run(`{ books(first: 5, after: "${endCursor}") { nodes { id } } }`);
		await run(`{ books { nodes { id } } }`);
		await run(`{ books(first: null, after: null) { nodes { id } } }`);
		expect(calls.map((c) => c.input)).toEqual([
			{ "page-size": 5, "page-token": "n2" },
			{ "page-size": 20 },
			{ "page-size": 20 },
		]);
	});

	it("keeps an explicit null on an argument that is not dropNull, for the request schema to judge", async () => {
		next["Books_list"] = () => ({ status: 200, body: { items: [] } });
		await run(`{ books(tag: null) { nodes { id } } }`);
		expect(calls.map((c) => c.input)).toEqual([{ "page-size": 20, tag: null }]);
	});

	it("refuses a page size the operation's schema refuses, as BAD_USER_INPUT with issues", async () => {
		const result = await run(`{ books(first: 500) { nodes { id } } }`);
		expect(result.errors?.[0]?.extensions["code"]).toBe("BAD_USER_INPUT");
		expect(result.errors?.[0]?.message).toBe("The input to Books_list is not valid");
		expect(issuePaths(result)).toEqual([[["first"], ["page-size"]]]);
		expect(calls).toEqual([]);
	});
});

describe("a mutation", () => {
	const create = `mutation ($input: CreateBookInput!) {
		createBook(input: $input) {
			__typename
			... on Book { id }
			... on Conflict { message }
			... on CreateBookNoContent { success }
		}
	}`;
	/** Every call carries the required `X-Api-Version` header, which an argument may override. */
	const send = (input: Record<string, unknown>) =>
		run(create, { caller: "alice" }, { input: { xApiVersion: "v1", ...input } });

	it("hands the handler the wire-shaped input: renamed, nested, supplied keys added", async () => {
		next["Books_create"] = () => ({ status: 201, body: book("c9", null) });
		const result = await send({
			xApiVersion: "v2",
			title: "hello",
			labels: [{ displayName: "a" }],
		});
		expect(result).toEqual({
			data: { createBook: { __typename: "Book", id: "c9" } },
		});
		expect(calls[0]?.input).toEqual({
			"x-api-version": "v2",
			title: "hello",
			labels: [{ display_name: "a" }],
			accept: "application/json",
		});
	});

	it("drops an explicit null on an optional non-nullable field, and keeps it on a `| null` one", async () => {
		next["Books_create"] = () => ({ status: 201, body: book("c9", null) });
		const result = await send({ title: "hello", authorId: null, note: null });
		expect(result.errors).toBeUndefined();
		expect(calls[0]?.input).toEqual({
			"x-api-version": "v1",
			title: "hello",
			note: null,
			accept: "application/json",
		});
	});

	it("refuses an input the operation's schema refuses, with the Zod issues, and calls nothing", async () => {
		const result = await send({ title: "" });
		expect(result.errors?.[0]?.extensions["code"]).toBe("BAD_USER_INPUT");
		expect(issuePaths(result)).toEqual([[["input", "title"], ["title"]]]);
		expect(calls).toEqual([]);
	});

	/**
	 * A mutation changes what a read answers, so a read memoised before it is stale after it. Two
	 * mutations in one document run in turn; a link read in the first's result must be read again,
	 * not answered from the memo, in the second's: DataLoader's own rule, to clear after a mutation.
	 */
	it("reads a link afresh after each mutation in one document, never from before it", async () => {
		let version = 0;
		next["Books_create"] = () => {
			version += 1;
			return { status: 201, body: book(`c${String(version)}`, "t1") };
		};
		next["Authors_read"] = () => ({ status: 200, body: { id: "t1", name: `v${String(version)}` } });
		const result = await run(
			`mutation ($input: CreateBookInput!) {
				first: createBook(input: $input) { ... on Book { author { name } } }
				second: createBook(input: $input) { ... on Book { author { name } } }
			}`,
			{ caller: "alice" },
			{ input: { xApiVersion: "v1", title: "t" } },
		);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			first: { author: { name: "v1" } },
			second: { author: { name: "v2" } },
		});
		expect(callsTo("Authors_read")).toBe(2);
	});

	it("answers each declared member by the ARM, never by the body's shape", async () => {
		next["Books_create"] = () => ({ status: 409, body: { message: "exists" } });
		expect(await send({ title: "t" })).toEqual({
			data: { createBook: { __typename: "Conflict", message: "exists" } },
		});
		next["Books_create"] = () => ({ status: 204 });
		expect(await send({ title: "t" })).toEqual({
			data: { createBook: { __typename: "CreateBookNoContent", success: true } },
		});
	});

	it("throws ResponseContractError, never a member, for a declared 4xx whose body breaks its schema", async () => {
		next["Books_create"] = () => ({ status: 409, body: { wrong: true } });
		const result = await send({ title: "t" });
		expect(result.data).toEqual({ createBook: null });
		expect(result.errors).toHaveLength(1);
		expect(result.errors?.[0]?.cause).toBeInstanceOf(ResponseContractError);
		// Not a GraphQLError of the runtime: no code, so the server masks it as INTERNAL_SERVER_ERROR.
		expect(result.errors?.[0]?.extensions["code"]).toBeUndefined();
	});

	it("is never memoised: two identical mutations in one request make two calls", async () => {
		next["Books_create"] = () => ({ status: 201, body: book("c9", null) });
		const result = await run(
			`mutation { a: createBook(input: { xApiVersion: "v1", title: "t" }) { __typename } b: createBook(input: { xApiVersion: "v1", title: "t" }) { __typename } }`,
		);
		expect(result.errors).toBeUndefined();
		expect(callsTo("Books_create")).toBe(2);
	});

	it("answers 429 as RATE_LIMITED with retryAfter where the arm declares the header", async () => {
		next["Books_create"] = () => ({
			status: 429,
			body: { message: "slow down" },
			headers: { "retry-after": 30 },
		});
		const result = await send({ title: "t" });
		expect(result.errors?.map((e) => e.extensions)).toEqual([
			{ code: "RATE_LIMITED", status: 429, body: { message: "slow down" }, retryAfter: 30 },
		]);
	});

	it("answers a status inside a declared range by that range's projection", async () => {
		next["Books_create"] = () => ({ status: 503, body: { message: "down" } });
		const result = await send({ title: "t" });
		expect(result.errors?.map((e) => e.extensions)).toEqual([
			{ code: "INTERNAL_SERVER_ERROR", status: 503, body: { message: "down" } },
		]);
	});

	it("throws a masked error for a declared 3xx, which is not projected", async () => {
		next["Books_create"] = () => ({ status: 302 });
		const result = await send({ title: "t" });
		expect(result.errors?.[0]?.cause).toBeInstanceOf(UnprojectedStatusError);
	});

	it("throws UndeclaredStatusError for a status no arm declares", async () => {
		next["Books_create"] = () => ({ status: 418, body: {} });
		const result = await send({ title: "t" });
		expect(result.errors?.[0]?.cause).toBeInstanceOf(UndeclaredStatusError);
	});

	/** A status is a number: one spelled otherwise is declared by no arm, `5XX` included. */
	it.each([
		["a string", "503"],
		["a bigint", 503n],
	])("throws UndeclaredStatusError for a status that is %s", async (_kind, status) => {
		next["Books_create"] = () => ({ status, body: { message: "down" } });
		const result = await send({ title: "t" });
		expect(result.errors?.[0]?.cause).toBeInstanceOf(UndeclaredStatusError);
		expect(result.errors?.[0]?.message).toBe(
			"Books_create answered 503, which its document does not declare",
		);
	});
});

/**
 * **A `default` arm stands for every status the operation does not declare exactly**, so the
 * status the handler answered decides the outcome, by design.md's table: a fixed code per arm
 * answered a 404 under the common `| Error` default as a server error on a read, never `null`.
 */
describe("a default arm, decided by the status answered", () => {
	const CODES = {
		"400": "BAD_USER_INPUT",
		"401": "UNAUTHENTICATED",
		"403": "FORBIDDEN",
		"404": "NOT_FOUND",
		"409": "CONFLICT",
		"410": "GONE",
		"429": "RATE_LIMITED",
		"500": "INTERNAL_SERVER_ERROR",
		"503": "SERVICE_UNAVAILABLE",
	};
	const ranged = new GraphQLSchema({
		query: new GraphQLObjectType({
			name: "Query",
			fields: {
				read: {
					type: Conflict,
					resolve: resolverFor(
						call({
							operationId: "Books_read",
							input: z.looseObject({}),
							authentication: "none",
							security: [],
							arms: [
								{ status: 200, schema: problemSchema },
								{ status: "default", schema: problemSchema },
							],
							projection: { "200": { as: "value" }, default: { as: "byStatus", nullOn404: true } },
						}),
						handlersFor,
						deps,
						RULES,
						CODES,
					),
				},
			},
		}),
		mutation: new GraphQLObjectType({
			name: "Mutation",
			fields: {
				write: {
					type: CreateBookResult,
					resolve: resolverFor(
						call({
							kind: "mutation",
							operationId: "Books_create",
							input: z.looseObject({}),
							authentication: "none",
							security: [],
							arms: [
								{ status: 201, schema: bookSchema },
								{ status: "default", schema: problemSchema },
							],
							projection: {
								"201": { as: "member", type: "Book" },
								default: { as: "byStatus", nullOn404: false, member: "Conflict" },
							},
						}),
						handlersFor,
						deps,
						RULES,
						CODES,
					),
				},
			},
		}),
	});
	const ask = (source: string) =>
		graphql({ schema: ranged, source, contextValue: { caller: "alice" } });

	/**
	 * 499 has no reason phrase, so `STATUS_CODES` holds no code for it, and it is coded as the
	 * emitter's `reasonCodeOf` codes such a status: `STATUS_499`.
	 */
	it.each([
		[404, null, undefined],
		[400, null, "BAD_USER_INPUT"],
		[410, null, "GONE"],
		[499, null, "STATUS_499"],
		[503, null, "SERVICE_UNAVAILABLE"],
	])("answers a read's %s under it as %s, coded %s", async (status, value, code) => {
		next["Books_read"] = () => ({ status, body: { message: "m" } });
		const result = await ask(`{ read { message } }`);
		expect(result.data).toEqual({ read: value });
		expect(result.errors?.[0]?.extensions["code"]).toBe(code);
		if (code !== undefined) expect(result.errors?.[0]?.extensions["status"]).toBe(status);
	});

	it("answers a mutation's member-class status under it as the member, and the rest at top level", async () => {
		next["Books_create"] = () => ({ status: 409, body: { message: "exists" } });
		expect(
			(await ask(`mutation { write { __typename ... on Conflict { message } } }`)).data,
		).toEqual({
			write: { __typename: "Conflict", message: "exists" },
		});
		next["Books_create"] = () => ({ status: 401, body: { message: "who" } });
		const refused = await ask(`mutation { write { __typename } }`);
		expect(refused.errors?.[0]?.extensions["code"]).toBe("UNAUTHENTICATED");
	});

	/**
	 * design.md's mutation table: "4xx, except 401, 403 and 429" is a member; 401, 403 and 429 are
	 * top-level, and so is every status outside 4xx, a 5xx or a 3xx alike.
	 */
	it.each([
		[400, "member"],
		[409, "member"],
		[499, "member"],
		[401, "UNAUTHENTICATED"],
		[403, "FORBIDDEN"],
		[429, "RATE_LIMITED"],
		[500, "INTERNAL_SERVER_ERROR"],
		[503, "SERVICE_UNAVAILABLE"],
	])("answers a mutation's %s under it as %s", async (status, outcome) => {
		next["Books_create"] = () => ({ status, body: { message: "m" } });
		const result = await ask(`mutation { write { __typename ... on Conflict { message } } }`);
		if (outcome === "member") {
			expect(result).toEqual({ data: { write: { __typename: "Conflict", message: "m" } } });
		} else {
			expect(result.data).toEqual({ write: null });
			expect(result.errors?.map((e) => [e.extensions["code"], e.extensions["status"]])).toEqual([
				[outcome, status],
			]);
		}
	});

	it("answers a mutation's 3xx under it at top level, never as a member", async () => {
		next["Books_create"] = () => ({ status: 302, body: { message: "m" } });
		const result = await ask(`mutation { write { __typename } }`);
		expect(result.data).toEqual({ write: null });
		expect(result.errors?.map((e) => e.extensions["status"])).toEqual([302]);
	});
});

/**
 * **A key the operation does not declare never reaches the handler.** The wire rules are code, so a
 * schema rebuilt or transformed keeps them; this is the guard behind them, for a rule or a transform
 * that renames a key the merged request schema, a looseObject, would otherwise let through unread.
 */
describe("assembling the input", () => {
	const anyone = { authentication: "none", security: [] } as const;
	const answersTrue = {
		arms: [{ status: 204, schema: undefined }],
		projection: { "204": { as: "true" } },
	} as const;
	/** `RenameInput.newName` is written as `new-name`, which the request schema does not declare. */
	const RenameInput = new GraphQLInputObjectType({
		name: "RenameInput",
		fields: { newName: { type: new GraphQLNonNull(GraphQLString) } },
	});
	const strayRules: InputRules = { ...RULES, RenameInput: { newName: { wire: "new-name" } } };
	/** An open body's request schema, as `schemas.gen.ts` declares one. */
	const patchInput = z.looseObject({ title: z.string() });
	const strayField = new GraphQLObjectType({
		name: "Query",
		fields: {
			read: {
				type: GraphQLString,
				args: { bookId: { type: GraphQLString } },
				resolve: resolverFor(
					call({
						operationId: "Books_read",
						input: readInput,
						...anyone,
						arms: [{ status: 200, schema: z.string() }],
						projection: { "200": { as: "value" } },
						// Maps the argument to a key `readInput` does not declare: it declares `id`.
						args: { bookId: { wire: "book-id" } },
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
			// `note` is required and `| null`: left out, the resolver states its null.
			annotate: {
				type: GraphQLBoolean,
				args: { note: { type: GraphQLString } },
				resolve: resolverFor(
					call({
						operationId: "Notes_annotate",
						input: z.looseObject({ note: z.string().nullable() }),
						...anyone,
						...answersTrue,
						args: { note: { nullIfAbsent: true } },
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
			annotateStray: {
				type: GraphQLBoolean,
				args: { note: { type: GraphQLString } },
				resolve: resolverFor(
					call({
						operationId: "Notes_annotate",
						input: z.looseObject({ note: z.string().nullable() }),
						...anyone,
						...answersTrue,
						args: { note: { wire: "annotation", nullIfAbsent: true } },
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
			// A request schema that states no keys of its own, but reads every key it is given.
			lookup: {
				type: GraphQLBoolean,
				args: { bookId: { type: GraphQLString } },
				resolve: resolverFor(
					call({
						operationId: "Notes_lookup",
						input: z.record(z.string(), z.string()),
						...anyone,
						...answersTrue,
						args: { bookId: { wire: "book-id" } },
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
		},
	});
	const strayMutation = new GraphQLObjectType({
		name: "Mutation",
		fields: {
			rename: {
				type: GraphQLBoolean,
				args: { input: { type: new GraphQLNonNull(RenameInput) } },
				resolve: resolverFor(
					call({
						kind: "mutation",
						operationId: "Notes_rename",
						input: z.looseObject({ new_name: z.string() }),
						...anyone,
						...answersTrue,
						args: { input: { merge: true } },
					}),
					handlersFor,
					deps,
					strayRules,
				),
			},
			// An open body: its input is JSON, keys as the wire spells them, additional ones included.
			patch: {
				type: GraphQLBoolean,
				args: { input: { type: new GraphQLNonNull(SCALARS.JSON) } },
				resolve: resolverFor(
					call({
						kind: "mutation",
						operationId: "Notes_patch",
						input: patchInput,
						...anyone,
						...answersTrue,
						args: { input: { merge: true } },
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
			// A merged input object the field leaves nullable: `null` states no key.
			retitle: {
				type: GraphQLBoolean,
				args: { input: { type: RenameInput } },
				resolve: resolverFor(
					call({
						kind: "mutation",
						operationId: "Notes_rename",
						input: z.looseObject({ newName: z.string().exactOptional() }),
						...anyone,
						...answersTrue,
						args: { input: { merge: true } },
					}),
					handlersFor,
					deps,
					RULES,
				),
			},
		},
	});
	const stray = new GraphQLSchema({ query: strayField, mutation: strayMutation });
	const ask = (source: string) =>
		graphql({ schema: stray, source, contextValue: { caller: "alice" } });

	it("refuses a key the request schema does not declare, as a masked error, and calls no handler", async () => {
		next["Books_read"] = () => ({ status: 200, body: "never" });
		const result = await ask(`{ read(bookId: "c1") }`);
		expect(result.errors?.[0]?.cause).toBeInstanceOf(InputAssemblyError);
		expect(result.errors?.[0]?.extensions["code"]).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("refuses an undeclared key that a merged input object's field is written to", async () => {
		next["Notes_rename"] = () => ({ status: 204 });
		const result = await ask(`mutation { rename(input: { newName: "n" }) }`);
		expect(result.errors?.[0]?.cause).toBeInstanceOf(InputAssemblyError);
		expect(result.errors?.[0]?.message).toBe(
			"Notes_rename was assembled an input key it does not declare: new-name",
		);
		expect(calls).toEqual([]);
	});

	/** design.md, Arguments and input: "the resolver writes the null the operation requires". */
	it("writes the null a required `| null` argument must state, where the caller leaves it out", async () => {
		next["Notes_annotate"] = () => ({ status: 204 });
		expect((await ask(`{ annotate }`)).errors).toBeUndefined();
		expect((await ask(`{ annotate(note: "n") }`)).errors).toBeUndefined();
		expect(calls.map((c) => c.input)).toEqual([{ note: null }, { note: "n" }]);
	});

	it("refuses an undeclared key it would write that null to", async () => {
		next["Notes_annotate"] = () => ({ status: 204 });
		const result = await ask(`{ annotateStray }`);
		expect(result.errors?.[0]?.cause).toBeInstanceOf(InputAssemblyError);
		expect(calls).toEqual([]);
	});

	it("hands every key to a request schema that declares none, such as a record, which reads each", async () => {
		next["Notes_lookup"] = () => ({ status: 204 });
		const result = await ask(`{ lookup(bookId: "c1") }`);
		expect(result.errors).toBeUndefined();
		expect(calls.map((c) => c.input)).toEqual([{ "book-id": "c1" }]);
	});

	/** design.md: an open body's input is JSON, "validated by the schema itself", extra keys and all. */
	it("hands a JSON input's keys to the handler as the request carries them", async () => {
		next["Notes_patch"] = () => ({ status: 204 });
		const result = await ask(`mutation { patch(input: { title: "t", colour: "red" }) }`);
		expect(result.errors).toBeUndefined();
		expect(calls.map((c) => c.input)).toEqual([{ title: "t", colour: "red" }]);
	});

	/**
	 * **A JSON input is the handler's whole input, so it is an object**: the REST route refuses a body
	 * that is not one, and design.md makes validation the HTTP surface's. A string, a number or a list
	 * is `BAD_USER_INPUT` at the argument, never spread into keys or dropped, refused as the request
	 * schema refuses an input (design.md, README): the same message, and one issue at `input`, the
	 * handler's whole input, coded as Zod codes that schema's own refusal of the value.
	 */
	it.each([
		["a string", `"ab"`, "ab"],
		["a number", "5", 5],
		["a list", "[1, 2]", [1, 2]],
	])(
		"refuses %s as a JSON input, at the argument, and calls no handler",
		async (_kind, literal, value) => {
			next["Notes_patch"] = () => ({ status: 204 });
			const result = await ask(`mutation { patch(input: ${literal}) }`);
			expect(
				result.errors?.map(({ message, path, extensions }) => ({ message, path, extensions })),
			).toEqual([
				{
					message: "The input to Notes_patch is not valid",
					path: ["patch"],
					extensions: {
						code: "BAD_USER_INPUT",
						issues: [
							{
								code: "invalid_type",
								expected: "object",
								path: ["input"],
								wirePath: [],
								message: "the input must be an object, as the request it stands for is",
							},
						],
					},
				},
			]);
			expect(calls).toEqual([]);
			// The issue's code and expectation are Zod's for the request schema and that value.
			expect(
				patchInput.safeParse(value).error?.issues.map(({ code, path, ...issue }) => ({
					code,
					path,
					expected: "expected" in issue ? issue.expected : undefined,
				})),
			).toEqual([{ code: "invalid_type", path: [], expected: "object" }]);
		},
	);

	it("reads a null merged input as stating no key, for the request schema to judge", async () => {
		next["Notes_rename"] = () => ({ status: 204 });
		const result = await ask(`mutation { retitle(input: null) }`);
		expect(result.errors).toBeUndefined();
		expect(calls.map((c) => c.input)).toEqual([{}]);
	});
});

describe("authorisation, per field at call time", () => {
	const query = `{ book(id: "c1") { id } }`;

	/** Each refusal names the operation, so a log of it says which field was refused. */
	const refusalsOf = (result: ExecutionResult) =>
		result.errors?.map((e) => [e.extensions["code"], e.message]);

	it("answers UNAUTHENTICATED when authorize says so, and calls no handler", async () => {
		const result = await run(query, { caller: "alice", verdict: "unauthenticated" });
		expect(refusalsOf(result)).toEqual([
			["UNAUTHENTICATED", "Books_read requires an authenticated caller"],
		]);
		expect(calls).toEqual([]);
	});

	it("answers FORBIDDEN when authorize says so, and calls no handler", async () => {
		const result = await run(query, { caller: "alice", verdict: "forbidden" });
		expect(refusalsOf(result)).toEqual([["FORBIDDEN", "The caller may not call Books_read"]]);
		expect(calls).toEqual([]);
	});

	it("answers UNAUTHENTICATED when there is no caller context, and calls no handler", async () => {
		const result = await run(query, { caller: null });
		expect(refusalsOf(result)).toEqual([
			["UNAUTHENTICATED", "Books_read requires an authenticated caller"],
		]);
		expect(calls).toEqual([]);
	});
});

describe("two fields that reach one operation", () => {
	/**
	 * The memo shares the CALL, never a projection: each field projects the one answer by its own
	 * plan. A root field and a link that both reach `Widgets_read` name their wrapper types after
	 * themselves, so a projection cached by the first would hand the second a member of the wrong
	 * union ("Runtime Object type WidgetNoContent is not a possible type for GadgetWidgetResult").
	 */
	const widgetSchema = z.object({ id: z.string() });
	const widgetCalls: Record<string, unknown>[] = [];
	const readWidget = (wrapper: string, kind: CallRuntime["kind"], bound: CallRuntime["bound"]) =>
		call({
			operationId: "Widgets_read",
			kind,
			input: readInput,
			bound,
			arms: [
				{ status: 200, schema: widgetSchema },
				{ status: 204, schema: undefined },
			],
			projection: {
				"200": { as: "member", type: "Widget" },
				"204": { as: "wrap", type: wrapper, hasBody: false },
			},
		});
	const widgetHandlers = (): object => ({
		Widgets_read: (_ctx: unknown, input: Record<string, unknown>) => {
			widgetCalls.push(input);
			return { status: 204 };
		},
	});
	const Widget = new GraphQLObjectType({
		name: "Widget",
		fields: { id: { type: new GraphQLNonNull(GraphQLString) } },
	});
	const wrapperOf = (name: string) =>
		new GraphQLObjectType({ name, fields: { status: { type: new GraphQLNonNull(GraphQLInt) } } });
	const resultOf = (name: string, wrapper: GraphQLObjectType) =>
		new GraphQLUnionType({
			name,
			types: [Widget, wrapper],
			resolveType: (value) => memberTypeOf(value),
		});
	const Gadget = new GraphQLObjectType({
		name: "Gadget",
		fields: {
			id: { type: new GraphQLNonNull(GraphQLString) },
			widget: {
				type: resultOf("GadgetWidgetResult", wrapperOf("GadgetWidgetNoContent")),
				resolve: resolverFor(
					readWidget("GadgetWidgetNoContent", "link", [{ wire: "id", parent: "widget_id" }]),
					widgetHandlers,
					deps,
					RULES,
				),
			},
		},
	});
	const twoFields = new GraphQLSchema({
		query: new GraphQLObjectType({
			name: "Query",
			fields: {
				widget: {
					type: resultOf("WidgetResult", wrapperOf("WidgetNoContent")),
					args: { id: { type: new GraphQLNonNull(GraphQLString) } },
					resolve: resolverFor(
						readWidget("WidgetNoContent", "query", []),
						widgetHandlers,
						deps,
						RULES,
					),
				},
				gadget: { type: Gadget, resolve: () => ({ id: "g1", widget_id: "w1" }) },
			},
		}),
	});

	it("projects one memoised call by each field's own plan, and calls once", async () => {
		widgetCalls.length = 0;
		const result = await graphql({
			schema: twoFields,
			source: `{ widget(id: "w1") { __typename } gadget { widget { __typename } } }`,
			contextValue: { caller: "alice" } satisfies Context,
		});
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			widget: { __typename: "WidgetNoContent" },
			gadget: { widget: { __typename: "GadgetWidgetNoContent" } },
		});
		expect(widgetCalls).toEqual([{ id: "w1" }]);
	});
});

/**
 * **A projection by the status's class**, RFC 9110 §15: 1xx Informational, 2xx Successful, 3xx
 * Redirection, 4xx Client Error, 5xx Server Error. design.md's wrapper "carries `value` for a body.
 * With none it carries `success: Boolean!`, true for a success and false for a refusal"; a top-level
 * error carries the declared body and `Retry-After` where its arm declares them, and nothing else.
 */
describe("a projection by status class", () => {
	const Outcome = new GraphQLObjectType({
		name: "Outcome",
		fields: { success: { type: GraphQLBoolean }, value: { type: GraphQLString } },
	});
	const OutcomeResult = new GraphQLUnionType({
		name: "OutcomeResult",
		types: [Outcome],
		resolveType: memberTypeOf,
	});
	const bodyless = { as: "wrap", type: "Outcome", hasBody: false } as const;
	const anyone = { authentication: "none", security: [], input: z.looseObject({}) } as const;
	const classes = new GraphQLSchema({
		query: new GraphQLObjectType({
			name: "Query",
			fields: {
				refuse: {
					type: GraphQLBoolean,
					resolve: resolverFor(
						call({
							operationId: "Outcomes_refuse",
							...anyone,
							arms: [
								{
									status: "4XX",
									schema: undefined,
									headers: [
										{ name: "x-request-id", optional: true },
										{ name: "Retry-After", optional: true },
									],
								},
								{ status: "5XX", schema: problemSchema },
							],
							projection: {
								"4XX": { as: "error", code: "CLIENT_ERROR" },
								"5XX": { as: "error", code: "SERVER_ERROR" },
							},
						}),
						handlersFor,
						deps,
						RULES,
					),
				},
			},
		}),
		mutation: new GraphQLObjectType({
			name: "Mutation",
			fields: {
				answer: {
					type: OutcomeResult,
					resolve: resolverFor(
						call({
							kind: "mutation",
							operationId: "Outcomes_answer",
							...anyone,
							arms: [
								{ status: 201, schema: z.string() },
								{ status: "1XX", schema: undefined },
								{ status: "2XX", schema: undefined },
								{ status: "3XX", schema: undefined },
								{ status: "4XX", schema: undefined },
								{ status: "5XX", schema: undefined },
							],
							projection: {
								"201": { as: "wrap", type: "Outcome", hasBody: true },
								"1XX": bodyless,
								"2XX": bodyless,
								"3XX": bodyless,
								"4XX": bodyless,
								"5XX": bodyless,
							},
						}),
						handlersFor,
						deps,
						RULES,
					),
				},
			},
		}),
	});
	const ask = (source: string) =>
		graphql({ schema: classes, source, contextValue: { caller: "alice" } });

	it("wraps a body as the wrapper's value", async () => {
		next["Outcomes_answer"] = () => ({ status: 201, body: "made" });
		expect(await ask(`mutation { answer { ... on Outcome { value } } }`)).toEqual({
			data: { answer: { value: "made" } },
		});
	});

	it.each([
		[103, false],
		[200, true],
		[204, true],
		[299, true],
		[300, false],
		[404, false],
		[503, false],
	])("wraps a bodyless %s as success: %s", async (status, success) => {
		next["Outcomes_answer"] = () => ({ status });
		expect(await ask(`mutation { answer { ... on Outcome { success } } }`)).toEqual({
			data: { answer: { success } },
		});
	});

	it("answers a bodyless error with its status and no body", async () => {
		next["Outcomes_refuse"] = () => ({ status: 400 });
		const result = await ask(`{ refuse }`);
		expect(result.errors?.map((e) => e.extensions)).toStrictEqual([
			{ code: "CLIENT_ERROR", status: 400 },
		]);
	});

	it("carries Retry-After by the wire name its arm declares it under, and no other header", async () => {
		next["Outcomes_refuse"] = () => ({
			status: 429,
			headers: { "x-request-id": "r1", "Retry-After": 5 },
		});
		const result = await ask(`{ refuse }`);
		expect(result.errors?.map((e) => e.extensions)).toStrictEqual([
			{ code: "CLIENT_ERROR", status: 429, retryAfter: 5 },
		]);
	});

	it("carries no Retry-After where the handler sets no headers", async () => {
		next["Outcomes_refuse"] = () => ({ status: 429, headers: null });
		const result = await ask(`{ refuse }`);
		expect(result.errors?.map((e) => e.extensions)).toStrictEqual([
			{ code: "CLIENT_ERROR", status: 429 },
		]);
	});

	it("carries no Retry-After its arm does not declare, whatever the handler sets", async () => {
		next["Outcomes_refuse"] = () => ({
			status: 503,
			body: { message: "down" },
			headers: { "Retry-After": 5 },
		});
		const result = await ask(`{ refuse }`);
		expect(result.errors?.map((e) => e.extensions)).toStrictEqual([
			{ code: "SERVER_ERROR", status: 503, body: { message: "down" } },
		]);
	});
});

/**
 * **Each issue's `path` is the GraphQL path the client wrote, and its `wirePath` the handler's input
 * path** (design.md, Arguments and input): through a renamed argument, a list, an input object's
 * renamed field and a merged `input`. Below a `JSON` argument there are no GraphQL names to map back
 * to, and a key no argument wrote, a supplied header, keeps its wire path as its path.
 */
describe("a refused input's issues", () => {
	const FilterInput = new GraphQLInputObjectType({
		name: "FilterInput",
		fields: { fieldName: { type: new GraphQLNonNull(GraphQLString) } },
	});
	const FindInput = new GraphQLInputObjectType({
		name: "FindInput",
		fields: {
			filters: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(FilterInput))) },
		},
	});
	const filterRules: InputRules = { FilterInput: { fieldName: { wire: "field_name" } } };
	const filter = z.object({ field_name: z.string().min(1) });
	/** At most two filters, so a list can be refused as a whole, at the list's own path. */
	const filterList = z.array(filter).max(2);
	const anyone = { authentication: "none", security: [] } as const;
	const answersTrue = {
		arms: [{ status: 204, schema: undefined }],
		projection: { "204": { as: "true" } },
	} as const;
	const make = (accept: string) =>
		resolverFor(
			call({
				kind: "mutation",
				operationId: "Filters_make",
				input: z.looseObject({ filters: filterList, accept: z.literal("application/json") }),
				...anyone,
				...answersTrue,
				args: { input: { merge: true } },
				supplied: { accept },
			}),
			handlersFor,
			deps,
			filterRules,
		);
	const filters = new GraphQLSchema({
		query: new GraphQLObjectType({
			name: "Query",
			fields: {
				find: {
					type: GraphQLBoolean,
					args: {
						filterList: {
							type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(FilterInput))),
						},
						meta: { type: SCALARS.JSON },
						tag: { type: GraphQLString },
					},
					resolve: resolverFor(
						call({
							operationId: "Filters_find",
							input: z.looseObject({
								"filter-list": filterList,
								meta: z.record(z.string(), z.number()).exactOptional(),
								tag: z.string().min(1).exactOptional(),
							}),
							...anyone,
							...answersTrue,
							args: { filterList: { wire: "filter-list" } },
						}),
						handlersFor,
						deps,
						filterRules,
					),
				},
			},
		}),
		mutation: new GraphQLObjectType({
			name: "Mutation",
			fields: {
				make: {
					type: GraphQLBoolean,
					args: { input: { type: new GraphQLNonNull(FindInput) } },
					resolve: make("application/json"),
				},
				// Supplies a header value the request schema refuses: no argument wrote it.
				makePlain: {
					type: GraphQLBoolean,
					args: { input: { type: new GraphQLNonNull(FindInput) } },
					resolve: make("text/plain"),
				},
			},
		}),
	});
	const ask = async (source: string) => {
		const result = await graphql({ schema: filters, source, contextValue: { caller: "alice" } });
		expect(result.errors?.map((e) => e.extensions["code"])).toEqual(["BAD_USER_INPUT"]);
		expect(calls).toEqual([]);
		return issuePaths(result);
	};

	it.each([
		[
			"a renamed field in a list under a renamed argument",
			`{ find(filterList: [{ fieldName: "a" }, { fieldName: "" }]) }`,
			[
				[
					["filterList", 1, "fieldName"],
					["filter-list", 1, "field_name"],
				],
			],
		],
		[
			"a key below a JSON argument",
			`{ find(filterList: [], meta: { a: "x" }) }`,
			[
				[
					["meta", "a"],
					["meta", "a"],
				],
			],
		],
		["an argument after the first", `{ find(filterList: [], tag: "") }`, [[["tag"], ["tag"]]]],
		[
			"a list argument refused as a whole",
			`{ find(filterList: [{ fieldName: "a" }, { fieldName: "b" }, { fieldName: "c" }]) }`,
			[[["filterList"], ["filter-list"]]],
		],
		[
			"a list in a merged input refused as a whole",
			`mutation { make(input: { filters: [{ fieldName: "a" }, { fieldName: "b" }, { fieldName: "c" }] }) }`,
			[[["input", "filters"], ["filters"]]],
		],
		[
			"a renamed field in a list in a merged input",
			`mutation { make(input: { filters: [{ fieldName: "" }] }) }`,
			[
				[
					["input", "filters", 0, "fieldName"],
					["filters", 0, "field_name"],
				],
			],
		],
		[
			"a header the resolver supplied",
			`mutation { makePlain(input: { filters: [] }) }`,
			[[["accept"], ["accept"]]],
		],
	])("names %s by the path the client wrote", async (_where, source, paths) => {
		expect(await ask(source)).toEqual(paths);
	});
});

/**
 * **The call memo**, design.md's Links: "memoised per GraphQL context value, keyed by operation and
 * canonical input", and "Mutations are never memoised". Canonical is the input as JSON states it: a
 * list in its order, an object's keys in any order, a key whose value is undefined absent and an
 * undefined list item `null`, as `JSON.stringify` writes them.
 */
describe("the call memo", () => {
	let searches = 0;
	const searchHandlers = (): object => ({
		Tags_search: () => {
			searches += 1;
			return { status: 200, body: searches };
		},
	});
	const anyCaller: GraphQLDeps<object, string> = {
		authorize: () => "allow",
		context: () => "anyone",
	};
	const search = (kind: CallRuntime["kind"]) =>
		resolverFor(
			call({
				kind,
				operationId: "Tags_search",
				input: z.looseObject({
					scores: z.array(z.int()).exactOptional(),
					filter: z.unknown().exactOptional(),
				}),
				authentication: "none",
				security: [],
				arms: [{ status: 200, schema: z.int() }],
				projection: { "200": { as: "value" } },
			}),
			searchHandlers,
			anyCaller,
			RULES,
		);
	const memo = new GraphQLSchema({
		query: new GraphQLObjectType({
			name: "Query",
			fields: {
				search: {
					type: GraphQLInt,
					args: {
						scores: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) },
						filter: { type: SCALARS.JSON },
					},
					resolve: search("query"),
				},
				read: { type: GraphQLInt, resolve: search("query") },
				write: { type: GraphQLInt, resolve: search("mutation") },
			},
		}),
	});
	/** How many calls the handler took for one request, with the context value given. */
	const callsIn = async (
		contextValue: unknown,
		source: string,
		variableValues?: Record<string, unknown>,
	): Promise<number> => {
		searches = 0;
		const result = await graphql({ schema: memo, source, variableValues, contextValue });
		expect(result.errors).toBeUndefined();
		return searches;
	};
	/** The same, with a fresh context object, as a server hands each request. */
	const callsFor = (source: string, variableValues?: Record<string, unknown>) =>
		callsIn({}, source, variableValues);
	const twoFilters = `query ($f: JSON, $g: JSON) { a: search(filter: $f) b: search(filter: $g) }`;

	it("calls once for one input, and once for each input that differs", async () => {
		expect(await callsFor(`{ a: search(scores: [1, 2]) b: search(scores: [1, 2]) }`)).toBe(1);
		expect(await callsFor(`{ a: search(scores: [1]) b: search(scores: [2]) }`)).toBe(2);
		expect(await callsFor(`{ a: search(scores: [12]) b: search(scores: [1, 2]) }`)).toBe(2);
		expect(await callsFor(twoFilters, { f: [1, 2], g: { "0": 1, "1": 2 } })).toBe(2);
		expect(await callsFor(twoFilters, { f: { x: null }, g: {} })).toBe(2);
		expect(await callsFor(twoFilters, { f: [undefined], g: [] })).toBe(2);
	});

	it("calls once for inputs JSON states alike", async () => {
		expect(
			await callsFor(`{ a: search(filter: { x: 1, y: 2 }) b: search(filter: { y: 2, x: 1 }) }`),
		).toBe(1);
		expect(await callsFor(twoFilters, { f: { x: undefined }, g: {} })).toBe(1);
	});

	it("memoises on a context value that is a function, as on any object", async () => {
		expect(await callsIn(() => undefined, `{ a: read b: read }`)).toBe(1);
	});

	/**
	 * **A mutation forgets what the request has read, on every context the memo keys on**: a read
	 * after it calls again, the context an object or a function. graphql-js calls these resolvers in
	 * field order, so `w` runs between the two reads.
	 */
	it.each([
		["an object", {}],
		["a function", () => undefined],
	])("reads again after a mutation, on %s as the context value", async (_kind, contextValue) => {
		expect(await callsIn(contextValue, `{ a: read w: write b: read }`)).toBe(3);
	});

	/** With no context object there is no request to key a memo on: every field calls. */
	it.each([
		["undefined", undefined],
		["null", null],
	])("calls once per field where the context value is %s", async (_value, contextValue) => {
		expect(await callsIn(contextValue, `{ a: read b: read }`)).toBe(2);
	});

	/** The key is the operation and its input, so a mutation memoised would answer a read of both. */
	it("never shares a mutation's call with a read of the same operation and input after it", async () => {
		expect(await callsFor(`{ w: write r: read }`)).toBe(2);
	});
});

describe("a call the runtime cannot complete", () => {
	const anyone = { authentication: "none", security: [], input: listInput } as const;
	const plan = { items: "items", next: "next_token", first: "page-size", after: "page-token" };
	const misplanned = new GraphQLSchema({
		query: new GraphQLObjectType({
			name: "Query",
			fields: {
				planless: {
					type: BookConnection,
					resolve: resolverFor(
						call({
							operationId: "Books_list",
							...anyone,
							arms: [{ status: 200, schema: pageSchema }],
							projection: { "200": { as: "connection" } },
						}),
						handlersFor,
						deps,
						RULES,
					),
				},
				bodiless: {
					type: BookConnection,
					resolve: resolverFor(
						call({
							operationId: "Books_list",
							...anyone,
							arms: [
								{ status: 200, schema: z.null() },
								{ status: 204, schema: undefined },
							],
							projection: { "200": { as: "connection" }, "204": { as: "connection" } },
							connection: plan,
						}),
						handlersFor,
						deps,
						RULES,
					),
				},
				unhandled: {
					type: GraphQLBoolean,
					resolve: resolverFor(
						call({
							operationId: "Authors_list",
							authentication: "none",
							security: [],
							arms: [{ status: 204, schema: undefined }],
							projection: { "204": { as: "true" } },
						}),
						handlersFor,
						deps,
						RULES,
					),
				},
				// A link placed on the root, where there is no parent value to read its binding from.
				orphan: {
					type: Author,
					resolve: resolverFor(
						call({
							kind: "link",
							operationId: "Authors_read",
							input: authorInput,
							arms: [{ status: 200, schema: authorSchema }],
							bound: [{ wire: "authorId", parent: "author_id" }],
							projection: { "200": { as: "value" } },
						}),
						handlersFor,
						deps,
						RULES,
					),
				},
			},
		}),
		mutation: new GraphQLObjectType({
			name: "Mutation",
			fields: {
				// A member arm whose body is no object: a null, and none at all.
				nothing: {
					type: CreateBookResult,
					resolve: resolverFor(
						call({
							kind: "mutation",
							operationId: "Books_create",
							authentication: "none",
							security: [],
							input: z.looseObject({}),
							arms: [
								{ status: 200, schema: z.null() },
								{ status: 201, schema: undefined },
							],
							projection: {
								"200": { as: "member", type: "Book" },
								"201": { as: "member", type: "Book" },
							},
						}),
						handlersFor,
						deps,
						RULES,
					),
				},
			},
		}),
	});
	const ask = (source: string, rootValue?: unknown) =>
		graphql({ schema: misplanned, source, rootValue, contextValue: { caller: "alice" } });

	it("names the operation projected as a connection with no plan to page it by", async () => {
		next["Books_list"] = () => ({ status: 200, body: { items: [] } });
		const result = await ask(`{ planless { nodes { id } } }`);
		expect(result.errors?.map((e) => e.message)).toEqual([
			"Books_list is projected as a connection without a connection plan",
		]);
	});

	/** No body, or a null one, holds no items and no next token: §5.1's empty connection. */
	it.each([
		["no body", { status: 204 }],
		["a null body", { status: 200, body: null }],
	])("answers a connection whose page has %s as an empty connection", async (_body, answer) => {
		next["Books_list"] = () => answer;
		const result = await ask(
			`{ bodiless { edges { cursor } nodes { id } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } } }`,
		);
		expect(result).toEqual({
			data: {
				bodiless: {
					edges: [],
					nodes: [],
					pageInfo: {
						hasNextPage: false,
						hasPreviousPage: false,
						startCursor: null,
						endCursor: null,
					},
				},
			},
		});
	});

	it("names the operation handlersFor has no handler for", async () => {
		const result = await ask(`{ unhandled }`);
		expect(result.errors?.map((e) => e.message)).toEqual([
			"handlersFor returned no handler for Authors_list",
		]);
	});

	/** design.md, Links: a bound property that is absent gives `null` without calling the handler. */
	it.each([
		["undefined", undefined],
		["null", null],
	])(
		"answers a binding with a parent value of %s as null, calling nothing",
		async (_value, rootValue) => {
			expect(await ask(`{ orphan { id } }`, rootValue)).toEqual({ data: { orphan: null } });
			expect(calls).toEqual([]);
		},
	);

	it.each([
		["null", { status: 200, body: null }],
		["no body", { status: 201 }],
	])(
		"answers a member arm with %s as null: there is no object to be a member",
		async (_body, answer) => {
			next["Books_create"] = () => answer;
			expect(await ask(`mutation { nothing { __typename } }`)).toEqual({ data: { nothing: null } });
		},
	);
});

/**
 * **The resolver as the runtime exports it**, called as a schema transform or middleware calls it,
 * with no graphql-js execution between: what it answers is what such a caller sees.
 */
describe("a resolver called directly", () => {
	const Root = new GraphQLObjectType({
		name: "Root",
		fields: {
			author: { type: Author, args: { authorId: { type: new GraphQLNonNull(GraphQLString) } } },
		},
	});
	const infoFor = (fieldName: string) =>
		({ parentType: Root, fieldName }) as unknown as GraphQLResolveInfo;
	const author = resolverFor(
		call({
			operationId: "Authors_read",
			input: authorInput,
			arms: [
				{ status: 200, schema: authorSchema },
				{ status: 404, schema: problemSchema },
			],
			projection: { "200": { as: "value" }, "404": { as: "null" } },
		}),
		handlersFor,
		deps,
		RULES,
	);

	/** design.md § Results: a read's 404 is `null` itself, not a value graphql-js completes alike. */
	it("answers a read's 404 as null", async () => {
		next["Authors_read"] = () => ({ status: 404, body: { message: "no such author" } });
		await expect(
			author(undefined, { authorId: "t1" }, { caller: "u1" }, infoFor("author")),
		).resolves.toBe(null);
	});

	/** graphql-js resolves only a field its parent type has: a caller that asks for another is refused. */
	it("refuses a field its parent type does not have", () => {
		expect(() =>
			author(undefined, { authorId: "t1" }, { caller: "u1" }, infoFor("missing")),
		).toThrow(new Error("Root.missing: no such field"));
	});
});

describe("the handler object", () => {
	/**
	 * **`handlersFor` is called once per context value, not once per call.** A factory building the
	 * object for a request (a client per request, a logger bound to it) was built again for every
	 * field: three here, before.
	 */
	it("is built once per request, however many fields call a handler", async () => {
		next["Books_read"] = (input) => ({
			status: 200,
			body: book(String(input["id"]), "t1"),
		});
		next["Authors_read"] = (input) => ({ status: 200, body: { id: input["authorId"], name: "n" } });
		const before = built;
		const result = await run(`{ a: book(id: "c1") { id } b: book(id: "c2") { author { id } } }`);
		expect(result.errors).toBeUndefined();
		expect(callsTo("Books_read") + callsTo("Authors_read")).toBe(3);
		expect(built - before).toBe(1);
		await run(`{ book(id: "c3") { id } }`);
		expect(built - before).toBe(2);
	});

	/**
	 * **Its own `handlersFor`**, so the first call this test makes is the first the runtime has seen
	 * of it, and builds the cache this test then reads: a context value that is an object, and one
	 * that is a function.
	 */
	it("is built once per context value by a handlersFor it has not seen before", async () => {
		let made = 0;
		const own = () => {
			made += 1;
			return handlersFor({ caller: "alice" });
		};
		const Shelf = new GraphQLObjectType({
			name: "Root",
			fields: Object.fromEntries(
				["first", "second"].map((name) => [
					name,
					{
						type: GraphQLBoolean,
						resolve: resolverFor(
							// An input of each field's own, so the memo shares no call between them.
							call({
								operationId: "ping",
								authentication: "none",
								security: [],
								input: z.looseObject({}),
								supplied: { field: name },
								arms: [{ status: 200, schema: z.boolean() }],
								projection: { "200": { as: "value" } },
							}),
							own,
							// A function's `caller` cannot be read in strict mode, so no caller is read off it.
							{ authorize: () => "allow", context: () => "alice" },
							RULES,
						),
					},
				]),
			),
		});
		const shelf = new GraphQLSchema({ query: Shelf });
		next["ping"] = () => ({ status: 200, body: true });
		for (const contextValue of [{}, () => undefined]) {
			made = 0;
			const before = calls.length;
			const result = await graphql({ schema: shelf, source: "{ first second }", contextValue });
			expect(result).toEqual({ data: { first: true, second: true } });
			expect(calls.length - before).toBe(2);
			expect(made).toBe(1);
		}
	});

	it("is each schema's own where two share a context value", async () => {
		const Root = new GraphQLObjectType({
			name: "Root",
			fields: {
				author: { type: Author, args: { authorId: { type: new GraphQLNonNull(GraphQLString) } } },
			},
		});
		const info = { parentType: Root, fieldName: "author" } as unknown as GraphQLResolveInfo;
		const authorCall = call({
			operationId: "Authors_read",
			input: authorInput,
			arms: [{ status: 200, schema: authorSchema }],
			projection: { "200": { as: "value" } },
		});
		const named = (name: string) => () => ({
			Authors_read: () => ({ status: 200, body: { id: "t1", name } }),
		});
		const one = resolverFor(authorCall, named("one"), deps, RULES);
		const two = resolverFor(authorCall, named("two"), deps, RULES);
		const shared: Context = { caller: "u1" };
		await expect(one(undefined, { authorId: "t1" }, shared, info)).resolves.toEqual({
			id: "t1",
			name: "one",
		});
		await expect(two(undefined, { authorId: "t2" }, shared, info)).resolves.toEqual({
			id: "t1",
			name: "two",
		});
	});
});
