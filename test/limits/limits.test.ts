import {
	buildSchema,
	extendSchema,
	type GraphQLError,
	GraphQLInt,
	GraphQLList,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
	Kind,
	parse,
	specifiedRules,
	validate,
	type ValidationRule,
} from "graphql";
import { describe, expect, it } from "vitest";
import {
	aliasLimit,
	costLimit,
	depthLimit,
	operationCost,
	typeCost,
	typeCostLimit,
} from "../../src/runtime.js";

/**
 * **The runtime's operation limits, against the GraphQL Cost Directives Specification**
 * (ibm.github.io/graphql-specs/cost-spec.html) and against counts written out by hand.
 *
 * The cost arms are the specification's own examples, their SDL copied from it and their costs the
 * ones it states. Where an example leaves a type undefined, the smallest declaration that lets the SDL
 * build is added beside it and named as an addition. Where the specification states a rule but no
 * number, the number is worked by hand from the rule, which is quoted. The depth and alias arms have
 * no specification to follow, so each states the count it expects and why.
 */

/** §7 and §8's definitions of the two directives, as the specification writes them. */
const DIRECTIVES = `
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
`;

const schemaOf = (sdl: string): GraphQLSchema => buildSchema(`${DIRECTIVES}\n${sdl}`);
const costOf = (
	schema: GraphQLSchema,
	document: string,
	variableValues: Readonly<Record<string, unknown>> = {},
): number => operationCost({ schema, document: parse(document), variableValues });

/** Example № 1, verbatim. */
const EXAMPLE_1 = schemaOf(`
type User {
  name: String
  age: Int @cost(weight: "2.0")
}

type Query {
  users(max: Int): [User] @listSize(slicingArguments: ["max"])
}
`);

/** Example № 10, verbatim, with `Filter` added: the example names it and leaves it undefined. */
const EXAMPLE_10 = schemaOf(`
type Query {
  topProducts(filter: Filter @cost(weight: "15.0")): [String] @cost(weight: "5.0") @listSize(assumedSize: 10)
}

input Filter { term: String }
`);

/** Example № 11, verbatim, with `Approximate` and `Product` added, which it leaves undefined. */
const EXAMPLE_11 = `
type Query {
  mostPopularProduct(approx: Approximate @cost(weight: "-3.0")): Product @cost(weight: "5.0")
}

input Approximate { tolerance: Float }
type Product { name: String }
`;

/** Example № 12, verbatim, with `Approximate` added. */
const EXAMPLE_12 = schemaOf(`
input Filter {
  approx: Approximate @cost(weight: "-12.0")
}
type Query {
  topProducts(filter: Filter @cost(weight: "15.0")): [String] @cost(weight: "5.0") @listSize(assumedSize: 10)
}

input Approximate { tolerance: Float }
`);

/** Example № 18, verbatim, with `Film` and `PageInfo` added, which it leaves undefined. */
const EXAMPLE_18 = schemaOf(`
type FilmEdge {
  cursor: ID
  node: Film # Definition of this type left out in this example
}

type FilmConnection {
  edges: [FilmEdge]
  # See https://relay.dev/graphql/connections.htm#sec-Connection-Types.Fields.PageInfo
  pageInfo: PageInfo
}

type Query {
  films(first: Int, after: ID, last: Int, before: ID): FilmConnection @listSize(
      slicingArguments: ["first", "last"],
      sizedFields: ["edges"]
    )
}

type Film { title: String }
type PageInfo { hasNextPage: Boolean }
`);

describe("operationCost: the specification's worked examples", () => {
	it('Example № 2: "The field cost of this query can be statically analyzed ... as 11.0"', () => {
		expect(costOf(EXAMPLE_1, `query Example { users (max: 5) { age } }`)).toBe(11);
	});

	it('Example № 10: "a Field Cost of 5.0 unless it uses a filter ... to 20.0"', () => {
		expect(costOf(EXAMPLE_10, `{ topProducts }`)).toBe(5);
		expect(costOf(EXAMPLE_10, `{ topProducts(filter: { term: "lamps" }) }`)).toBe(20);
	});

	it('Example № 11: "a Field Cost of 5.0 unless ... the cost would reduce to 2.0"', () => {
		const schema = schemaOf(EXAMPLE_11);
		expect(costOf(schema, `{ mostPopularProduct { name } }`)).toBe(5);
		expect(costOf(schema, `{ mostPopularProduct(approx: { tolerance: 0.1 }) { name } }`)).toBe(2);
	});

	it('Example № 12: "the filter argument overall contributes ... 3.0 ... for an overall field cost of 8.0"', () => {
		expect(costOf(EXAMPLE_12, `{ topProducts(filter: { approx: { tolerance: 0.1 } }) }`)).toBe(8);
	});

	/**
	 * Example № 13 states the effect, "adds -1.0 to the cost of every use of the @approx directive,
	 * and in turn to every field which uses the @approx directive", and no total: Example № 11's
	 * field, 5.0, with the directive used once, is 4.0.
	 */
	it("Example № 13: a directive argument's weight is added to the field that uses it", () => {
		const schema = schemaOf(
			`directive @approx (tolerance: Float! @cost(weight: "-1.0")) on FIELD\n${EXAMPLE_11}`,
		);
		expect(costOf(schema, `{ mostPopularProduct @approx(tolerance: 0.5) { name } }`)).toBe(4);
	});

	/**
	 * Example № 18 states no cost. By §8.3, `first: 3` sizes `edges`, not `films`: `films` 1, `edges`
	 * 1, three edges each running `node` at 1, and `pageInfo` 1, which is 6.
	 */
	it("Example № 18: sizedFields moves a slicing argument's size onto the field it names", () => {
		const document = `{ films(first: 3) { edges { cursor node { title } } pageInfo { hasNextPage } } }`;
		expect(costOf(EXAMPLE_18, document)).toBe(6);
	});
});

