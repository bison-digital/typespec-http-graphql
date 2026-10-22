import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertObjectType, type GraphQLSchema, isInputObjectType, isObjectType } from "graphql";
import { type Context, Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyFieldNamePipeline } from "../names/upstream-naming.js";
import { byCodeUnit } from "../support/by-code-unit.js";
import { CallLog } from "../support/call-log.js";
import { compileFixture } from "../support/compile-fixture.js";
import { executeThroughYoga, type GraphQLResult } from "../support/yoga.js";

/**
 * **The surface a GraphQL client sees, served through Yoga from emitted output, beside the REST
 * surface the published `typespec-hono` serves from the same spec, both calling ONE handler
 * object.**
 *
 * Every other arm grades a file, a type or one function. This one asks what a consumer asks: does a
 * query answer what the REST route answers, refuse what it refuses, and hand the handler what the
 * route hands it? The REST server is a sibling package's, never this one's, so where the two agree
 * it is not because one copied the other.
 *
 * The backend is a store in memory behind a log of every call, so an arm can say how many calls a
 * request made and exactly what each was given.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

/** What `deps.context` establishes on both surfaces, and so what every handler receives first. */
interface Caller {
	readonly subject: string;
}

/** The server context this suite hands Yoga per request; Yoga adds its own fields beside it. */
interface ServerContext {
	readonly caller: string;
}

/** The emitted GraphQL module, as far as this suite calls it. */
interface GraphQLModule {
	readonly createSchema: (
		handlersFor: (context: ServerContext) => object,
		deps: {
			readonly authorize: (context: ServerContext, requirements: readonly unknown[]) => "allow";
			readonly context: (context: ServerContext, authentication: string) => Caller | null;
		},
	) => GraphQLSchema;
}

/** The published server emitter's module, as far as this suite calls it. */
interface RestModule {
	readonly registerRoutes: (
		app: Hono,
		handlersFor: () => object,
		deps: Readonly<Record<string, unknown>>,
	) => unknown;
}

/** One issue of a failed parse, as `zValidator` hands it to `deps.invalid`. */
interface Issue {
	readonly path: readonly (string | number)[];
	readonly wirePath?: readonly (string | number)[];
}

const NOW = "2026-10-01T09:00:00Z";
const AUTHOR = "6c0f8e52-3b7a-4c1e-9d2a-000000000001";
const GONE_AUTHOR = "6c0f8e52-3b7a-4c1e-9d2a-000000000002";
const NOVEL = "0b7e1c44-5a2d-4f6e-8c3b-000000000001";
const NO_AUTHOR = "0b7e1c44-5a2d-4f6e-8c3b-000000000002";
const STRAY = "0b7e1c44-5a2d-4f6e-8c3b-000000000003";
const CREATED = "0b7e1c44-5a2d-4f6e-8c3b-000000000099";
const MISSING = "0b7e1c44-5a2d-4f6e-8c3b-0000000000ff";
const HARDBACK = "a1d2e3f4-0000-4000-8000-000000000001";
const EPUB = "a1d2e3f4-0000-4000-8000-000000000002";

/** The id of the nth of many books. */
const nth = (n: number): string => `0b7e1c44-5a2d-4f6e-8c3b-${String(1000 + n).padStart(12, "0")}`;

interface AuthorWire {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
}

interface BookWire {
	readonly id: string;
	readonly authorId: string | null;
	readonly editorId: string | null;
	readonly title: string | null;
	readonly status: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly createdAt: string;
}

/** Snake_case on the wire, as the fixture publishes it. */
interface EditionWire {
	readonly id: string;
	readonly edition_name: string;
	readonly edition_type: string;
	readonly created_at: string;
}

interface Store {
	readonly authors: Map<string, AuthorWire>;
	books: readonly BookWire[];
	readonly editions: ReadonlyMap<string, readonly EditionWire[]>;
}

const novel: BookWire = {
	id: NOVEL,
	authorId: AUTHOR,
	editorId: null,
	title: "Harbour Lights",
	status: "in_review",
	metadata: { source: "catalogue", tags: ["first"] },
	createdAt: NOW,
};

