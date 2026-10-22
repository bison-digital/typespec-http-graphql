import { fileURLToPath } from "node:url";
import { getSourceLocation, NoTarget } from "@typespec/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { linkDeclarationsOf, rootDeclarationsOf } from "../../src/decorators.js";
import { type Surface, type SurfaceDiagnostic, surfaceOf } from "../../src/surface.js";
import { emittedServicesOf } from "../support/compile-fixture.js";
import { byCodeUnit } from "../support/by-code-unit.js";

/**
 * **Every check on a declaration, one fixture each, and the arithmetic that makes a silent drop
 * impossible.**
 *
 * Each fixture declares a surface over `rest.tsp` with at least one declaration that fails the
 * check under test and at least one that passes every check. A check that dropped too much is as
 * wrong as one that dropped too little, so every arm asserts both what was dropped and what
 * survived.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

/** The surface of a fixture's one service. */
async function surfaceFor(name: string): Promise<Surface> {
	const { program, services } = await emittedServicesOf(here, name, `surface-${name}`);
	const [service] = services;
	if (service === undefined || services.length !== 1) {
		throw new Error(`${name}.tsp should declare exactly one service, not ${services.length}.`);
	}
	return surfaceOf(program, service);
}

const rootsOf = (surface: Surface): string[] =>
	surface.roots.map((root) => `${root.kind}:${root.name}`).toSorted();
const linksOf = (surface: Surface): string[] =>
	surface.links.map((link) => `${link.parent.name}.${link.name}`).toSorted();
const codesOf = (diagnostics: readonly SurfaceDiagnostic[]): string[] =>
	diagnostics.map((diagnostic) => diagnostic.code).toSorted();
const formatsOf = (diagnostics: readonly SurfaceDiagnostic[]): Record<string, string>[] =>
	diagnostics
		.map((diagnostic) => ({ ...diagnostic.format }))
		.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/**
 * Every declaration lands in exactly one place, and every diagnostic points at the declaration it is
 * about, in the fixture's own file, where a spec author would fix it.
 */
function expectAccounted(surface: Surface, fixture: string): void {
	expect(surface.roots.length + surface.links.length + surface.dropped.length).toBe(
		surface.declared,
	);
	for (const diagnostic of [...surface.dropped, ...surface.warnings]) {
		if (diagnostic.target === NoTarget) throw new Error(`${diagnostic.code} has no target`);
		expect(getSourceLocation(diagnostic.target).file.path.endsWith(`/${fixture}.tsp`)).toBe(true);
	}
}

describe("invalid-graphql-name", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("invalid-graphql-name");
	}, 300_000);

	it("drops every root field and link whose name GraphQL cannot carry", () => {
		expect(codesOf(surface.dropped)).toEqual([
			"invalid-graphql-name",
			"invalid-graphql-name",
			"invalid-graphql-name",
		]);
		expect(surface.dropped.map((d) => d.format["name"]).toSorted(byCodeUnit)).toEqual([
			"__createWidget",
			"author of",
			"list-widgets",
		]);
	});

	it("keeps the rest", () => {
		expect(rootsOf(surface)).toEqual(["query:widget"]);
		expect(linksOf(surface)).toEqual(["Widget.author"]);
		expectAccounted(surface, "invalid-graphql-name");
	});
});

describe("graphql-name-collision between root fields", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("graphql-name-collision");
	}, 300_000);

	/** Every party, not the second: keeping the first would make the schema depend on order. */
	it("drops every party to a collision within one root type, naming both", () => {
		expect(codesOf(surface.dropped)).toEqual(["graphql-name-collision", "graphql-name-collision"]);
		for (const { format } of surface.dropped) {
			expect(format["name"]).toBe("widget");
			expect([format["first"], format["second"]].toSorted(byCodeUnit)).toEqual([
				"Authors_read",
				"Widgets_read",
			]);
		}
	});

	it("keeps a field of the same name on the other root type, and the rest", () => {
		expect(rootsOf(surface)).toEqual(["mutation:widget", "query:widgets"]);
		expectAccounted(surface, "graphql-name-collision");
	});
});