describe("operationCost: the specification's rules, worked by hand", () => {
	it('§7.1: "For scalar and enum types the weight defaults to "0.0"", composites to 1.0', () => {
		expect(costOf(EXAMPLE_1, `{ users(max: 5) { name } }`)).toBe(1);
	});

	/**
	 * 5.0 - 7.0 is -2.0, rounded up to zero, beside a sibling costing 3.0: 3.0, where an unrounded
	 * field would have taken 2.0 off its sibling.
	 */
	it('§5.3.2.2: "if this sum is negative then round it up to zero"', () => {
		const schema = schemaOf(
			EXAMPLE_11.replace('"-3.0"', '"-7.0"').replace(
				"type Query {",
				'type Query {\n  featured: Product @cost(weight: "3.0")',
			),
		);
		const document = `{ mostPopularProduct(approx: { tolerance: 0.1 }) { name } featured { name } }`;
		expect(costOf(schema, document)).toBe(3);
	});

	it('§8.1: assumedSize "can be used to statically define the maximum length of a list"', () => {
		const schema = schemaOf(`
			type Query { topProducts: [Product] @listSize(assumedSize: 10) }
			type Product { name: String price: Int @cost(weight: "2.0") }
		`);
		expect(costOf(schema, `{ topProducts { price } }`)).toBe(21);
	});

	it('§8.2: an argument "with a default value in the schema but no value given" is read as given', () => {
		const schema = schemaOf(`
			type User { age: Int @cost(weight: "2.0") }
			type Query { users(max: Int = 4): [User] @listSize(slicingArguments: ["max"]) }
		`);
		expect(costOf(schema, `{ users { age } }`)).toBe(9);
		// A value given is read over the default: `max: 5` is five users at 2.0, and the field's 1.0.
		expect(costOf(schema, `{ users(max: 5) { age } }`)).toBe(11);
	});

	/** The default read is the slicing argument's own: `offset`'s is no list size. */
	it("§8.2: reads the default of the slicing argument it names, not of another argument", () => {
		const schema = schemaOf(`
			type User { age: Int @cost(weight: "2.0") }
			type Query { users(offset: Int = 100, max: Int = 4): [User] @listSize(slicingArguments: ["max"]) }
		`);
		expect(costOf(schema, `{ users { age } }`)).toBe(1 + 4 * 2);
	});

	/** A slicing argument the field does not have is never given, so `assumedSize` sizes the list. */
	it("§8.1: falls back to assumedSize where a slicing argument names no argument of the field", () => {
		const schema = schemaOf(`
			type User { age: Int @cost(weight: "2.0") }
			type Query { users: [User] @listSize(slicingArguments: ["max"], assumedSize: 3) }
		`);
		expect(costOf(schema, `{ users { age } }`)).toBe(1 + 3 * 2);
	});

	/**
	 * A slicing argument is an Int, the length of the list; NaN, which only an in-process caller can
	 * hand over, is no length, so the list is sized as if no slicing argument were given (§8.1).
	 */
	it("§8.1: falls back to assumedSize where the slicing argument's value is no number", () => {
		const schema = schemaOf(`
			type User { age: Int @cost(weight: "2.0") }
			type Query { users(max: Int): [User] @listSize(slicingArguments: ["max"], assumedSize: 3) }
		`);
		const document = `query ($n: Int) { users(max: $n) { age } }`;
		expect(costOf(schema, document, { n: Number.NaN })).toBe(1 + 3 * 2);
		expect(costOf(schema, document, { n: 5 })).toBe(1 + 5 * 2);
	});

	it('§8: a bare @listSize bounds nothing, so a list "must initially" be assumed infinite', () => {
		const schema = schemaOf(`
			type User { name: String age: Int @cost(weight: "2.0") }
			type Query { users: [User] @listSize }
		`);
		expect(costOf(schema, `{ users { age } }`)).toBe(Infinity);
		expect(costOf(schema, `{ users { name } }`)).toBe(1);
	});

	/**
	 * `@listSize` sizes the list the field returns, the outer one; the lists inside it have no bound,
	 * so by §8 each is infinite, and only a selection costing nothing below them is finite.
	 */
	it("§8: a list of lists is sized at its outer level only", () => {
		const schema = schemaOf(`
			type User { name: String age: Int @cost(weight: "2.0") }
			type Query { matrix: [[User]] @listSize(assumedSize: 3) }
		`);
		expect(costOf(schema, `{ matrix { age } }`)).toBe(Infinity);
		expect(costOf(schema, `{ matrix { name } }`)).toBe(1);
	});

	/** No users, so nothing below them runs, however unbounded `friends` is: 1.0 for `users` alone. */
	it("§8.2: a list sliced to nothing costs nothing below it, even an unbounded list", () => {
		const schema = schemaOf(`
			type User { age: Int @cost(weight: "2.0") friends: [User] }
			type Query { users(max: Int): [User] @listSize(slicingArguments: ["max"]) }
		`);
		expect(costOf(schema, `{ users(max: 0) { friends { age } } }`)).toBe(1);
		expect(costOf(schema, `{ users(max: 1) { friends { age } } }`)).toBe(Infinity);
	});

	/** `@cost` and `@listSize` are each read by name, in either order: 3.0, and five users at 2.0. */
	it("§7 and §8: reads each directive by its name, whichever is applied first", () => {
		const costFirst = schemaOf(`
			type User { age: Int @cost(weight: "2.0") }
			type Query { users(max: Int): [User] @cost(weight: "3.0") @listSize(slicingArguments: ["max"]) }
		`);
		const sizeFirst = schemaOf(`
			type User { age: Int @cost(weight: "2.0") }
			type Query { users(max: Int): [User] @listSize(slicingArguments: ["max"]) @cost(weight: "3.0") }
		`);
		expect(costOf(costFirst, `{ users(max: 5) { age } }`)).toBe(3 + 5 * 2);
		expect(costOf(sizeFirst, `{ users(max: 5) { age } }`)).toBe(3 + 5 * 2);
	});

	it('§8.2: with more than one slicing argument, "static analysis should consider their largest value"', () => {
		const document = `{ films(first: 3, last: 7) { edges { node { title } } } }`;
		expect(costOf(EXAMPLE_18, document)).toBe(1 + 1 + 7);
	});

	it('§8: "it must initially assume the length of lists to be infinite"', () => {
		const schema = schemaOf(`
			type User { name: String age: Int @cost(weight: "2.0") }
			type Query { users: [User] }
		`);
		expect(costOf(schema, `{ users { age } }`)).toBe(Infinity);
		// Nothing below the list costs anything, so its length does not matter.
		expect(costOf(schema, `{ users { name } }`)).toBe(1);
	});

	it("§7.2: below a union or an interface, the costliest possible type counts", () => {
		const schema = schemaOf(`
			interface Named { name: String }
			type A implements Named { name: String x: Int @cost(weight: "3.0") }
			type B implements Named { name: String y: Int @cost(weight: "5.0") }
			union Either = A | B
			type Query { either: Either named: Named }
		`);
		expect(costOf(schema, `{ either { ... on A { x } ... on B { y } } }`)).toBe(1 + 5);
		expect(costOf(schema, `{ named { name ... on A { x } } }`)).toBe(1 + 3);
	});

	/**
	 * A fragment counts where its type condition applies, as CollectFields' DoesFragmentTypeApply
	 * decides: on that object type, or on an interface or union the object belongs to. `A` costs 3.0
	 * under `name`, `B` 5.0 and `C` 7.0; `C` does not implement `Named`.
	 */
	it("§7.2: counts a fragment only on the types its condition applies to", () => {
		const schema = schemaOf(`
			interface Named { name: String }
			type A implements Named { name: String @cost(weight: "3.0") }
			type B implements Named { name: String @cost(weight: "5.0") }
			type C { name: String @cost(weight: "7.0") }
			union AorC = A | C
			type Query { named: Named aOrC: AorC }
		`);
		expect(costOf(schema, `{ named { ... on A { name } } }`)).toBe(1 + 3);
		expect(costOf(schema, `{ named { ...OnA } } fragment OnA on A { name }`)).toBe(1 + 3);
		expect(costOf(schema, `{ aOrC { ... on Named { name } } }`)).toBe(1 + 3);
		expect(costOf(schema, `{ aOrC { ... on C { name } } }`)).toBe(1 + 7);
	});

	it("counts an inline fragment with no type condition on the type it is in", () => {
		expect(costOf(EXAMPLE_1, `{ users(max: 5) { ... { age } } }`)).toBe(11);
		expect(costOf(EXAMPLE_1, `{ users(max: 5) { ... @include(if: true) { age } } }`)).toBe(11);
	});

	it("reads a slicing argument from a variable, or from the variable's default", () => {
		const document = `query ($n: Int) { users(max: $n) { age } }`;
		expect(costOf(EXAMPLE_1, document, { n: 5 })).toBe(11);
		expect(costOf(EXAMPLE_1, `query ($n: Int = 2) { users(max: $n) { age } }`)).toBe(5);
		// A variable sent is read over its default.
		expect(costOf(EXAMPLE_1, `query ($n: Int = 2) { users(max: $n) { age } }`, { n: 5 })).toBe(11);
		// Neither sent nor defaulted, the slicing argument is not given, and the list is unbounded.
		expect(costOf(EXAMPLE_1, document)).toBe(Infinity);
	});

	it("counts a field once for every response key, as execution resolves it", () => {
		expect(costOf(EXAMPLE_1, `{ users(max: 5) { age } users(max: 5) { name } }`)).toBe(11);
		expect(costOf(EXAMPLE_1, `{ a: users(max: 5) { age } b: users(max: 5) { age } }`)).toBe(22);
		expect(
			costOf(EXAMPLE_1, `{ ...Users } fragment Users on Query { users(max: 5) { age } }`),
		).toBe(11);
	});

	it("leaves out what @skip and @include leave out, by the request's variables", () => {
		const document = `query ($s: Boolean!) { users(max: 5) { age @skip(if: $s) } }`;
		expect(costOf(EXAMPLE_1, document, { s: true })).toBe(1);
		expect(costOf(EXAMPLE_1, document, { s: false })).toBe(11);
		const included = `query ($i: Boolean!) { users(max: 5) { age @include(if: $i) } }`;
		expect(costOf(EXAMPLE_1, included, { i: true })).toBe(11);
		expect(costOf(EXAMPLE_1, included, { i: false })).toBe(1);
	});

	/** `level` is declared and unweighted, so `@trace` costs nothing given it or not. */
	it("reads a directive given no arguments as leaving its field in, at no cost", () => {
		const traced = extendSchema(EXAMPLE_1, parse(`directive @trace(level: Int) on FIELD`));
		expect(costOf(traced, `{ users(max: 5) @trace { age @trace } }`)).toBe(11);
		expect(costOf(traced, `{ users(max: 5) @trace(level: 1) { age } }`)).toBe(11);
	});

	it("charges nothing for introspection or __typename", () => {
		expect(costOf(EXAMPLE_1, `{ __typename __schema { types { name } } }`)).toBe(0);
	});
});

