import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertName, GraphQLInt, GraphQLObjectType, GraphQLSchema, validateSchema } from "graphql";
import { STATUS_CODES } from "typespec-http-zod";
import { describe, expect, it } from "vitest";
import {
	enumValueNameOf,
	fieldNameOf,
	isGraphQLName,
	NameBook,
	reasonCodeOf,
	reasonTypeNameOf,
	typeNameOf,
} from "../../src/names.js";

/**
 * **Whether graphql-js accepts `name` as a field of a schema it validates.** `assertName` checks the
 * characters only; the reservation of a leading `__` for introspection is enforced when a schema is
 * validated, so both are asked.
 */
function graphqlAccepts(name: string): boolean {
	try {
		assertName(name);
	} catch {
		return false;
	}
	const schema = new GraphQLSchema({
		query: new GraphQLObjectType({ name: "Query", fields: { [name]: { type: GraphQLInt } } }),
	});
	return validateSchema(schema).length === 0;
}

describe("type names", () => {
	it.each([
		["Widget", "Widget"],
		["Acme.Widgets.Widget", "Widget"],
		["widget_record", "WidgetRecord"],
		["HTTPStatus", "HTTPStatus"],
		["XMLParser", "XMLParser"],
		["Widget[]", "WidgetArray"],
		["2fa-settings", "_2faSettings"],
	])("%s becomes %s", (raw, expected) => {
		expect(typeNameOf(raw)).toBe(expected);
	});
});

describe("field and argument names, from the wire name", () => {
	it.each([
		["created_at", "createdAt"],
		["x-request-id", "xRequestId"],
		["page-size", "pageSize"],
		["author_id", "authorId"],
		["XMLParser", "xmlParser"],
		["id", "id"],
	])("%s becomes %s", (raw, expected) => {
		expect(fieldNameOf(raw)).toBe(expected);
	});
});

describe("enum value names", () => {
	it.each([
		["in-progress", "IN_PROGRESS"],
		["active", "ACTIVE"],
		["v2", "V_2"],
		["Read", "READ"],
	])("%s becomes %s", (raw, expected) => {
		expect(enumValueNameOf(raw)).toBe(expected);
	});
});

/**
 * **Reason phrases come from a fixed table of RFC 9110's phrases and IANA's registry**, never from
 * the Node running the emitter. These rows pin it, including the two RFC 9110 renamed (413, 422),
 * which Node 22 still spells the old way.
 */
describe("status reason names, for wrapper types", () => {
	it.each([
		[200, "OK"],
		[204, "NoContent"],
		[404, "NotFound"],
		[413, "ContentTooLarge"],
		[418, "ImATeapot"],
		[422, "UnprocessableContent"],
		[226, "IMUsed"],
		["404", "NotFound"],
		["2XX", "Success"],
		["4XX", "ClientError"],
		["5XX", "ServerError"],
		["default", "Default"],
		[299, "Status299"],
	])("%s becomes %s", (status, expected) => {
		expect(reasonTypeNameOf(status)).toBe(expected);
	});
});

describe("status reason codes, for top-level errors", () => {
	it.each([
		[409, "CONFLICT"],
		[410, "GONE"],
		[412, "PRECONDITION_FAILED"],
		[418, "IM_A_TEAPOT"],
		[422, "UNPROCESSABLE_CONTENT"],
		[429, "TOO_MANY_REQUESTS"],
		[500, "INTERNAL_SERVER_ERROR"],
		[503, "SERVICE_UNAVAILABLE"],
		[299, "STATUS_299"],
	])("%s becomes %s", (status, expected) => {
		expect(reasonCodeOf(status)).toBe(expected);
	});
});