describe("declared-twice", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("declared-twice");
	}, 300_000);

	it("keeps the first declaration of an operation and drops each later one, of either kind", () => {
		expect(formatsOf(surface.dropped)).toEqual([
			{ operationId: "Widgets_read" },
			{ operationId: "Widgets_read" },
		]);
		expect(codesOf(surface.dropped)).toEqual(["declared-twice", "declared-twice"]);
		expect(rootsOf(surface)).toEqual(["query:widget", "query:widgets"]);
		expectAccounted(surface, "declared-twice");
	});
});

describe("unknown-link-parameter", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("unknown-link-parameter");
	}, 300_000);

	it("drops a link that fills a parameter the operation does not have, or its body", () => {
		expect(codesOf(surface.dropped)).toEqual(["unknown-link-parameter", "unknown-link-parameter"]);
		expect(formatsOf(surface.dropped)).toEqual([
			{ link: "Widget.authorByKey", parameter: "author", operationId: "Authors_read" },
			{ link: "Widget.similar", parameter: "filter", operationId: "Widgets_find" },
		]);
	});

	it("keeps the rest", () => {
		expect(linksOf(surface)).toEqual(["Widget.author"]);
		expectAccounted(surface, "unknown-link-parameter");
	});
});

describe("link-property-unreadable", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("link-property-unreadable");
	}, 300_000);

	it("drops a link bound to a property no client reads: create-only, or a header", () => {
		expect(codesOf(surface.dropped)).toEqual([
			"link-property-unreadable",
			"link-property-unreadable",
		]);
		// Augments on one type are not applied in source order, so the two are compared as a set.
		expect(
			formatsOf(surface.dropped).toSorted((a, b) =>
				String(a["link"]).localeCompare(String(b["link"])),
			),
		).toEqual([
			{ link: "Signing.author", property: "authorId", model: "Signing" },
			{ link: "Signing.tagged", property: "etag", model: "Signing" },
		]);
	});

	it("keeps a link bound to a property the read body carries", () => {
		expect(linksOf(surface)).toEqual(["Signing.readAuthor"]);
		expectAccounted(surface, "link-property-unreadable");
	});
});

describe("unknown-link-property", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("unknown-link-property");
	}, 300_000);

	it("drops a link that reads a property the parent does not have", () => {
		expect(codesOf(surface.dropped)).toEqual(["unknown-link-property"]);
		expect(formatsOf(surface.dropped)).toEqual([
			{ link: "Widget.owner", property: "ownerId", model: "Widget" },
		]);
	});

	it("keeps a link that reads an inherited property, and the rest", () => {
		expect(linksOf(surface)).toEqual(["Gadget.author", "Widget.author"]);
		expectAccounted(surface, "unknown-link-property");
	});
});

describe("link-type-mismatch", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("link-type-mismatch");
	}, 300_000);

	it("drops a link whose property the parameter does not accept", () => {
		expect(codesOf(surface.dropped)).toEqual(["link-type-mismatch"]);
		expect(formatsOf(surface.dropped)).toEqual([
			{ link: "Widget.authorByMistake", parameter: "authorId", property: "count" },
		]);
	});

	it("ignores the property's null, and accepts a narrower scalar", () => {
		expect(linksOf(surface)).toEqual(["Widget.author", "Widget.authorByCount"]);
		expectAccounted(surface, "link-type-mismatch");
	});
});

/**
 * **A bound property narrowed by its parameter, and a bound list.** A parameter whose type extends
 * the property's (`AuthorId extends string`) is filled from it, and its Zod schema checks the value
 * at call time. A list of values the parameter accepts binds as a list, once per link, of single
 * items, and bounded by `@maxItems`.
 */