/**
 * **The operation a request runs is the one execution picks**, by GraphQL's GetOperation (§6.1): the
 * one named `operationName`, else the document's only operation. Where it picks none, the request is
 * refused before anything executes, and nothing is spent.
 */
describe("operationCost: the operation a request runs", () => {
	const TWO = `query A { users(max: 1) { age } } query B { users(max: 5) { age } }`;
	const costNamed = (document: string, operationName: string | null | undefined): number =>
		operationCost({ schema: EXAMPLE_1, document: parse(document), operationName });

	it("costs the operation operationName names", () => {
		expect(costNamed(TWO, "B")).toBe(1 + 5 * 2);
		expect(costNamed(TWO, "A")).toBe(1 + 1 * 2);
	});

	it("never picks an anonymous operation by a name", () => {
		expect(costNamed(`{ users(max: 1) { age } } query B { users(max: 5) { age } }`, "B")).toBe(11);
	});

	it("costs a document's only operation where no name is given, as undefined or as null", () => {
		expect(costNamed(`{ users(max: 5) { age } }`, undefined)).toBe(11);
		expect(costNamed(`{ users(max: 5) { age } }`, null)).toBe(11);
	});

	it("costs nothing where execution picks no operation", () => {
		expect(costNamed(TWO, undefined)).toBe(0);
		expect(costNamed(TWO, "C")).toBe(0);
	});

	it("costs nothing for an operation whose root type the schema does not have", () => {
		const document = parse(`mutation { users(max: 5) { age } }`);
		expect(operationCost({ schema: EXAMPLE_1, document })).toBe(0);
		const declaredNull = new GraphQLSchema({ ...EXAMPLE_1.toConfig(), mutation: null });
		expect(operationCost({ schema: declaredNull, document })).toBe(0);
	});
});

