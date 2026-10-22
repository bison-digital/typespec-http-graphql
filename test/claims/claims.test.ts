import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, GraphQLString, type GraphQLSchema, validateSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { CallLog } from "../support/call-log.js";
import { compileFixture, type CompiledFixture } from "../support/compile-fixture.js";
import { appliedDirectives, normalised } from "../support/sdl-compare.js";
import { executeThroughYoga, type GraphQLResult } from "../support/yoga.js";

/**
 * **Every sentence the README says about what a client sees, quoted, and held to rows written out
 * by hand.**
 *
 * A row is a document, the handlers it scripts, and literally what the response and the handler
 * calls must be. Each expectation was written from the README and design.md alone, before the row
 * first ran; none was read off this emitter's output. A reference server built from the same prose
 * could share a misreading with the runtime it is compared against; a literal cannot.
 *
 * **The README is the contract this suite is held to.** `CLAIMS` quotes it, emphasis markers and line
 * breaks aside: a quote that is no longer in README.md fails, so the README cannot be reworded away
 * from the behaviour graded here, and a claim with no row fails, so a quote cannot stand ungraded.
 *
 * Two fixtures: `test/idiom/`, a bookshop's domain, and `extras/`, what that domain does not
 * show. `extras/expected.graphql` is the schema a person would write for `extras/main.tsp`, held to
 * `PROVENANCE.md` as the idiom suite holds its own.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const idiomDir = fileURLToPath(new URL("../idiom/", import.meta.url));
const extrasDir = join(here, "extras");

const CLAIMS = {
	names:
		"Types are PascalCase with the namespace stripped; fields and arguments are camelCase of the property's JSON wire name, so a field reads the same in REST and GraphQL; enum values are CONSTANT_CASE.",
	interface: "select `... on ProblemFieldsInterface { title detail }` across a result's members.",
	success:
		"A member with no body carries `success: Boolean!`, true for a success and false for a refusal.",
	wire: "A handler receives `x-api-version` and `edition-name` from the arguments `xApiVersion` and `editionName`, and a response's `created_at` is read back under `createdAt`.",
	deprecated:
		"`#deprecated` becomes `@deprecated`, except on a required input field, which GraphQL refuses to deprecate: there the reason ends the field's description, as `Deprecated: <reason>`.",
	arguments:
		"A query field or a link takes one argument per path, query and cookie parameter it does not bind, and per REQUIRED header whose type is not a single literal.",
	literalHeader:
		"A header whose type is one literal, such as a negotiated `accept` or a merge patch's `Content-Type`, is supplied by the resolver.",
	optionalHeader:
		"An optional header or cookie is never an argument, and reaches the handler absent.",
	mutationInput:
		"A mutation takes one `input: <Name>Input!` whose fields are the handler's input, less the headers above.",
	encode:
		'An argument\'s type is its wire form, its own `@encode` included: an `@encode("seconds")` duration header is a `DurationSeconds` number, a `unixTimestamp` query parameter a `UTCDateTimeUnix` one.',
	headerDate:
		"A date-time header with no `@encode` is `UTCDateTimeHuman` or `OffsetDateTimeHuman`, an RFC 7231 HTTP-date: the form TypeSpec sends a header in, and the one `@typespec/openapi3` publishes for it.",
	unsafeInteger:
		"A `Long` or `BigInteger` beyond ±2^53 − 1 is `BAD_USER_INPUT`, as the REST route refuses it: a JSON number carries no larger integer exactly, so one is refused rather than rounded.",
	nullAbsent:
		"An explicit `null` for an optional field that is not `| null` is treated as absent, as REST sees an omitted key.",
	nullKept: "A `| null` field keeps its `null`.",
	nullRequired:
		"A field that is required and `| null` can be left out, since GraphQL cannot require a nullable input; the handler then receives the `null` the operation requires.",
	defaults:
		"A default is in the schema, an enum's by its value's name (`first: Int = 50`, `order: Order = NEWEST`), and the handler receives its wire value.",
	deprecatedParameter:
		"`#deprecated` on a parameter is `@deprecated` on its argument, or, where the argument is required, `Deprecated: <reason>` at the end of its description.",
	validation:
		"Input is validated with the operation's own Zod schemas, so a request the REST route answers `400` is `BAD_USER_INPUT` here, with the Zod issues in `extensions.issues`, each issue's `path` naming the argument you wrote (`[\"input\", \"ownerId\"]`) and its `wirePath` the REST route's key (`owner_id`), and the handler receives exactly what the REST route's handler would.",
	rootNullable:
		"Root fields and links are nullable, so one failing field does not null its siblings.",
	linkNull:
		"A link whose bound property is `null` or absent is `null`, and its handler is not called.",
	nullability:
		"A property is nullable when it is optional or `| null`; a list's items are non-null unless they are `| null` themselves, a connection's `node` included.",
	query2xx: "| 2xx | the field's value |",
	query404: "| 404 | `null` |",
	query400: "| 400, 422 | top-level `BAD_USER_INPUT` |",
	query401: "| 401, 403 | top-level `UNAUTHENTICATED`, `FORBIDDEN` |",
	query409: "| 409 | top-level `CONFLICT` |",
	query429: "| 429 | top-level `RATE_LIMITED` |",
	queryOther: "| another 4xx | top-level, `code` the reason phrase (`GONE`) |",
	mutation2xx: "| 2xx | a success member of `<Name>Result`, a union even with one member |",
	mutation4xx:
		"| 4xx but 401, 403 and 429 | a typed error member of `<Name>Result`: the error model |",
	mutationTopLevel: "| 401, 403, 429 | top-level, as on a query |",
	byStatus:
		"A `default`, `4XX` or `5XX` response stands for many statuses, so the status your handler answers decides, by the tables above: a 404 under a `| Error` default arm is `null` on a query, a 400 is `BAD_USER_INPUT`, and on a mutation a member-class status is the default arm's model as a member.",
	serverError:
		"On both, a 5xx is top-level with `extensions.status` and the declared body in `extensions.body`.",
	masked:
		"A response that breaks its declared schema, an undeclared status, or a handler that throws is a plain error the server masks: Yoga answers `INTERNAL_SERVER_ERROR` with no detail.",
	memberByStatus:
		"A union member is chosen by the status the handler returned, never by the shape of its body.",
	first:
		"`first: Int` fills the `@pageSize` parameter, whose default and maximum stay the operation's; a negative `first` is `BAD_USER_INPUT`, and a page the backend answers longer than `first` is cut to it.",
	after:
		"`after: String` takes a cursor from this connection, an edge's or `pageInfo.endCursor`, and the handler receives the backend's own token for that page. Anything else is `BAD_USER_INPUT`.",
	connectionShape:
		"`<Item>Connection { edges, nodes, pageInfo }`, `<Item>Edge { node, cursor }` and `PageInfo` follow relay.dev/graphql/connections.htm.",
	edgeCursors:
		"Every edge has an opaque cursor you can resume after, which a Relay client such as Apollo's `relayStylePagination` relies on; `startCursor` and `endCursor` are the first and last edges'.",
	forwardOnly: "Paging is forward only, so `hasPreviousPage` is `false`.",
	cost: '`@cost(weight: "1")` is on every root field and link, and `@listSize` on every connection field, in `schema.graphql` (the IBM cost directives) and in each field\'s `extensions` (`cost`, `listSize`), so a validation rule can read them from the runtime schema.',
	memo: "Calls are memoised per GraphQL context value, keyed by operation and input, so fifty books by one author cost one author read per request.",
	mutationMemo:
		"Mutations are never memoised, and each mutation forgets what the request has read, so a read after it is answered afresh.",
	contextPerRequest:
		"Calls are memoised per context object, and authorisation runs inside the memoised call.",
	authorize:
		'`authorize(context, requirements)` answers `"allow"`, `"unauthenticated"` or `"forbidden"` for the operation\'s `@useAuth` requirements',
	context:
		"`context(context, authentication)` returns the caller every handler receives, or `null`, which is answered `UNAUTHENTICATED`.",
	extendCollision:
		"A field with the name of a generated one throws when the schema is built, naming both.",
} as const;

type Claim = keyof typeof CLAIMS;

/** What `deps.context` hands every handler. */
interface Caller {
	readonly subject: string;
}

type Input = Readonly<Record<string, unknown>>;
type Handler = (caller: Caller, input: Input) => unknown;

/** One entry of `errors`, reduced to what the README promises about it. */
interface ExpectedError {
	readonly path: readonly (string | number)[];
	readonly code: string;
	readonly status?: number;
	readonly retryAfter?: number;
	readonly body?: unknown;
	readonly issues?: readonly {
		readonly path: readonly (string | number)[];
		readonly wirePath: readonly (string | number)[];
	}[];
	/** Yoga's "Unexpected error.", with no detail of what went wrong. */
	readonly masked?: true;
}

interface Row {
	readonly name: string;
	readonly claims: readonly Claim[];
	readonly fixture: "idiom" | "extras";
	/** A document run first, whose result the row's variables are taken from. Its calls are not the row's. */
	readonly prelude?: string;
	readonly document: string;
	readonly variables?: (prelude: GraphQLResult | undefined) => Readonly<Record<string, unknown>>;
	readonly handlers?: Readonly<Record<string, Handler>>;
	readonly authorize?: "allow" | "unauthenticated" | "forbidden";
	/** What `deps.context` returns; `{ subject: "alice" }` when not given. */
	readonly caller?: Caller | null;
	/** Runs of the document, each its own request. */
	readonly times?: number;
	readonly data: unknown;
	readonly errors?: readonly ExpectedError[];
	readonly calls: readonly { readonly operationId: string; readonly input: Input }[];
	/** What a literal cannot say: that one value in the response equals another. */
	readonly also?: (result: GraphQLResult) => void;
}

// ---------------------------------------------------------------------------------------------
// The backend's data, as each REST route publishes it.
// ---------------------------------------------------------------------------------------------