describe("the reason phrase table", () => {
	/**
	 * **Every code the library says a server can answer with has a phrase**, so no generated name
	 * falls back to `Status<code>`. Graded against the library's own list, which its server
	 * emitters grade against Hono's: a code added there turns this red.
	 */
	it("has a phrase for every code in typespec-http-zod's STATUS_CODES", () => {
		const codes: number[] = Object.values(STATUS_CODES).flat();
		expect(codes.length).toBeGreaterThanOrEqual(60);
		for (const code of codes) {
			expect(reasonTypeNameOf(code), String(code)).not.toBe(`Status${code}`);
			expect(reasonCodeOf(code), String(code)).not.toBe(`STATUS_${code}`);
		}
	});

	it("is the only source of phrases: names.ts imports change-case and nothing else", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../../src/names.ts", import.meta.url)),
			"utf8",
		);
		const specifiers = [...source.matchAll(/^import [^;]* from "([^"]+)";$/gm)].map((m) => m[1]);
		expect(specifiers).toEqual(["change-case"]);
	});
});

describe("every produced name is one graphql-js accepts", () => {
	/**
	 * **`--` and `__typename` are the inputs upstream's pipeline turns into a name starting `__`**,
	 * which GraphQL reserves for introspection. Here they become `_`-prefixed names instead.
	 */
	it("holds over awkward input", () => {
		const awkward = [
			"$x",
			"a b",
			"9lives",
			"--",
			"__typename",
			"___x",
			"_-x",
			"Ü",
			"",
			"  spaced  ",
		];
		for (const raw of awkward) {
			for (const name of [typeNameOf(raw), fieldNameOf(raw), enumValueNameOf(raw)]) {
				expect(isGraphQLName(name), `${JSON.stringify(raw)} -> ${name}`).toBe(true);
				expect(graphqlAccepts(name), `${JSON.stringify(raw)} -> ${name}`).toBe(true);
			}
		}
		expect(fieldNameOf("--")).toBe("_");
		expect(fieldNameOf("__typename")).toBe("_typename");
	});

	it("holds for every status, ranged or exact", () => {
		for (let status = 100; status < 600; status++) {
			expect(isGraphQLName(reasonTypeNameOf(status)), String(status)).toBe(true);
			expect(isGraphQLName(reasonCodeOf(status)), String(status)).toBe(true);
		}
	});

	it("rejects what graphql-js rejects", () => {
		for (const name of ["__typename", "__x", "1a", "a-b", "", "a b", "é"]) {
			expect(isGraphQLName(name), name).toBe(false);
			expect(graphqlAccepts(name), name).toBe(false);
		}
		for (const name of ["_", "_x", "x_1", "X"]) {
			expect(isGraphQLName(name), name).toBe(true);
			expect(graphqlAccepts(name), name).toBe(true);
		}
	});
});

describe("NameBook", () => {
	it("lets one owner claim a name twice", () => {
		const book = new NameBook();
		expect(book.claim("Widget", "model:Widget")).toBe(true);
		expect(book.claim("Widget", "model:Widget")).toBe(true);
		expect(book.collisions).toEqual([]);
		expect(book.owners("Widget")).toEqual(["model:Widget"]);
	});

	it("records a collision between two owners, naming both", () => {
		const book = new NameBook();
		book.claim("FooBar", "model:foo_bar");
		expect(book.claim("FooBar", "model:FooBar")).toBe(false);
		expect(book.collisions).toEqual([
			{ name: "FooBar", first: "model:foo_bar", second: "model:FooBar" },
		]);
	});

	/**
	 * **Every party is reachable**, because the caller drops them all: keeping the first owner would
	 * make the schema depend on walk order.
	 */
	it("keeps every owner of a contested name, once each, first claimant first", () => {
		const book = new NameBook();
		book.claim("X", "a");
		book.claim("X", "b");
		book.claim("X", "c");
		book.claim("X", "b");
		expect(book.owners("X")).toEqual(["a", "b", "c"]);
		expect(book.collisions.map((c) => c.second)).toEqual(["b", "c"]);
		expect(book.owners("unclaimed")).toEqual([]);
	});
});