/**
 * **What an argument adds**, §5.3.2.2: "the weight of argument a" and "the sum of the cost of all of
 * the input fields which are used on argument a". `Term`'s `boost` weighs 2.0, and a list of terms is
 * a composite argument, 1.0 by §7.1.
 */
describe("operationCost: arguments", () => {
	const SEARCH = schemaOf(`
		scalar JSON
		input Term { boost: Float @cost(weight: "2.0") }
		type Query {
			search(terms: [Term], meta: JSON, filter: Filter @cost(weight: "15.0")): [String]
				@cost(weight: "5.0") @listSize(assumedSize: 10)
		}
		input Filter { term: String }
	`);

	it("adds the input fields each item of a list argument uses", () => {
		expect(costOf(SEARCH, `{ search(terms: [{ boost: 1 }, { boost: 2 }]) }`)).toBe(5 + 1 + 2 + 2);
	});

	/** GraphQL's input coercion reads a single value in list position as a list of one (§3.11). */
	it("reads a single value given for a list argument as a list of one", () => {
		expect(costOf(SEARCH, `{ search(terms: { boost: 1 }) }`)).toBe(5 + 1 + 2);
	});

	it("adds nothing for an item that uses no input field: a null, or a variable not sent", () => {
		expect(costOf(SEARCH, `query ($t: Term) { search(terms: [$t, null]) }`)).toBe(5 + 1);
	});

	it("adds only a JSON argument's weight, 0.0 as a scalar's, whatever object it holds", () => {
		expect(costOf(SEARCH, `{ search(meta: { boost: 1, terms: [] }) }`)).toBe(5);
	});

	/** Example № 10's filter, its weight read from the argument named, not the first one declared. */
	it("weighs the argument given, by its name", () => {
		expect(costOf(SEARCH, `{ search(filter: { term: "lamps" }) }`)).toBe(5 + 15);
	});

	it("adds nothing for an argument whose variable was not sent", () => {
		expect(costOf(EXAMPLE_10, `query ($f: Filter) { topProducts(filter: $f) }`)).toBe(5);
	});

	/** Variables reach a limit as the client sent them, before execution coerces them. */
	it("adds nothing for a key a variable carries that the input type does not declare", () => {
		const document = `query ($f: Filter) { topProducts(filter: $f) }`;
		expect(costOf(EXAMPLE_10, document, { f: { term: "lamps", colour: "red" } })).toBe(20);
	});

	/** Example № 13's `@approx`, with a costless argument declared before the costed one. */
	it("weighs a directive's argument by its name", () => {
		const schema = schemaOf(
			`directive @approx (mode: String, tolerance: Float! @cost(weight: "-1.0")) on FIELD\n${EXAMPLE_11}`,
		);
		expect(costOf(schema, `{ mostPopularProduct @approx(tolerance: 0.5) { name } }`)).toBe(4);
	});
});