const NOW = "2026-10-01T09:00:00Z";
const PUBLISHER = "9a1b2c3d-0000-4000-8000-000000000001";
const AUTHOR = "6c0f8e52-3b7a-4c1e-9d2a-000000000001";
const OTHER_AUTHOR = "6c0f8e52-3b7a-4c1e-9d2a-000000000002";
const EDITOR = "5e4d3c2b-0000-4000-8000-000000000001";
const BOOK = "0b7e1c44-5a2d-4f6e-8c3b-000000000001";
const CREATED = "0b7e1c44-5a2d-4f6e-8c3b-000000000099";
const EDITION = "a1d2e3f4-0000-4000-8000-000000000001";

/** Five authors, for a connection to page through. */
const AUTHORS = [1, 2, 3, 4, 5].map((n) => ({
	id: `6c0f8e52-3b7a-4c1e-9d2a-00000000010${String(n)}`,
	publisherId: PUBLISHER,
	name: `Author ${String(n)}`,
	createdAt: NOW,
}));
const authorId = (n: number): string => AUTHORS[n - 1]?.id ?? "";

const author = (name = "Ada Lane") => ({
	id: AUTHOR,
	publisherId: PUBLISHER,
	name,
	createdAt: NOW,
});

const book = (over: Input = {}) => ({
	id: BOOK,
	publisherId: PUBLISHER,
	editorId: null,
	commissionedById: null,
	authorId: AUTHOR,
	title: "Harbour Lights",
	status: "in_review",
	metadata: { source: "catalogue" },
	createdAt: NOW,
	updatedAt: NOW,
	...over,
});

const editor = {
	id: EDITOR,
	publisherId: PUBLISHER,
	displayName: "Ada",
	email: null,
	role: "senior_editor",
	status: "active",
	authorIds: [AUTHOR],
	createdAt: NOW,
};

const edition = {
	id: EDITION,
	bookId: BOOK,
	editionName: "hardback.uk",
	editionType: "print_hardback",
	versionNumber: 2,
	checksum: null,
	metadata: {},
	createdAt: NOW,
};

const problem = (status: number, title: string) => ({ type: "about:blank", title, status });

/** A read's 200, with the `ETag` every read declares. */
const read = (body: unknown) => ({ status: 200, body, headers: { etag: '"1"' } });

/** An offset-paged backend: the token is `offset:<n>`, opaque to both surfaces. */
function paged<T>(all: readonly T[], input: Input) {
	const limit = input["limit"] as number;
	const cursor = input["cursor"] as string | undefined;
	const start = cursor === undefined ? 0 : Number(cursor.slice("offset:".length));
	const end = start + limit;
	return {
		status: 200,
		body: {
			items: all.slice(start, end),
			nextCursor: end < all.length ? `offset:${String(end)}` : null,
		},
	};
}

const item = { id: "i1", name: "Widget" };

/** The input every `createItem` row starts from, and what its handler receives for it. */
const ITEM_INPUT = 'xStore: "acme", name: "Widget", kind: "tool"';
const ITEM_WIRE = { "x-store": "acme", name: "Widget", note: null, kind: "tool" };

const masked = (path: readonly (string | number)[]): ExpectedError => ({
	path,
	code: "INTERNAL_SERVER_ERROR",
	masked: true,
});

/** A description no README sentence states: the emitter's own prose for `first` and `after`, or none. */
const prose = {
	asymmetricMatch: (value: unknown) => value === null || typeof value === "string",
	toAsymmetricMatcher: () => "a description or null",
};

/** Edge cursors, opaque: the row asserts only that each is a string, and `also` how they relate. */
const cursor = expect.any(String) as unknown as string;

type PageInfo = {
	readonly startCursor: string | null;
	readonly endCursor: string | null;
};
type Edges = readonly { readonly cursor: string }[];

/** `startCursor` and `endCursor` are the first and last edges' cursors. */
function cursorsAreTheEdges(at: string) {
	return (result: GraphQLResult): void => {
		const connection = result.data?.[at] as { edges: Edges; pageInfo: PageInfo };
		expect(connection.pageInfo.startCursor).toBe(connection.edges[0]?.cursor);
		expect(connection.pageInfo.endCursor).toBe(connection.edges.at(-1)?.cursor);
		expect(new Set(connection.edges.map((edge) => edge.cursor)).size).toBe(connection.edges.length);
	};
}

/** The `authors` connection a prelude answered. */
function authorsOf<T>(prelude: GraphQLResult | undefined): T {
	const authors = prelude?.data?.["authors"];
	if (typeof authors !== "object" || authors === null)
		throw new Error("the prelude answered no authors");
	return authors as T;
}

const PAGE = `edges { cursor node { id } } nodes { id }
	pageInfo { hasNextPage hasPreviousPage startCursor endCursor }`;

// ---------------------------------------------------------------------------------------------
// The rows.
// ---------------------------------------------------------------------------------------------