describe("link-lists", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("link-lists");
	}, 300_000);

	it("keeps a narrowed parameter's link, and each list link that is bounded and of single items", () => {
		expect(linksOf(surface)).toEqual([
			"Roster.authors",
			"Roster.checkedAuthors",
			"Roster.maybeAuthors",
			"Widget.checkedAuthor",
		]);
		const byName = new Map(surface.links.map((link) => [link.name, link]));
		expect(byName.get("authors")?.maxItems).toBe(20);
		expect(byName.get("maybeAuthors")?.maxItems).toBe(5);
		expect(byName.get("checkedAuthor")?.maxItems).toBeUndefined();
		expect(byName.get("authors")?.bindings.map((binding) => binding.list)).toEqual([true]);
		expect(byName.get("checkedAuthor")?.bindings.map((binding) => binding.list)).toEqual([false]);
	});

	it("drops an unbounded list, a list of what the parameter refuses, a second list and a list of pages", () => {
		expect(formatsOf(surface.dropped)).toEqual(
			[
				{ link: "Roster.byCounts", parameter: "authorId", property: "counts" },
				{
					link: "Roster.pairs",
					property: "moreIds",
					reason: "it already binds the list 'authorIds'",
				},
				{
					link: "Roster.authorPages",
					property: "authorIds",
					reason: "'CheckedAuthors_pages' answers a page, and a field cannot be a list of pages",
				},
				{ link: "Roster.unbounded", property: "unboundedIds" },
			].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		);
		expect(codesOf(surface.dropped)).toEqual([
			"link-list-not-bindable",
			"link-list-not-bindable",
			"link-list-unbounded",
			"link-type-mismatch",
		]);
		expectAccounted(surface, "link-lists");
	});
});

describe("link-not-safe", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("link-not-safe");
	}, 300_000);

	it("drops a link to an operation that is not a GET", () => {
		expect(codesOf(surface.dropped)).toEqual(["link-not-safe"]);
		expect(formatsOf(surface.dropped)).toEqual([
			{ link: "Widget.touched", operationId: "Widgets_touch", verb: "POST" },
		]);
		expect(linksOf(surface)).toEqual(["Widget.author"]);
		expectAccounted(surface, "link-not-safe");
	});
});

describe("query-not-safe", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("query-not-safe");
	}, 300_000);

	/** A WARNING that keeps the field: a search by POST is a read that needs a body. */
	it("warns on a Query field over an unsafe method, and still emits it", () => {
		expect(surface.dropped).toEqual([]);
		expect(codesOf(surface.warnings)).toEqual(["query-not-safe"]);
		expect(formatsOf(surface.warnings)).toEqual([
			{ name: "searchWidgets", operationId: "Widgets_search", verb: "POST" },
		]);
		expect(rootsOf(surface)).toEqual(["query:searchWidgets", "query:widget"]);
		expectAccounted(surface, "query-not-safe");
	});
});

describe("head-operation", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("head-operation");
	}, 300_000);

	it("drops a field over a HEAD operation", () => {
		expect(codesOf(surface.dropped)).toEqual(["head-operation"]);
		expect(formatsOf(surface.dropped)).toEqual([{ operationId: "Widgets_exists" }]);
		expect(rootsOf(surface)).toEqual(["query:widget"]);
		expectAccounted(surface, "head-operation");
	});
});

describe("non-json-request", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("non-json-request");
	}, 300_000);

	it("drops text, multipart, raw text and raw bytes request bodies", () => {
		expect(formatsOf(surface.dropped)).toEqual([
			{ operationId: "Widgets_blob", types: "raw bytes as application/octet-stream" },
			{ operationId: "Widgets_form", types: "multipart/form-data" },
			{ operationId: "Widgets_upload", types: "text/plain" },
			{ operationId: "Widgets_xml", types: "raw text as application/xml" },
		]);
		expect(new Set(codesOf(surface.dropped))).toEqual(new Set(["non-json-request"]));
	});

	/** Where JSON is declared beside another type, the resolver sends JSON: no defect. */
	it("keeps an operation that declares JSON beside another type, and the rest", () => {
		expect(rootsOf(surface)).toEqual(["mutation:uploadEither", "query:widget"]);
		expectAccounted(surface, "non-json-request");
	});
});