/**
 * **A runtime schema's `extensions`**, as `graphql.gen.ts` writes them (`cost`, `listSize`), are read
 * where it was built in code and carries no SDL; where an extension holds no directive, the SDL's
 * applied directive is. The expected costs are worked as for the SDL examples above.
 */
describe("operationCost: a runtime schema's extensions", () => {
	const User = new GraphQLObjectType({
		name: "User",
		fields: {
			name: { type: GraphQLString },
			age: { type: GraphQLInt, extensions: { cost: { weight: "2.0" } } },
		},
	});
	const users = (listSize: Readonly<Record<string, unknown>>) => ({
		type: new GraphQLList(User),
		args: { max: { type: GraphQLInt, default: { value: 4 } } },
		extensions: { listSize },
	});
	const definition = parse(`type Query { legacy: Int @cost(weight: "4.0") }`).definitions[0];
	const legacy =
		definition?.kind === Kind.OBJECT_TYPE_DEFINITION ? definition.fields?.[0] : undefined;
	const RUNTIME = new GraphQLSchema({
		query: new GraphQLObjectType({
			name: "Query",
			fields: {
				users: users({ slicingArguments: ["max"] }),
				// An entry that names no field is no sized field: assumedSize sizes the list itself.
				sized: users({ assumedSize: 3, sizedFields: [5] }),
				// An assumedSize that is no number states no size, and the list is unbounded (§8).
				textSize: users({ assumedSize: "3" }),
				noSize: users({ assumedSize: Number.NaN }),
				legacy: { type: GraphQLInt, astNode: legacy, extensions: { cost: null } },
			},
		}),
	});

	it("reads @cost and @listSize from extensions, and a default stated as a value (§8.2)", () => {
		expect(costOf(RUNTIME, `{ users { age } }`)).toBe(1 + 4 * 2);
		expect(costOf(RUNTIME, `{ users(max: 2) { age } }`)).toBe(1 + 2 * 2);
	});

	it("ignores a sizedFields entry that is no field name", () => {
		expect(costOf(RUNTIME, `{ sized { age } }`)).toBe(1 + 3 * 2);
	});

	it("reads an assumedSize that is no number as no size", () => {
		expect(costOf(RUNTIME, `{ textSize { age } }`)).toBe(Infinity);
		expect(costOf(RUNTIME, `{ noSize { age } }`)).toBe(Infinity);
	});

	it("reads the SDL's @cost where the extension holds no directive", () => {
		expect(legacy).toBeDefined();
		expect(costOf(RUNTIME, `{ legacy }`)).toBe(4);
	});
});

