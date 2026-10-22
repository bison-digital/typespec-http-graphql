import { graphql, GraphQLObjectType, GraphQLSchema } from "graphql";
import { describe, expect, it } from "vitest";
import { type RuntimeScalar, SCALARS } from "../../src/runtime.js";

/**
 * **What a client is told when a scalar refuses its input, and the edges of each JSON type.** The
 * wire form is a JSON value (RFC 8259), so a number scalar takes only what a JSON number can be, and
 * an integer scalar only an integer literal, as GraphQL's own `Int` does (§3.5.1: "only integer input
 * values are accepted"). Driven through graphql-js's executor, as `scalars.test.ts` is: a literal is
 * refused during validation, a variable as it is coerced.
 */

const ECHOED = ["Long", "BigDecimal", "UTCDateTime"] as const satisfies readonly RuntimeScalar[];

/** A schema with one `<scalar>(value: <Scalar>): <Scalar>` field per scalar above. */
const schema = new GraphQLSchema({
	query: new GraphQLObjectType({
		name: "Query",
		fields: Object.fromEntries(
			ECHOED.map((name) => [
				name,
				{
					type: SCALARS[name],
					args: { value: { type: SCALARS[name] } },
					resolve: (_source: unknown, args: { readonly value?: unknown }) => args.value,
				},
			]),
		),
	}),
});

const codesOf = async (source: string, variableValues?: Record<string, unknown>) =>
	(await graphql({ schema, source, variableValues })).errors?.map((e) => e.extensions["code"]);

describe("a refused literal", () => {
	/** The literal follows `{ `, the field's name and `(value: `: `{ Long(value: ` ends at column 14. */
	it.each([
		["Long", `"x"`, 15, "Long expects a JSON integer on the wire"],
		["BigDecimal", `"x"`, 21, "BigDecimal expects a JSON number on the wire"],
		["UTCDateTime", `5`, 22, "UTCDateTime expects a JSON string on the wire"],
	])(
		"of %s is BAD_USER_INPUT at the literal, naming the JSON type it needs",
		async (name, literal, column, message) => {
			const result = await graphql({ schema, source: `{ ${name}(value: ${literal}) }` });
			expect(
				result.errors?.map((error) => ({
					message: error.message,
					locations: error.locations,
					code: error.extensions["code"],
				})),
			).toEqual([{ message, locations: [{ line: 1, column }], code: "BAD_USER_INPUT" }]);
		},
	);
});

describe("the edges of a JSON type", () => {
	it("an integer scalar refuses a float literal, even one whose value is whole", async () => {
		expect(await codesOf(`{ Long(value: 2.0) }`)).toEqual(["BAD_USER_INPUT"]);
		expect(await codesOf(`{ Long(value: 1e3) }`)).toEqual(["BAD_USER_INPUT"]);
		expect(await codesOf(`{ Long(value: 2) }`)).toBeUndefined();
	});

	/**
	 * `1e400` is a number literal no double holds: read, it is Infinity, which no JSON value is. A
	 * variable of a non-finite number reaches the scalar only from an in-process caller, never from a
	 * JSON request, and is refused alike.
	 */
	it("a number scalar refuses a number no JSON value is, as a literal and as a variable", async () => {
		expect(await codesOf(`{ BigDecimal(value: 1e400) }`)).toEqual(["BAD_USER_INPUT"]);
		for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
			expect(
				await codesOf(`query ($v: BigDecimal) { BigDecimal(value: $v) }`, { v: value }),
			).toEqual(["BAD_USER_INPUT"]);
		}
	});
});
