import {
	buildSchema,
	graphql,
	type GraphQLFieldConfig,
	GraphQLObjectType,
	GraphQLSchema,
	printSchema,
} from "graphql";
import { describe, expect, expectTypeOf, it } from "vitest";
import { RUNTIME_SCALARS, type RuntimeScalar as PlannedScalar } from "../../src/model.js";
import { SCALAR_DEFINITIONS } from "../../src/types.js";
import {
	CostDirective,
	ListSizeDirective,
	type RuntimeScalar,
	SCALARS,
} from "../../src/runtime.js";

/**
 * **One scalar, one wire form.** Serialisation hands the wire value back unchanged, and input
 * coercion checks only the JSON type the emitter's `SCALAR_DEFINITIONS` states; the operation's Zod
 * schema validates the rest.
 *
 * Driven through graphql-js's own executor, so both coercion paths are the ones a server takes:
 * a literal goes through `parseLiteral` during validation, a variable through `parseValue`.
 */

/**
 * **The JSON type each scalar's wire value has, written by hand** from what each one encodes
 * (design.md § Types): an integer for a 64-bit or arbitrary integer and for Unix seconds, a number
 * for a decimal and for a duration in seconds or milliseconds, any JSON for `JSON`, a string for
 * every other. Held to the emitter's `SCALAR_DEFINITIONS` by a test of its own below, rather than
 * read from it, so a wrong entry there fails an assertion instead of reshaping these tests.
 */
const KINDS = {
	Long: "integer",
	BigInteger: "integer",
	Numeric: "number",
	BigDecimal: "number",
	UTCDateTime: "string",
	UTCDateTimeHuman: "string",
	UTCDateTimeUnix: "integer",
	OffsetDateTime: "string",
	OffsetDateTimeHuman: "string",
	OffsetDateTimeUnix: "integer",
	PlainDate: "string",
	PlainTime: "string",
	Duration: "string",
	DurationSeconds: "number",
	DurationMilliseconds: "number",
	Bytes: "string",
	BytesUrl: "string",
	URL: "string",
	JSON: "any",
} as const satisfies Readonly<Record<RuntimeScalar, string>>;
const JSON_KIND = (name: RuntimeScalar) => KINDS[name];

describe("the emitter's scalar table", () => {
	it("states each scalar's JSON type as the scalar encodes it", () => {
		expect(
			Object.fromEntries(RUNTIME_SCALARS.map((name) => [name, SCALAR_DEFINITIONS[name].json])),
		).toEqual(KINDS);
	});
});

/** A schema with one `echo<Scalar>(value: <Scalar>): <Scalar>` field per scalar. */
const schema = new GraphQLSchema({
	query: new GraphQLObjectType({
		name: "Query",
		fields: Object.fromEntries(
			RUNTIME_SCALARS.map((name): [string, GraphQLFieldConfig<unknown, unknown>] => [
				`echo${name}`,
				{
					type: SCALARS[name],
					args: { value: { type: SCALARS[name] } },
					resolve: (_source, args: { value?: unknown }) => args.value,
				},
			]),
		),
	}),
});

async function viaVariable(name: RuntimeScalar, value: unknown) {
	return graphql({
		schema,
		source: `query ($v: ${name}) { echo${name}(value: $v) }`,
		variableValues: { v: value },
	});
}

async function viaLiteral(name: RuntimeScalar, literal: string) {
	return graphql({ schema, source: `{ echo${name}(value: ${literal}) }` });
}

/** A wire value of each JSON kind, and a literal spelling it. */
const ACCEPTED = {
	string: { value: "2026-10-13T00:00:00Z", literal: '"2026-10-13T00:00:00Z"' },
	number: { value: 1.5, literal: "1.5" },
	integer: { value: 9007199254740991, literal: "9007199254740991" },
	any: { value: { a: [1, "x", null, true] }, literal: '{ a: [1, "x", null, true] }' },
} as const;

/** A value of the wrong JSON kind for each, and a literal spelling it. */
const REFUSED = {
	string: [
		{ value: 5, literal: "5" },
		{ value: true, literal: "true" },
	],
	number: [
		{ value: "1.5", literal: '"1.5"' },
		{ value: false, literal: "false" },
	],
	integer: [
		{ value: 1.5, literal: "1.5" },
		{ value: "42", literal: '"42"' },
	],
	any: [],
} as const;

