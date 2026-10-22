import type { EmittedResponse, EmittedRoute, RouteSchemaNames } from "typespec-http-zod";
import type {
	AppliedDirective,
	ArgumentPlan,
	CallPlan,
	InputFieldPlan,
	OutputFieldPlan,
	SchemaPlan,
	TypeRef,
} from "../../src/model.js";
import { listOf, named } from "../../src/model.js";
import { SCALAR_DEFINITIONS } from "../../src/types.js";

/**
 * **A SchemaPlan written by hand, with no TypeSpec**, carrying every TypeDef kind and every rendering
 * rule: an object with wire-renamed fields, a deprecated field and a link; a connection with both
 * cost directives; an enum with a deprecated value; a result union and a discriminated union; input
 * objects with `wire` and `dropNull`; arguments with `wire`, `merge` and `dropNull`; two runtime
 * scalars; a mutation whose body is spread into its input and one with a named body; a negotiated
 * `accept`.
 *
 * `SCHEMAS_STUB` is the `schemas.gen.ts` the library would write for these operations, by hand, so
 * the rendered module has every name it imports. `CONSUMER` is a consumer's file, typechecked beside
 * the output: it proves the handler types are inhabitable, and that `GraphQLExhaustive` refuses a
 * surplus handler and a missing one.
 */

const JSON_TYPES = ["application/json"] as const;

function response(
	status: EmittedResponse["status"],
	schema: string | undefined,
	headers: EmittedResponse["headers"] = [],
): EmittedResponse {
	return {
		status,
		schema,
		contentTypes: schema === undefined ? [] : JSON_TYPES,
		headers,
		binary: false,
		streamed: false,
		textual: false,
	};
}

/** An `EmittedRoute` as the library publishes one; `verb` is upper case, as the library writes it. */
function route(
	operationId: string,
	verb: string,
	path: string,
	responses: readonly EmittedResponse[],
	overrides: Partial<EmittedRoute> = {},
): EmittedRoute {
	return {
		operationId,
		verb,
		path,
		reservedPathParameters: [],
		pathSegments: [],
		decodedPathParameters: [],
		sharedInputKeys: [],
		literalQuery: [],
		responses,
		responseContentTypes: JSON_TYPES,
		requestContentTypes: [],
		requestTextual: false,
		summary: undefined,
		requestSchema: undefined,
		pathSchema: undefined,
		cookieSchema: undefined,
		querySchema: undefined,
		queryFieldsSchema: undefined,
		headerSchema: undefined,
		negotiatedHeaderSchema: undefined,
		accept: undefined,
		rawBodyProperty: undefined,
		rawBodyBinary: false,
		rawBodyUnvalidated: false,
		bodyProperty: undefined,
		optionalBody: false,
		authentication: "required",
		scopes: [],
		security: [{ BearerAuth: [] }],
		...overrides,
	};
}

type Groups = Partial<Omit<RouteSchemaNames, "operationId" | "arms" | "responses">>;

function operation(route: EmittedRoute, groups: Groups): SchemaPlan["operations"][number] {
	const names: RouteSchemaNames = {
		operationId: route.operationId,
		path: undefined,
		query: undefined,
		queryFields: undefined,
		header: undefined,
		selectedAccept: undefined,
		cookie: undefined,
		body: undefined,
		arms: route.responses.map((r) => ({ status: r.status, schema: r.schema })),
		responses: `${route.operationId}Responses`,
		...groups,
	};
	return { route, names };
}

const read = route(
	"Books_read",
	"GET",
	"/books/{id}",
	[response(200, "bookSchema"), response(404, "problemSchema")],
	{ summary: "Read one book." },
);
const list = route("Books_list", "GET", "/books", [response(200, "bookPageSchema")]);
const create = route(
	"Books_create",
	"POST",
	"/books",
	[
		response(201, "bookSchema"),
		response(204, undefined),
		response(409, "problemSchema"),
		response(429, "problemSchema", [
			{
				name: "retry-after",
				type: "number",
				schema: "Books_createResponse429Headers",
				optional: true,
			},
		]),
	],
	{ requestContentTypes: JSON_TYPES },
);
const rename = route(
	"Books_rename",
	"PATCH",
	"/books/{id}",
	[response(200, "bookSchema"), response(404, "problemSchema")],
	{ requestContentTypes: JSON_TYPES, bodyProperty: "body" },
);
const summary = route("Books_summary", "GET", "/books/{id}/summary", [
	response(200, "summarySchema"),
]);
const author = route(
	"Authors_read",
	"GET",
	"/authors/{authorId}",
	[response(200, "authorSchema"), response(404, "problemSchema")],
	{ authentication: "optional", security: [{}, { BearerAuth: [] }] },
);

