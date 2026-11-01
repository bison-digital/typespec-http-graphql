import { fileURLToPath } from "node:url";
import type { Program } from "@typespec/compiler";
import { getNamespaceFullName } from "@typespec/compiler";
import { buildSchema, parse, validate } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { planService } from "../../src/plan.js";
import {
	beginRecord,
	type GraphQLRequest,
	type GraphQLServiceRequests,
	graphqlRequestsOf,
	type PlannedRecord,
	record,
} from "../../src/requests.js";
import { renderSdl } from "../../src/sdl.js";
import { surfaceOf } from "../../src/surface.js";
import { serviceOf } from "../support/service-of.js";

/**
 * **What `graphqlRequestsOf` answers, from `src/`**, for the plan of `main.tsp` recorded as `$onEmit`
 * records it: `requests.test.ts` reads the copy the compiler ran, which the mutation run cannot see,
 * and this reads the module itself. Every expected value is written out by hand from the schema the
 * fixture declares.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let program: Program;
let planned: PlannedRecord;
let sdl: string;

/**
 * **The record `$onEmit` makes, made afresh in each test that reads it**, but for `edition`'s root,
 * left out to show a field without one is skipped. Recorded in the test, not in `beforeAll`, so the
 * mutation run sees the tests that reach it.
 */
function recorded(): readonly GraphQLServiceRequests[] | undefined {
	beginRecord(program);
	record(program, planned);
	return graphqlRequestsOf(program);
}

function requestNamed(field: string): GraphQLRequest {
	const request = recorded()?.[0]?.requests.find((candidate) => candidate.field === field);
	if (request === undefined) throw new Error(`no request for ${field}`);
	return request;
}

beforeAll(async () => {
	const compiled = await serviceOf(here, "main");
	program = compiled.program;
	const surface = surfaceOf(program, compiled.emitted);
	const { plan } = planService(program, compiled.emitted, surface);
	sdl = renderSdl(plan);
	planned = {
		service: getNamespaceFullName(compiled.emitted.service.namespace),
		plan,
		roots: new Map(
			surface.roots
				.filter((root) => root.name !== "edition")
				.map((root) => [
					`${root.kind}:${root.name}`,
					{ operation: root.operation, route: root.route },
				]),
		),
	};
}, 300_000);

describe("graphqlRequestsOf, from the module itself", () => {
	it("answers nothing for a program never recorded, and refuses a record nothing began", async () => {
		const other = await serviceOf(here, "conflicts");
		expect(graphqlRequestsOf(other.program)).toBeUndefined();
		expect(() => record(other.program, planned)).toThrow(
			"record: beginRecord was not called for this program",
		);
	});

	it("answers each recorded service's root fields, queries first, skipping one with no root", () => {
		const services = recorded();
		expect(services?.map((service) => service.service)).toEqual(["Bookshop"]);
		expect(services?.[0]?.requests.map((request) => `${request.kind} ${request.field}`)).toEqual([
			"query book",
			"query books",
			"query shelving",
			"query titles",
			"mutation createBook",
			"mutation moveBook",
			"mutation tagBook",
		]);
		expect(requestNamed("book").operation.operation.name).toBe("read");
		expect(requestNamed("createBook").description).toBeUndefined();
	});

	it("writes documents the planned schema accepts", () => {
		const schema = buildSchema(sdl);
		const requests = recorded()?.[0]?.requests ?? [];
		expect(requests).toHaveLength(7);
		for (const request of requests) {
			expect(validate(schema, parse(request.document)), request.field).toEqual([]);
		}
	});

	it("starts a fresh record for a program emitted again, and keeps every service recorded", () => {
		beginRecord(program);
		expect(graphqlRequestsOf(program)).toEqual([]);
		record(program, planned);
		record(program, { ...planned, service: "Bookshop.Again" });
		expect(graphqlRequestsOf(program)?.map((service) => service.service)).toEqual([
			"Bookshop",
			"Bookshop.Again",
		]);
	});
});