/** What the backend holds at the start of every test. */
function seed(): Store {
	return {
		authors: new Map([[AUTHOR, { id: AUTHOR, name: "Ada Lane", createdAt: NOW }]]),
		books: [
			novel,
			{ ...novel, id: NO_AUTHOR, authorId: null, title: "No author", status: "published" },
			{
				...novel,
				id: STRAY,
				authorId: GONE_AUTHOR,
				title: "An author since removed",
				status: "rejected",
			},
		],
		editions: new Map([
			[
				NOVEL,
				[
					{
						id: HARDBACK,
						edition_name: "hardback.uk",
						edition_type: "print_hardback",
						created_at: NOW,
					},
					{
						id: EPUB,
						edition_name: "epub.uk",
						edition_type: "ebook_epub",
						created_at: NOW,
					},
				],
			],
		]),
	};
}

const problem = (status: number, title: string) => ({ type: "about:blank", title, status });

/** A page of `items` from an offset cursor: the backend's own token, opaque to both surfaces. */
function page<T>(items: readonly T[], input: { readonly limit: number; readonly cursor?: string }) {
	const start = input.cursor === undefined ? 0 : Number(input.cursor.slice("offset:".length));
	const end = start + input.limit;
	return {
		items: items.slice(start, end),
		nextCursor: end < items.length ? `offset:${end}` : null,
	};
}

/**
 * The backend: one handler per operation, reading whatever the store holds when it is called. Each
 * answers only with a response the spec declares, failures included, as a handler given to
 * `registerRoutes` must.
 */
function backend(current: () => Store) {
	return {
		Authors_read: (_caller: Caller, input: { readonly authorId: string }) => {
			const author = current().authors.get(input.authorId);
			return author === undefined
				? { status: 404, body: problem(404, "Not Found") }
				: { status: 200, body: author, headers: { etag: `"${author.name}"` } };
		},
		Books_read: (_caller: Caller, input: { readonly bookId: string }) => {
			const found = current().books.find((c) => c.id === input.bookId);
			return found === undefined
				? { status: 404, body: problem(404, "Not Found") }
				: { status: 200, body: found, headers: { etag: `"${found.id}"` } };
		},
		Books_list: (_caller: Caller, input: { readonly limit: number; readonly cursor?: string }) => ({
			status: 200,
			body: page(current().books, input),
		}),
		Books_create: (
			_caller: Caller,
			input: { readonly originalLanguage: string; readonly title?: string | null },
		) => {
			switch (input.originalLanguage) {
				case "duplicate":
					return { status: 409, body: problem(409, "Conflict") };
				case "malformed":
					// A declared status whose body breaks its schema: a ConflictProblem has a title and a status.
					return { status: 409, body: { type: "about:blank" } };
				default:
					return {
						status: 201,
						body: {
							...novel,
							id: CREATED,
							authorId: null,
							title: input.title ?? null,
							status: "draft",
						},
						headers: { location: `/v1/books/${CREATED}` },
					};
			}
		},
		BookEditions_list: (
			_caller: Caller,
			input: {
				readonly bookId: string;
				readonly limit: number;
				readonly cursor?: string;
				readonly "edition-name"?: string;
				readonly "x-api-version": string;
			},
		) => {
			const all = current().editions.get(input.bookId) ?? [];
			const wanted = input["edition-name"];
			const named = wanted === undefined ? all : all.filter((a) => a.edition_name === wanted);
			return { status: 200, body: page(named, input) };
		},
	};
}

const log = new CallLog();
let store = seed();
let schema: GraphQLSchema;
const rest = new Hono();

beforeAll(async () => {
	const compiled = await compileFixture(here, "main", { outName: "acceptance", withServer: true });
	const graphql = (await import(
		join(compiled.outDir, "graphql.gen.ts")
	)) as unknown as GraphQLModule;
	const routes = (await import(join(compiled.serverDir, "app.gen.ts"))) as unknown as RestModule;

	/** ONE object, built once, given to both surfaces. */
	const handlers = log.wrap(backend(() => store));

	/** Built once, as a server builds it at module scope: per-request state arrives only through the context. */
	schema = graphql.createSchema(() => handlers, {
		authorize: () => "allow",
		context: (context) => ({ subject: context.caller }),
	});
	routes.registerRoutes(rest, () => handlers, {
		authorize: () => async (_c: Context, next: () => Promise<void>) => {
			await next();
		},
		context: () => ({ subject: "rest" }),
		noContext: (c: Context) => c.json({ title: "Unauthorized" }, 401),
		notAcceptable: (c: Context) => c.body(null, 406),
		invalid: (
			result: { readonly success: boolean; readonly error?: { readonly issues: readonly Issue[] } },
			c: Context,
		) =>
			result.success
				? undefined
				: c.json(
						{
							title: "Bad Request",
							paths: (result.error?.issues ?? []).map((issue) => [...issue.path]),
						},
						400,
					),
	});
}, 300_000);

