import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listOf, named, type OutputFieldPlan, type TypeDef } from "../../src/model.js";
import { planService, type PlannedService } from "../../src/plan.js";
import { surfaceOf } from "../../src/surface.js";
import { serviceOf } from "../support/service-of.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const inputs = fileURLToPath(new URL("../inputs/", import.meta.url));

const COST = { name: "cost", arguments: { weight: "1" } };
const LIST_SIZE = {
	name: "listSize",
	arguments: {
		slicingArguments: ["first"],
		sizedFields: ["edges", "nodes"],
		requireOneSlicingArgument: false,
	},
};

type Planned = PlannedService & { readonly declared: number };

/** Each fixture is compiled and planned once per file; every arm reads the same plan. */
const plans = new Map<string, Promise<Planned>>();

/** The plan for a fixture, through the real surface, with the declaration count it started from. */
function planOf(name: string): Promise<Planned> {
	const cached = plans.get(name);
	if (cached !== undefined) return cached;
	const planned = serviceOf(here, name).then(({ program, emitted }) => {
		const surface = surfaceOf(program, emitted);
		const declared = surface.roots.length + surface.links.length;
		return { ...planService(program, emitted, surface), declared };
	});
	plans.set(name, planned);
	return planned;
}

function rootOf(fields: readonly OutputFieldPlan[], name: string): OutputFieldPlan {
	const field = fields.find((candidate) => candidate.name === name);
	if (field === undefined) throw new Error(`no root field ${name}`);
	return field;
}

function objectOf(types: readonly TypeDef[], name: string): Extract<TypeDef, { kind: "object" }> {
	const def = types.find((candidate) => candidate.name === name);
	if (def?.kind !== "object") throw new Error(`no object ${name}`);
	return def;
}

/**
 * **A request's read-only property, at each OpenAPI version openapi3 publishes**: optional at 3.0,
 * whose `readOnly` makes `required` "take effect on the response only" (OAS 3.0.4), and required at
 * 3.1, as the library validates each. `test/inputs/read-only.test.ts` grades the same fixture
 * through REST and Yoga, by the document.
 */
describe("a request's read-only property", () => {
	it.each([
		["openapi3's default", undefined, false],
		["3.0.0", ["3.0.0"], false],
		["3.1.0", ["3.1.0"], true],
	])(
		"published at %s (openapi-versions %j), is typed non-null: %s",
		async (_version, versions, nonNull) => {
			const { program, emitted } = await serviceOf(inputs, "read-only", versions);
			const { types } = planService(program, emitted, surfaceOf(program, emitted)).plan;
			for (const name of ["CreateWidgetInput", "PartInput"]) {
				const def = types.find((candidate) => candidate.name === name);
				const id =
					def?.kind === "input" ? def.fields.find((field) => field.name === "id") : undefined;
				expect(id?.type, name).toEqual(named("String", nonNull));
			}
		},
	);
});

describe("the bookshop surface", () => {
	it("plans a read as a nullable value, null on 404, through its handler", async () => {
		const { plan } = await planOf("bookshop");
		const book = rootOf(plan.query, "book");
		expect(book).toMatchObject({
			type: named("Book", false),
			description: "Read one book.",
			arguments: [{ name: "bookId", wire: "bookId", type: named("String", true) }],
			directives: [COST],
		});
		expect(book.call).toEqual({
			kind: "query",
			operationId: "Books_read",
			authentication: "none",
			security: [],
			inputSchema: "Books_readGraphQLInput",
			responses: "Books_readResponses",
			bound: [],
			supplied: {},
			projection: { "200": { as: "value" }, "404": { as: "null" } },
			connection: undefined,
		});
	});

	it("plans a list as a connection with first and after, sized by @listSize", async () => {
		const { plan } = await planOf("bookshop");
		const books = rootOf(plan.query, "books");
		expect(books.type).toEqual(named("BookConnection", false));
		expect(books.arguments.map((arg) => [arg.name, arg.wire])).toEqual([
			["first", "limit"],
			["after", "cursor"],
			["authorId", "authorId"],
		]);
		expect(books.directives).toEqual([COST, LIST_SIZE]);
		expect(books.call).toMatchObject({
			projection: { "200": { as: "connection" } },
			connection: {
				items: "items",
				next: "nextCursor",
				first: "limit",
				after: "cursor",
				item: named("Book", true),
			},
		});
	});

	it("plans a mutation as one input argument and a result union", async () => {
		const { plan } = await planOf("bookshop");
		const create = rootOf(plan.mutation, "createBook");
		expect(create.type).toEqual(named("CreateBookResult", false));
		expect(create.arguments).toEqual([
			{
				name: "input",
				wire: "input",
				type: named("CreateBookInput", true),
				description: undefined,
				deprecationReason: undefined,
				dropNull: false,
				nullIfAbsent: false,
				defaultValue: undefined,
				merge: true,
			},
		]);
		expect(create.call?.projection).toEqual({
			"201": { as: "member", type: "Book" },
			"409": { as: "member", type: "Conflict" },
		});
		const input = plan.types.find((def) => def.name === "CreateBookInput");
		expect(
			input?.kind === "input" && input.fields.map((field) => [field.name, field.wire, field.type]),
		).toEqual([
			/**
			 * The read-only `id` and `createdAt` may be sent and may be left out: `Book` differs
			 * at Create only by them, so the request is its canonical schema, as `@typespec/openapi3`
			 * publishes it, and at its default, OpenAPI 3.0, a read-only `required` takes effect on the
			 * response only (OAS 3.0.4). `typespec-http-zod` validates the body so: `BookCreate`,
			 * `id` and `created_at` `.exactOptional()`.
			 */
			["id", "id", named("String", false)],
			["authorId", "author_id", named("String", false)],
			["title", "title", named("String", true)],
			["createdAt", "created_at", named("UTCDateTime", false)],
		]);
	});

	it("adds each link to its parent, bound by wire keys, a connection where the target is one", async () => {
		const { plan } = await planOf("bookshop");
		const book = objectOf(plan.types, "Book");
		expect(book.fields.map((field) => field.name)).toEqual([
			"id",
			"authorId",
			"title",
			"createdAt",
			"author",
			"editions",
		]);
		const author = book.fields.find((field) => field.name === "author");
		expect(author).toMatchObject({
			type: named("Author", false),
			arguments: [],
			directives: [COST],
			call: {
				kind: "link",
				operationId: "Authors_read",
				bound: [{ wire: "authorId", parent: "author_id" }],
				projection: { "200": { as: "value" }, "404": { as: "null" } },
			},
		});
		const editions = book.fields.find((field) => field.name === "editions");
		expect(editions).toMatchObject({
			type: named("EditionConnection", false),
			arguments: [
				{ name: "first", wire: "limit" },
				{ name: "after", wire: "cursor" },
			],
			directives: [COST, LIST_SIZE],
			call: { kind: "link", bound: [{ wire: "bookId", parent: "id" }] },
		});
	});

	it("declares exactly the types the fields reach, sorted, and every operation called, once", async () => {
		const { plan, warnings, emitted, dropped, declared } = await planOf("bookshop");
		expect(plan.types.map((def) => def.name)).toEqual([
			"Author",
			"Book",
			"BookConnection",
			"BookEdge",
			"Conflict",
			"CreateBookInput",
			"CreateBookResult",
			"Edition",
			"EditionConnection",
			"EditionEdge",
			"PageInfo",
			"UTCDateTime",
		]);
		expect(objectOf(plan.types, "BookConnection").fields.map((field) => field.type)).toEqual([
			listOf(named("BookEdge", true), true),
			listOf(named("Book", true), true),
			named("PageInfo", true),
		]);
		expect(plan.operations.map((operation) => operation.route.operationId)).toEqual([
			"Authors_read",
			"BookEditions_list",
			"Books_create",
			"Books_list",
			"Books_read",
		]);
		expect(plan.usesCost).toBe(true);
		expect(warnings).toEqual([]);
		expect({ emitted, dropped }).toEqual({ emitted: 5, dropped: 0 });
		expect(emitted + dropped).toBe(declared);
	});
});