describe("variables, from a REST request's values", () => {
	it("passes a parameter by its GraphQL name, and an enum's wire value as its GraphQL value", () => {
		expect(requestNamed("book").variables({ parameters: { id: "b1", format: "e-book" } })).toEqual({
			value: { id: "b1", format: "EBOOK" },
			missing: [],
		});
		expect(requestNamed("book").variables({ parameters: { id: "b1", format: "audio" } })).toEqual({
			value: { id: "b1", format: "audio" },
			missing: [],
		});
		expect(requestNamed("book").variables({ parameters: { id: null } })).toEqual({
			value: { id: null },
			missing: [],
		});
	});

	it("passes a value of the wrong kind as it is, for the operation's schema to refuse", () => {
		expect(requestNamed("book").variables({ parameters: { id: { not: "a string" } } })).toEqual({
			value: { id: { not: "a string" } },
			missing: [],
		});
	});

	it("passes an argument named after on a field that is no connection", () => {
		expect(requestNamed("shelving").variables({ parameters: { id: "b1", after: "t1" } })).toEqual({
			value: { id: "b1", after: "t1" },
			missing: [],
		});
	});

	it("names no argument or input field missing that has a default", () => {
		expect(requestNamed("shelving").variables({ parameters: { id: "b1" } })).toEqual({
			value: { id: "b1" },
			missing: [],
		});
		expect(
			requestNamed("createBook").variables({
				parameters: {},
				body: { title: "One", format: "paperback", price: { amount: 5, currency: "GBP" } },
			}).missing,
		).toEqual([]);
	});

	it("starts a connection at its first page, whatever cursor the REST request sends", () => {
		expect(requestNamed("books").variables({ parameters: { limit: 5, cursor: "t2" } })).toEqual({
			value: { first: 5 },
			missing: [],
		});
	});

	it("merges an unnamed body into a mutation's input, its fields and lists converted", () => {
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
		expect(
			requestNamed("createBook").variables({ parameters: {}, body: ["not", "an", "object"] }),
		).toEqual({ value: { input: {} }, missing: ["input.title", "input.format", "input.price"] });
		expect(
			requestNamed("createBook").variables({
				parameters: {},
				body: { title: "One", format: "paperback", price: "five" },
			}),
		).toEqual({
			value: { input: { title: "One", format: "PAPERBACK", price: "five" } },
			missing: [],
		});
	});

	it("passes a null as it is, and converts a list item by item", () => {
		expect(
			requestNamed("createBook").variables({
				parameters: {},
				body: { title: "One", format: "paperback", price: null, formats: ["e-book", "hardback"] },
			}),
		).toEqual({
			value: {
				input: { title: "One", format: "PAPERBACK", price: null, formats: ["EBOOK", "HARDBACK"] },
			},
			missing: [],
		});
		expect(
			requestNamed("createBook").variables({
				parameters: {},
				body: {
					title: "One",
					format: "paperback",
					price: { amount: 5, currency: "GBP" },
					prices: [{ amount: 1, currency: "GBP" }, { amount: 2 }],
					formats: "e-book",
				},
			}),
		).toEqual({
			value: {
				input: {
					title: "One",
					format: "PAPERBACK",
					price: { amount: 5, currency: "GBP" },
					prices: [{ amount: 1, currency: "GBP" }, { amount: 2 }],
					formats: "e-book",
				},
			},
			missing: ["input.prices.1.currency"],
		});
	});

	it("puts a named body under its property, a list item by item", () => {
		expect(
			requestNamed("tagBook").variables({ parameters: { id: "b1" }, body: ["classic", "boxed"] }),
		).toEqual({ value: { input: { id: "b1", labels: ["classic", "boxed"] } }, missing: [] });
		expect(requestNamed("tagBook").variables({ parameters: { id: "b1" } })).toEqual({
			value: { input: { id: "b1" } },
			missing: ["input.labels"],
		});
		expect(
			requestNamed("tagBook").variables({ parameters: { id: "b1" }, body: "classic" }),
		).toEqual({ value: { input: { id: "b1", labels: "classic" } }, missing: [] });
	});

	it("names each required argument and input field no value fills, an optional one never", () => {
		expect(requestNamed("book").variables({ parameters: {} }).missing).toEqual(["id"]);
		expect(requestNamed("books").variables({ parameters: {} })).toEqual({ value: {}, missing: [] });
		expect(
			requestNamed("createBook").variables({ parameters: {}, body: { format: "hardback" } }),
		).toEqual({
			value: { input: { format: "HARDBACK" } },
			missing: ["input.title", "input.price"],
		});
		expect(
			requestNamed("createBook").variables({
				parameters: {},
				body: { title: "One", format: "hardback", price: { currency: "GBP" } },
			}).missing,
		).toEqual(["input.price.amount"]);
	});
});