const OPERATIONS: SchemaPlan["operations"] = [
	operation(create, { header: "Books_createHeader", body: "newBookSchema" }),
	operation(list, { query: "Books_listQuery" }),
	operation(read, { path: "Books_readPath", header: "Books_readHeader" }),
	operation(rename, { path: "Books_renamePath", body: "renameSchema" }),
	operation(summary, {
		path: "Books_summaryPath",
		selectedAccept: { name: "accept", value: "application/json" },
	}),
	operation(author, { path: "Authors_readPath" }),
];

/** Every operation the document declares: one more than the surface calls. */
export const DECLARED: readonly string[] = [
	...OPERATIONS.map((o) => o.route.operationId),
	"Books_delete",
];

const COST: AppliedDirective = { name: "cost", arguments: { weight: "1" } };
const LIST_SIZE: AppliedDirective = {
	name: "listSize",
	arguments: {
		slicingArguments: ["first"],
		sizedFields: ["edges", "nodes"],
		requireOneSlicingArgument: false,
	},
};

const str = (nonNull: boolean): TypeRef => named("String", nonNull);

function field(
	name: string,
	type: TypeRef,
	extra: Partial<Omit<OutputFieldPlan, "name" | "type">> = {},
): OutputFieldPlan {
	return {
		name,
		wire: name,
		type,
		description: undefined,
		deprecationReason: undefined,
		arguments: [],
		call: undefined,
		directives: [],
		...extra,
	};
}

function input(
	name: string,
	type: TypeRef,
	extra: Partial<Omit<InputFieldPlan, "name" | "type">> = {},
): InputFieldPlan {
	return {
		name,
		wire: name,
		type,
		description: undefined,
		deprecationReason: undefined,
		dropNull: false,
		nullIfAbsent: false,
		defaultValue: undefined,
		...extra,
	};
}

function argument(
	name: string,
	type: TypeRef,
	extra: Partial<Omit<ArgumentPlan, "name" | "type">> = {},
): ArgumentPlan {
	return {
		name,
		wire: name,
		type,
		description: undefined,
		deprecationReason: undefined,
		merge: false,
		dropNull: false,
		nullIfAbsent: false,
		defaultValue: undefined,
		...extra,
	};
}

function call(
	kind: CallPlan["kind"],
	operationId: string,
	extra: Partial<Omit<CallPlan, "kind" | "operationId">>,
): CallPlan {
	const planned = OPERATIONS.find((o) => o.route.operationId === operationId);
	if (planned === undefined) throw new Error(`no operation ${operationId}`);
	return {
		kind,
		operationId,
		authentication: planned.route.authentication,
		security: planned.route.security,
		inputSchema: `${operationId}GraphQLInput`,
		responses: planned.names.responses,
		bound: [],
		supplied: {},
		projection: {},
		connection: undefined,
		...extra,
	};
}