describe("links to a fixpoint", () => {
	it("plans a link made reachable by another, and drops one whose parent nothing reaches", async () => {
		const { plan, warnings, emitted, dropped, declared } = await planOf("reach");
		expect(objectOf(plan.types, "Widget").fields.map((field) => field.name)).toEqual([
			"id",
			"gadgetId",
			"gadget",
		]);
		expect(objectOf(plan.types, "Gadget").fields.map((field) => field.name)).toEqual([
			"id",
			"partId",
			"part",
		]);
		expect(plan.types.map((def) => def.name)).toEqual(["Gadget", "Part", "Widget"]);
		expect(warnings.map((warning) => [warning.code, warning.format])).toEqual([
			["link-target-unreachable", { link: "thing", model: "Reach.Orphan" }],
		]);
		expect(plan.operations.map((operation) => operation.route.operationId)).toEqual([
			"readGadget",
			"readPart",
			"readWidget",
		]);
		expect({ emitted, dropped }).toEqual({ emitted: 3, dropped: 1 });
		expect(emitted + dropped).toBe(declared);
	});
});

describe("name collisions", () => {
	it("drops every declaration that reaches either party, and keeps the rest", async () => {
		const { plan, warnings, emitted, dropped, declared } = await planOf("collide");
		expect(plan.query.map((field) => field.name)).toEqual(["widget"]);
		expect(plan.types.map((def) => def.name)).toEqual(["Widget"]);
		const collision = {
			name: "GadgetKind",
			first: "model Collide.GadgetKind",
			second: "model Collide.gadget_kind",
		};
		expect(warnings.map((warning) => [warning.code, warning.format])).toEqual([
			["graphql-name-collision", collision],
			["graphql-name-collision", collision],
		]);
		expect({ emitted, dropped }).toEqual({ emitted: 1, dropped: 2 });
		expect(emitted + dropped).toBe(declared);
	});
});

describe("a surface with no query", () => {
	it("still has a Query, carrying only a nullable _empty: Boolean", async () => {
		const { plan } = await planOf("mutations-only");
		expect(plan.query).toEqual([
			{
				name: "_empty",
				wire: "_empty",
				type: named("Boolean", false),
				description:
					"Always null: GraphQL requires a Query type, and this schema declares no query.",
				deprecationReason: undefined,
				arguments: [],
				call: undefined,
				directives: [],
			},
		]);
		expect(plan.mutation.map((field) => field.name)).toEqual(["createWidget"]);
	});
});

/**
 * A credential carried as a parameter becomes document text when it is an argument, so it is warned;
 * a required header that is domain input is not, and an optional cookie is no argument at all.
 */
describe("a credential a field takes as an argument", () => {
	it("is warned transport-argument for a required cookie and an Authorization header, and only those", async () => {
		const { plan, warnings } = await planOf("credentials");
		expect(rootOf(plan.query, "account").arguments.map((arg) => arg.wire)).toEqual([
			"id",
			"authorization",
			"session",
			"x-api-version",
		]);
		expect(
			warnings
				.filter((warning) => warning.code === "transport-argument")
				.map((warning) => warning.format),
		).toEqual([
			{ field: "account", location: "header", name: "authorization" },
			{ field: "account", location: "cookie", name: "session" },
		]);
	});
});