beforeEach(() => {
	store = seed();
	log.clear();
});

const query = (document: string, caller = "alice"): Promise<GraphQLResult> =>
	executeThroughYoga(schema, { query: document }, { caller });

/** The `books` connection a result carries. */
function booksOf<T>(result: GraphQLResult): T {
	const books = result.data?.["books"];
	if (typeof books !== "object" || books === null) {
		throw new Error("the result carries no books");
	}
	return books as T;
}

/** The end cursor of the first page of `first` books: how a client gets an `after`. */
async function endCursorOf(first: number): Promise<string> {
	const result = await query(`{ books(first: ${String(first)}) { pageInfo { endCursor } } }`);
	const cursor = booksOf<{ pageInfo: { endCursor: string | null } }>(result).pageInfo.endCursor;
	if (cursor === null) throw new Error("the first page has no end cursor");
	return cursor;
}

const codesOf = (result: GraphQLResult): unknown[] =>
	(result.errors ?? []).map((error) => error.extensions?.["code"]);

describe("a root field, through Yoga", () => {
	it("answers a query field with the handler's value", async () => {
		const result = await query(
			`{ book(bookId: "${NOVEL}") { id title status authorId createdAt metadata } }`,
		);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			book: {
				id: NOVEL,
				title: "Harbour Lights",
				status: "IN_REVIEW",
				authorId: AUTHOR,
				createdAt: NOW,
				metadata: { source: "catalogue", tags: ["first"] },
			},
		});
		expect(log.count("Books_read")).toBe(1);
	});

	it("answers a declared 404 with null, and no error", async () => {
		const result = await query(`{ book(bookId: "${MISSING}") { id } }`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({ book: null });
		expect(log.count("Books_read")).toBe(1);
	});

	/**
	 * `title` is `String` on `Book` and `String!` on `ConflictProblem`, and `status` an enum on
	 * one and `Int!` on the other, so the error member's are aliased: GraphQL refuses one response
	 * name with two shapes, even across members of a union.
	 */
	it("answers a mutation's success as the success member of its result union", async () => {
		const result = await query(`mutation {
			createBook(input: { originalLanguage: "en", title: "Low Tide" }) {
				__typename
				... on Book { id title status }
				... on ConflictProblem { problemTitle: title problemStatus: status }
			}
		}`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			createBook: {
				__typename: "Book",
				id: CREATED,
				title: "Low Tide",
				status: "DRAFT",
			},
		});
		expect(log.inputsOf("Books_create")).toStrictEqual([
			{ originalLanguage: "en", title: "Low Tide" },
		]);
	});

	it("answers a declared mutation 4xx as a typed error member, chosen by the status", async () => {
		const result = await query(`mutation {
			createBook(input: { originalLanguage: "duplicate" }) {
				__typename
				... on Book { id }
				... on ConflictProblem { problemTitle: title problemStatus: status }
			}
		}`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			createBook: {
				__typename: "ConflictProblem",
				problemTitle: "Conflict",
				problemStatus: 409,
			},
		});
	});
});