export const PLAN: SchemaPlan = {
	types: [
		{
			kind: "object",
			name: "Book",
			interfaces: ["IdentifiedInterface"],
			description: "A book, and the author who wrote it.",
			fields: [
				field("id", str(true)),
				field("title", str(true)),
				field("legacyTitle", str(false), {
					wire: "legacy_title",
					deprecationReason: "Use title.",
				}),
				field("status", named("BookStatus", true)),
				field("createdAt", named("UTCDateTime", true), { wire: "created_at" }),
				field("authorId", str(false), { wire: "author_id" }),
				field("metadata", named("JSON", false)),
				// A wire key `Object.prototype` also owns, which no book below carries.
				field("constructor", str(false)),
				field("lastEvent", named("Event", false), { wire: "last_event" }),
				field("author", named("Author", false), {
					description: "The author the book belongs to.",
					call: call("link", "Authors_read", {
						bound: [{ wire: "authorId", parent: "author_id" }],
						projection: { "200": { as: "value" }, "404": { as: "null" } },
					}),
					directives: [COST],
				}),
			],
		},
		{
			kind: "object",
			name: "BookConnection",
			description: undefined,
			fields: [
				field("edges", listOf(named("BookEdge", true), true)),
				field("nodes", listOf(named("Book", true), true)),
				field("pageInfo", named("PageInfo", true)),
			],
		},
		{
			kind: "object",
			name: "BookEdge",
			description: undefined,
			fields: [field("node", named("Book", true)), field("cursor", str(false))],
		},
		{
			kind: "enum",
			name: "BookStatus",
			description: "Where a book is in its life.",
			values: [
				{ name: "OPEN", wire: "open", description: undefined, deprecationReason: undefined },
				{
					name: "ARCHIVED",
					wire: "archived",
					description: "Kept, read-only.",
					deprecationReason: "Use CLOSED.",
				},
				{ name: "CLOSED", wire: "closed", description: undefined, deprecationReason: undefined },
			],
		},
		{
			kind: "object",
			name: "BookSummary",
			description: undefined,
			fields: [field("text", str(true))],
		},
		{
			kind: "input",
			name: "CreateBookInput",
			description: undefined,
			fields: [
				input("xApiVersion", str(true), {
					wire: "x-api-version",
					description: "The API version the caller speaks.",
				}),
				input("title", str(true)),
				input("authorId", str(false), { wire: "author_id", dropNull: true }),
				input("note", str(false), { description: "Kept as null when sent as null." }),
				input("status", named("BookStatus", false), { dropNull: true }),
				input("labels", listOf(named("LabelInput", true), false), { dropNull: true }),
			],
		},
		{
			kind: "object",
			name: "CreateBookNoContent",
			description: undefined,
			fields: [field("status", named("Int", true))],
		},
		{
			kind: "union",
			name: "CreateBookResult",
			description: undefined,
			members: ["Book", "CreateBookNoContent", "Problem"],
			resolveBy: { kind: "member" },
		},
		{
			kind: "union",
			name: "Event",
			description: "Something that happened to a book.",
			members: ["ReviewEvent", "NoteEvent"],
			resolveBy: {
				kind: "discriminator",
				property: "kind",
				mapping: { review: "ReviewEvent", note: "NoteEvent" },
			},
		},
		{
			kind: "scalar",
			name: "JSON",
			...SCALAR_DEFINITIONS.JSON,
		},
		{
			kind: "object",
			name: "ReviewEvent",
			description: undefined,
			fields: [field("kind", str(true)), field("reviewer", str(true))],
		},
		{
			kind: "input",
			name: "LabelInput",
			description: undefined,
			fields: [input("displayName", str(true), { wire: "display_name" })],
		},
		{
			kind: "object",
			name: "NoteEvent",
			description: undefined,
			fields: [field("kind", str(true)), field("text", str(true))],
		},
		{
			kind: "object",
			name: "PageInfo",
			description: undefined,
			fields: [
				field("hasNextPage", named("Boolean", true)),
				field("hasPreviousPage", named("Boolean", true)),
				field("startCursor", str(false)),
				field("endCursor", str(false)),
			],
		},
		{
			kind: "object",
			name: "Problem",
			description: undefined,
			fields: [field("message", str(true))],
		},
		{
			kind: "input",
			name: "RenameBookInput",
			description: undefined,
			fields: [input("id", str(true)), input("body", named("RenameInput", true))],
		},
		{
			kind: "input",
			name: "RenameInput",
			description: undefined,
			fields: [input("title", str(true))],
		},
		{
			kind: "object",
			name: "Author",
			description: undefined,
			interfaces: ["IdentifiedInterface"],
			fields: [field("id", str(true)), field("name", str(true))],
		},
		{
			kind: "interface",
			name: "IdentifiedInterface",
			description: "What every identified thing shares.",
			fields: [field("id", str(true))],
		},
		{
			kind: "scalar",
			name: "UTCDateTime",
			...SCALAR_DEFINITIONS.UTCDateTime,
		},
	],
	query: [
		field("book", named("Book", false), {
			description: "Read one book.",
			arguments: [
				argument("id", str(true)),
				argument("xApiVersion", str(true), {
					wire: "x-api-version",
					description: "The API version the caller speaks.",
				}),
			],
			call: call("query", "Books_read", {
				projection: { "200": { as: "value" }, "404": { as: "null" } },
			}),
			directives: [COST],
		}),
		field("books", named("BookConnection", false), {
			arguments: [
				argument("first", named("Int", false), { wire: "page-size", dropNull: true }),
				argument("after", str(false), { wire: "page-token", dropNull: true }),
				argument("status", named("BookStatus", false), { dropNull: true }),
			],
			call: call("query", "Books_list", {
				projection: { "200": { as: "connection" } },
				connection: {
					items: "items",
					next: "next_token",
					first: "page-size",
					after: "page-token",
					item: named("Book", true),
					maximum: undefined,
					assumedSize: undefined,
				},
			}),
			directives: [COST, LIST_SIZE],
		}),
		field("bookSummary", named("BookSummary", false), {
			arguments: [argument("id", str(true))],
			call: call("query", "Books_summary", {
				supplied: { accept: "application/json" },
				projection: { "200": { as: "value" } },
			}),
			directives: [COST],
		}),
	],
	mutation: [
		field("createBook", named("CreateBookResult", false), {
			description: "Add a book.\n\nThe author is optional.",
			arguments: [argument("input", named("CreateBookInput", true), { merge: true })],
			call: call("mutation", "Books_create", {
				projection: {
					"201": { as: "member", type: "Book" },
					"204": { as: "wrap", type: "CreateBookNoContent", hasBody: false },
					"409": { as: "member", type: "Problem" },
					"429": { as: "error", code: "RATE_LIMITED" },
				},
			}),
			directives: [COST],
		}),
		field("renameBook", named("Book", false), {
			arguments: [argument("input", named("RenameBookInput", true), { merge: true })],
			call: call("mutation", "Books_rename", {
				projection: { "200": { as: "value" }, "404": { as: "error", code: "NOT_FOUND" } },
			}),
			directives: [COST],
		}),
	],
	operations: OPERATIONS,
	statusCodes: {},
	usesCost: true,
};

