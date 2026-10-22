import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { connectionOf, defineConnection } from "../../src/connections.js";
import {
	listOf,
	named,
	type OutputFieldPlan,
	type TypeDef,
	type TypeRef,
} from "../../src/model.js";
import { NameBook } from "../../src/names.js";
import { TypeProjector } from "../../src/types.js";
import { type CompiledService, operationOf, serviceOf, typeOf } from "../support/service-of.js";

const here = fileURLToPath(new URL(".", import.meta.url));

let service: CompiledService;
beforeAll(async () => {
	service = await serviceOf(here, "connections");
});

function fresh(): { projector: TypeProjector; book: NameBook } {
	const book = new NameBook();
	return {
		projector: new TypeProjector(service.program, book, service.emitted.typeSchemaNames),
		book,
	};
}

function verdictOf(operationId: string, projector = fresh().projector) {
	return connectionOf(service.program, operationOf(service, operationId).operation, projector);
}

function objectOf(projector: TypeProjector, name: string): Extract<TypeDef, { kind: "object" }> {
	const def = projector.defs().find((candidate) => candidate.name === name);
	if (def?.kind !== "object") throw new Error(`no object ${name}`);
	return def;
}

/** A field of a connection type, as a generated field is planned: no arguments, resolver or directives. */
function shapeField(name: string, type: TypeRef, description: string): OutputFieldPlan {
	return {
		name,
		wire: name,
		type,
		description,
		deprecationReason: undefined,
		arguments: [],
		call: undefined,
		directives: [],
	};
}

describe("connectionOf", () => {
	it("reads a Page and PageRequest as a connection, by their wire keys", () => {
		expect(verdictOf("Books_list")).toEqual({
			kind: "connection",
			plan: {
				items: "items",
				next: "nextCursor",
				first: "limit",
				after: "cursor",
				item: named("Book", true),
				// `@maxValue(200)`: no resume asks the backend for more.
				maximum: 200,
				// None: `first` defaults to the page size's 50, which a cost analysis reads in its place.
				assumedSize: undefined,
			},
		});
	});

	/**
	 * Where `first` has no default, the page size's `@maxValue` bounds a page sent no `first`: the
	 * cost specification's `assumedSize`, allowed beside a slicing argument with no default (§9.2.4).
	 */
	it("assumes the page size's maximum where the page size has no default", () => {
		expect(verdictOf("Books_bounded")).toMatchObject({
			kind: "connection",
			plan: { first: "limit", after: "cursor", assumedSize: 100 },
		});
	});

	/**
	 * **The largest page size the operation's schema accepts**, which a resume never asks past: an
	 * exclusive bound less one, and the least of the property's bound and every scalar's below it.
	 */
	it.each([
		["Books_exclusive", "@maxValueExclusive(30) beside a default", 29, undefined],
		["Books_scalarBounded", "a SmallPage of 40, extending a WidePage of 80", 40, 40],
	])("reads %s's maximum, %s", (operationId, _bounds, maximum, assumedSize) => {
		expect(verdictOf(operationId)).toMatchObject({
			kind: "connection",
			plan: { maximum, assumedSize },
		});
	});

	/** `@listSize(assumedSize:)` is an `Int` in the cost specification, so a fraction bounds nothing. */
	it("assumes nothing from a maximum that is not an integer", () => {
		expect(verdictOf("Books_fractional")).toEqual({
			kind: "connection",
			plan: {
				items: "items",
				next: "nextCursor",
				first: "limit",
				after: "cursor",
				item: named("Book", true),
				maximum: undefined,
				assumedSize: undefined,
			},
		});
	});

	it("reads through a response that names its body with @body", () => {
		expect(verdictOf("Books_wrapped")).toMatchObject({
			kind: "connection",
			plan: { items: "items", next: "nextCursor" },
		});
	});

	it("is plain where the operation is not @list", () => {
		expect(verdictOf("Books_read")).toEqual({ kind: "plain" });
	});

	it.each([
		["Books_noNext", ["@continuationToken on the response"]],
		["Books_headerNext", ["@continuationToken on the response body rather than a header"]],
		["Books_noToken", ["@continuationToken on a request parameter"]],
		["Books_search", ["@continuationToken on a request parameter (found at body.cursor)"]],
		["Books_noSize", ["@pageSize on a request parameter"]],
		[
			"Books_nested",
			["@pageItems as a top-level property of the response body (found at data.items)"],
		],
		[
			"Books_offset",
			["@continuationToken on a request parameter", "cursor paging rather than @offset"],
		],
		[
			"Books_indexed",
			["@continuationToken on a request parameter", "cursor paging rather than @pageIndex"],
		],
		["Books_linked", ["@continuationToken on the response", "cursor paging rather than @nextLink"]],
		// All five markers, and link paging beside them: a connection pages one way only.
		[
			"Books_navigable",
			[
				"cursor paging rather than @prevLink",
				"cursor paging rather than @firstLink",
				"cursor paging rather than @lastLink",
			],
		],
		// A page of lists: an edge's `node` is one item, never a list (Relay § 3.2), `| null` or not,
		// and a union variant naming a list (`Cell.row`) is that list.
		["Books_grid", ["@pageItems on an array of single items, not of lists"]],
		["Books_sparseGrid", ["@pageItems on an array of single items, not of lists"]],
		["Books_rows", ["@pageItems on an array of single items, not of lists"]],
	])("%s is not a connection, missing %j", (operationId, missing) => {
		expect(verdictOf(operationId)).toEqual({ kind: "not-a-connection", missing });
	});

	/**
	 * **An edge's `node` is any type but a list** (Relay § 3.2: a scalar, enum, object, interface or
	 * union, nullable or not). A page of `T | null` has nullable nodes, a page of strings has `String`
	 * ones, and a union of a list with anything else is one value, `JSON`, as design.md § Types
	 * projects every union that is neither literals nor discriminated.
	 */
	it.each([
		["Books_sparse", named("Book", false)],
		["Books_tags", named("String", true)],
		["Books_mixed", named("JSON", true)],
	])("%s is a connection of %j", (operationId, item) => {
		expect(verdictOf(operationId)).toEqual({
			kind: "connection",
			plan: {
				items: "items",
				next: "nextCursor",
				first: "limit",
				after: "cursor",
				item,
				maximum: 200,
				assumedSize: undefined,
			},
		});
	});

	it("projects nothing for an operation that is not a connection", () => {
		const { projector } = fresh();
		verdictOf("Books_nested", projector);
		verdictOf("Books_grid", projector);
		expect(projector.defs()).toEqual([]);
	});
});