describe("validation and values are the REST route's", () => {
	/**
	 * Each issue names the input twice: `path` as the client wrote it (the argument `first`), and
	 * `wirePath` as the handler's input holds it, which is the REST route's own (`limit`).
	 */
	it("refuses with BAD_USER_INPUT the request REST refuses with 400, naming the same input both ways, and calls no handler", async () => {
		const response = await rest.request("/v1/books?limit=500");
		expect(response.status).toBe(400);
		const refused = (await response.json()) as { readonly paths: readonly Issue["path"][] };
		expect(refused.paths).toEqual([["limit"]]);

		const result = await query(`{ books(first: 500) { nodes { id } } }`);
		expect(result.data).toEqual({ books: null });
		expect(codesOf(result)).toEqual(["BAD_USER_INPUT"]);
		const issues = result.errors?.[0]?.extensions?.["issues"] as readonly Issue[] | undefined;
		expect(issues?.map((issue) => issue.wirePath)).toEqual(refused.paths);
		expect(issues?.map((issue) => issue.path)).toEqual([["first"]]);

		expect(log.count("Books_list")).toBe(0);
	});

	it("hands the handler exactly what the REST route hands it, the next page's token included", async () => {
		const endCursor = await endCursorOf(2);
		log.clear();
		await rest.request("/v1/books?limit=2&cursor=offset%3A2");
		await query(`{ books(first: 2, after: "${endCursor}") { nodes { id } } }`);
		const [fromRest, fromGraphQL] = log.inputsOf("Books_list");
		expect(fromRest).toStrictEqual({ limit: 2, cursor: "offset:2" });
		expect(fromGraphQL).toStrictEqual(fromRest);
	});

	/**
	 * **The expected side is the REST JSON itself**, every key it carries, each renamed by the
	 * vendored upstream naming oracle and selected under that name. Nothing here reads the schema or
	 * the emitted types to decide what a value should be, so a field the schema lacks fails the
	 * query and a value the schema reshapes fails the comparison. The one translation the design
	 * table makes, an enum's wire value to its CONSTANT_CASE name, is written out by hand.
	 */
	it("answers every value REST answers, under the name the upstream naming gives each key", async () => {
		const response = await rest.request(`/v1/books/${NOVEL}`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Readonly<Record<string, unknown>>;
		const keys = Object.keys(body);
		// Non-vacuity: every property of Book, not a chosen few.
		expect(keys.toSorted(byCodeUnit)).toEqual([
			"authorId",
			"createdAt",
			"editorId",
			"id",
			"metadata",
			"status",
			"title",
		]);
		const selection = keys.map((key) => applyFieldNamePipeline(key)).join(" ");
		const result = await query(`{ book(bookId: "${NOVEL}") { ${selection} } }`);
		expect(result.errors).toBeUndefined();
		const handWritten: Readonly<Record<string, unknown>> = { status: "IN_REVIEW" };
		const expected = Object.fromEntries(
			keys.map((key) => [
				applyFieldNamePipeline(key),
				key in handWritten ? handWritten[key] : body[key],
			]),
		);
		expect(result.data?.["book"]).toStrictEqual(expected);
		// The enum's wire value differs from its GraphQL name, so this is not identity.
		expect(body["status"]).toBe("in_review");
	});
});

describe("links", () => {
	it("resolves a link through its operation, from the parent's bound property", async () => {
		const result = await query(`{ book(bookId: "${NOVEL}") { author { id name createdAt } } }`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			book: { author: { id: AUTHOR, name: "Ada Lane", createdAt: NOW } },
		});
		expect(log.inputsOf("Authors_read")).toStrictEqual([{ authorId: AUTHOR }]);
	});

	it("answers a link whose bound property is null with null, and never calls its handler", async () => {
		const result = await query(`{ book(bookId: "${NO_AUTHOR}") { title author { name } } }`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({ book: { title: "No author", author: null } });
		expect(log.count("Authors_read")).toBe(0);
		// Non-vacuity: the parent was read, so the link had a parent to resolve against.
		expect(log.count("Books_read")).toBe(1);
	});

	it("answers a link whose target answers 404 with null, and no error", async () => {
		const result = await query(`{ book(bookId: "${STRAY}") { author { name } } }`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({ book: { author: null } });
		expect(log.inputsOf("Authors_read")).toStrictEqual([{ authorId: GONE_AUTHOR }]);
	});

	/** DataLoader's deduplication, without the library. */
	it("makes one call for fifty parents that share one author", async () => {
		const fifty = Array.from({ length: 50 }, (_, n) => ({ ...novel, id: nth(n) }));
		store.books = fifty;
		const result = await query(`{ books(first: 50) { nodes { id author { name } } } }`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			books: { nodes: fifty.map(({ id }) => ({ id, author: { name: "Ada Lane" } })) },
		});
		expect(log.count("Books_list")).toBe(1);
		expect(log.count("Authors_read")).toBe(1);
	});

	/**
	 * **The memo is per request.** The author is renamed between two requests through one schema. A
	 * memo keyed anywhere but on the context value would answer the second request from the first
	 * request's call.
	 */
	it("makes one call per request, and answers the second request from its own call", async () => {
		store.books = Array.from({ length: 5 }, (_, n) => ({ ...novel, id: nth(n) }));
		const document = `{ books(first: 5) { nodes { author { name } } } }`;

		const first = await query(document, "alice");
		store.authors.set(AUTHOR, { id: AUTHOR, name: "Ida Lane", createdAt: NOW });
		const second = await query(document, "bob");

		const names = (result: GraphQLResult) => {
			const books = result.data?.["books"] as
				| { readonly nodes: readonly { readonly author: { readonly name: string } }[] }
				| undefined;
			return books?.nodes.map((node) => node.author.name);
		};
		expect(names(first)).toEqual(Array.from({ length: 5 }, () => "Ada Lane"));
		expect(names(second)).toEqual(Array.from({ length: 5 }, () => "Ida Lane"));
		expect(log.count("Authors_read")).toBe(2);
	});
});

describe("connections", () => {
	/**
	 * relay.dev §3.1: a cursor is opaque, so a client never writes one; it takes it from an edge or
	 * from `pageInfo`. Every `after` here is one this connection answered.
	 */
	it("maps first onto the page size and a returned cursor onto the backend's own token", async () => {
		const endCursor = await endCursorOf(2);
		log.clear();
		await query(`{ books(first: 2, after: "${endCursor}") { nodes { id } } }`);
		expect(log.inputsOf("Books_list")).toStrictEqual([{ limit: 2, cursor: "offset:2" }]);
	});

	it("resumes partway into a page by asking for that page again, enlarged by what it skips", async () => {
		const first = await query(`{ books(first: 2) { edges { cursor node { id } } } }`);
		const [edge] = booksOf<{ edges: { cursor: string }[] }>(first).edges;
		log.clear();
		const result = await query(
			`{ books(first: 2, after: "${edge?.cursor ?? ""}") { nodes { id } } }`,
		);
		expect(result.errors).toBeUndefined();
		// The first page again (no token), one item longer, so two remain after the edge skipped.
		expect(log.inputsOf("Books_list")).toStrictEqual([{ limit: 3 }]);
		expect(result.data).toEqual({ books: { nodes: [{ id: NO_AUTHOR }, { id: STRAY }] } });
	});

	it("refuses as BAD_USER_INPUT an after that is no cursor of this connection, and calls nothing", async () => {
		log.clear();
		const result = await query(`{ books(first: 2, after: "offset:1") { nodes { id } } }`);
		expect(result.data).toEqual({ books: null });
		expect(codesOf(result)).toEqual(["BAD_USER_INPUT"]);
		const issues = result.errors?.[0]?.extensions?.["issues"] as readonly Issue[] | undefined;
		expect(issues?.map((issue) => issue.path)).toEqual([["after"]]);
		expect(log.count("Books_list")).toBe(0);
	});

	it("lets the operation's own default page size apply when first is absent", async () => {
		await query(`{ books { nodes { id } } }`);
		expect(log.inputsOf("Books_list")).toStrictEqual([{ limit: 50 }]);
	});

	/**
	 * relay.dev §3.1 and §5.1: every edge has a cursor, and `startCursor` and `endCursor` are the
	 * first and last edges'. Cursors are opaque, so the assertions are those relations, not values.
	 */
	it("builds edges, nodes and pageInfo from a page with a next token", async () => {
		const result = await query(`{
			books(first: 2) {
				edges { cursor node { id } }
				nodes { id }
				pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
			}
		}`);
		expect(result.errors).toBeUndefined();
		const connection = result.data?.["books"] as {
			edges: { cursor: unknown; node: { id: string } }[];
			nodes: { id: string }[];
			pageInfo: Record<string, unknown>;
		};
		expect(connection.edges.map((edge) => edge.node)).toEqual([{ id: NOVEL }, { id: NO_AUTHOR }]);
		expect(connection.nodes).toEqual([{ id: NOVEL }, { id: NO_AUTHOR }]);
		const cursors = connection.edges.map((edge) => edge.cursor);
		expect(cursors.every((cursor) => typeof cursor === "string" && cursor !== "")).toBe(true);
		expect(new Set(cursors).size).toBe(2);
		expect(connection.pageInfo).toEqual({
			hasNextPage: true,
			hasPreviousPage: false,
			startCursor: cursors[0],
			endCursor: cursors[1],
		});
	});

	it("ends on a page with no next token, its last edge still a cursor", async () => {
		const endCursor = await endCursorOf(2);
		const result = await query(`{
			books(first: 2, after: "${endCursor}") {
				edges { cursor node { id } }
				pageInfo { hasNextPage endCursor }
			}
		}`);
		expect(result.errors).toBeUndefined();
		const connection = result.data?.["books"] as {
			edges: { cursor: string; node: { id: string } }[];
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
		};
		expect(connection.edges.map((edge) => edge.node)).toEqual([{ id: STRAY }]);
		expect(connection.pageInfo).toEqual({
			hasNextPage: false,
			endCursor: connection.edges[0]?.cursor,
		});
	});

	it("pages a link: the bound id from the parent, the page and filters from the field's arguments", async () => {
		const result = await query(`{
			book(bookId: "${NOVEL}") {
				editions(
					first: 1
					editionName: "epub.uk"
					editionType: [EBOOK_EPUB]
					xApiVersion: "2026-10-01"
				) {
					nodes { id editionName editionType createdAt }
					pageInfo { hasNextPage }
				}
			}
		}`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			book: {
				editions: {
					nodes: [
						{
							id: EPUB,
							editionName: "epub.uk",
							editionType: "EBOOK_EPUB",
							createdAt: NOW,
						},
					],
					pageInfo: { hasNextPage: false },
				},
			},
		});
		expect(log.inputsOf("BookEditions_list")).toStrictEqual([
			{
				bookId: NOVEL,
				limit: 1,
				"edition-name": "epub.uk",
				editionType: ["ebook_epub"],
				"x-api-version": "2026-10-01",
			},
		]);
	});
});