/** The `schemas.gen.ts` the library would write for `OPERATIONS`, by hand. */
export const SCHEMAS_STUB = `import { z } from "zod";

type ResponseArm = {
	readonly status: number | "default" | \`\${1 | 2 | 3 | 4 | 5}XX\`;
	readonly schema: z.ZodType | undefined;
	readonly contentTypes?: readonly string[];
	readonly headers?: readonly { readonly name: string; readonly optional: boolean }[];
};

export const problemSchema = z.object({ message: z.string() });
export const authorSchema = z.object({ id: z.string(), name: z.string() });
export const bookStatusSchema = z.enum(["open", "archived", "closed"]);
export const noteEventSchema = z.object({ kind: z.literal("note"), text: z.string() });
export const reviewEventSchema = z.object({ kind: z.literal("review"), reviewer: z.string() });
export const eventSchema = z.discriminatedUnion("kind", [noteEventSchema, reviewEventSchema]);
export const bookSchema = z.object({
	id: z.string(),
	title: z.string(),
	legacy_title: z.string().exactOptional(),
	status: bookStatusSchema,
	created_at: z.string(),
	author_id: z.string().nullable(),
	metadata: z.unknown().exactOptional(),
	last_event: eventSchema.nullable(),
});
export const bookPageSchema = z.object({
	items: z.array(bookSchema),
	next_token: z.string().exactOptional(),
});
export const labelSchema = z.object({ display_name: z.string() });
export const newBookSchema = z.object({
	title: z.string().min(1),
	author_id: z.string().exactOptional(),
	note: z.string().nullable().exactOptional(),
	status: bookStatusSchema.exactOptional(),
	labels: z.array(labelSchema).exactOptional(),
});
export const renameSchema = z.object({ title: z.string() });
export const summarySchema = z.object({ text: z.string() });

export const Books_createHeader = z.object({ "x-api-version": z.string() });
export const Books_createResponse429Headers = z.object({ "retry-after": z.int32().exactOptional() });
export const Books_createResponses = [{ status: 201, schema: bookSchema, contentTypes: ["application/json"] }, { status: 204, schema: undefined }, { status: 409, schema: problemSchema, contentTypes: ["application/json"] }, { status: 429, schema: problemSchema, contentTypes: ["application/json"], headers: [{ name: "retry-after", optional: true }] }] satisfies readonly ResponseArm[];
export const Books_listQuery = z.object({
	"page-size": z.int32().max(50).default(20),
	"page-token": z.string().exactOptional(),
	status: bookStatusSchema.exactOptional(),
});
export const Books_listResponses = [{ status: 200, schema: bookPageSchema, contentTypes: ["application/json"] }] satisfies readonly ResponseArm[];
export const Books_readPath = z.object({ id: z.string() });
export const Books_readHeader = z.object({ "x-api-version": z.string() });
export const Books_readResponses = [{ status: 200, schema: bookSchema, contentTypes: ["application/json"] }, { status: 404, schema: problemSchema, contentTypes: ["application/json"] }] satisfies readonly ResponseArm[];
export const Books_renamePath = z.object({ id: z.string() });
export const Books_renameResponses = [{ status: 200, schema: bookSchema, contentTypes: ["application/json"] }, { status: 404, schema: problemSchema, contentTypes: ["application/json"] }] satisfies readonly ResponseArm[];
export const Books_summaryPath = z.object({ id: z.string() });
export const Books_summaryResponses = [{ status: 200, schema: summarySchema, contentTypes: ["application/json"] }] satisfies readonly ResponseArm[];
export const Authors_readPath = z.object({ authorId: z.string() });
export const Authors_readResponses = [{ status: 200, schema: authorSchema, contentTypes: ["application/json"] }, { status: 404, schema: problemSchema, contentTypes: ["application/json"] }] satisfies readonly ResponseArm[];
`;