/**
 * **What execution reads of a document nobody validated.** `operationCost` takes any document, and
 * reads it as GraphQL's execution does rather than refuse it: CollectFields (§6.3.2) skips a spread
 * whose fragment "does not exist" and one already in `visitedFragments`, and CoerceArgumentValues
 * reads each argument the definition declares, by name, so any other is never read. Each cost is the
 * same document's with the stray part left out.
 */
describe("operationCost: a document no validation has refused", () => {
	const APPROX = schemaOf(
		`directive @approx (tolerance: Float! @cost(weight: "-1.0")) on FIELD\n${EXAMPLE_11}`,
	);

	it.each([
		["a spread of no fragment", EXAMPLE_1, `{ ...Missing users(max: 5) { age } }`, 11],
		[
			"a fragment spread within itself",
			EXAMPLE_1,
			`{ ...Users } fragment Users on Query { users(max: 5) { age } ...Users }`,
			11,
		],
		["an argument the field does not declare", EXAMPLE_1, `{ users(max: 5, sort: 1) { age } }`, 11],
		[
			"a directive the schema does not declare",
			EXAMPLE_1,
			`{ users(max: 5) { age @x(y: 1) } }`,
			11,
		],
		[
			"a directive argument the directive does not declare",
			APPROX,
			`{ mostPopularProduct @approx(mode: 1, tolerance: 0.5) { name } }`,
			4,
		],
		[
			"@skip's condition, read by its name `if`",
			EXAMPLE_1,
			`{ users(max: 5) { age @skip(other: true, if: false) } }`,
			11,
		],
		["a list of objects with no selection", EXAMPLE_1, `{ users(max: 5) }`, 1],
	])("reads past %s", (_stray, schema, document, cost) => {
		expect(costOf(schema, document)).toBe(cost);
	});
});

describe("costLimit", () => {
	const request = { schema: EXAMPLE_1, document: parse(`{ users(max: 5) { age } }`) };

	it("lets an operation that costs the limit through", () => {
		expect(costLimit(11)(request)).toBeUndefined();
	});

	it("refuses one that costs more, saying what it cost", () => {
		const refusal = costLimit(10)(request);
		expect(refusal?.extensions).toEqual({ code: "COST_LIMIT_EXCEEDED", cost: 11, maximumCost: 10 });
		expect(refusal?.message).toBe("The operation costs 11, beyond the limit of 10");
	});

	it("refuses an unbounded one, whatever the limit", () => {
		const refusal = costLimit(1_000_000)({
			schema: EXAMPLE_1,
			document: parse(`{ users { age } }`),
		});
		expect(refusal?.extensions).toEqual({
			code: "COST_LIMIT_EXCEEDED",
			cost: null,
			maximumCost: 1_000_000,
		});
		expect(refusal?.message).toBe(
			"The operation costs an unbounded amount, beyond the limit of 1000000",
		);
	});
});

const typeCostOf = (
	schema: GraphQLSchema,
	document: string,
	variableValues: Readonly<Record<string, unknown>> = {},
): number => typeCost({ schema, document: parse(document), variableValues });

/**
 * **Type Cost, §5.3.2.1: "the weighted sum of the Type Counts".** The specification states the rule
 * and Example № 4's counts, `{ "Query" : 1, "User" : 3 }`, and no Type Cost, so each number here is
 * worked by hand from §5.3.1.1 ("the number of times that a query produces something of that specific
 * type"), §7.1's default weights and §8's list sizes, and stated beside its arm.
 */