/** The GraphQL names are camelCase, and the wire is untouched both ways. */
describe("wire names that are not GraphQL style", () => {
	it("hands a required header argument to the handler under its wire name", async () => {
		const result = await query(
			`{ book(bookId: "${NOVEL}") { editions(xApiVersion: "2026-10-01") { nodes { id } } } }`,
		);
		expect(result.errors).toBeUndefined();
		expect(log.inputsOf("BookEditions_list")).toStrictEqual([
			{ bookId: NOVEL, limit: 50, "x-api-version": "2026-10-01" },
		]);
		// Required on the wire, so required in GraphQL: a selection without it is refused before any call.
		const missing = await query(`{ book(bookId: "${NOVEL}") { editions { nodes { id } } } }`);
		expect(codesOf(missing)).toEqual(["GRAPHQL_VALIDATION_FAILED"]);
		expect(log.count("BookEditions_list")).toBe(1);
	});

	it("hands nested input objects to the handler under their wire names", async () => {
		const result = await query(`mutation {
			createBook(input: {
				originalLanguage: "en"
				contributors: [{ key: "alice", displayName: "Alice", role: "illustrator" }]
			}) { __typename }
		}`);
		expect(result.errors).toBeUndefined();
		expect(log.inputsOf("Books_create")).toStrictEqual([
			{
				originalLanguage: "en",
				contributors: [{ key: "alice", display_name: "Alice", role: "illustrator" }],
			},
		]);
	});

	it("reads a response's snake_case wire names back under camelCase fields", async () => {
		const result = await query(
			`{ book(bookId: "${NOVEL}") { editions(xApiVersion: "2026-10-01") { nodes { editionName createdAt } } } }`,
		);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			book: {
				editions: {
					nodes: [
						{ editionName: "hardback.uk", createdAt: NOW },
						{ editionName: "epub.uk", createdAt: NOW },
					],
				},
			},
		});
	});
});

