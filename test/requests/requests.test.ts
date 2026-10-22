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
			"query shelving",
			"mutation createBook",
			"mutation tagBook",
		]);
		expect(requestNamed("book").operation.operation.name).toBe("read");
	});

	it("writes documents the served schema accepts", () => {
		const requests = services.flatMap((service) => service.requests);
		// Non-vacuity: no request at all would break no rule below.
		expect(requests).toHaveLength(5);
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
			body: { title: "One", format: "e-book", price: { amount: 5, currency: "GBP" } },
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
