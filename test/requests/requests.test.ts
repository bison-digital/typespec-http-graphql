import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, type GraphQLSchema, parse, validate } from "graphql";
import { type Context, Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	type GraphQLRequest,
	type GraphQLServiceRequests,
	graphqlRequestsOf as srcRequestsOf,
} from "../../src/requests.js";
import { type CompiledFixture, compileFixture } from "../support/compile-fixture.js";
import { executeThroughYoga } from "../support/yoga.js";

/**
 * **What this emitter served, as requests another tool can write**: a document per root field that
 * the served schema accepts, and the variables a REST request's values make, which reach the
 * handler as that REST request does.
 *
 * Read the way such a tool reads it: from the copy of this package the compiler ran, found through
 * `program.emitters`. The suite's own `src/` copy never emitted the program, and answers nothing.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

type RequestsOf = (program: unknown) => readonly GraphQLServiceRequests[] | undefined;

let compiled: CompiledFixture;
let services: readonly GraphQLServiceRequests[];
let served: GraphQLSchema;
let schema: GraphQLSchema;
const rest = new Hono();
let received: { readonly operationId: string; readonly input: unknown }[];

function requestNamed(field: string): GraphQLRequest {
	const request = services[0]?.requests.find((candidate) => candidate.field === field);
	if (request === undefined) throw new Error(`no request for ${field}`);
	return request;
}

beforeAll(async () => {
	compiled = await compileFixture(here, "main", { withServer: true });
	const ref = compiled.program.emitters.find(
		(emitter) => emitter.metadata.name === "typespec-http-graphql",
	);
	const exported = (ref?.library.entrypoint?.esmExports as { graphqlRequestsOf?: RequestsOf })
		?.graphqlRequestsOf;
	if (exported === undefined)
		throw new Error("the emitter the compiler ran exports no graphqlRequestsOf");
	services = exported(compiled.program) ?? [];
	served = buildSchema(readFileSync(join(compiled.outDir, "schema.graphql"), "utf8"));

	const book = {
		id: "b1",
		title: "One",
		format: "e-book",
		page_count: 120,
		price: { amount: 5, currency: "GBP" },
	};
	const answers: Readonly<Record<string, unknown>> = {
		Books_read: { status: 200, body: book },
		Books_list: { status: 200, body: { items: [book] } },
		Books_create: { status: 201, body: book },
		Books_shelve: { status: 202, body: { shelf: "front" } },
		Books_tag: { status: 200, body: book },
	};
	const handlers = Object.fromEntries(
		Object.entries(answers).map(([operationId, answer]) => [
			operationId,
			(_ctx: unknown, input: unknown) => {
				received.push({ operationId, input });
				return answer;
			},
		]),
	);
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
		readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
	};
	schema = generated.createSchema(() => handlers, {
		authorize: () => "allow",
		context: () => ({ subject: "requests" }),
	});
	const routes = (await import(join(compiled.serverDir, "app.gen.ts"))) as {
		readonly registerRoutes: (app: Hono, handlersFor: () => object, deps: object) => unknown;
	};
	routes.registerRoutes(rest, () => handlers, {
		authorize: () => async (_c: Context, next: () => Promise<void>) => {
			await next();
		},
		context: () => ({ subject: "requests" }),
		noContext: (c: Context) => c.json({}, 401),
		notAcceptable: (c: Context) => c.body(null, 406),
		invalid: (result: { readonly success: boolean }, c: Context) =>
			result.success ? undefined : c.json({}, 400),
	});
}, 300_000);

beforeEach(() => {
	received = [];
});

describe("graphqlRequestsOf", () => {
	it("answers, per service, one request per root field the schema serves", () => {
		expect(services.map((service) => service.service)).toEqual(["Bookshop"]);
		expect(services[0]?.requests.map((request) => `${request.kind} ${request.field}`)).toEqual([
			"query book",
			"query books",
			"query edition",
			"query shelving",
			"query titles",
			"mutation createBook",
			"mutation moveBook",
			"mutation tagBook",
		]);
		expect(requestNamed("book").operation.operation.name).toBe("read");
	});

	it("writes documents the served schema accepts", () => {
		const requests = services.flatMap((service) => service.requests);
		// Non-vacuity: no request at all would break no rule below.
		expect(requests).toHaveLength(8);
		for (const request of requests) {
			expect(validate(served, parse(request.document)), request.field).toEqual([]);
		}
	});

	it("selects a type's leaf fields and passes every argument as a variable", () => {
		expect(requestNamed("book").document).toBe(
			[
				"query Book($id: String!, $format: Format) {",
				"  book(id: $id, format: $format) {",
				"    __typename",
				"    id",
				"    title",
				"    format",
				"    pageCount",
				"  }",
				"}",
			].join("\n"),
		);
	});

	it("selects a connection through its nodes and its page's cursor", () => {
		expect(requestNamed("books").document).toBe(
			[
				"query Books($first: Int, $after: String) {",
				"  books(first: $first, after: $after) {",
				"    __typename",
				"    nodes {",
				"      __typename",
				"      id",
				"      title",
				"      format",
				"      pageCount",
				"    }",
				"    pageInfo {",
				"      hasNextPage",
				"      endCursor",
				"    }",
				"  }",
				"}",
			].join("\n"),
		);
	});

	it("selects each member of a result union by a fragment, and names the success members", () => {
		expect(requestNamed("createBook").document).toBe(
			[
				"mutation CreateBook($input: CreateBookInput!) {",
				"  createBook(input: $input) {",
				"    __typename",
				"    ... on Book {",
				"      id",
				"      title",
				"      format",
				"      pageCount",
				"    }",
				"    ... on Conflict {",
				"      message",
				"    }",
				"  }",
				"}",
			].join("\n"),
		);
		expect(requestNamed("createBook").successTypenames).toEqual(["Book"]);
		expect(requestNamed("shelving").successTypenames?.toSorted()).toEqual(["Book", "Shelved"]);
		expect(requestNamed("book").successTypenames).toBeUndefined();
	});

	it("selects a member with no leaf of its own by its __typename, not by an empty fragment", () => {
		expect(requestNamed("moveBook").document).toContain(
			["    ... on Moved {", "      __typename", "    }"].join("\n"),
		);
		expect(requestNamed("moveBook").successTypenames?.toSorted()).toEqual(["Book", "Moved"]);
	});

	it("selects a connection of leaves by its nodes alone", () => {
		expect(requestNamed("titles").document).toBe(
			[
				"query Titles($first: Int, $after: String) {",
				"  titles(first: $first, after: $after) {",
				"    __typename",
				"    nodes",
				"    pageInfo {",
				"      hasNextPage",
				"      endCursor",
				"    }",
				"  }",
				"}",
			].join("\n"),
		);
	});

	it("selects a discriminated union's payload under its envelope, each member a success", () => {
		expect(requestNamed("edition").document).toBe(
			[
				"query Edition($id: String!) {",
				"  edition(id: $id) {",
				"    __typename",
				"    ... on EditionPrint {",
				"      kind",
				"      value {",
				"        __typename",
				"        pages",
				"      }",
				"    }",
				"    ... on EditionDigital {",
				"      kind",
				"      value {",
				"        __typename",
				"        bytes",
				"      }",
				"    }",
				"  }",
				"}",
			].join("\n"),
		);
		expect(requestNamed("edition").successTypenames).toEqual(["EditionPrint", "EditionDigital"]);
	});

	it("makes a REST request's values the variables, under GraphQL's names", () => {
		expect(requestNamed("book").variables({ parameters: { id: "b1", format: "e-book" } })).toEqual({
			value: { id: "b1", format: "EBOOK" },
			missing: [],
		});
		expect(requestNamed("books").variables({ parameters: { limit: 5, cursor: "t2" } })).toEqual({
			value: { first: 5 },
			missing: [],
		});
		expect(
			requestNamed("createBook").variables({
				parameters: { "Idempotency-Key": "k1" },
				body: { title: "One", format: "paperback", price: { amount: 5, currency: "GBP" } },
			}),
		).toEqual({
			value: {
				input: {
					idempotencyKey: "k1",
					title: "One",
					format: "PAPERBACK",
					price: { amount: 5, currency: "GBP" },
				},
			},
			missing: [],
		});
	});

	it("names each required argument and input field no value fills", () => {
		expect(requestNamed("book").variables({ parameters: {} }).missing).toEqual(["id"]);
		expect(
			requestNamed("createBook").variables({ parameters: {}, body: { format: "hardback" } })
				.missing,
		).toEqual(["input.title", "input.price"]);
	});

	it("hands the handler what the REST request with the same values hands it", async () => {
		const values = {
			parameters: { "Idempotency-Key": "k1" },
			body: { title: "One", format: "e-book", price: { amount: 5, currency: "GBP" }, copies: 2 },
		};
		await rest.request("/books", {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": "k1" },
			body: JSON.stringify(values.body),
		});
		const create = requestNamed("createBook");
		const result = await executeThroughYoga(
			schema,
			{ query: create.document, variables: create.variables(values).value },
			{ caller: "requests" },
		);
		expect(result.errors).toBeUndefined();
		const [overRest, overGraphQL] = received;
		expect(received).toHaveLength(2);
		expect(overGraphQL?.input).toEqual(overRest?.input);

		received = [];
		await rest.request("/books/tags/b1", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(["classic", "boxed"]),
		});
		const tag = requestNamed("tagBook");
		await executeThroughYoga(
			schema,
			{
				query: tag.document,
				variables: tag.variables({ parameters: { id: "b1" }, body: ["classic", "boxed"] }).value,
			},
			{ caller: "requests" },
		);
		expect(received).toHaveLength(2);
		expect(received[1]?.input).toEqual(received[0]?.input);

		received = [];
		await rest.request("/books/b1?format=e-book");
		const read = requestNamed("book");
		await executeThroughYoga(
			schema,
			{
				query: read.document,
				variables: read.variables({ parameters: { id: "b1", format: "e-book" } }).value,
			},
			{ caller: "requests" },
		);
		expect(received).toHaveLength(2);
		expect(received[1]?.input).toEqual(received[0]?.input);
	});

	it("answers nothing for a program this copy never emitted", async () => {
		expect(srcRequestsOf(compiled.program)).toBeUndefined();
		const alone = await compileFixture(here, "main", { outName: "without", withoutGraphQL: true });
		expect(srcRequestsOf(alone.program)).toBeUndefined();
	});
});

/**
 * **Result unions whose members share a field name with another response shape** (`conflicts.tsp`),
 * one union for each way two fields of one selection set fail to merge (GraphQL 5.3.2). Each document
 * below is written out from the rule, Apollo Federation's decision with graphql-tools' spelling: the
 * first field keeps its name, a later one that cannot merge with it is `<name><Type>` with `!` as
 * `NonNull`, `[` as `List` and `]` dropped, and `__alias_<n>` follows a name already taken.
 */