/**
 * **An optional header is never an argument** (design.md § Arguments and input, as decided). It is
 * HTTP transport metadata: a GraphQL client sends such metadata as headers of its own `/graphql`
 * request, and the handler receives the header absent, as a REST handler does when a client leaves
 * it out.
 */
describe("an optional header", () => {
	it("is an argument of no field and a field of no input, and never reaches the handler", async () => {
		const names = new Set<string>();
		for (const type of Object.values(schema.getTypeMap())) {
			if (isObjectType(type)) {
				for (const field of Object.values(type.getFields())) {
					for (const argument of field.args) names.add(argument.name);
				}
			}
			if (isInputObjectType(type)) {
				for (const field of Object.keys(type.getFields())) names.add(field);
			}
		}
		// Non-vacuity: the names were collected, the one required header among them.
		expect(names).toContain("xApiVersion");
		for (const optional of ["xRequestId", "idempotencyKey", "ifNoneMatch"]) {
			expect(names).not.toContain(optional);
		}

		const refused = await query(`{ book(bookId: "${NOVEL}", xRequestId: "r-1") { id } }`);
		expect(codesOf(refused)).toEqual(["GRAPHQL_VALIDATION_FAILED"]);
		await query(`{ book(bookId: "${NOVEL}") { id } }`);
		// REST hands it over when a client sends it; GraphQL never does.
		await rest.request(`/v1/books/${NOVEL}`, { headers: { "X-Request-Id": "r-1" } });
		expect(log.inputsOf("Books_read")).toStrictEqual([
			{ bookId: NOVEL },
			{ bookId: NOVEL, "X-Request-Id": "r-1" },
		]);
	});
});