describe("non-json-response", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("non-json-response");
	}, 300_000);

	/**
	 * **Every media type of a status, not one of them.** The handler chooses which to answer, so a
	 * status offering XML beside JSON may answer XML, which no GraphQL type projects.
	 */
	it("drops an operation that answers a status as text or bytes, even beside JSON", () => {
		expect(formatsOf(surface.dropped)).toEqual([
			{
				operationId: "Widgets_download",
				status: "200",
				types: "bytes as application/octet-stream",
			},
			{ operationId: "Widgets_export", status: "200", types: "text as text/csv" },
			{ operationId: "Widgets_formats", status: "200", types: "text as application/xml" },
			{ operationId: "Widgets_parts", status: "200", types: "parts as multipart/form-data" },
			{
				operationId: "Widgets_partsConflict",
				status: "409",
				types: "parts as multipart/form-data",
			},
		]);
		expect(new Set(codesOf(surface.dropped))).toEqual(new Set(["non-json-response"]));
	});

	/**
	 * **A body declared `void` is none.** The library declares no schema and lists no media type for
	 * it, and `@typespec/openapi3` publishes its status with no content, so it answers nothing for
	 * GraphQL to carry.
	 */
	it("keeps the rest, an error body declared void among them", () => {
		expect(rootsOf(surface)).toEqual([
			"query:voidRangeWidget",
			"query:voidedWidget",
			"query:widget",
		]);
		expectAccounted(surface, "non-json-response");
	});
});

describe("non-json-response for JSON beside bytes", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("json-beside-bytes");
	}, 300_000);

	/**
	 * **One status offered as `application/json` and as `application/octet-stream`.** The handler's
	 * result type is the server's, so it may return the bytes, and GraphQL cannot project them.
	 */
	it("drops an operation one of whose statuses may be answered as bytes", () => {
		expect(codesOf(surface.dropped)).toEqual(["non-json-response"]);
		expect(formatsOf(surface.dropped)).toEqual([
			{ operationId: "Widgets_archive", status: "200", types: "bytes as application/octet-stream" },
		]);
	});

	it("keeps the rest", () => {
		expect(rootsOf(surface)).toEqual(["query:widget", "query:widgets"]);
		expectAccounted(surface, "json-beside-bytes");
	});
});

describe("non-object-body", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("non-object-body");
	}, 300_000);

	it("drops a root field and a link whose unnamed body has no properties to merge", () => {
		expect(codesOf(surface.dropped)).toEqual(["non-object-body", "non-object-body"]);
		expect(formatsOf(surface.dropped)).toEqual([
			{ operationId: "Widgets_adopt", types: "the discriminated union 'Pet'" },
			{ operationId: "Widgets_match", types: "the discriminated union 'Pet'" },
		]);
	});

	/** A body the library named is one field of the input, whatever its type: no defect. */
	it("keeps a scalar and an array body the library named, and the rest", () => {
		expect(rootsOf(surface)).toEqual([
			"mutation:createWidgets",
			"mutation:tallyWidgets",
			"query:widget",
		]);
		expect(linksOf(surface)).toEqual(["Widget.author"]);
		expectAccounted(surface, "non-object-body");
	});
});

describe("shared-input-key", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("shared-input-key");
	}, 300_000);

	/**
	 * **The handler takes one object keyed by wire name**, as every server built on the library
	 * does (`Fields<Query> & Fields<Header>`), so two inputs of one name reach it as one key, and a
	 * GraphQL field could pass only one of them. The compiler refuses a path parameter and a query
	 * sharing a name (`incompatible-uri-param`); every other pairing reaches the emitter.
	 */
	it("drops a root field and a link whose operation has two inputs of one name", () => {
		expect(codesOf(surface.dropped)).toEqual(Array(6).fill("shared-input-key"));
		expect(formatsOf(surface.dropped)).toEqual([
			{ operationId: "Shared_body", name: "body", locations: "query and body" },
			{ operationId: "Shared_cookie", name: "x", locations: "cookie and query" },
			{ operationId: "Shared_header", name: "x", locations: "header and query" },
			{ operationId: "Shared_header", name: "x", locations: "header and query" },
			{ operationId: "Shared_path", name: "id", locations: "path and header" },
			{ operationId: "Shared_query", name: "x", locations: "query and query" },
		]);
	});

	it("keeps one location with two names, and the rest", () => {
		expect(rootsOf(surface)).toEqual(["query:distinct", "query:widget"]);
		expect(linksOf(surface)).toEqual([]);
		expectAccounted(surface, "shared-input-key");
	});
});