describe("the runtime's scalars are the plan's", () => {
	it("defines exactly RUNTIME_SCALARS", () => {
		expect(Object.keys(SCALARS).toSorted()).toEqual([...RUNTIME_SCALARS].toSorted());
		expectTypeOf<RuntimeScalar>().toEqualTypeOf<PlannedScalar>();
	});

	/**
	 * **The hand copy agrees with the emitter's table**, which `schema.graphql` is printed from. The
	 * SDL oracle would catch a drift too, but only for the scalars a fixture happens to reach.
	 */
	it("carries the emitter's description and @specifiedBy URL for every scalar", () => {
		for (const name of RUNTIME_SCALARS) {
			expect({
				name: SCALARS[name].name,
				description: SCALARS[name].description,
				specifiedBy: SCALARS[name].specifiedByURL ?? undefined,
			}).toEqual({
				name,
				description: SCALAR_DEFINITIONS[name].description,
				specifiedBy: SCALAR_DEFINITIONS[name].specifiedBy,
			});
		}
	});
});

describe("a scalar round-trips its wire value", () => {
	for (const name of RUNTIME_SCALARS) {
		const accepted = ACCEPTED[JSON_KIND(name)];
		it(`${name} accepts a JSON ${JSON_KIND(name)} as a variable and as a literal, unchanged`, async () => {
			const variable = await viaVariable(name, accepted.value);
			expect(variable.errors).toBeUndefined();
			expect(variable.data?.[`echo${name}`]).toEqual(accepted.value);
			const literal = await viaLiteral(name, accepted.literal);
			expect(literal.errors).toBeUndefined();
			expect(literal.data?.[`echo${name}`]).toEqual(accepted.value);
		});
	}

	it("a number scalar accepts an integer literal too", async () => {
		const result = await viaLiteral("BigDecimal", "2");
		expect(result.errors).toBeUndefined();
		expect(result.data?.["echoBigDecimal"]).toBe(2);
	});
});

describe("a scalar refuses a value of the wrong JSON type, as BAD_USER_INPUT", () => {
	for (const name of RUNTIME_SCALARS) {
		for (const wrong of REFUSED[JSON_KIND(name)]) {
			it(`${name} refuses ${JSON.stringify(wrong.value)}`, async () => {
				const variable = await viaVariable(name, wrong.value);
				expect(variable.errors?.map((e) => e.extensions["code"])).toEqual(["BAD_USER_INPUT"]);
				const literal = await viaLiteral(name, wrong.literal);
				expect(literal.errors?.map((e) => e.extensions["code"])).toEqual(["BAD_USER_INPUT"]);
			});
		}
	}

	// Non-vacuity: every scalar but JSON refuses something.
	it("refuses something for every scalar that is not JSON", () => {
		const refusing = RUNTIME_SCALARS.filter((name) => REFUSED[JSON_KIND(name)].length > 0);
		expect(refusing).toHaveLength(RUNTIME_SCALARS.length - 1);
	});
});

describe("the cost directives are IBM's", () => {
	/** Quoted verbatim from https://ibm.github.io/graphql-specs/cost-spec.html. */
	const SPEC = `
directive @cost(weight: String!) on
  | ARGUMENT_DEFINITION
  | ENUM
  | FIELD_DEFINITION
  | INPUT_FIELD_DEFINITION
  | OBJECT
  | SCALAR

directive @listSize(
  assumedSize: Int,
  slicingArguments: [String!],
  sizedFields: [String!],
  requireOneSlicingArgument: Boolean = true
) on FIELD_DEFINITION

type Query { ok: Boolean }
`;

	it("prints exactly as the specification's definitions", () => {
		const ours = new GraphQLSchema({
			query: new GraphQLObjectType({ name: "Query", fields: { ok: { type: SCALARS.JSON } } }),
			directives: [CostDirective, ListSizeDirective],
		});
		const directivesOf = (text: string) =>
			text.split("\n\n").filter((block) => block.startsWith("directive "));
		const theirs = directivesOf(printSchema(buildSchema(SPEC)));
		expect(theirs).toHaveLength(2);
		expect(directivesOf(printSchema(ours))).toEqual(theirs);
	});
});