describe("an explicit null on input", () => {
	it("is absent for an optional field that is not nullable, and kept for one that is", async () => {
		const result = await query(`mutation {
			createBook(input: {
				originalLanguage: "en"
				title: null
				firstPrintRun: null
				contributors: [{ key: "alice", displayName: null, role: null }]
			}) { __typename }
		}`);
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({ createBook: { __typename: "Book" } });
		// Strict: a key present with the value `undefined` is not a key left out.
		expect(log.inputsOf("Books_create")).toStrictEqual([
			{ originalLanguage: "en", title: null, contributors: [{ key: "alice", display_name: null }] },
		]);
	});

	it("matches REST, which refuses that null and accepts the key left out", async () => {
		const post = (body: object) =>
			rest.request("/v1/books", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		expect((await post({ originalLanguage: "en", firstPrintRun: null })).status).toBe(400);
		const accepted = await post({
			originalLanguage: "en",
			title: null,
			contributors: [{ key: "alice", display_name: null }],
		});
		expect(accepted.status).toBe(201);
		expect(log.inputsOf("Books_create")).toStrictEqual([
			{ originalLanguage: "en", title: null, contributors: [{ key: "alice", display_name: null }] },
		]);
	});
});

describe("a response that breaks its contract", () => {
	it("masks a declared mutation 4xx whose body breaks its schema, rather than answer a member with bad data", async () => {
		const result = await query(`mutation {
			createBook(input: { originalLanguage: "malformed" }) {
				__typename
				... on ConflictProblem { problemTitle: title }
			}
		}`);
		expect(result.data).toEqual({ createBook: null });
		expect(result.errors?.map((error) => error.message)).toEqual(["Unexpected error."]);
		expect(codesOf(result)).toEqual(["INTERNAL_SERVER_ERROR"]);
		expect(log.count("Books_create")).toBe(1);
	});
});

describe("cost hints", () => {
	const COST = { weight: "1" };
	const LIST_SIZE = {
		slicingArguments: ["first"],
		sizedFields: ["edges", "nodes"],
		requireOneSlicingArgument: false,
	};

	it("repeats @cost on every root field and link, and @listSize on every connection, in extensions", () => {
		const roots = schema.getQueryType()?.getFields() ?? {};
		expect(roots["book"]?.extensions).toMatchObject({ cost: COST });
		expect(roots["book"]?.extensions).not.toHaveProperty("listSize");
		expect(roots["books"]?.extensions).toMatchObject({ cost: COST, listSize: LIST_SIZE });
		expect(schema.getMutationType()?.getFields()["createBook"]?.extensions).toMatchObject({
			cost: COST,
		});
		const book = assertObjectType(schema.getType("Book")).getFields();
		expect(book["author"]?.extensions).toMatchObject({ cost: COST });
		expect(book["editions"]?.extensions).toMatchObject({
			cost: COST,
			listSize: LIST_SIZE,
		});
		// A plain field calls nothing, so it costs nothing extra.
		expect(book["title"]?.extensions).not.toHaveProperty("cost");
	});
});