describe("graphql-name-collision on a parent type", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("link-collision");
	}, 300_000);

	it("drops both of two links of one parent that share a name", () => {
		const owners = surface.dropped.filter((d) => d.format["name"] === "owner");
		expect(formatsOf(owners)).toEqual([
			{
				name: "owner",
				first: "Widget.owner -> Authors_read",
				second: "Widget.owner -> Authors_byNumber",
			},
			{
				name: "owner",
				first: "Widget.owner -> Authors_read",
				second: "Widget.owner -> Authors_byNumber",
			},
		]);
	});

	/**
	 * **By the property's GraphQL name, which is the camelCase of its JSON wire name.** `display_name`
	 * is `displayName`, and `createdAt` sent as `made_on` is `madeOn`, while `createdAt` names no
	 * field of the GraphQL type at all.
	 */
	it("drops a link named like one of the parent's fields, by the field's wire name", () => {
		const shadowing = surface.dropped.filter((d) => d.format["name"] !== "owner");
		expect(formatsOf(shadowing)).toEqual([
			{
				name: "displayName",
				first: "Widget.display_name",
				second: "Widget.displayName -> Authors_read",
			},
			{ name: "madeOn", first: "Widget.createdAt", second: "Widget.madeOn -> Authors_read" },
		]);
		expect(new Set(codesOf(surface.dropped))).toEqual(new Set(["graphql-name-collision"]));
	});

	it("keeps the same name on another parent, a TypeSpec-only name, and the rest", () => {
		expect(linksOf(surface)).toEqual(["Gadget.owner", "Widget.author", "Widget.createdAt"]);
		expectAccounted(surface, "link-collision");
	});
});

describe("a link chosen by a kind", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("link-keyed");
	}, 300_000);

	const armsOf = (name: string) =>
		surface.links
			.filter((link) => link.name === name)
			.map((link) => ({
				operationId: link.route.operationId,
				property: link.when?.property.name,
				parentWire: link.when?.parentWire,
				values: link.when?.values,
				description: link.description,
			}));

	it("keeps each arm of a field whose arms agree, one link per arm", () => {
		expect(linksOf(surface)).toEqual([
			"Review.author",
			"Review.onceDescribed",
			"Review.onceDescribed",
			"Review.subject",
			"Review.subject",
		]);
		expect(armsOf("subject")).toEqual([
			{
				operationId: "Authors_read",
				property: "subject_type",
				parentWire: "subject_type",
				values: ["author"],
				description: undefined,
			},
			{
				operationId: "Widgets_read",
				property: "subject_type",
				parentWire: "subject_type",
				values: ["widget", "gadget"],
				description: undefined,
			},
		]);
		expect(armsOf("author").map((arm) => arm.values)).toEqual([["author"]]);
	});

	it("gives every arm the one description an arm states", () => {
		expect(armsOf("onceDescribed").map((arm) => arm.description)).toEqual([
			"What the review is of.",
			"What the review is of.",
		]);
	});

	it("drops a link `when` cannot choose", () => {
		const mismatched = surface.dropped.filter((d) => d.code === "link-when-mismatch");
		expect(formatsOf(mismatched)).toEqual([
			{ link: "Review.byNothing", reason: "`when` names no property" },
			{ link: "Review.byRating", reason: "'rating' is no string property" },
			{ link: "Review.misspelt", reason: "'subject_type' never holds 'editor'" },
			{ link: "Review.noValue", reason: "`when` names no value of 'subject_type'" },
			{
				link: "Review.twoKeys",
				reason:
					"`when` names 2 properties, 'subject_type' and 'tone', where a link is chosen by one",
			},
		]);
	});

	it("drops a link `when` chooses by a property the parent's read body does not carry", () => {
		expect(
			formatsOf(
				surface.dropped.filter(
					(d) => d.code === "unknown-link-property" || d.code === "link-property-unreadable",
				),
			),
		).toEqual([
			{ link: "Review.byDraft", property: "draft_type", model: "Review" },
			{ link: "Review.byMood", property: "mood", model: "Review" },
		]);
		expect(
			surface.dropped
				.filter((d) => d.code === "unknown-link-property" || d.code === "link-property-unreadable")
				.map((d) => d.code)
				.toSorted(),
		).toEqual(["link-property-unreadable", "unknown-link-property"]);
	});

	it("drops every arm of links sharing a name that cannot be one field", () => {
		const conflicts = surface.dropped.filter((d) => d.code === "link-arms-conflict");
		expect(formatsOf(conflicts)).toEqual(
			[
				...Array(2).fill({ link: "Review.claimedTwice", reason: "'author' chooses two of them" }),
				...Array(2).fill({ link: "Review.described", reason: "their descriptions differ" }),
				...Array(2).fill({ link: "Review.listed", reason: "some bind a list and some do not" }),
				...Array(2).fill({
					link: "Review.mixed",
					reason: "only some of them say `when` they are chosen",
				}),
				...Array(2).fill({
					link: "Review.twoProperties",
					reason: "they are chosen by different properties, 'subject_type' and 'tone'",
				}),
			].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		);
	});

	it("accounts for every arm", () => {
		expect(codesOf(surface.dropped)).toEqual([
			...Array(10).fill("link-arms-conflict"),
			"link-property-unreadable",
			...Array(5).fill("link-when-mismatch"),
			"unknown-link-property",
		]);
		expectAccounted(surface, "link-keyed");
	});
});