describe("typeCost: the specification's rules, worked by hand", () => {
	/** Query 1 and five `User`s at 1.0; five `Int`s at §7.1's "0.0" add nothing. */
	it("Example № 2's document counts the root once and each user it can return", () => {
		expect(typeCostOf(EXAMPLE_1, `query Example { users (max: 5) { age } }`)).toBe(6);
	});

	/** Example № 4 counts `"Query" : 1`: a document selecting only leaves still produces its root. */
	it("counts the root type as one value", () => {
		expect(typeCostOf(EXAMPLE_10, `{ topProducts }`)).toBe(1);
	});

	/** `__typename` is no field of the type's own, and holds a name, not a value of any type. */
	it("counts nothing for __typename", () => {
		expect(typeCostOf(EXAMPLE_1, `{ __typename }`)).toBe(1);
	});

	/**
	 * **A document is costed as it is given**, and one not yet validated may select an object with
	 * no subfields: the object is still one value of its type.
	 */
	it("counts an object selected with no subfields as the value it is", () => {
		const schema = schemaOf(`
			type Book { title: String }
			type Query { book: Book }
		`);
		expect(typeCostOf(schema, `{ book }`)).toBe(2);
	});

	/** An interface no object type implements can hold no value, so nothing below it counts. */
	it("§7.2: counts nothing for an interface no type implements", () => {
		const schema = schemaOf(`
			interface Shelved { title: String }
			type Query { shelved: Shelved }
		`);
		expect(typeCostOf(schema, `{ shelved { title } }`)).toBe(1);
	});

	/** `@cost` on OBJECT and on SCALAR weighs every value of the type: Query 1, five users at 3.0, each with a `Money` at 0.5. */
	it("§7.1: a type's own @cost weighs each value of it", () => {
		const schema = schemaOf(`
			scalar Money @cost(weight: "0.5")
			type User @cost(weight: "3.0") { name: String balance: Money }
			type Query { users(max: Int): [User] @listSize(slicingArguments: ["max"]) }
		`);
		expect(typeCostOf(schema, `{ users(max: 5) { name balance } }`)).toBe(1 + 5 * 3 + 5 * 0.5);
	});

	/**
	 * Example № 18's connection, by §8.3: Query 1, `FilmConnection` 1, three `FilmEdge`s and three
	 * `Film`s, and `PageInfo` 1. Field Cost reads the same document as 6.
	 */
	it("§8.3: sizedFields sizes the edges and every node below them", () => {
		const document = `{ films(first: 3) { edges { cursor node { title } } pageInfo { hasNextPage } } }`;
		expect(typeCostOf(EXAMPLE_18, document)).toBe(1 + 1 + 3 + 3 + 1);
		expect(costOf(EXAMPLE_18, document)).toBe(6);
	});

	/** Query 1, and a `Film` at its heaviest member, 4.0, rather than the sum of the two. */
	it("§7.2: a value of a union counts as its costliest member", () => {
		const schema = schemaOf(`
			type Film @cost(weight: "4.0") { title: String }
			type Short { title: String }
			union Feature = Film | Short
			type Query { feature: Feature }
		`);
		expect(typeCostOf(schema, `{ feature { ... on Film { title } ... on Short { title } } }`)).toBe(
			5,
		);
	});

	/** No `@listSize`, so the five-user bound is gone: the list is unbounded, and so is its count. */
	it("is unbounded where a list of weighted values has no size", () => {
		expect(typeCostOf(EXAMPLE_1, `{ users { age } }`)).toBe(Infinity);
	});

	/** An unbounded list of a type weighing 0.0 adds nothing: Query 1, and `[String]` of no weight. */
	it("reads a list of unweighted leaves as nothing, bounded or not", () => {
		const schema = schemaOf(`type Query { tags: [String] }`);
		expect(typeCostOf(schema, `{ tags }`)).toBe(1);
	});

	it("reads @skip and @include with the request's variables, and each fragment once per spread", () => {
		const document = `query ($all: Boolean!) {
			a: users(max: 2) { ...Who }
			b: users(max: 3) @include(if: $all) { ...Who }
		}
		fragment Who on User { name }`;
		expect(typeCostOf(EXAMPLE_1, document, { all: false })).toBe(1 + 2);
		expect(typeCostOf(EXAMPLE_1, document, { all: true })).toBe(1 + 2 + 3);
	});

	it("answers 0 for a document naming no operation the schema runs", () => {
		expect(typeCost({ schema: EXAMPLE_1, document: parse(`mutation { x }`) })).toBe(0);
	});
});

describe("typeCostLimit", () => {
	const request = { schema: EXAMPLE_1, document: parse(`{ users(max: 5) { age } }`) };

	it("lets an operation whose type cost is the limit through", () => {
		expect(typeCostLimit(6)(request)).toBeUndefined();
	});

	it("refuses one that costs more, saying what it cost", () => {
		const refusal = typeCostLimit(5)(request);
		expect(refusal?.extensions).toEqual({
			code: "TYPE_COST_LIMIT_EXCEEDED",
			cost: 6,
			maximumCost: 5,
		});
		expect(refusal?.message).toBe("The operation's type cost is 6, beyond the limit of 5");
	});

	it("refuses an unbounded one, whatever the limit", () => {
		const refusal = typeCostLimit(1_000_000)({
			schema: EXAMPLE_1,
			document: parse(`{ users { name } }`),
		});
		expect(refusal?.extensions).toEqual({
			code: "TYPE_COST_LIMIT_EXCEEDED",
			cost: null,
			maximumCost: 1_000_000,
		});
	});
});