const ROWS: readonly Row[] = [
	// Names, and a query's value.
	{
		name: "a query field answers the handler's body under camelCase fields and CONSTANT_CASE enums",
		claims: ["names", "query2xx", "optionalHeader", "nullability"],
		fixture: "idiom",
		document: `{ book(bookId: "${BOOK}") {
			id publisherId editorId authorId title status createdAt metadata } }`,
		handlers: { Books_read: () => read(book()) },
		data: {
			book: {
				id: BOOK,
				publisherId: PUBLISHER,
				editorId: null,
				authorId: AUTHOR,
				title: "Harbour Lights",
				status: "IN_REVIEW",
				createdAt: NOW,
				metadata: { source: "catalogue" },
			},
		},
		calls: [{ operationId: "Books_read", input: { bookId: BOOK } }],
	},
	{
		name: "every enum value of an editor reads CONSTANT_CASE, and a list of ids is a list",
		claims: ["names", "query2xx", "nullability"],
		fixture: "idiom",
		document: `{ editor(editorId: "${EDITOR}") { displayName email role status authorIds } }`,
		handlers: { Editors_read: () => read(editor) },
		data: {
			editor: {
				displayName: "Ada",
				email: null,
				role: "SENIOR_EDITOR",
				status: "ACTIVE",
				authorIds: [AUTHOR],
			},
		},
		calls: [{ operationId: "Editors_read", input: { editorId: EDITOR } }],
	},
	{
		name: "a snake_case wire property is read back under its camelCase field",
		claims: ["wire", "query2xx", "nullability"],
		fixture: "extras",
		document: `{ item(id: "i1") { id name createdAt label } }`,
		handlers: { Items_read: () => ({ status: 200, body: { ...item, created_at: NOW } }) },
		data: { item: { id: "i1", name: "Widget", createdAt: NOW, label: null } },
		calls: [{ operationId: "Items_read", input: { id: "i1" } }],
	},
	{
		name: "a bodyless success of a query is true",
		claims: ["query2xx"],
		fixture: "extras",
		document: `{ itemExists(id: "i1") }`,
		handlers: { Items_exists: () => ({ status: 204 }) },
		data: { itemExists: true },
		calls: [{ operationId: "Items_exists", input: { id: "i1" } }],
	},

	// Arguments and input.
	{
		name: "required headers are arguments, and reach the handler under their wire names",
		claims: ["wire", "arguments", "query2xx", "memberByStatus"],
		fixture: "extras",
		document: `{ itemEither(id: "i1", xApiVersion: "2026-10-01", editionName: "hardback") {
			__typename ... on Item { id } } }`,
		handlers: { Items_either: () => ({ status: 200, body: item }) },
		data: { itemEither: { __typename: "Item", id: "i1" } },
		calls: [
			{
				operationId: "Items_either",
				input: { id: "i1", "x-api-version": "2026-10-01", "edition-name": "hardback" },
			},
		],
	},
	{
		name: "a second success body is its own member, a list wrapped in value",
		claims: ["memberByStatus", "query2xx"],
		fixture: "extras",
		document: `{ itemEither(id: "i1", xApiVersion: "2026-10-01") {
			__typename ... on Item { id } ... on ItemEitherAccepted { value } } }`,
		handlers: { Items_either: () => ({ status: 202, body: ["queued", "later"] }) },
		data: { itemEither: { __typename: "ItemEitherAccepted", value: ["queued", "later"] } },
		calls: [{ operationId: "Items_either", input: { id: "i1", "x-api-version": "2026-10-01" } }],
	},
	{
		name: "a link binds its parameter from the parent and takes the rest as arguments",
		claims: ["arguments", "names", "connectionShape"],
		fixture: "idiom",
		document: `{ book(bookId: "${BOOK}") { editions(first: 2,
			editionType: [PRINT_HARDBACK, EBOOK_EPUB], editionName: "hardback.uk", allVersions: true) {
			nodes { editionName editionType versionNumber checksum } } } }`,
		handlers: {
			Books_read: () => read(book()),
			BookEditions_list: () => ({
				status: 200,
				body: { items: [edition], nextCursor: null },
			}),
		},
		data: {
			book: {
				editions: {
					nodes: [
						{
							editionName: "hardback.uk",
							editionType: "PRINT_HARDBACK",
							versionNumber: 2,
							checksum: null,
						},
					],
				},
			},
		},
		calls: [
			{ operationId: "Books_read", input: { bookId: BOOK } },
			{
				operationId: "BookEditions_list",
				input: {
					bookId: BOOK,
					limit: 2,
					editionType: ["print_hardback", "ebook_epub"],
					editionName: "hardback.uk",
					allVersions: true,
				},
			},
		],
	},
	{
		name: "a link to an author reads the parent's bound id and takes no argument",
		claims: ["arguments", "query2xx"],
		fixture: "idiom",
		document: `{ book(bookId: "${BOOK}") { author { name } } }`,
		handlers: {
			Books_read: () => read(book()),
			Authors_read: () => read(author()),
		},
		data: { book: { author: { name: "Ada Lane" } } },
		calls: [
			{ operationId: "Books_read", input: { bookId: BOOK } },
			{ operationId: "Authors_read", input: { authorId: AUTHOR } },
		],
	},
	{
		name: "a nested connection link binds the author and pages by first",
		claims: ["arguments", "connectionShape"],
		fixture: "idiom",
		document: `{ author(authorId: "${AUTHOR}") { editors(first: 1) { nodes { displayName role } } } }`,
		handlers: {
			Authors_read: () => read(author()),
			Authors_listEditors: () => ({ status: 200, body: { items: [editor], nextCursor: null } }),
		},
		data: { author: { editors: { nodes: [{ displayName: "Ada", role: "SENIOR_EDITOR" }] } } },
		calls: [
			{ operationId: "Authors_read", input: { authorId: AUTHOR } },
			{ operationId: "Authors_listEditors", input: { authorId: AUTHOR, limit: 1 } },
		],
	},
	{
		name: "a merge patch's Content-Type is supplied, never an input field",
		claims: ["literalHeader", "mutationInput", "mutation2xx"],
		fixture: "idiom",
		document: `mutation { updateBook(input: { bookId: "${BOOK}", title: "Renamed" }) {
			__typename ... on Book { title } } }`,
		handlers: {
			Books_update: () => ({ status: 200, body: book({ title: "Renamed" }) }),
		},
		data: { updateBook: { __typename: "Book", title: "Renamed" } },
		calls: [
			{
				operationId: "Books_update",
				input: {
					bookId: BOOK,
					"Content-Type": "application/merge-patch+json",
					title: "Renamed",
				},
			},
		],
	},
	{
		name: "a mutation's input fields are the handler's input, a required header among them",
		claims: ["mutationInput", "wire", "nullRequired", "mutation2xx"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT} }) { __typename ... on Item { id } } }`,
		handlers: { Items_create: () => ({ status: 200, body: item }) },
		data: { createItem: { __typename: "Item", id: "i1" } },
		calls: [{ operationId: "Items_create", input: ITEM_WIRE }],
	},
	{
		name: "a required | null input field sent as null is null",
		claims: ["nullKept", "nullRequired"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT}, note: null }) { __typename } }`,
		handlers: { Items_create: () => ({ status: 200, body: item }) },
		data: { createItem: { __typename: "Item" } },
		calls: [{ operationId: "Items_create", input: ITEM_WIRE }],
	},
	{
		name: "a required | null input field sent with a value keeps it",
		claims: ["nullRequired", "mutationInput"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT}, note: "fragile" }) { __typename } }`,
		handlers: { Items_create: () => ({ status: 200, body: item }) },
		data: { createItem: { __typename: "Item" } },
		calls: [{ operationId: "Items_create", input: { ...ITEM_WIRE, note: "fragile" } }],
	},
	{
		name: "an optional | null input field keeps an explicit null",
		claims: ["nullKept", "mutationInput"],
		fixture: "idiom",
		document: `mutation { createBook(input: { originalLanguage: "en", title: null }) { __typename } }`,
		handlers: {
			Books_create: () => ({
				status: 201,
				body: book({ id: CREATED, title: null }),
				headers: { location: `/v1/books/${CREATED}` },
			}),
		},
		data: { createBook: { __typename: "Book" } },
		calls: [{ operationId: "Books_create", input: { originalLanguage: "en", title: null } }],
	},
	{
		name: "an explicit null for an optional input field that is not | null is absent",
		claims: ["nullAbsent", "mutationInput"],
		fixture: "idiom",
		document: `mutation { createBook(input: { originalLanguage: "en", metadata: null }) { __typename } }`,
		handlers: {
			Books_create: () => ({
				status: 201,
				body: book({ id: CREATED }),
				headers: { location: `/v1/books/${CREATED}` },
			}),
		},
		data: { createBook: { __typename: "Book" } },
		calls: [{ operationId: "Books_create", input: { originalLanguage: "en" } }],
	},
	{
		name: "an explicit null for an optional argument that is not | null is absent",
		claims: ["nullAbsent"],
		fixture: "extras",
		document: `{ item(id: "i1", legacy: null) { id } }`,
		handlers: { Items_read: () => ({ status: 200, body: item }) },
		data: { item: { id: "i1" } },
		calls: [{ operationId: "Items_read", input: { id: "i1" } }],
	},
	{
		name: "a deprecated optional argument still reaches the handler",
		claims: ["deprecatedParameter", "arguments"],
		fixture: "extras",
		document: `{ item(id: "i1", legacy: "W-1") { id } }`,
		handlers: { Items_read: () => ({ status: 200, body: item }) },
		data: { item: { id: "i1" } },
		calls: [{ operationId: "Items_read", input: { id: "i1", legacy: "W-1" } }],
	},
	{
		name: "an @encode'd query parameter and header are numbers on the wire, as literals",
		claims: ["encode", "wire"],
		fixture: "extras",
		document: `{ itemHistory(id: "i1", since: 1790000000, xWindow: 30) { id } }`,
		handlers: { Items_history: () => ({ status: 200, body: [item] }) },
		data: { itemHistory: [{ id: "i1" }] },
		calls: [
			{ operationId: "Items_history", input: { id: "i1", since: 1790000000, "x-window": 30 } },
		],
	},
	{
		name: "an @encode'd header is a number on the wire, as a variable",
		claims: ["encode"],
		fixture: "extras",
		document: `query ($window: DurationSeconds!) { itemHistory(id: "i1", xWindow: $window) { id } }`,
		variables: () => ({ window: 45 }),
		handlers: { Items_history: () => ({ status: 200, body: [] }) },
		data: { itemHistory: [] },
		calls: [{ operationId: "Items_history", input: { id: "i1", "x-window": 45 } }],
	},
	{
		name: "a date-time header takes the HTTP-date its type states, which reaches the handler",
		claims: ["headerDate", "validation"],
		fixture: "extras",
		document: `query ($asOf: UTCDateTimeHuman!) { itemAsOf(id: "i1", xAsOf: $asOf) { id } }`,
		variables: () => ({ asOf: "Fri, 26 Aug 2022 14:38:00 GMT" }),
		handlers: { Items_asOf: () => ({ status: 200, body: item }) },
		data: { itemAsOf: { id: "i1" } },
		calls: [
			{
				operationId: "Items_asOf",
				input: { id: "i1", "x-as-of": "Fri, 26 Aug 2022 14:38:00 GMT" },
			},
		],
	},
	{
		name: "a Long at the largest integer a JSON number carries exactly reaches the handler",
		claims: ["unsafeInteger"],
		fixture: "extras",
		document: `{ itemHistory(id: "i1", xWindow: 30, after: 9007199254740991) { id } }`,
		handlers: { Items_history: () => ({ status: 200, body: [] }) },
		data: { itemHistory: [] },
		calls: [
			{
				operationId: "Items_history",
				input: { id: "i1", after: 9007199254740991, "x-window": 30 },
			},
		],
	},
	{
		name: "a Long literal beyond it is refused, not rounded",
		claims: ["unsafeInteger"],
		fixture: "extras",
		document: `{ itemHistory(id: "i1", xWindow: 30, after: 9007199254740993) { id } }`,
		data: { itemHistory: null },
		errors: [
			{
				path: ["itemHistory"],
				code: "BAD_USER_INPUT",
				issues: [{ path: ["after"], wirePath: ["after"] }],
			},
		],
		calls: [],
	},
	{
		name: "a Long variable beyond it is refused, not rounded",
		claims: ["unsafeInteger"],
		fixture: "extras",
		document: `query ($after: Long) { itemHistory(id: "i1", xWindow: 30, after: $after) { id } }`,
		// 2^53: the first integer beyond the safe range, and exact as a JavaScript number.
		variables: () => ({ after: 2 ** 53 }),
		data: { itemHistory: null },
		errors: [
			{
				path: ["itemHistory"],
				code: "BAD_USER_INPUT",
				issues: [{ path: ["after"], wirePath: ["after"] }],
			},
		],
		calls: [],
	},
	{
		name: "a duration in seconds is refused as an ISO string",
		claims: ["encode"],
		fixture: "extras",
		document: `query ($window: DurationSeconds!) { itemHistory(id: "i1", xWindow: $window) { id } }`,
		variables: () => ({ window: "PT30S" }),
		data: undefined,
		errors: [{ path: [], code: "BAD_USER_INPUT" }],
		calls: [],
	},
	{
		name: "a query argument the request schema refuses is BAD_USER_INPUT, at the argument",
		claims: ["validation", "first"],
		fixture: "idiom",
		document: `{ authors(first: 0) { nodes { id } } }`,
		data: { authors: null },
		errors: [
			{
				path: ["authors"],
				code: "BAD_USER_INPUT",
				issues: [{ path: ["first"], wirePath: ["limit"] }],
			},
		],
		calls: [],
	},
	{
		name: "an input field the request schema refuses names the field written and the wire key",
		claims: ["validation"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT}, ownerId: "x" }) { __typename } }`,
		data: { createItem: null },
		errors: [
			{
				path: ["createItem"],
				code: "BAD_USER_INPUT",
				issues: [{ path: ["input", "ownerId"], wirePath: ["owner_id"] }],
			},
		],
		calls: [],
	},
	{
		name: "a too-short name is refused at input.name, and the handler is not called",
		claims: ["validation"],
		fixture: "extras",
		document: `mutation { createItem(input: { xStore: "acme", name: "", kind: "tool" }) { __typename } }`,
		data: { createItem: null },
		errors: [
			{
				path: ["createItem"],
				code: "BAD_USER_INPUT",
				issues: [{ path: ["input", "name"], wirePath: ["name"] }],
			},
		],
		calls: [],
	},
	{
		name: "a valid snake_case input field reaches the handler under its wire key",
		claims: ["validation", "wire"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT}, ownerId: "${EDITOR}" }) { __typename } }`,
		handlers: { Items_create: () => ({ status: 200, body: item }) },
		data: { createItem: { __typename: "Item" } },
		calls: [{ operationId: "Items_create", input: { ...ITEM_WIRE, owner_id: EDITOR } }],
	},

	// Nullability.
	{
		name: "a link whose bound id is null is null, and its handler is not called",
		claims: ["linkNull", "nullability"],
		fixture: "idiom",
		document: `{ book(bookId: "${BOOK}") { id author { name } editor { displayName } } }`,
		handlers: { Books_read: () => read(book({ authorId: null })) },
		data: { book: { id: BOOK, author: null, editor: null } },
		calls: [{ operationId: "Books_read", input: { bookId: BOOK } }],
	},
	{
		name: "a failing root field is null beside a sibling that answers",
		claims: ["rootNullable", "masked"],
		fixture: "idiom",
		document: `{ author(authorId: "${AUTHOR}") { name } publisher(publisherId: "${PUBLISHER}") { name } }`,
		handlers: {
			Authors_read: () => read(author()),
			Publishers_read: () => {
				throw new Error("the database is down");
			},
		},
		data: { author: { name: "Ada Lane" }, publisher: null },
		errors: [masked(["publisher"])],
		calls: [
			{ operationId: "Authors_read", input: { authorId: AUTHOR } },
			{ operationId: "Publishers_read", input: { publisherId: PUBLISHER } },
		],
	},
	{
		name: "a failing link is null beside its parent's other fields",
		claims: ["rootNullable", "query400"],
		fixture: "idiom",
		document: `{ book(bookId: "${BOOK}") { id editions { nodes { id } } } }`,
		handlers: {
			Books_read: () => read(book()),
			BookEditions_list: () => ({ status: 400, body: problem(400, "Bad Request") }),
		},
		data: { book: { id: BOOK, editions: null } },
		errors: [
			{
				path: ["book", "editions"],
				code: "BAD_USER_INPUT",
				status: 400,
				body: problem(400, "Bad Request"),
			},
		],
		calls: [
			{ operationId: "Books_read", input: { bookId: BOOK } },
			{
				operationId: "BookEditions_list",
				input: { bookId: BOOK, limit: 50 },
			},
		],
	},

	// Errors on a query or a link.
	{
		name: "a declared 404 on a read is null, with no error",
		claims: ["query404"],
		fixture: "idiom",
		document: `{ book(bookId: "${BOOK}") { id } }`,
		handlers: { Books_read: () => ({ status: 404, body: problem(404, "Not Found") }) },
		data: { book: null },
		calls: [{ operationId: "Books_read", input: { bookId: BOOK } }],
	},
	{
		name: "a declared 401 is top-level UNAUTHENTICATED, with its status and body",
		claims: ["query401"],
		fixture: "idiom",
		document: `{ publisher(publisherId: "${PUBLISHER}") { name } }`,
		handlers: {
			Publishers_read: () => ({
				status: 401,
				body: problem(401, "Unauthorized"),
				headers: { "www-authenticate": "Bearer" },
			}),
		},
		data: { publisher: null },
		errors: [
			{
				path: ["publisher"],
				code: "UNAUTHENTICATED",
				status: 401,
				body: problem(401, "Unauthorized"),
			},
		],
		calls: [{ operationId: "Publishers_read", input: { publisherId: PUBLISHER } }],
	},
	{
		name: "a declared 403 is top-level FORBIDDEN",
		claims: ["query401"],
		fixture: "idiom",
		document: `{ author(authorId: "${AUTHOR}") { name } }`,
		handlers: { Authors_read: () => ({ status: 403, body: problem(403, "Forbidden") }) },
		data: { author: null },
		errors: [{ path: ["author"], code: "FORBIDDEN", status: 403, body: problem(403, "Forbidden") }],
		calls: [{ operationId: "Authors_read", input: { authorId: AUTHOR } }],
	},
	{
		name: "a declared 429 is top-level RATE_LIMITED, with Retry-After",
		claims: ["query429"],
		fixture: "idiom",
		document: `{ editor(editorId: "${EDITOR}") { displayName } }`,
		handlers: {
			Editors_read: () => ({
				status: 429,
				body: problem(429, "Too Many Requests"),
				headers: { "retry-after": 7 },
			}),
		},
		data: { editor: null },
		errors: [
			{
				path: ["editor"],
				code: "RATE_LIMITED",
				status: 429,
				retryAfter: 7,
				body: problem(429, "Too Many Requests"),
			},
		],
		calls: [{ operationId: "Editors_read", input: { editorId: EDITOR } }],
	},
	{
		name: "a declared 429 on extras carries its Retry-After too",
		claims: ["query429"],
		fixture: "extras",
		document: `{ item(id: "i1") { id } }`,
		handlers: {
			Items_read: () => ({
				status: 429,
				body: { message: "slow down" },
				headers: { "retry-after": 30 },
			}),
		},
		data: { item: null },
		errors: [
			{
				path: ["item"],
				code: "RATE_LIMITED",
				status: 429,
				retryAfter: 30,
				body: { message: "slow down" },
			},
		],
		calls: [{ operationId: "Items_read", input: { id: "i1" } }],
	},
	{
		name: "a declared 409 on a query is top-level CONFLICT",
		claims: ["query409"],
		fixture: "extras",
		document: `{ item(id: "i1") { id } }`,
		handlers: { Items_read: () => ({ status: 409, body: { message: "being moved" } }) },
		data: { item: null },
		errors: [{ path: ["item"], code: "CONFLICT", status: 409, body: { message: "being moved" } }],
		calls: [{ operationId: "Items_read", input: { id: "i1" } }],
	},
	{
		name: "another declared 4xx is top-level, coded by its reason phrase",
		claims: ["queryOther"],
		fixture: "extras",
		document: `{ item(id: "i1") { id } }`,
		handlers: { Items_read: () => ({ status: 410, body: { message: "retired" } }) },
		data: { item: null },
		errors: [{ path: ["item"], code: "GONE", status: 410, body: { message: "retired" } }],
		calls: [{ operationId: "Items_read", input: { id: "i1" } }],
	},
	{
		name: "a declared 500 is top-level with its status and body",
		claims: ["serverError"],
		fixture: "idiom",
		document: `{ edition(editionId: "${EDITION}") { id } }`,
		handlers: {
			Editions_read: () => ({ status: 500, body: problem(500, "Internal Server Error") }),
		},
		data: { edition: null },
		errors: [
			{
				path: ["edition"],
				code: "INTERNAL_SERVER_ERROR",
				status: 500,
				body: problem(500, "Internal Server Error"),
			},
		],
		calls: [{ operationId: "Editions_read", input: { editionId: EDITION } }],
	},
	{
		name: "a declared 501 is top-level, coded by its reason phrase",
		claims: ["serverError"],
		fixture: "idiom",
		document: `{ edition(editionId: "${EDITION}") { id } }`,
		handlers: { Editions_read: () => ({ status: 501, body: problem(501, "Not Implemented") }) },
		data: { edition: null },
		errors: [
			{
				path: ["edition"],
				code: "NOT_IMPLEMENTED",
				status: 501,
				body: problem(501, "Not Implemented"),
			},
		],
		calls: [{ operationId: "Editions_read", input: { editionId: EDITION } }],
	},
	{
		name: "a 404 under a default arm is null on a query",
		claims: ["byStatus"],
		fixture: "extras",
		document: `{ item(id: "i1") { id } }`,
		handlers: { Items_read: () => ({ status: 404, body: { message: "no such item" } }) },
		data: { item: null },
		calls: [{ operationId: "Items_read", input: { id: "i1" } }],
	},
	{
		name: "a 400 under a default arm is BAD_USER_INPUT on a query",
		claims: ["byStatus"],
		fixture: "extras",
		document: `{ item(id: "i1") { id } }`,
		handlers: { Items_read: () => ({ status: 400, body: { message: "bad id" } }) },
		data: { item: null },
		errors: [{ path: ["item"], code: "BAD_USER_INPUT", status: 400, body: { message: "bad id" } }],
		calls: [{ operationId: "Items_read", input: { id: "i1" } }],
	},
	{
		name: "a 503 under a default arm is top-level SERVICE_UNAVAILABLE with its body",
		claims: ["byStatus", "serverError"],
		fixture: "extras",
		document: `{ item(id: "i1") { id } }`,
		handlers: { Items_read: () => ({ status: 503, body: { message: "maintenance" } }) },
		data: { item: null },
		errors: [
			{
				path: ["item"],
				code: "SERVICE_UNAVAILABLE",
				status: 503,
				body: { message: "maintenance" },
			},
		],
		calls: [{ operationId: "Items_read", input: { id: "i1" } }],
	},
	{
		name: "a body that breaks its declared schema is masked",
		claims: ["masked"],
		fixture: "idiom",
		document: `{ book(bookId: "${BOOK}") { id } }`,
		handlers: { Books_read: () => read({ id: BOOK }) },
		data: { book: null },
		errors: [masked(["book"])],
		calls: [{ operationId: "Books_read", input: { bookId: BOOK } }],
	},
	{
		name: "an undeclared status is masked",
		claims: ["masked"],
		fixture: "idiom",
		document: `{ book(bookId: "${BOOK}") { id } }`,
		handlers: { Books_read: () => ({ status: 418, body: problem(418, "I'm a teapot") }) },
		data: { book: null },
		errors: [masked(["book"])],
		calls: [{ operationId: "Books_read", input: { bookId: BOOK } }],
	},
	{
		name: "a 3xx, though declared, is masked",
		claims: ["masked", "optionalHeader"],
		fixture: "idiom",
		document: `{ book(bookId: "${BOOK}") { id } }`,
		handlers: { Books_read: () => ({ status: 304, headers: { etag: '"1"' } }) },
		data: { book: null },
		errors: [masked(["book"])],
		calls: [{ operationId: "Books_read", input: { bookId: BOOK } }],
	},
	{
		name: "a handler that throws is masked",
		claims: ["masked"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT} }) { __typename } }`,
		handlers: {
			Items_create: () => {
				throw new Error("constraint items_name_key violated");
			},
		},
		data: { createItem: null },
		errors: [masked(["createItem"])],
		calls: [{ operationId: "Items_create", input: ITEM_WIRE }],
	},

	// Errors on a mutation.
	{
		name: "a mutation's success is the success member",
		claims: ["mutation2xx", "mutationInput"],
		fixture: "idiom",
		document: `mutation { createBook(input: { originalLanguage: "en", title: "Low Tide" }) {
			__typename ... on Book { id status } } }`,
		handlers: {
			Books_create: () => ({
				status: 201,
				body: book({ id: CREATED, title: "Low Tide", status: "draft" }),
				headers: { location: `/v1/books/${CREATED}` },
			}),
		},
		data: { createBook: { __typename: "Book", id: CREATED, status: "DRAFT" } },
		calls: [
			{
				operationId: "Books_create",
				input: { originalLanguage: "en", title: "Low Tide" },
			},
		],
	},
	{
		name: "a mutation with one success body is still a union",
		claims: ["mutation2xx"],
		fixture: "extras",
		document: `mutation { batchItems { __typename ... on BatchItemsOK { value { id name } } } }`,
		handlers: { Items_batch: () => ({ status: 200, body: [item] }) },
		data: { batchItems: { __typename: "BatchItemsOK", value: [item] } },
		calls: [{ operationId: "Items_batch", input: {} }],
	},
	{
		name: "a declared 409 on a mutation is its member, selected through the shared interface",
		claims: ["mutation4xx", "interface"],
		fixture: "idiom",
		document: `mutation { createBook(input: { originalLanguage: "en" }) {
			__typename ... on ProblemFieldsInterface { title detail } } }`,
		handlers: {
			Books_create: () => ({
				status: 409,
				body: { ...problem(409, "Conflict"), detail: "a book with this source exists" },
			}),
		},
		data: {
			createBook: {
				__typename: "ConflictProblem",
				title: "Conflict",
				detail: "a book with this source exists",
			},
		},
		calls: [{ operationId: "Books_create", input: { originalLanguage: "en" } }],
	},
	{
		name: "a declared 400 on a mutation is its member, with the model's own fields",
		claims: ["mutation4xx", "interface", "names"],
		fixture: "idiom",
		document: `mutation { createBook(input: { originalLanguage: "en" }) {
			__typename ... on ValidationProblem { status requestId errors { pointer detail } }
			... on ProblemFieldsInterface { title } } }`,
		handlers: {
			Books_create: () => ({
				status: 400,
				body: {
					...problem(400, "Bad Request"),
					requestId: "req-1",
					errors: [{ pointer: "/title", detail: "too long" }],
				},
			}),
		},
		data: {
			createBook: {
				__typename: "ValidationProblem",
				status: 400,
				requestId: "req-1",
				errors: [{ pointer: "/title", detail: "too long" }],
				title: "Bad Request",
			},
		},
		calls: [{ operationId: "Books_create", input: { originalLanguage: "en" } }],
	},
	{
		name: "a declared 412 on a mutation is its member",
		claims: ["mutation4xx"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT} }) { __typename ... on Unmet { message } } }`,
		handlers: { Items_create: () => ({ status: 412, body: { message: "stale store" } }) },
		data: { createItem: { __typename: "Unmet", message: "stale store" } },
		calls: [{ operationId: "Items_create", input: ITEM_WIRE }],
	},
	{
		name: "a declared 422 on a mutation is its member",
		claims: ["mutation4xx"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT} }) {
			__typename ... on Unprocessable { message } } }`,
		handlers: { Items_create: () => ({ status: 422, body: { message: "names are unique" } }) },
		data: { createItem: { __typename: "Unprocessable", message: "names are unique" } },
		calls: [{ operationId: "Items_create", input: ITEM_WIRE }],
	},
	{
		name: "a declared 404 on a mutation is its member",
		claims: ["mutation4xx"],
		fixture: "idiom",
		document: `mutation { deleteBook(input: { bookId: "${BOOK}" }) {
			__typename ... on NotFoundProblem { status } } }`,
		handlers: { Books_remove: () => ({ status: 404, body: problem(404, "Not Found") }) },
		data: { deleteBook: { __typename: "NotFoundProblem", status: 404 } },
		calls: [{ operationId: "Books_remove", input: { bookId: BOOK } }],
	},
	{
		name: "a declared 429 on a mutation is top-level, with Retry-After",
		claims: ["mutationTopLevel"],
		fixture: "idiom",
		document: `mutation { createBook(input: { originalLanguage: "en" }) { __typename } }`,
		handlers: {
			Books_create: () => ({
				status: 429,
				body: problem(429, "Too Many Requests"),
				headers: { "retry-after": 3 },
			}),
		},
		data: { createBook: null },
		errors: [
			{
				path: ["createBook"],
				code: "RATE_LIMITED",
				status: 429,
				retryAfter: 3,
				body: problem(429, "Too Many Requests"),
			},
		],
		calls: [{ operationId: "Books_create", input: { originalLanguage: "en" } }],
	},
	{
		name: "a declared 401 on a mutation is top-level",
		claims: ["mutationTopLevel"],
		fixture: "idiom",
		document: `mutation { deleteBook(input: { bookId: "${BOOK}" }) { __typename } }`,
		handlers: {
			Books_remove: () => ({
				status: 401,
				body: problem(401, "Unauthorized"),
				headers: { "www-authenticate": "Bearer" },
			}),
		},
		data: { deleteBook: null },
		errors: [
			{
				path: ["deleteBook"],
				code: "UNAUTHENTICATED",
				status: 401,
				body: problem(401, "Unauthorized"),
			},
		],
		calls: [{ operationId: "Books_remove", input: { bookId: BOOK } }],
	},
	{
		name: "a declared 403 on a mutation is top-level",
		claims: ["mutationTopLevel"],
		fixture: "idiom",
		document: `mutation { updateBook(input: { bookId: "${BOOK}" }) { __typename } }`,
		handlers: { Books_update: () => ({ status: 403, body: problem(403, "Forbidden") }) },
		data: { updateBook: null },
		errors: [
			{
				path: ["updateBook"],
				code: "FORBIDDEN",
				status: 403,
				body: problem(403, "Forbidden"),
			},
		],
		calls: [
			{
				operationId: "Books_update",
				input: { bookId: BOOK, "Content-Type": "application/merge-patch+json" },
			},
		],
	},
	{
		name: "a 404 under a mutation's default arm is the default model as a member",
		claims: ["byStatus"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT} }) { __typename ... on Problem { message } } }`,
		handlers: { Items_create: () => ({ status: 404, body: { message: "no such store" } }) },
		data: { createItem: { __typename: "Problem", message: "no such store" } },
		calls: [{ operationId: "Items_create", input: ITEM_WIRE }],
	},
	{
		name: "a 500 under a mutation's default arm is top-level with its body",
		claims: ["byStatus", "serverError"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT} }) { __typename } }`,
		handlers: { Items_create: () => ({ status: 500, body: { message: "try again" } }) },
		data: { createItem: null },
		errors: [
			{
				path: ["createItem"],
				code: "INTERNAL_SERVER_ERROR",
				status: 500,
				body: { message: "try again" },
			},
		],
		calls: [{ operationId: "Items_create", input: ITEM_WIRE }],
	},
	{
		name: "a 429 under a mutation's default arm is top-level, not a member",
		claims: ["byStatus", "mutationTopLevel"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT} }) { __typename } }`,
		handlers: { Items_create: () => ({ status: 429, body: { message: "slow down" } }) },
		data: { createItem: null },
		errors: [
			{ path: ["createItem"], code: "RATE_LIMITED", status: 429, body: { message: "slow down" } },
		],
		calls: [{ operationId: "Items_create", input: ITEM_WIRE }],
	},
	{
		name: "a refusal whose body looks like an Item is still the refusal's member",
		claims: ["memberByStatus", "mutation4xx"],
		fixture: "extras",
		document: `mutation { createItem(input: { ${ITEM_INPUT} }) {
			__typename ... on Item { id } ... on Unmet { message } } }`,
		handlers: {
			Items_create: () => ({ status: 412, body: { ...item, message: "stale store" } }),
		},
		data: { createItem: { __typename: "Unmet", message: "stale store" } },
		calls: [{ operationId: "Items_create", input: ITEM_WIRE }],
	},
	{
		name: "a bodyless success member carries success: true",
		claims: ["success", "mutation2xx"],
		fixture: "idiom",
		document: `mutation { deleteBook(input: { bookId: "${BOOK}" }) {
			__typename ... on DeleteBookNoContent { success } } }`,
		handlers: { Books_remove: () => ({ status: 204 }) },
		data: { deleteBook: { __typename: "DeleteBookNoContent", success: true } },
		calls: [{ operationId: "Books_remove", input: { bookId: BOOK } }],
	},
	{
		name: "a bodyless refusal member carries success: false",
		claims: ["success", "mutation4xx"],
		fixture: "extras",
		document: `mutation { removeItem(input: { id: "i1" }) {
			__typename ... on RemoveItemNotFound { success } ... on RemoveItemNoContent { success } } }`,
		handlers: { Items_remove: () => ({ status: 404 }) },
		data: { removeItem: { __typename: "RemoveItemNotFound", success: false } },
		calls: [{ operationId: "Items_remove", input: { id: "i1" } }],
	},
	{
		name: "a bodyless success on extras carries success: true",
		claims: ["success"],
		fixture: "extras",
		document: `mutation { removeItem(input: { id: "i1" }) { __typename ... on RemoveItemNoContent { success } } }`,
		handlers: { Items_remove: () => ({ status: 204 }) },
		data: { removeItem: { __typename: "RemoveItemNoContent", success: true } },
		calls: [{ operationId: "Items_remove", input: { id: "i1" } }],
	},

	// The caller.
	{
		name: "authorize answering unauthenticated is UNAUTHENTICATED, and no handler runs",
		claims: ["authorize"],
		fixture: "idiom",
		document: `{ author(authorId: "${AUTHOR}") { name } }`,
		authorize: "unauthenticated",
		data: { author: null },
		errors: [{ path: ["author"], code: "UNAUTHENTICATED" }],
		calls: [],
	},
	{
		name: "authorize answering forbidden is FORBIDDEN, and no handler runs",
		claims: ["authorize"],
		fixture: "idiom",
		document: `mutation { createBook(input: { originalLanguage: "en" }) { __typename } }`,
		authorize: "forbidden",
		data: { createBook: null },
		errors: [{ path: ["createBook"], code: "FORBIDDEN" }],
		calls: [],
	},
	{
		name: "a null caller is UNAUTHENTICATED, and no handler runs",
		claims: ["context"],
		fixture: "idiom",
		document: `{ author(authorId: "${AUTHOR}") { name } }`,
		caller: null,
		data: { author: null },
		errors: [{ path: ["author"], code: "UNAUTHENTICATED" }],
		calls: [],
	},
	{
		name: "the caller deps.context returns is the one the handler receives",
		claims: ["context"],
		fixture: "idiom",
		document: `{ author(authorId: "${AUTHOR}") { name } }`,
		caller: { subject: "bob" },
		handlers: { Authors_read: (caller) => read(author(`seen by ${caller.subject}`)) },
		data: { author: { name: "seen by bob" } },
		calls: [{ operationId: "Authors_read", input: { authorId: AUTHOR } }],
	},

	// Connections.
	{
		name: "a connection page is edges, nodes and pageInfo, each edge with a cursor",
		claims: ["connectionShape", "edgeCursors", "forwardOnly", "first"],
		fixture: "idiom",
		document: `{ authors(first: 2) { ${PAGE} } }`,
		handlers: { Authors_list: (_caller, input) => paged(AUTHORS, input) },
		data: {
			authors: {
				edges: [
					{ cursor, node: { id: authorId(1) } },
					{ cursor, node: { id: authorId(2) } },
				],
				nodes: [{ id: authorId(1) }, { id: authorId(2) }],
				pageInfo: {
					hasNextPage: true,
					hasPreviousPage: false,
					startCursor: cursor,
					endCursor: cursor,
				},
			},
		},
		calls: [{ operationId: "Authors_list", input: { limit: 2 } }],
		also: cursorsAreTheEdges("authors"),
	},
	{
		name: "the last page has no next page, and its end cursor is its last edge's",
		claims: ["edgeCursors", "forwardOnly"],
		fixture: "idiom",
		document: `{ authors(first: 10) { ${PAGE} } }`,
		handlers: { Authors_list: (_caller, input) => paged(AUTHORS, input) },
		data: {
			authors: {
				edges: AUTHORS.map((t) => ({ cursor, node: { id: t.id } })),
				nodes: AUTHORS.map((t) => ({ id: t.id })),
				pageInfo: {
					hasNextPage: false,
					hasPreviousPage: false,
					startCursor: cursor,
					endCursor: cursor,
				},
			},
		},
		calls: [{ operationId: "Authors_list", input: { limit: 10 } }],
		also: cursorsAreTheEdges("authors"),
	},
	{
		name: "an empty page has no cursors",
		claims: ["edgeCursors", "connectionShape"],
		fixture: "idiom",
		document: `{ authors { ${PAGE} } }`,
		handlers: { Authors_list: () => ({ status: 200, body: { items: [], nextCursor: null } }) },
		data: {
			authors: {
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
		calls: [{ operationId: "Authors_list", input: { limit: 50 } }],
	},
	{
		name: "first left out is the operation's default page size",
		claims: ["defaults", "first"],
		fixture: "idiom",
		document: `{ authors { nodes { id } } }`,
		handlers: { Authors_list: (_caller, input) => paged(AUTHORS, input) },
		data: { authors: { nodes: AUTHORS.map((t) => ({ id: t.id })) } },
		calls: [{ operationId: "Authors_list", input: { limit: 50 } }],
	},
	{
		// An unset variable takes the argument's default (graphql 17's `getArgumentValues`), which
		// Yoga's executor applies from `@graphql-tools/executor` 2.0.5 (graphql-tools#8511).
		name: "first bound to a variable the request leaves unset is the default page size",
		claims: ["defaults", "first"],
		fixture: "idiom",
		document: `query ($n: Int) { authors(first: $n) { nodes { id } } }`,
		handlers: { Authors_list: (_caller, input) => paged(AUTHORS, input) },
		data: { authors: { nodes: AUTHORS.map((t) => ({ id: t.id })) } },
		calls: [{ operationId: "Authors_list", input: { limit: 50 } }],
	},
	{
		// The guard on Yoga's executor: before `@graphql-tools/utils` 12.1.0 (graphql-tools#8511) it
		// handed the resolver the enum's NAME, `NEWEST`, which the request schema refuses.
		name: "an enum left out is its default, and the handler receives its wire value",
		claims: ["defaults"],
		fixture: "extras",
		document: `{ sortedItems { id } }`,
		handlers: { Items_sorted: () => ({ status: 200, body: [item] }) },
		data: { sortedItems: [{ id: "i1" }] },
		calls: [{ operationId: "Items_sorted", input: { order: "newest" } }],
	},
	{
		// Before `@graphql-tools/utils` 12.1.0 (graphql-tools#8511) Yoga's executor dropped the default
		// for an unset variable, and the request schema's own default stood in.
		name: "an enum bound to a variable the request leaves unset is its default's wire value",
		claims: ["defaults"],
		fixture: "extras",
		document: `query ($order: Order) { sortedItems(order: $order) { id } }`,
		handlers: { Items_sorted: () => ({ status: 200, body: [item] }) },
		data: { sortedItems: [{ id: "i1" }] },
		calls: [{ operationId: "Items_sorted", input: { order: "newest" } }],
	},
	{
		name: "an enum value given reaches the handler as its wire value",
		claims: ["defaults"],
		fixture: "extras",
		document: `{ sortedItems(order: OLDEST) { id } }`,
		handlers: { Items_sorted: () => ({ status: 200, body: [item] }) },
		data: { sortedItems: [{ id: "i1" }] },
		calls: [{ operationId: "Items_sorted", input: { order: "oldest" } }],
	},
	{
		name: "first left out where the page size has no default sends no page size",
		claims: ["first"],
		fixture: "extras",
		document: `{ items { nodes { id } pageInfo { hasNextPage } } }`,
		handlers: { Items_list: () => ({ status: 200, body: { items: [item] } }) },
		data: { items: { nodes: [{ id: "i1" }], pageInfo: { hasNextPage: false } } },
		calls: [{ operationId: "Items_list", input: {} }],
	},
	{
		name: "first above a maximum with no default is BAD_USER_INPUT at first",
		claims: ["first", "validation"],
		fixture: "extras",
		document: `{ items(first: 101) { nodes { id } } }`,
		data: { items: null },
		errors: [
			{
				path: ["items"],
				code: "BAD_USER_INPUT",
				issues: [{ path: ["first"], wirePath: ["size"] }],
			},
		],
		calls: [],
	},
	{
		name: "first above the operation's maximum is BAD_USER_INPUT at first",
		claims: ["first", "validation"],
		fixture: "idiom",
		document: `{ authors(first: 500) { nodes { id } } }`,
		data: { authors: null },
		errors: [
			{
				path: ["authors"],
				code: "BAD_USER_INPUT",
				issues: [{ path: ["first"], wirePath: ["limit"] }],
			},
		],
		calls: [],
	},
	{
		name: "a negative first is BAD_USER_INPUT, and the handler is not called",
		claims: ["first"],
		fixture: "idiom",
		document: `{ authors(first: -1) { nodes { id } } }`,
		data: { authors: null },
		errors: [
			{
				path: ["authors"],
				code: "BAD_USER_INPUT",
				issues: [{ path: ["first"], wirePath: ["limit"] }],
			},
		],
		calls: [],
	},
	{
		name: "a page the backend answers longer than first is cut to it",
		claims: ["first", "edgeCursors"],
		fixture: "idiom",
		document: `{ authors(first: 2) { ${PAGE} } }`,
		handlers: { Authors_list: () => ({ status: 200, body: { items: AUTHORS, nextCursor: null } }) },
		data: {
			authors: {
				edges: [
					{ cursor, node: { id: authorId(1) } },
					{ cursor, node: { id: authorId(2) } },
				],
				nodes: [{ id: authorId(1) }, { id: authorId(2) }],
				pageInfo: {
					hasNextPage: true,
					hasPreviousPage: false,
					startCursor: cursor,
					endCursor: cursor,
				},
			},
		},
		calls: [{ operationId: "Authors_list", input: { limit: 2 } }],
		also: cursorsAreTheEdges("authors"),
	},
	{
		name: "after the end cursor, the handler receives the backend's next token",
		claims: ["after"],
		fixture: "idiom",
		prelude: `{ authors(first: 2) { pageInfo { endCursor } } }`,
		document: `query ($after: String) { authors(first: 2, after: $after) { nodes { id } } }`,
		variables: (prelude) => ({
			after: authorsOf<{ pageInfo: PageInfo }>(prelude).pageInfo.endCursor,
		}),
		handlers: { Authors_list: (_caller, input) => paged(AUTHORS, input) },
		data: { authors: { nodes: [{ id: authorId(3) }, { id: authorId(4) }] } },
		calls: [{ operationId: "Authors_list", input: { limit: 2, cursor: "offset:2" } }],
	},
	{
		name: "after the first edge's cursor, the page resumes at the second item",
		claims: ["after", "edgeCursors"],
		fixture: "idiom",
		prelude: `{ authors(first: 2) { edges { cursor } } }`,
		document: `query ($after: String) { authors(first: 2, after: $after) { nodes { id } } }`,
		variables: (prelude) => ({
			after: authorsOf<{ edges: Edges }>(prelude).edges[0]?.cursor,
		}),
		handlers: { Authors_list: (_caller, input) => paged(AUTHORS, input) },
		data: { authors: { nodes: [{ id: authorId(2) }, { id: authorId(3) }] } },
		calls: [{ operationId: "Authors_list", input: { limit: 3 } }],
	},
	{
		name: "after the end cursor of a page that was cut, nothing is skipped",
		claims: ["after", "first"],
		fixture: "idiom",
		prelude: `{ authors(first: 2) { pageInfo { endCursor } } }`,
		document: `query ($after: String) { authors(first: 2, after: $after) { nodes { id } } }`,
		variables: (prelude) => ({
			after: authorsOf<{ pageInfo: PageInfo }>(prelude).pageInfo.endCursor,
		}),
		handlers: { Authors_list: () => ({ status: 200, body: { items: AUTHORS, nextCursor: null } }) },
		data: { authors: { nodes: [{ id: authorId(3) }, { id: authorId(4) }] } },
		calls: [{ operationId: "Authors_list", input: { limit: 4 } }],
	},
	{
		name: "an after that is not this connection's cursor is BAD_USER_INPUT",
		claims: ["after"],
		fixture: "idiom",
		document: `{ authors(after: "offset:2") { nodes { id } } }`,
		data: { authors: null },
		errors: [
			{
				path: ["authors"],
				code: "BAD_USER_INPUT",
				issues: [{ path: ["after"], wirePath: ["cursor"] }],
			},
		],
		calls: [],
	},

	// Calls per request.
	{
		name: "fifty books by one author cost one author read",
		claims: ["memo"],
		fixture: "idiom",
		document: `{ books(first: 50) { nodes { author { name } } } }`,
		handlers: {
			Books_list: () => ({
				status: 200,
				body: {
					items: Array.from({ length: 50 }, (_, n) =>
						book({ id: `0b7e1c44-5a2d-4f6e-8c3b-${String(1000 + n).padStart(12, "0")}` }),
					),
					nextCursor: null,
				},
			}),
			Authors_read: () => read(author()),
		},
		data: {
			books: {
				nodes: Array.from({ length: 50 }, () => ({ author: { name: "Ada Lane" } })),
			},
		},
		calls: [
			{ operationId: "Books_list", input: { limit: 50 } },
			{ operationId: "Authors_read", input: { authorId: AUTHOR } },
		],
	},
	{
		name: "two aliases of one call with one input share it",
		claims: ["memo"],
		fixture: "idiom",
		document: `{ a: author(authorId: "${AUTHOR}") { name } b: author(authorId: "${AUTHOR}") { id } }`,
		handlers: { Authors_read: () => read(author()) },
		data: { a: { name: "Ada Lane" }, b: { id: AUTHOR } },
		calls: [{ operationId: "Authors_read", input: { authorId: AUTHOR } }],
	},
	{
		name: "two aliases with different inputs are two calls",
		claims: ["memo"],
		fixture: "idiom",
		document: `{ a: author(authorId: "${AUTHOR}") { id } b: author(authorId: "${OTHER_AUTHOR}") { id } }`,
		handlers: {
			Authors_read: (_caller, input) => read({ ...author(), id: input["authorId"] }),
		},
		data: { a: { id: AUTHOR }, b: { id: OTHER_AUTHOR } },
		calls: [
			{ operationId: "Authors_read", input: { authorId: AUTHOR } },
			{ operationId: "Authors_read", input: { authorId: OTHER_AUTHOR } },
		],
	},
	{
		name: "a second request is answered afresh: the memo is per context",
		claims: ["memo", "contextPerRequest"],
		fixture: "idiom",
		document: `{ author(authorId: "${AUTHOR}") { name } }`,
		times: 2,
		handlers: { Authors_read: () => read(author()) },
		data: { author: { name: "Ada Lane" } },
		calls: [
			{ operationId: "Authors_read", input: { authorId: AUTHOR } },
			{ operationId: "Authors_read", input: { authorId: AUTHOR } },
		],
	},
	{
		name: "a refusal by authorize is shared with the alias that shares the call",
		claims: ["contextPerRequest", "authorize"],
		fixture: "idiom",
		document: `{ a: author(authorId: "${AUTHOR}") { name } b: author(authorId: "${AUTHOR}") { name } }`,
		authorize: "forbidden",
		data: { a: null, b: null },
		errors: [
			{ path: ["a"], code: "FORBIDDEN" },
			{ path: ["b"], code: "FORBIDDEN" },
		],
		calls: [],
	},
	{
		name: "two mutations with one input are two calls",
		claims: ["mutationMemo"],
		fixture: "idiom",
		document: `mutation {
			a: deleteBook(input: { bookId: "${BOOK}" }) { __typename }
			b: deleteBook(input: { bookId: "${BOOK}" }) { __typename } }`,
		handlers: { Books_remove: () => ({ status: 204 }) },
		data: {
			a: { __typename: "DeleteBookNoContent" },
			b: { __typename: "DeleteBookNoContent" },
		},
		calls: [
			{ operationId: "Books_remove", input: { bookId: BOOK } },
			{ operationId: "Books_remove", input: { bookId: BOOK } },
		],
	},
	{
		name: "a read after a mutation is answered afresh",
		claims: ["mutationMemo", "memo"],
		fixture: "idiom",
		document: `mutation {
			a: createBook(input: { originalLanguage: "en" }) { ... on Book { author { name } } }
			b: deleteBook(input: { bookId: "${BOOK}" }) { __typename }
			c: createBook(input: { originalLanguage: "en" }) { ... on Book { author { name } } } }`,
		handlers: (() => {
			let reads = 0;
			return {
				Books_create: () => ({
					status: 201,
					body: book({ id: CREATED }),
					headers: { location: `/v1/books/${CREATED}` },
				}),
				Books_remove: () => ({ status: 204 }),
				Authors_read: () => {
					reads += 1;
					return read(author(`read ${String(reads)}`));
				},
			};
		})(),
		data: {
			a: { author: { name: "read 1" } },
			b: { __typename: "DeleteBookNoContent" },
			c: { author: { name: "read 2" } },
		},
		calls: [
			{ operationId: "Books_create", input: { originalLanguage: "en" } },
			{ operationId: "Authors_read", input: { authorId: AUTHOR } },
			{ operationId: "Books_remove", input: { bookId: BOOK } },
			{ operationId: "Books_create", input: { originalLanguage: "en" } },
			{ operationId: "Authors_read", input: { authorId: AUTHOR } },
		],
	},

	// What introspection shows.
	{
		name: "a connection link states its default page size",
		claims: ["defaults"],
		fixture: "idiom",
		document: `{ __type(name: "Author") { fields { name args { name defaultValue } } } }`,
		data: {
			__type: {
				fields: [
					{ name: "id", args: [] },
					{ name: "publisherId", args: [] },
					{ name: "name", args: [] },
					{ name: "createdAt", args: [] },
					{
						name: "editors",
						args: [
							{ name: "first", defaultValue: "50" },
							{ name: "after", defaultValue: null },
						],
					},
				],
			},
		},
		calls: [],
	},
	{
		name: "a deprecated output field is @deprecated",
		claims: ["deprecated"],
		fixture: "extras",
		document: `{ __type(name: "Item") { fields(includeDeprecated: true) { name isDeprecated deprecationReason } } }`,
		data: {
			__type: {
				fields: [
					{ name: "id", isDeprecated: false, deprecationReason: null },
					{ name: "name", isDeprecated: false, deprecationReason: null },
					{ name: "label", isDeprecated: true, deprecationReason: "use name" },
					{ name: "createdAt", isDeprecated: false, deprecationReason: null },
				],
			},
		},
		calls: [],
	},
	{
		name: "a deprecated required input field says so at the end of its description instead",
		claims: ["deprecated"],
		fixture: "extras",
		document: `{ __type(name: "CreateItemInput") {
			inputFields(includeDeprecated: true) { name isDeprecated description } } }`,
		data: {
			__type: {
				inputFields: [
					{ name: "xStore", isDeprecated: false, description: null },
					{ name: "name", isDeprecated: false, description: null },
					{
						name: "note",
						isDeprecated: false,
						description:
							"Required, and may be null: GraphQL lets a caller leave it out, and then it is null.",
					},
					{ name: "ownerId", isDeprecated: false, description: null },
					{ name: "kind", isDeprecated: false, description: "Deprecated: kinds are inferred" },
				],
			},
		},
		calls: [],
	},
	{
		name: "a deprecated parameter is @deprecated on an optional argument, described on a required one",
		claims: ["deprecatedParameter", "encode", "arguments"],
		fixture: "extras",
		document: `{ __type(name: "Query") { fields { name
			args(includeDeprecated: true) { name type { name kind ofType { name } } isDeprecated deprecationReason description } } } }`,
		data: {
			__type: {
				fields: [
					{
						name: "item",
						args: [
							{
								name: "id",
								type: { name: null, kind: "NON_NULL", ofType: { name: "String" } },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
							{
								name: "legacy",
								type: { name: "String", kind: "SCALAR", ofType: null },
								isDeprecated: true,
								deprecationReason: "address an item by its id",
								description: null,
							},
						],
					},
					{
						name: "itemAsOf",
						args: [
							{
								name: "id",
								type: { name: null, kind: "NON_NULL", ofType: { name: "String" } },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
							{
								name: "xAsOf",
								type: { name: null, kind: "NON_NULL", ofType: { name: "UTCDateTimeHuman" } },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
						],
					},
					{
						name: "itemEither",
						args: [
							{
								name: "id",
								type: { name: null, kind: "NON_NULL", ofType: { name: "String" } },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
							{
								name: "xApiVersion",
								type: { name: null, kind: "NON_NULL", ofType: { name: "String" } },
								isDeprecated: false,
								deprecationReason: null,
								description: "Deprecated: sent for old clients",
							},
							{
								name: "editionName",
								type: { name: "String", kind: "SCALAR", ofType: null },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
						],
					},
					{
						name: "itemExists",
						args: [
							{
								name: "id",
								type: { name: null, kind: "NON_NULL", ofType: { name: "String" } },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
						],
					},
					{
						name: "itemHistory",
						args: [
							{
								name: "id",
								type: { name: null, kind: "NON_NULL", ofType: { name: "String" } },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
							{
								name: "since",
								type: { name: "UTCDateTimeUnix", kind: "SCALAR", ofType: null },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
							{
								name: "after",
								type: { name: "Long", kind: "SCALAR", ofType: null },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
							{
								name: "xWindow",
								type: { name: null, kind: "NON_NULL", ofType: { name: "DurationSeconds" } },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
						],
					},
					{
						name: "items",
						args: [
							{
								name: "first",
								type: { name: "Int", kind: "SCALAR", ofType: null },
								isDeprecated: false,
								deprecationReason: null,
								description: prose,
							},
							{
								name: "after",
								type: { name: "String", kind: "SCALAR", ofType: null },
								isDeprecated: false,
								deprecationReason: null,
								description: prose,
							},
						],
					},
					{
						name: "sortedItems",
						args: [
							{
								name: "order",
								type: { name: "Order", kind: "ENUM", ofType: null },
								isDeprecated: false,
								deprecationReason: null,
								description: null,
							},
						],
					},
				],
			},
		},
		calls: [],
	},
];

// ---------------------------------------------------------------------------------------------
// The harness: each fixture's emitted schema, served through Yoga, over the row's handlers.
// ---------------------------------------------------------------------------------------------

/** The emitted module, as far as this suite calls it. */
interface GraphQLModule {
	readonly createSchema: (
		handlersFor: () => object,
		deps: {
			readonly authorize: () => "allow" | "unauthenticated" | "forbidden";
			readonly context: () => Caller | null;
		},
		extend?: (types: Readonly<Record<string, unknown>>) => unknown,
	) => GraphQLSchema;
}

const log = new CallLog();
let current: Row | undefined;

const OPERATIONS: Readonly<Record<Row["fixture"], readonly string[]>> = {
	idiom: [
		"Publishers_read",
		"Authors_list",
		"Authors_read",
		"Authors_listEditors",
		"Editors_read",
		"Books_create",
		"Books_list",
		"Books_read",
		"Books_update",
		"Books_remove",
		"BookEditions_list",
		"Editions_read",
	],
	extras: [
		"Items_list",
		"Items_read",
		"Items_exists",
		"Items_either",
		"Items_create",
		"Items_batch",
		"Items_history",
		"Items_asOf",
		"Items_remove",
		"Items_sorted",
	],
};

/** Every operation, answering only what the current row scripts: an unscripted call throws. */
function handlersOf(fixture: Row["fixture"]): object {
	const handlers: Record<string, Handler> = {};
	for (const operationId of OPERATIONS[fixture]) {
		handlers[operationId] = (caller, input) => {
			const scripted = current?.handlers?.[operationId];
			if (scripted === undefined) throw new Error(`${operationId} is not scripted by this row`);
			return scripted(caller, input);
		};
	}
	return log.wrap(handlers);
}

const deps = {
	authorize: () => current?.authorize ?? "allow",
	context: () =>
		current !== undefined && "caller" in current ? (current.caller ?? null) : { subject: "alice" },
};

const modules = new Map<Row["fixture"], GraphQLModule>();
const schemas = new Map<Row["fixture"], GraphQLSchema>();
let extras: CompiledFixture;

beforeAll(async () => {
	const idiom = await compileFixture(idiomDir, "main", { outName: "claims" });
	extras = await compileFixture(extrasDir, "main", { outDir: join(here, ".out", "extras") });
	for (const [fixture, compiled] of [
		["idiom", idiom],
		["extras", extras],
	] as const) {
		expect(compiled.diagnostics, fixture).toEqual([]);
		const module = (await import(join(compiled.outDir, "graphql.gen.ts"))) as GraphQLModule;
		const handlers = handlersOf(fixture);
		modules.set(fixture, module);
		schemas.set(
			fixture,
			module.createSchema(() => handlers, deps),
		);
	}
}, 300_000);

/** An error as the README describes it: where, which code, and what `extensions` carries. */
function reduced(error: NonNullable<GraphQLResult["errors"]>[number]): ExpectedError {
	const extensions = error.extensions ?? {};
	const issues = extensions["issues"] as
		| readonly { readonly path: (string | number)[]; readonly wirePath: (string | number)[] }[]
		| undefined;
	return {
		path: error.path ?? [],
		code: extensions["code"] as string,
		...(extensions["status"] === undefined ? {} : { status: extensions["status"] as number }),
		...(extensions["retryAfter"] === undefined
			? {}
			: { retryAfter: extensions["retryAfter"] as number }),
		...(extensions["body"] === undefined ? {} : { body: extensions["body"] }),
		...(issues === undefined
			? {}
			: { issues: issues.map((issue) => ({ path: issue.path, wirePath: issue.wirePath })) }),
		...(error.message === "Unexpected error." ? { masked: true as const } : {}),
	};
}

async function run(row: Row): Promise<GraphQLResult> {
	const schema = schemas.get(row.fixture);
	if (schema === undefined) throw new Error(`no schema for ${row.fixture}`);
	current = row;
	const prelude =
		row.prelude === undefined
			? undefined
			: await executeThroughYoga(schema, { query: row.prelude }, {});
	expect(prelude?.errors, "the prelude answers without error").toBeUndefined();
	log.clear();
	const variables = row.variables?.(prelude);
	let result: GraphQLResult | undefined;
	for (let n = 0; n < (row.times ?? 1); n += 1) {
		result = await executeThroughYoga(
			schema,
			variables === undefined ? { query: row.document } : { query: row.document, variables },
			{},
		);
	}
	if (result === undefined) throw new Error("the row ran no request");
	return result;
}

describe("each README claim, row by row", () => {
	it.each(ROWS.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
		const result = await run(row);
		expect(
			{
				data: result.data,
				errors: result.errors?.map(reduced),
				calls: log.calls,
			},
			JSON.stringify(result, null, 1),
		).toEqual({ data: row.data, errors: row.errors, calls: row.calls });
		row.also?.(result);
	});
});

/** README.md as prose: emphasis markers dropped and every run of whitespace one space. */
const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8")
	.replaceAll("**", "")
	.replaceAll(/\s+/g, " ");

describe("the rows grade the README as it reads", () => {
	it.each(Object.entries(CLAIMS))("quotes %s from README.md", (_key, quote) => {
		expect(readme).toContain(quote);
	});

	it("has a row for every claim, and every row grades one", () => {
		const graded = new Set([...ROWS.flatMap((row) => row.claims), ...SCHEMA_CLAIMS]);
		expect(Object.keys(CLAIMS).filter((claim) => !graded.has(claim as Claim))).toEqual([]);
		expect(ROWS.every((row) => row.claims.length > 0)).toBe(true);
	});

	it("is a matrix, not a sample: rows enough of each outcome, every row named once", () => {
		expect(ROWS.length).toBeGreaterThanOrEqual(60);
		expect(ROWS.filter((row) => row.errors !== undefined).length).toBeGreaterThanOrEqual(25);
		expect(ROWS.filter((row) => row.errors === undefined).length).toBeGreaterThanOrEqual(25);
		expect(new Set(ROWS.map((row) => row.name)).size).toBe(ROWS.length);
	});
});

/** The two claims a request cannot show: what the built schema carries, and how it refuses to be built. */
const SCHEMA_CLAIMS: readonly Claim[] = ["cost", "extendCollision"];

describe("the claims about the built schema", () => {
	it("carries @cost on every root field and link, and @listSize on every connection, in extensions", () => {
		const schema = schemas.get("idiom");
		const fieldsOf = (type: string) => {
			const named = schema?.getType(type);
			if (named === undefined || !("getFields" in named)) throw new Error(`no type ${type}`);
			return named.getFields() as Readonly<
				Record<string, { readonly extensions: Readonly<Record<string, unknown>> }>
			>;
		};
		const cost = { weight: "1" };
		const listSize = {
			slicingArguments: ["first"],
			sizedFields: ["edges", "nodes"],
			requireOneSlicingArgument: false,
		};
		const extensionsOf = (type: string, field: string) => {
			const { cost: fieldCost, listSize: fieldListSize } = fieldsOf(type)[field]?.extensions ?? {};
			return { cost: fieldCost, listSize: fieldListSize };
		};
		const expected: Readonly<Record<string, unknown>> = {
			"Query.publisher": { cost, listSize: undefined },
			"Query.author": { cost, listSize: undefined },
			"Query.authors": { cost, listSize },
			"Query.editor": { cost, listSize: undefined },
			"Query.book": { cost, listSize: undefined },
			"Query.books": { cost, listSize },
			"Query.edition": { cost, listSize: undefined },
			"Mutation.createBook": { cost, listSize: undefined },
			"Mutation.updateBook": { cost, listSize: undefined },
			"Mutation.deleteBook": { cost, listSize: undefined },
			"Book.author": { cost, listSize: undefined },
			"Book.editor": { cost, listSize: undefined },
			"Book.commissionedBy": { cost, listSize: undefined },
			"Book.editions": { cost, listSize },
			"Author.editors": { cost, listSize },
			"Book.title": { cost: undefined, listSize: undefined },
		};
		const actual = Object.fromEntries(
			Object.keys(expected).map((coordinate) => {
				const [type = "", field = ""] = coordinate.split(".");
				return [coordinate, extensionsOf(type, field)];
			}),
		);
		expect(actual).toEqual(expected);
		expect(Object.keys(fieldsOf("Query")).toSorted()).toEqual(
			Object.keys(expected)
				.filter((coordinate) => coordinate.startsWith("Query."))
				.map((coordinate) => coordinate.slice("Query.".length))
				.toSorted(),
		);
	});

	it("carries assumedSize where first has no default, the page size's maximum", () => {
		const items = schemas.get("extras")?.getQueryType()?.getFields()["items"];
		expect(items?.extensions).toEqual({
			cost: { weight: "1" },
			listSize: {
				assumedSize: 100,
				slicingArguments: ["first"],
				sizedFields: ["edges", "nodes"],
				requireOneSlicingArgument: false,
			},
			operationId: "Items_list",
		});
	});

	it("refuses an extension field with a generated field's name, naming both", () => {
		const module = modules.get("idiom");
		expect(() =>
			module?.createSchema(
				() => ({}),
				deps,
				() => ({ query: { book: { type: GraphQLString } } }),
			),
		).toThrow(/book/);
	});
});

/**
 * **`extras/expected.graphql` is the schema a person would write for `extras/main.tsp`**, compared as
 * the idiom suite compares its own, and held to the digest `PROVENANCE.md` records.
 */
describe("extras/expected.graphql", () => {
	const expected = readFileSync(join(extrasDir, "expected.graphql"), "utf8");

	it("is valid in its own right", () => {
		expect(validateSchema(buildSchema(expected))).toEqual([]);
	});

	it("is the emitted schema, descriptions set aside", () => {
		const emitted = readFileSync(join(extras.outDir, "schema.graphql"), "utf8");
		expect(normalised(emitted)).toBe(normalised(expected));
		expect(appliedDirectives(emitted)).toEqual(appliedDirectives(expected));
	});

	it("is the file whose sha256 PROVENANCE.md records", () => {
		const digest = createHash("sha256").update(expected).digest("hex");
		const recorded = /`sha256 ([0-9a-f]{64})`/.exec(
			readFileSync(join(here, "PROVENANCE.md"), "utf8"),
		);
		expect(recorded?.[1]).toBe(digest);
	});
});