describe("a batched link", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("link-batch");
	}, 300_000);

	const batchOf = (name: string) => {
		const link = surface.links.find((candidate) => candidate.name === name);
		return {
			batch: link?.batch === undefined ? undefined : { ...link.batch, item: link.batch.item.name },
			list: link?.bindings.map((binding) => binding.list),
			maxItems: link?.maxItems,
		};
	};

	it("keeps a batch of one value per parent, of a parent's list, and of a list `items` names", () => {
		expect(linksOf(surface)).toEqual(["Shelf.author", "Shelf.authors", "Shelf.named"]);
		expect(batchOf("author")).toEqual({
			batch: { wire: "ids", key: "id", items: "authors", size: 50, item: "Author" },
			list: [false],
			maxItems: undefined,
		});
		expect(batchOf("authors")).toEqual({
			batch: { wire: "ids", key: "id", items: undefined, size: undefined, item: "Author" },
			list: [true],
			maxItems: 10,
		});
		expect(batchOf("named").batch?.items).toBe("editors");
	});

	it("drops a link that cannot call its operation as a batch, saying why", () => {
		expect(formatsOf(surface.dropped.filter((d) => d.code === "link-batch-invalid"))).toEqual(
			[
				{
					link: "Shelf.ambiguous",
					operationId: "BatchAuthors_twice",
					reason: "its body holds 2 lists, 'authors' and 'editors'; name one with `items`",
				},
				{
					link: "Shelf.atLeastTwo",
					operationId: "BatchAuthors_atLeast",
					reason: "'ids' declares @minItems(2), so one value alone is refused",
				},
				{
					link: "Shelf.inPath",
					operationId: "BatchAuthors_byPath",
					reason: "'ids' is a path parameter, and a batch sends its values in the query",
				},
				{
					link: "Shelf.misnamed",
					operationId: "BatchAuthors_twice",
					reason: "'readers' is no list property of its body",
				},
				{
					link: "Shelf.noList",
					operationId: "Authors_read",
					reason: "it binds no list parameter",
				},
				{
					link: "Shelf.ofStrings",
					operationId: "BatchAuthors_strings",
					reason: "its items are no model",
				},
				{
					link: "Shelf.optionalKey",
					operationId: "BatchAuthors_penned",
					reason: "'nickname' is optional, so an item may have no key",
				},
				{
					link: "Shelf.paged",
					operationId: "BatchAuthors_pages",
					reason: "it answers a page",
				},
				{
					link: "Shelf.translated",
					operationId: "BatchAuthors_inLanguage",
					reason:
						"the list 'languages' fills 'lang', and only the batch's own list parameter may be filled from a list",
				},
				{
					link: "Shelf.twoAnswers",
					operationId: "BatchAuthors_answers",
					reason: "it answers 2 success bodies",
				},
				{
					link: "Shelf.unkeyed",
					operationId: "BatchAuthors_bare",
					reason: "'uid' is no property of 'Author'",
				},
				{
					link: "Shelf.wrongKey",
					operationId: "BatchAuthors_penned",
					reason: "'count' never equals 'authorId', a value of another type",
				},
			].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		);
	});

	it("drops a value the batch parameter's items refuse as a type mismatch", () => {
		expect(formatsOf(surface.dropped.filter((d) => d.code === "link-type-mismatch"))).toEqual([
			{ link: "Shelf.byCount", parameter: "ids", property: "count" },
		]);
		expectAccounted(surface, "link-batch");
	});
});