/** Every message the rules report for a document against a schema, beside graphql-js's own rules. */
function refusals(
	schema: GraphQLSchema,
	document: string,
	...rules: readonly ValidationRule[]
): readonly GraphQLError[] {
	return validate(schema, parse(document), [...specifiedRules, ...rules]);
}

const FAMILY = schemaOf(`
	type Person { name: String parent: Person children: [Person] }
	type Query { person(id: ID): Person }
`);

describe("depthLimit", () => {
	/** `person` 1, `parent` 2, `parent` 3, `name` 4. */
	const FOUR = `{ person(id: "1") { parent { parent { name } } } }`;

	it("lets an operation as deep as the limit through", () => {
		expect(refusals(FAMILY, FOUR, depthLimit(4))).toEqual([]);
	});

	it("refuses one deeper, saying how deep", () => {
		const [refusal, ...more] = refusals(FAMILY, FOUR, depthLimit(3));
		expect(more).toEqual([]);
		expect(refusal?.extensions).toEqual({
			code: "DEPTH_LIMIT_EXCEEDED",
			depth: 4,
			maximumDepth: 3,
		});
		expect(refusal?.message).toBe("The operation nests fields 4 deep, beyond the limit of 3");
	});

	it("counts no level for a fragment, inline or named", () => {
		const document = `{ person(id: "1") { ...Up } } fragment Up on Person { ... on Person { parent { name } } }`;
		expect(refusals(FAMILY, document, depthLimit(3))).toEqual([]);
		expect(refusals(FAMILY, document, depthLimit(2))).toHaveLength(1);
	});

	it("counts neither introspection nor __typename", () => {
		const document = `{ __typename __schema { types { fields { type { ofType { name } } } } } }`;
		expect(refusals(FAMILY, document, depthLimit(1))).toEqual([]);
	});
});

describe("aliasLimit", () => {
	/** `a`, `b` and `n`. */
	const THREE = `{ a: person(id: "1") { n: name } b: person(id: "2") { name } }`;

	it("lets an operation with as many aliases as the limit through", () => {
		expect(refusals(FAMILY, THREE, aliasLimit(3))).toEqual([]);
	});

	it("refuses one with more, saying how many", () => {
		const [refusal, ...more] = refusals(FAMILY, THREE, aliasLimit(2));
		expect(more).toEqual([]);
		expect(refusal?.extensions).toEqual({
			code: "ALIAS_LIMIT_EXCEEDED",
			aliases: 3,
			maximumAliases: 2,
		});
		expect(refusal?.message).toBe("The operation uses 3 aliases, beyond the limit of 2");
	});

	it("counts the aliases inside an inline fragment", () => {
		const document = `{ person(id: "1") { ... on Person { n: name } } }`;
		expect(refusals(FAMILY, document, aliasLimit(1))).toEqual([]);
		expect(refusals(FAMILY, document, aliasLimit(0)).map((e) => e.extensions)).toEqual([
			{ code: "ALIAS_LIMIT_EXCEEDED", aliases: 1, maximumAliases: 0 },
		]);
	});

	/** `x` and `y`, and the fragment's two aliases once for each of its two spreads: six. */
	it("counts a fragment's aliases once for every spread", () => {
		const document = `{ x: person(id: "1") { ...Names } y: person(id: "2") { ...Names } }
			fragment Names on Person { n: name m: name }`;
		expect(refusals(FAMILY, document, aliasLimit(6))).toEqual([]);
		expect(refusals(FAMILY, document, aliasLimit(5))).toHaveLength(1);
	});
});

/**
 * **A fragment graphql-js refuses leaves both rules standing.** Every rule runs in one validation
 * pass, so `depthLimit` and `aliasLimit` meet a fragment spread within itself and a spread of no
 * fragment beside the rules that refuse them; each is measured as far as it goes, and the refusal is
 * graphql-js's own.
 */
describe("depthLimit and aliasLimit beside graphql-js's fragment rules", () => {
	it("measure a fragment spread within itself, leaving its refusal to NoFragmentCycles", () => {
		const document = `{ person(id: "1") { ...Up } } fragment Up on Person { a: parent { ...Up } }`;
		const messages = refusals(FAMILY, document, depthLimit(10), aliasLimit(10)).map(
			(e) => e.message,
		);
		expect(messages).toEqual(['Cannot spread fragment "Up" within itself.']);
	});

	it("measure a spread of no fragment as nothing, leaving its refusal to KnownFragmentNames", () => {
		const document = `{ person(id: "1") { ...Missing } }`;
		const messages = refusals(FAMILY, document, depthLimit(1), aliasLimit(0)).map((e) => e.message);
		expect(messages).toEqual(['Unknown fragment "Missing".']);
	});
});