describe("graphqlRequestsOf, where union members' fields cannot merge", () => {
	let conflicts: readonly GraphQLRequest[];
	let conflictSchema: GraphQLSchema;
	let executable: GraphQLSchema;
	const restApp = new Hono();
	let calls: string[];
	let answers: Record<string, unknown>;

	const named = (field: string): GraphQLRequest => {
		const request = conflicts.find((candidate) => candidate.field === field);
		if (request === undefined) throw new Error(`no request for ${field}`);
		return request;
	};

	beforeAll(async () => {
		const fixture = await compileFixture(here, "conflicts", { withServer: true });
		const ref = fixture.program.emitters.find(
			(emitter) => emitter.metadata.name === "typespec-http-graphql",
		);
		const read = (ref?.library.entrypoint?.esmExports as { graphqlRequestsOf?: RequestsOf })
			?.graphqlRequestsOf;
		conflicts = read?.(fixture.program)?.[0]?.requests ?? [];
		conflictSchema = buildSchema(readFileSync(join(fixture.outDir, "schema.graphql"), "utf8"));
		const handlers = Object.fromEntries(
			[
				"Books_create",
				"Books_shelve",
				"Books_edition",
				"Books_copy",
				"Shelves_read",
				"Formats_read",
			].map((operationId) => [
				operationId,
				() => {
					calls.push(operationId);
					return answers[operationId];
				},
			]),
		);
		const generated = (await import(join(fixture.outDir, "graphql.gen.ts"))) as {
			readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
		};
		executable = generated.createSchema(() => handlers, {
			authorize: () => "allow",
			context: () => ({}),
		});
		const routes = (await import(join(fixture.serverDir, "app.gen.ts"))) as {
			readonly registerRoutes: (app: Hono, handlersFor: () => object, deps: object) => unknown;
		};
		routes.registerRoutes(restApp, () => handlers, {
			authorize: () => async (_c: Context, next: () => Promise<void>) => {
				await next();
			},
			context: () => ({}),
			noContext: (c: Context) => c.json({}, 401),
			notAcceptable: (c: Context) => c.body(null, 406),
			invalid: (result: { readonly success: boolean }, c: Context) =>
				result.success ? undefined : c.json({}, 400),
		});
	}, 300_000);

	beforeEach(() => {
		calls = [];
		answers = {};
	});

	it("writes, for every root field, a document the schema accepts", () => {
		// Non-vacuity: every field of the fixture has a request.
		expect(conflicts.map((request) => request.field).toSorted()).toEqual([
			"copy",
			"createBook",
			"edition",
			"format",
			"shelf",
			"shelving",
		]);
		for (const request of conflicts) {
			expect(validate(conflictSchema, parse(request.document)), request.field).toEqual([]);
		}
	});

	it("aliases an enum beside an Int, a nullable beside a non-null, and a name another field takes", () => {
		expect(named("createBook").document).toBe(
			[
				"mutation CreateBook($input: CreateBookInput!) {",
				"  createBook(input: $input) {",
				"    __typename",
				"    ... on Book {",
				"      id",
				"      status",
				"      title",
				"      labels",
				"      edition",
				"    }",
				"    ... on Problem {",
				"      type",
				"      titleStringNonNull: title",
				"      statusIntNonNull__alias_0: status",
				"    }",
				"    ... on Rejected {",
				"      statusIntNonNull__alias_0: status",
				"      statusIntNonNull",
				"    }",
				"  }",
				"}",
			].join("\n"),
		);
	});

	it("aliases a list beside one value, and compares a third member with the first, not the last", () => {
		expect(named("shelving").document).toBe(
			[
				"query Shelving($id: String!) {",
				"  shelving(id: $id) {",
				"    __typename",
				"    ... on Book {",
				"      id",
				"      status",
				"      title",
				"      labels",
				"      edition",
				"    }",
				"    ... on Shelved {",
				"      editionStringNonNull: edition",
				"      labelsStringNonNull: labels",
				"    }",
				"    ... on Reserved {",
				"      editionStringNonNull: edition",
				"    }",
				"  }",
				"}",
			].join("\n"),
		);
	});

	it("aliases an object beside a leaf, and a leaf below two objects that merge", () => {
		expect(named("shelf").document).toBe(
			[
				"query Shelf($id: String!) {",
				"  shelf(id: $id) {",
				"    __typename",
				"    ... on Shelf {",
				"      name",
				"      value",
				"    }",
				"    ... on ShelfAccepted {",
				"      valueListPrintedNonNullNonNull: value {",
				"        __typename",
				"        pages",
				"      }",
				"    }",
				"  }",
				"}",
			].join("\n"),
		);
		expect(named("edition").document).toBe(
			[
				"query Edition($id: String!) {",
				"  edition(id: $id) {",
				"    __typename",
				"    ... on EditionPrint {",
				"      kind",
				"      value {",
				"        __typename",
				"        pages",
				"      }",
				"    }",
				"    ... on EditionDigital {",
				"      kind",
				"      value {",
				"        __typename",
				"        pagesLongNonNull: pages",
				"      }",
				"    }",
				"  }",
				"}",
			].join("\n"),
		);
	});

	it("selects no link as a variant's payload, so the request calls one handler", async () => {
		expect(named("copy").document).not.toContain("format");
		answers = { Books_copy: { status: 200, body: { kind: "paperback" } } };
		const result = await executeThroughYoga(
			executable,
			{ query: named("copy").document, variables: { id: "b1" } },
			{},
		);
		expect(result.errors).toBeUndefined();
		expect(calls).toEqual(["Books_copy"]);
	});

	/**
	 * **The path names where the REST answer's own value is, in the real GraphQL answer.** Each arm
	 * answers one body through both surfaces and reads the REST response at the wire path and the
	 * GraphQL response at the path `resultPathsOf` gives, for a member that is aliased there.
	 */
	it("finds a success member's value of the REST body where the GraphQL answer holds it", async () => {
		const at = (value: unknown, path: readonly string[]): unknown =>
			path.reduce<unknown>(
				(inner, key) =>
					typeof inner === "object" && inner !== null ? Reflect.get(inner, key) : undefined,
				value,
			);
		const cases: readonly {
			readonly field: string;
			readonly operationId: string;
			readonly url: string;
			readonly answer: { readonly status: number; readonly body: unknown };
			readonly typename: string;
			readonly wire: readonly string[];
		}[] = [
			{
				field: "shelving",
				operationId: "Books_shelve",
				url: "/books/b1/shelve",
				answer: { status: 202, body: { edition: "second", labels: "one" } },
				typename: "Shelved",
				wire: ["edition"],
			},
			{
				field: "shelving",
				operationId: "Books_shelve",
				url: "/books/b1/shelve",
				answer: { status: 203, body: { edition: "third" } },
				typename: "Reserved",
				wire: ["edition"],
			},
			{
				field: "shelf",
				operationId: "Shelves_read",
				url: "/shelves/s1",
				answer: { status: 202, body: [{ pages: 10 }, { pages: 12 }] },
				typename: "ShelfAccepted",
				wire: ["1", "pages"],
			},
			{
				field: "edition",
				operationId: "Books_edition",
				url: "/books/b1/edition",
				answer: { status: 200, body: { kind: "digital", value: { pages: 1024 } } },
				typename: "EditionDigital",
				wire: ["value", "pages"],
			},
		];
		for (const { field, operationId, url, answer, typename, wire } of cases) {
			answers = { [operationId]: answer };
			const overRest = (await (await restApp.request(url)).json()) as unknown;
			const request = named(field);
			const result = await executeThroughYoga(
				executable,
				{ query: request.document, variables: { id: url.split("/")[2] } },
				{},
			);
			expect(result.errors, field).toBeUndefined();
			const path = request.resultPathsOf(wire).get(typename);
			expect(path, `${field} ${typename}`).toBeDefined();
			expect(at(result.data, path ?? []), `${field} ${typename}`).toEqual(at(overRest, wire));
			expect(at(overRest, wire), `${field} ${typename}`).not.toBeUndefined();
		}
	});

	it("names no path for a value no success member selects, nor for a refusal", () => {
		expect([...named("createBook").resultPathsOf(["id"])]).toEqual([
			["Book", ["createBook", "id"]],
		]);
		expect([...named("createBook").resultPathsOf(["type"])]).toEqual([]);
		expect([...named("shelf").resultPathsOf(["0", "pages"])]).toEqual([
			["ShelfAccepted", ["shelf", "valueListPrintedNonNullNonNull", "0", "pages"]],
		]);
		expect([...named("shelf").resultPathsOf(["pages", "0"])]).toEqual([]);
		expect([...named("format").resultPathsOf(["binding"])]).toEqual([
			["Format", ["format", "binding"]],
		]);
	});
});