describe("link bindings", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("bindings");
	}, 300_000);

	/**
	 * **`wire` is the key the handler's merged input carries, which is the validator's key**: the
	 * parameter's wire name for path, query, header and cookie alike. `parentWire` is the key the
	 * parent's JSON body carries. Neither is the TypeSpec name, and this fixture makes every one of
	 * them differ from it.
	 */
	it("carries each binding's parameter, wire key, property and parent wire key", () => {
		const [link] = surface.links;
		expect(surface.links).toHaveLength(1);
		expect(
			link?.bindings.map((binding) => ({
				parameter: binding.parameter,
				wire: binding.wire,
				property: binding.property.name,
				parentWire: binding.parentWire,
			})),
		).toEqual([
			{ parameter: "thing_id", wire: "thing_id", property: "thing_ref", parentWire: "thingRef" },
			{ parameter: "page_size", wire: "page-size", property: "size", parentWire: "size" },
			{
				parameter: "request_id",
				wire: "x-request-id",
				property: "requestId",
				parentWire: "requestId",
			},
			{ parameter: "session", wire: "session", property: "session", parentWire: "session" },
		]);
		expect(link?.route.operationId).toBe("read");
		expect(link?.names.operationId).toBe("read");
	});
});

describe("roots + links + dropped === declared", () => {
	let surface: Surface;
	beforeAll(async () => {
		surface = await surfaceFor("mixed");
	}, 300_000);

	it("accounts for every declaration of a surface that fails in every way", () => {
		expectAccounted(surface, "mixed");
		// Non-vacuity: both terms, and every kind of drop, are present.
		expect(rootsOf(surface)).toEqual(["query:searchWidgets", "query:widget"]);
		expect(linksOf(surface)).toEqual(["Gadget.author", "Widget.author"]);
		expect(codesOf(surface.dropped)).toEqual(
			[
				"declared-twice",
				"graphql-name-collision",
				"graphql-name-collision",
				"graphql-name-collision",
				"head-operation",
				"invalid-graphql-name",
				"invalid-graphql-name",
				"link-not-safe",
				"link-type-mismatch",
				"non-json-request",
				"non-json-response",
				"non-object-body",
				"unknown-link-parameter",
				"unknown-link-property",
			].toSorted(),
		);
		expect(codesOf(surface.warnings)).toEqual(["query-not-safe"]);
		expect(surface.declared).toBe(18);
	});
});

describe("a surface per service", () => {
	it("holds only the declarations whose operation the service serves", async () => {
		const { program, services } = await emittedServicesOf(here, "two-services", "surface-two");
		const byName = new Map(services.map((service) => [service.service.namespace.name, service]));
		const alpha = byName.get("Alpha");
		const beta = byName.get("Beta");
		if (alpha === undefined || beta === undefined) throw new Error("expected Alpha and Beta");

		const alphaSurface = surfaceOf(program, alpha);
		const betaSurface = surfaceOf(program, beta);
		expect(rootsOf(alphaSurface)).toEqual(["query:thing", "query:things"]);
		expect(rootsOf(betaSurface)).toEqual(["query:item"]);
		// A link belongs to the service whose operation it calls, wherever its parent is declared.
		expect(linksOf(alphaSurface)).toEqual(["Item.thing"]);
		expect(linksOf(betaSurface)).toEqual(["Item.self"]);

		// Every declaration is some service's, and no service's twice.
		const total = rootDeclarationsOf(program).length + linkDeclarationsOf(program).length;
		expect(alphaSurface.declared + betaSurface.declared).toBe(total);
		expect(total).toBe(5);
	}, 300_000);
});