/** A consumer's file, typechecked beside the output: one handler object, refused when wrong. */
export const CONSUMER = `import { createSchema } from "./graphql.gen.js";
import type { GraphQLDeps } from "./graphql-runtime.gen.js";

interface Request {
	readonly caller: string | null;
}

const deps: GraphQLDeps<Request, string> = {
	authorize: () => "allow",
	context: (request) => request.caller,
};

const book = {
	id: "c1",
	title: "First",
	status: "open" as const,
	created_at: "2026-10-13T00:00:00Z",
	author_id: "t1",
	last_event: null,
};

const handlers = {
	Books_read: (_ctx: string, input: { readonly id: string }) =>
		input.id === "missing"
			? { status: 404 as const, body: { message: "gone" } }
			: { status: 200 as const, body: { ...book, id: input.id } },
	Books_list: () => ({ status: 200 as const, body: { items: [book], next_token: "n1" } }),
	Books_create: async () => ({ status: 201 as const, body: book }),
	Books_rename: (_ctx: string, input: { readonly id: string; readonly body: { readonly title: string } }) => ({
		status: 200 as const,
		body: { ...book, id: input.id, title: input.body.title },
	}),
	Books_summary: (_ctx: string, input: { readonly accept: "application/json" }) => ({
		status: 200 as const,
		body: { text: input.accept },
	}),
	Authors_read: (_ctx: string, input: { readonly authorId: string }) => ({
		status: 200 as const,
		body: { id: input.authorId, name: "Author one" },
	}),
	// Declared by the document and called by no field: accepted, as one object serves every surface.
	Books_delete: () => ({ status: 204 as const }),
};

export const schema = createSchema((_request: Request) => handlers, deps);

const surplus = { ...handlers, Nope_read: () => ({ status: 200 as const }) };
// @ts-expect-error -- Nope_read names no declared operation, so GraphQLExhaustive refuses it.
export const refusedSurplus = createSchema((_request: Request) => surplus, deps);

const incomplete: Omit<typeof handlers, "Authors_read"> = handlers;
// @ts-expect-error -- Authors_read is called through a link, so a handler for it is required.
export const refusedMissing = createSchema((_request: Request) => incomplete, deps);
`;