describe("defineConnection", () => {
	/**
	 * The shapes are the Relay connection specification's: an edge's `node` and opaque `cursor`
	 * (§3), `PageInfo` (§5) paging forward only, as §5.1 allows, and GitHub's `nodes` beside `edges`.
	 * Each description is what a reader of the SDL is told about it.
	 */
	it("registers the Relay shapes, with nodes beside edges", () => {
		const { projector } = fresh();
		const verdict = verdictOf("Books_list", projector);
		if (verdict.kind !== "connection") throw new Error("not a connection");
		expect(defineConnection(verdict.plan, projector)).toEqual(named("BookConnection", false));
		expect(objectOf(projector, "BookConnection")).toEqual({
			kind: "object",
			name: "BookConnection",
			description: "A page of Book, as a Relay connection.",
			fields: [
				shapeField(
					"edges",
					listOf(named("BookEdge", true), true),
					"The page's items, each with its cursor.",
				),
				shapeField("nodes", listOf(named("Book", true), true), "The page's items."),
				shapeField("pageInfo", named("PageInfo", true), "Where this page sits in the connection."),
			],
		});
		expect(objectOf(projector, "BookEdge")).toEqual({
			kind: "object",
			name: "BookEdge",
			description: "One Book in a connection.",
			fields: [
				shapeField("node", named("Book", true), "The Book."),
				shapeField(
					"cursor",
					named("String", true),
					"An opaque cursor: pass it as `after` for the items after this edge.",
				),
			],
		});
		expect(objectOf(projector, "PageInfo")).toEqual({
			kind: "object",
			name: "PageInfo",
			description:
				"Where a page sits in its connection, as the Relay connection specification defines it.",
			fields: [
				shapeField(
					"hasNextPage",
					named("Boolean", true),
					"Whether a further page follows this one.",
				),
				shapeField(
					"hasPreviousPage",
					named("Boolean", true),
					"Always false: paging is forward only.",
				),
				shapeField(
					"startCursor",
					named("String", false),
					"The first edge's cursor; null when the page has no edges.",
				),
				shapeField(
					"endCursor",
					named("String", false),
					"The last edge's cursor, to pass as `after` for the next page; null when there is none.",
				),
			],
		});
	});

	it("defines PageInfo once across connections", () => {
		const { projector, book } = fresh();
		for (const operationId of ["Books_list", "BookEditions_list"]) {
			const verdict = verdictOf(operationId, projector);
			if (verdict.kind !== "connection") throw new Error(`${operationId} is not a connection`);
			defineConnection(verdict.plan, projector);
		}
		expect(projector.defs().filter((def) => def.name === "PageInfo")).toHaveLength(1);
		expect(projector.defs().map((def) => def.name)).toContain("EditionConnection");
		expect(book.collisions).toEqual([]);
	});

	it("collides with a model of the spec's own named PageInfo, rather than merging", () => {
		const { projector, book } = fresh();
		projector.output(typeOf(service, "Paging.PageInfo"));
		const verdict = verdictOf("Books_list", projector);
		if (verdict.kind !== "connection") throw new Error("not a connection");
		defineConnection(verdict.plan, projector);
		expect(book.collisions).toEqual([
			{ name: "PageInfo", first: "model Paging.PageInfo", second: "generated object PageInfo" },
		]);
	});
});
