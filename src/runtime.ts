import {
	DirectiveLocation,
	GraphQLBoolean,
	GraphQLDirective,
	GraphQLError,
	GraphQLInt,
	GraphQLList,
	GraphQLNonNull,
	GraphQLScalarType,
	GraphQLString,
	getNamedType,
	getNullableType,
	isAbstractType,
	isCompositeType,
	isInputObjectType,
	isLeafType,
	isListType,
	isNonNullType,
	isObjectType,
	Kind,
	valueFromASTUntyped,
	type ConstDirectiveNode,
	type ConstValueNode,
	type DocumentNode,
	type FieldNode,
	type FragmentDefinitionNode,
	type GraphQLArgument,
	type GraphQLCompositeType,
	type GraphQLField,
	type GraphQLFieldResolver,
	type GraphQLInputField,
	type GraphQLInputType,
	type GraphQLNamedType,
	type GraphQLObjectType,
	type GraphQLResolveInfo,
	type GraphQLSchema,
	type GraphQLType,
	type OperationDefinitionNode,
	type SelectionNode,
	type SelectionSetNode,
	type ValidationContext,
	type ValidationRule,
	type ValueNode,
} from "graphql";
import type { ZodError, ZodType } from "zod";

/**
 * **What generated code imports at run time.** The emitter copies this file verbatim beside
 * `graphql.gen.ts` as `graphql-runtime.gen.ts`, so emitted output imports no emitter package.
 *
 * It imports `graphql` as a value and `zod` as a type, and nothing else: no Node builtin and no
 * other module of this package. That is what lets the same file run on Node and on workerd without
 * `nodejs_compat`. typespec-http-graphql's architecture suite asserts it.
 */

export type Awaitable<T> = T | Promise<T>;

/** An OpenAPI security requirement: scheme name to the scopes it demands. */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

/**
 * One status an operation may answer with, and what the document publishes for it: the same
 * declaration typespec-http-mcp's runtime makes, and for the same reason. Emitted output must never
 * import the library, so the shape is declared here, and typespec-http-graphql's arm parity suite
 * holds it identical to `typespec-http-zod/runtime`'s.
 *
 * **The arms arrive in OpenAPI's precedence order**: an exact code, then a range, then the
 * catch-all. `schema: undefined` is a statement: a response the document says carries no body.
 */
export interface ResponseArm {
	/** Every media type this response offers, including a single one. Absent where there is no body. */
	readonly contentTypes?: readonly string[];
	/** The headers this response declares, by the WIRE name the response sets. */
	readonly headers?: readonly { readonly name: string; readonly optional: boolean }[];
	readonly status: number | "default" | `${1 | 2 | 3 | 4 | 5}XX`;
	readonly schema: ZodType | undefined;
}

/**
 * The arm that answers for a status, in the document's own precedence order: exact code, then the
 * `NXX` range, then `default`. Copied from typespec-http-mcp's runtime, rule for rule.
 */
export function armFor(arms: readonly ResponseArm[], status: number): ResponseArm | undefined {
	return (
		arms.find((arm) => arm.status === status) ??
		arms.find((arm) => arm.status === `${Math.floor(status / 100) as 1 | 2 | 3 | 4 | 5}XX`) ??
		arms.find((arm) => arm.status === "default")
	);
}

/**
 * A response body that does not match the schema the document publishes for its status.
 *
 * **Thrown as a plain `Error`, not a `GraphQLError`, so the server masks it**: a client is told
 * `INTERNAL_SERVER_ERROR` and never sees the offending body. The same class and fields as the
 * sibling emitters', copied from typespec-http-mcp's runtime.
 */
export class ResponseContractError extends Error {
	readonly operationId: string;
	readonly status: number;
	readonly issues: ZodError["issues"];

	/** Fields assigned rather than parameter properties, which `erasableSyntaxOnly` refuses. */
	constructor(operationId: string, status: number, issues: ZodError["issues"]) {
		super(`${operationId} answered ${status} with a body its document does not permit`);
		this.name = "ResponseContractError";
		this.operationId = operationId;
		this.status = status;
		this.issues = issues;
	}
}

/**
 * A handler answered with a status its operation does not declare. Unreachable from a typed handler;
 * this is what a cast produces. Copied from typespec-http-mcp's runtime.
 */
export class UndeclaredStatusError extends Error {
	readonly operationId: string;
	readonly result: unknown;

	constructor(operationId: string, result: unknown) {
		const status =
			typeof result === "object" && result !== null && "status" in result
				? String(result.status)
				: "no status";
		super(`${operationId} answered ${status}, which its document does not declare`);
		this.operationId = operationId;
		this.result = result;
		this.name = "UndeclaredStatusError";
	}
}

/**
 * A handler answered with a status the document declares and the GraphQL surface does not project:
 * a 3xx, which typespec-http-graphql's design does not project. Masked, like the two classes above.
 */
export class UnprojectedStatusError extends Error {
	readonly operationId: string;
	readonly status: number;

	constructor(operationId: string, status: number) {
		super(`${operationId} answered ${status}, which its GraphQL field does not project`);
		this.name = "UnprojectedStatusError";
		this.operationId = operationId;
		this.status = status;
	}
}

/** How one declared response arm becomes a GraphQL value. Identical to `model.ts`'s `Projection`. */
export type Projection =
	| { readonly as: "value" }
	| { readonly as: "connection" }
	| { readonly as: "null" }
	| { readonly as: "true" }
	| { readonly as: "member"; readonly type: string }
	| { readonly as: "wrap"; readonly type: string; readonly hasBody: boolean }
	| { readonly as: "error"; readonly code: string }
	/**
	 * A `default` or `NXX` arm, which stands for more than one status: decided by the status the
	 * handler answered. A 404 on a read is `null`; on a mutation, a member-class status is `member`;
	 * anything else is top-level, coded by that status (`STATUS_CODES`).
	 */
	| { readonly as: "byStatus"; readonly nullOn404: boolean; readonly member?: string };

/** Everything one root field or link needs at run time, written as a literal by `graphql.gen.ts`. */
export interface CallRuntime {
	readonly kind: "query" | "mutation" | "link";
	readonly operationId: string;
	readonly authentication: "none" | "optional" | "required";
	readonly security: readonly SecurityRequirement[];
	/** The operation's merged request schema: the same validators the HTTP route applies. */
	readonly input: ZodType;
	readonly arms: readonly ResponseArm[];
	/**
	 * Link bindings: the handler input's wire key, filled from the parent's wire key. `list` where the
	 * parent's value is a list: the field calls once per item, and is a list of what each answers.
	 */
	readonly bound: readonly {
		readonly wire: string;
		readonly parent: string;
		readonly list?: true;
	}[];
	/** Keys the resolver supplies itself: the negotiated `accept` and single-literal headers. */
	readonly supplied: Readonly<Record<string, string>>;
	/** Each argument's wire rule, where one is needed: see `WireRule` and `InputRules`. */
	readonly args: Readonly<Record<string, WireRule>>;
	/** Keyed by the arm's status key as a string: `"200"`, `"4XX"`, `"default"`. */
	readonly projection: Readonly<Record<string, Projection>>;
	readonly connection:
		| {
				readonly items: string;
				readonly next: string;
				readonly first: string;
				readonly after: string;
				/** The largest page size the operation accepts, where one is stated. */
				readonly maximum?: number;
		  }
		| undefined;
	/** Where the call is a batch read: the bound key one call fills with every value, and its answer. */
	readonly batch?: BatchRuntime | undefined;
}

/**
 * What the emitter cannot derive and the application must answer: the same two questions
 * `RouteDeps` and `ToolDeps` ask, asked per field at call time.
 */
export interface GraphQLDeps<X, C> {
	/** Same semantics as RouteDeps/ToolDeps: any one requirement authorises; `{}` is anonymous. */
	readonly authorize: (
		context: X,
		requirements: readonly SecurityRequirement[],
	) => Awaitable<"allow" | "unauthenticated" | "forbidden">;
	/** As ToolDeps.context; `null` is answered UNAUTHENTICATED. */
	readonly context: (context: X, authentication: "none" | "optional" | "required") => C | null;
}

/** `Object.hasOwn`, spelled so the copy compiles under any `lib` a consumer builds with. */
function own(record: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/** A top-level GraphQL error with an `extensions.code`, which a client can act on. */
function coded(code: string, message: string, extra: Readonly<Record<string, unknown>> = {}) {
	return new GraphQLError(message, { extensions: { code, ...extra } });
}

// ---------------------------------------------------------------------------------------------
// Scalars: one scalar, one wire form.
// ---------------------------------------------------------------------------------------------

/** The scalars this runtime defines. `model.ts`'s `RUNTIME_SCALARS` is the same list. */
export type RuntimeScalar =
	| "Long"
	| "BigInteger"
	| "Numeric"
	| "BigDecimal"
	| "UTCDateTime"
	| "UTCDateTimeHuman"
	| "UTCDateTimeUnix"
	| "OffsetDateTime"
	| "OffsetDateTimeHuman"
	| "OffsetDateTimeUnix"
	| "PlainDate"
	| "PlainTime"
	| "Duration"
	| "DurationSeconds"
	| "DurationMilliseconds"
	| "Bytes"
	| "BytesUrl"
	| "URL"
	| "JSON";

/** The JSON type a scalar's wire value has, which is all input coercion checks. */
type JsonKind = "string" | "number" | "integer" | "any";

/** `Number.isFinite`, as the type guard it is: false for every value that is not a number. */
function isFiniteNumber(value: unknown): value is number {
	return Number.isFinite(value);
}

function accepts(json: JsonKind, value: unknown): boolean {
	switch (json) {
		case "string":
			return typeof value === "string";
		case "number":
			return isFiniteNumber(value);
		case "integer":
			return Number.isInteger(value);
		case "any":
			return true;
	}
}

/**
 * A refusal, as `BAD_USER_INPUT`, thrown from `coerceInputValue` (a variable) and from
 * `coerceInputLiteral` (a literal in the document), so the code reaches the client on both paths.
 */
function refused(name: string, json: JsonKind, node: ConstValueNode | undefined): GraphQLError {
	return new GraphQLError(`${name} expects a JSON ${json} on the wire`, {
		nodes: node,
		extensions: { code: "BAD_USER_INPUT" },
	});
}

/**
 * A literal's value. graphql-js substitutes variables (`replaceVariables`) before it calls
 * `coerceInputLiteral`, so the node is constant and a `JSON` literal is read whole.
 */
function literalOf(name: string, json: JsonKind, node: ConstValueNode): unknown {
	if (json === "any") return valueFromASTUntyped(node);
	if (json === "string" && node.kind === Kind.STRING) return node.value;
	// An Int literal is a number of either kind, a Float literal only a `number`; `accepts` refuses
	// either for a `string`.
	if (node.kind === Kind.INT || (node.kind === Kind.FLOAT && json === "number")) {
		const value = Number(node.value);
		if (accepts(json, value)) return value;
	}
	throw refused(name, json, node);
}

/**
 * **Serialisation emits the wire value unchanged, and input coercion checks the JSON type.** The
 * operation's Zod schema validates everything else - formats, ranges, patterns - so a scalar never
 * restates a rule the HTTP surface already enforces, and never enforces one it does not.
 */
function scalarOf(
	name: RuntimeScalar,
	description: string,
	specifiedByURL: string | undefined,
	json: JsonKind,
): GraphQLScalarType {
	return new GraphQLScalarType({
		name,
		description,
		specifiedByURL,
		coerceOutputValue: (value) => value,
		coerceInputValue: (value) => {
			if (!accepts(json, value)) throw refused(name, json, undefined);
			return value;
		},
		coerceInputLiteral: (node) => literalOf(name, json, node),
	});
}

/**
 * Upstream's `SCALAR_MAPPINGS` names and `@specifiedBy` URLs (`@typespec/graphql`), with
 * typespec-http-graphql's two departures: a value whose wire form is a JSON number is never
 * `String`, and the names upstream leaves on `String` (`BigInteger`) are scalars.
 *
 * **The same names, descriptions, URLs and JSON types as the emitter's `SCALAR_DEFINITIONS`**,
 * copied by hand because this file imports only `graphql`. `schema.graphql` states them from that
 * table and this schema from this one, so the SDL == runtime oracle fails on any drift.
 */
export const SCALARS: { readonly [K in RuntimeScalar]: GraphQLScalarType } = {
	Long: scalarOf(
		"Long",
		"A 64-bit integer, as a JSON number.",
		"http://scalars.graphql.org/jakobmerrild/long.html",
		"integer",
	),
	BigInteger: scalarOf(
		"BigInteger",
		"An integer, as a JSON number, which carries it exactly within ±2^53 - 1.",
		undefined,
		"integer",
	),
	Numeric: scalarOf("Numeric", "A number of any kind, as a JSON number.", undefined, "number"),
	BigDecimal: scalarOf(
		"BigDecimal",
		"A decimal number, as a JSON number.",
		"https://scalars.graphql.org/chillicream/decimal.html",
		"number",
	),
	UTCDateTime: scalarOf(
		"UTCDateTime",
		"A UTC date and time, as an RFC 3339 string.",
		"https://scalars.graphql.org/chillicream/date-time.html",
		"string",
	),
	UTCDateTimeHuman: scalarOf(
		"UTCDateTimeHuman",
		"A UTC date and time, as an RFC 7231 HTTP-date string.",
		"https://datatracker.ietf.org/doc/html/rfc7231#section-7.1.1.1",
		"string",
	),
	UTCDateTimeUnix: scalarOf(
		"UTCDateTimeUnix",
		"A UTC date and time, as Unix seconds.",
		undefined,
		"integer",
	),
	OffsetDateTime: scalarOf(
		"OffsetDateTime",
		"A date and time with an offset, as an RFC 3339 string.",
		"https://scalars.graphql.org/chillicream/date-time.html",
		"string",
	),
	OffsetDateTimeHuman: scalarOf(
		"OffsetDateTimeHuman",
		"A date and time with an offset, as an RFC 7231 HTTP-date string.",
		"https://datatracker.ietf.org/doc/html/rfc7231#section-7.1.1.1",
		"string",
	),
	OffsetDateTimeUnix: scalarOf(
		"OffsetDateTimeUnix",
		"A date and time with an offset, as Unix seconds.",
		undefined,
		"integer",
	),
	PlainDate: scalarOf(
		"PlainDate",
		"A calendar date with no time or zone, as an ISO 8601 string.",
		"https://scalars.graphql.org/andimarek/local-date.html",
		"string",
	),
	PlainTime: scalarOf(
		"PlainTime",
		"A time of day with no date or zone, as an ISO 8601 string.",
		"https://scalars.graphql.org/apollographql/localtime-v0.1.html",
		"string",
	),
	Duration: scalarOf(
		"Duration",
		"A duration, as an ISO 8601 string.",
		"https://www.iso.org/standard/70907.html",
		"string",
	),
	DurationSeconds: scalarOf(
		"DurationSeconds",
		"A duration, as a number of seconds.",
		undefined,
		"number",
	),
	DurationMilliseconds: scalarOf(
		"DurationMilliseconds",
		"A duration, as a number of milliseconds.",
		undefined,
		"number",
	),
	Bytes: scalarOf(
		"Bytes",
		"Bytes, as a base64 string.",
		"https://datatracker.ietf.org/doc/html/rfc4648#section-4",
		"string",
	),
	BytesUrl: scalarOf(
		"BytesUrl",
		"Bytes, as a base64url string.",
		"https://datatracker.ietf.org/doc/html/rfc4648#section-5",
		"string",
	),
	URL: scalarOf("URL", "A URL, as a string.", "https://url.spec.whatwg.org/", "string"),
	JSON: scalarOf("JSON", "Any JSON value.", undefined, "any"),
};

// ---------------------------------------------------------------------------------------------
// Cost directives: IBM's GraphQL Cost Directives specification.
// ---------------------------------------------------------------------------------------------

/**
 * `directive @cost(weight: String!) on ARGUMENT_DEFINITION | ENUM | FIELD_DEFINITION |
 * INPUT_FIELD_DEFINITION | OBJECT | SCALAR`, as https://ibm.github.io/graphql-specs/cost-spec.html
 * defines it. `weight` is a String so that it may carry a formula; a serialised Float is the value.
 */
export const CostDirective: GraphQLDirective = new GraphQLDirective({
	name: "cost",
	locations: [
		DirectiveLocation.ARGUMENT_DEFINITION,
		DirectiveLocation.ENUM,
		DirectiveLocation.FIELD_DEFINITION,
		DirectiveLocation.INPUT_FIELD_DEFINITION,
		DirectiveLocation.OBJECT,
		DirectiveLocation.SCALAR,
	],
	args: { weight: { type: new GraphQLNonNull(GraphQLString) } },
});

/**
 * `directive @listSize(assumedSize: Int, slicingArguments: [String!], sizedFields: [String!],
 * requireOneSlicingArgument: Boolean = true) on FIELD_DEFINITION`, from the same specification.
 */
export const ListSizeDirective: GraphQLDirective = new GraphQLDirective({
	name: "listSize",
	locations: [DirectiveLocation.FIELD_DEFINITION],
	args: {
		assumedSize: { type: GraphQLInt },
		slicingArguments: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
		sizedFields: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
		requireOneSlicingArgument: { type: GraphQLBoolean, default: { value: true } },
	},
});

// ---------------------------------------------------------------------------------------------
// Operation limits: the cost directives enforced, and depth and aliases bounded.
// ---------------------------------------------------------------------------------------------

/**
 * What a limit reads of a request: the fields of graphql-js's `ExecutionArgs` it needs, so a server's
 * own execution arguments (Yoga's `onExecute` hands them over) pass as they are.
 */
export interface CostedRequest {
	readonly schema: GraphQLSchema;
	readonly document: DocumentNode;
	readonly variableValues?: Readonly<Record<string, unknown>> | null | undefined;
	readonly operationName?: string | null | undefined;
}

/** A field, argument or input field, as far as a weight or a list size is read from it. */
interface Weighed {
	readonly extensions: Readonly<Record<string, unknown>>;
	readonly astNode?:
		| { readonly directives?: readonly ConstDirectiveNode[] | undefined }
		| null
		| undefined;
}

/** `@listSize`, read: absent arguments as the directive defaults them. */
interface ListSize {
	readonly assumedSize: number | undefined;
	readonly slicingArguments: readonly string[];
	readonly sizedFields: readonly string[];
}

/** `a * b`, where nothing times an unbounded list is nothing: a list of leaves costs no more. */
function times(a: number, b: number): number {
	return a === 0 || b === 0 ? 0 : a * b;
}

/** A directive's arguments as values, from the SDL a schema was built from. */
function appliedArguments(
	element: Weighed,
	name: string,
): Readonly<Record<string, unknown>> | undefined {
	const directive = element.astNode?.directives?.find((applied) => applied.name.value === name);
	if (directive === undefined) return undefined;
	return Object.fromEntries(
		(directive.arguments ?? []).map((argument) => [
			argument.name.value,
			valueFromASTUntyped(argument.value),
		]),
	);
}

/** A directive's arguments: the runtime schema's `extensions`, else the SDL's applied directive. */
function directiveOf(
	element: Weighed,
	name: string,
): Readonly<Record<string, unknown>> | undefined {
	const extension = element.extensions[name];
	if (typeof extension === "object" && extension !== null) {
		return extension as Readonly<Record<string, unknown>>;
	}
	return appliedArguments(element, name);
}

/**
 * The weight of a field, argument or input field (§7.1): its `@cost`, a serialised Float, else the
 * default, `0` for a scalar or an enum and `1` for anything composite.
 */
function weightOf(element: Weighed, type: GraphQLType): number {
	const weight = Number(directiveOf(element, "cost")?.["weight"]);
	if (Number.isFinite(weight)) return weight;
	return isLeafType(getNamedType(type)) ? 0 : 1;
}

function listSizeOf(field: Weighed): ListSize | undefined {
	const declared = directiveOf(field, "listSize");
	if (declared === undefined) return undefined;
	const strings = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	const assumed = declared["assumedSize"];
	return {
		assumedSize: isFiniteNumber(assumed) ? assumed : undefined,
		slicingArguments: strings(declared["slicingArguments"]),
		sizedFields: strings(declared["sizedFields"]),
	};
}

/** How many list levels a type wraps: `[[T!]]!` is two. */
function listLevels(type: GraphQLType): number {
	const nullable = getNullableType(type);
	return isListType(nullable) ? 1 + listLevels(nullable.ofType) : 0;
}

/** One response key's field nodes: at least one. */
type FieldNodes = readonly [FieldNode, ...FieldNode[]];

/** How a field's value multiplies what is selected below it, and the sizes it hands down (§8). */
interface Sizing {
	readonly multiplier: number;
	readonly sizesBelow: ReadonlyMap<string, number>;
}

/**
 * **One operation, read for a static cost analysis**: the parts Field Cost and Type Cost share, so
 * the two read a document alike: the same operation, the same variables, the same `@skip` and
 * `@include`, the same fragments and the same list sizes.
 */
interface Analysis {
	readonly schema: GraphQLSchema;
	readonly root: GraphQLObjectType;
	readonly selections: readonly SelectionNode[];
	readonly valueOf: (node: ValueNode) => unknown;
	/** graphql-js's CollectFields, for one object type: each response key and its field nodes. */
	readonly collect: (
		object: GraphQLObjectType,
		selections: readonly SelectionNode[],
	) => Map<string, FieldNodes>;
	/** The object types a value of `type` can be: itself, or an abstract type's possible types. */
	readonly objectsOf: (type: GraphQLCompositeType) => readonly GraphQLObjectType[];
	/**
	 * How the list `field` returns multiplies what is selected below it: the largest slicing argument
	 * given, a slicing argument's default as if given (§8.2), else `assumedSize` (§8.1), else
	 * unbounded; `sizedFields` moves that size onto the named fields below (§8.3). `sized` is the size
	 * a parent's `sizedFields` handed this field.
	 */
	readonly sizing: (
		field: GraphQLField<unknown, unknown>,
		node: FieldNode,
		sized: number | undefined,
	) => Sizing;
}

/** The analysis of `request`'s operation, or `undefined` where it names none the schema can run. */
function analysisOf(request: CostedRequest): Analysis | undefined {
	const { schema, document } = request;
	const operations = document.definitions.filter(
		(definition): definition is OperationDefinitionNode =>
			definition.kind === Kind.OPERATION_DEFINITION,
	);
	const operation =
		request.operationName === undefined || request.operationName === null
			? operations.length === 1
				? operations[0]
				: undefined
			: operations.find((candidate) => candidate.name?.value === request.operationName);
	if (operation === undefined) return undefined;
	const root = schema.getRootType(operation.operation);
	if (root === undefined || root === null) return undefined;

	const fragments = new Map<string, FragmentDefinitionNode>();
	for (const definition of document.definitions) {
		if (definition.kind === Kind.FRAGMENT_DEFINITION) {
			fragments.set(definition.name.value, definition);
		}
	}
	/** The request's variables, each one not sent taking its definition's default. */
	const variables: Record<string, unknown> = { ...request.variableValues };
	for (const definition of operation.variableDefinitions ?? []) {
		const name = definition.variable.name.value;
		if (variables[name] === undefined && definition.defaultValue !== undefined) {
			variables[name] = valueFromASTUntyped(definition.defaultValue);
		}
	}
	const valueOf = (node: ValueNode): unknown => valueFromASTUntyped(node, variables);

	const included = (selection: SelectionNode): boolean => {
		for (const directive of selection.directives ?? []) {
			const condition = directive.arguments?.find((argument) => argument.name.value === "if");
			const value = condition === undefined ? undefined : valueOf(condition.value);
			if (directive.name.value === "skip" && value === true) return false;
			if (directive.name.value === "include" && value === false) return false;
		}
		return true;
	};
	const applies = (condition: string | undefined, object: GraphQLObjectType): boolean => {
		if (condition === undefined) return true;
		const type = schema.getType(condition);
		return type === object || (isAbstractType(type) && schema.isSubType(type, object));
	};
	/** Each response key and its field nodes, never none, since a key is only made by a node. */
	const collectInto = (
		object: GraphQLObjectType,
		selections: readonly SelectionNode[],
		into: Map<string, FieldNodes>,
		visited: Set<string>,
	): Map<string, FieldNodes> => {
		for (const selection of selections) {
			if (!included(selection)) continue;
			if (selection.kind === Kind.FIELD) {
				const key = selection.alias?.value ?? selection.name.value;
				const known = into.get(key);
				into.set(key, known === undefined ? [selection] : [...known, selection]);
			} else if (selection.kind === Kind.INLINE_FRAGMENT) {
				if (applies(selection.typeCondition?.name.value, object)) {
					collectInto(object, selection.selectionSet.selections, into, visited);
				}
			} else if (!visited.has(selection.name.value)) {
				visited.add(selection.name.value);
				const fragment = fragments.get(selection.name.value);
				if (fragment !== undefined && applies(fragment.typeCondition.name.value, object)) {
					collectInto(object, fragment.selectionSet.selections, into, visited);
				}
			}
		}
		return into;
	};

	/** What a list returned by `field` holds at most, as `node` asks for it. */
	const sizeOf = (
		field: GraphQLField<unknown, unknown>,
		node: FieldNode,
		listSize: ListSize,
	): number => {
		const given: number[] = [];
		for (const name of listSize.slicingArguments) {
			const argument = field.args.find((candidate) => candidate.name === name);
			if (argument === undefined) continue;
			const sent = node.arguments?.find((candidate) => candidate.name.value === name);
			let value = sent === undefined ? undefined : valueOf(sent.value);
			if (value === undefined && argument.default !== undefined) {
				value =
					argument.default.literal === undefined
						? argument.default.value
						: valueFromASTUntyped(argument.default.literal);
			}
			if (isFiniteNumber(value)) given.push(Math.max(0, value));
		}
		if (given.length > 0) return Math.max(...given);
		return listSize.assumedSize ?? Infinity;
	};

	return {
		schema,
		root,
		selections: operation.selectionSet.selections,
		valueOf,
		collect: (object, selections) => collectInto(object, selections, new Map(), new Set()),
		objectsOf: (type) => (isObjectType(type) ? [type] : schema.getPossibleTypes(type)),
		sizing: (field, node, sized) => {
			const listSize = listSizeOf(field);
			const sizesBelow = new Map<string, number>();
			let outer = sized ?? Infinity;
			if (listSize !== undefined) {
				const size = sizeOf(field, node, listSize);
				if (listSize.sizedFields.length > 0) {
					for (const name of listSize.sizedFields) sizesBelow.set(name, size);
				} else {
					outer = size;
				}
			}
			const levels = listLevels(field.type);
			let multiplier = levels === 0 ? 1 : outer;
			for (let level = 1; level < levels; level += 1) multiplier = times(multiplier, Infinity);
			return { multiplier, sizesBelow };
		},
	};
}

/**
 * **The Field Cost of one operation, by static analysis**: the IBM GraphQL Cost Directives
 * Specification's §5.3.2.2, an upper bound on what executing it can cost (§5.1.1). It counts the
 * fields a document resolves, and so, with `@cost(weight: "1")` on every field that calls a handler,
 * the handler calls it can make. It does not count the objects it returns: `typeCost` does.
 *
 * - A field costs its weight, plus each argument it is given (the argument's weight, plus the input
 *   fields its value uses), plus each directive's arguments; a negative sum counts as zero.
 * - A field returning a list multiplies what is selected below it by the list's size: the largest
 *   slicing argument given, a slicing argument's default as if given (§8.2), else `assumedSize`
 *   (§8.1), else unbounded. `sizedFields` moves that size onto the named fields below (§8.3).
 * - Below an interface or a union, the costliest possible type counts (§7.2).
 * - `@skip` and `@include` are read with the request's variables; one whose condition cannot be read
 *   counts. Introspection and `__typename` cost nothing.
 *
 * `Infinity` where a list with a costed selection below it has no bound: a limit refuses it, as the
 * specification's "must initially assume the length of lists to be infinite" requires.
 */
export function operationCost(request: CostedRequest): number {
	const analysis = analysisOf(request);
	if (analysis === undefined) return 0;
	const { schema, valueOf, collect, objectsOf, sizing } = analysis;

	const argumentCost = (argument: GraphQLArgument | GraphQLInputField, value: unknown): number =>
		value === undefined ? 0 : weightOf(argument, argument.type) + inputCost(argument.type, value);
	const inputCost = (type: GraphQLInputType, value: unknown): number => {
		const nullable = getNullableType(type);
		if (isListType(nullable)) {
			const items: readonly unknown[] = Array.isArray(value) ? value : [value];
			return items.reduce<number>((sum, item) => sum + inputCost(nullable.ofType, item), 0);
		}
		if (!isInputObjectType(nullable) || typeof value !== "object" || value === null) return 0;
		let sum = 0;
		for (const [name, fieldValue] of Object.entries(value)) {
			const field = nullable.getFields()[name];
			if (field !== undefined) sum += argumentCost(field, fieldValue);
		}
		return sum;
	};

	const fieldCost = (
		parent: GraphQLObjectType,
		nodes: FieldNodes,
		sized: number | undefined,
	): number => {
		const [node] = nodes;
		// An introspection field (`__typename`) is no field of the type, and costs nothing.
		const field = parent.getFields()[node.name.value];
		if (field === undefined) return 0;
		let own = weightOf(field, field.type);
		for (const sent of node.arguments ?? []) {
			const argument = field.args.find((candidate) => candidate.name === sent.name.value);
			if (argument !== undefined) own += argumentCost(argument, valueOf(sent.value));
		}
		for (const applied of node.directives ?? []) {
			const directive = schema.getDirective(applied.name.value);
			for (const sent of applied.arguments ?? []) {
				const argument = directive?.args.find((candidate) => candidate.name === sent.name.value);
				if (argument !== undefined) own += argumentCost(argument, valueOf(sent.value));
			}
		}
		own = Math.max(0, own);
		const named = getNamedType(field.type);
		if (!isCompositeType(named)) return own;
		const { multiplier, sizesBelow } = sizing(field, node, sized);
		const selections = nodes.flatMap((each) => each.selectionSet?.selections ?? []);
		return own + times(multiplier, selectionCost(named, selections, sizesBelow));
	};

	const selectionCost = (
		type: GraphQLCompositeType,
		selections: readonly SelectionNode[],
		sizes: ReadonlyMap<string, number>,
	): number => {
		let costliest = 0;
		for (const object of objectsOf(type)) {
			let sum = 0;
			for (const nodes of collect(object, selections).values()) {
				sum += fieldCost(object, nodes, sizes.get(nodes[0].name.value));
			}
			costliest = Math.max(costliest, sum);
		}
		return costliest;
	};

	return selectionCost(analysis.root, analysis.selections, new Map());
}

/**
 * **The Type Cost of one operation, by static analysis**: the specification's §5.3.2.1, "the
 * weighted sum of the Type Counts", an upper bound on it (§5.1.1). A Type Count is how many values of
 * a type the response can hold (§5.3.1.1), so this counts what a document returns, where
 * `operationCost` counts what it resolves: `{ nodes { id } }` and `{ edges { node { id } } }` select
 * the same items, and here both count every item, the second its edges as well.
 *
 * - Each value counts its type's weight (§7.1): its `@cost`, else `0` for a scalar or an enum and `1`
 *   for an object. The root type is one value, as Example № 4 counts `"Query" : 1`.
 * - A field returning a list counts each item, and what is selected below it, by the list's size,
 *   read as `operationCost` reads it (§8).
 * - A value of an interface or a union counts as its costliest possible type (§7.2).
 *
 * `Infinity` where a list holding a weighted value has no bound.
 */
export function typeCost(request: CostedRequest): number {
	const analysis = analysisOf(request);
	if (analysis === undefined) return 0;
	const { collect, objectsOf, sizing } = analysis;

	const fieldCost = (
		parent: GraphQLObjectType,
		nodes: FieldNodes,
		sized: number | undefined,
	): number => {
		const [node] = nodes;
		const field = parent.getFields()[node.name.value];
		if (field === undefined) return 0;
		const named = getNamedType(field.type);
		const { multiplier, sizesBelow } = sizing(field, node, sized);
		if (!isCompositeType(named)) return times(multiplier, typeWeightOf(named));
		const selections = nodes.flatMap((each) => each.selectionSet?.selections ?? []);
		return times(multiplier, valueCost(named, selections, sizesBelow));
	};

	/** One value of `type`: its own weight and what is selected below it, at its costliest type. */
	const valueCost = (
		type: GraphQLCompositeType,
		selections: readonly SelectionNode[],
		sizes: ReadonlyMap<string, number>,
	): number => {
		const costs = objectsOf(type).map((object) => {
			let sum = typeWeightOf(object);
			for (const nodes of collect(object, selections).values()) {
				sum += fieldCost(object, nodes, sizes.get(nodes[0].name.value));
			}
			return sum;
		});
		return costs.length === 0 ? 0 : Math.max(...costs);
	};

	return valueCost(analysis.root, analysis.selections, new Map());
}

/** A named type's weight (§7.1): its `@cost`, else `0` for a scalar or an enum, `1` otherwise. */
function typeWeightOf(type: GraphQLNamedType): number {
	return weightOf(type, type);
}

/** The error a limit answers with: the code, what the operation costs, and the maximum. */
function overLimit(
	code: string,
	costs: (amount: string) => string,
	cost: number,
	maximumCost: number,
): GraphQLError {
	const amount = Number.isFinite(cost) ? String(cost) : "an unbounded amount";
	return coded(code, `${costs(amount)}, beyond the limit of ${String(maximumCost)}`, {
		cost: Number.isFinite(cost) ? cost : null,
		maximumCost,
	});
}

/**
 * **A limit on the handler calls an operation can make**, by its Field Cost (`operationCost`): the
 * error to answer with in place of executing it, `COST_LIMIT_EXCEEDED`, or `undefined`. Run it where
 * the request's variables are known, before execution: GraphQL Yoga's `onExecute`, as the README's
 * mount does.
 */
export function costLimit(
	maximumCost: number,
): (request: CostedRequest) => GraphQLError | undefined {
	return (request) => {
		const cost = operationCost(request);
		return cost <= maximumCost
			? undefined
			: overLimit(
					"COST_LIMIT_EXCEEDED",
					(amount) => `The operation costs ${amount}`,
					cost,
					maximumCost,
				);
	};
}

/**
 * **A limit on the objects an operation can return**, by its Type Cost (`typeCost`): the error to
 * answer with in place of executing it, `TYPE_COST_LIMIT_EXCEEDED`, or `undefined`. Run where
 * `costLimit` runs; the two bound different things, and a server applies both.
 */
export function typeCostLimit(
	maximumCost: number,
): (request: CostedRequest) => GraphQLError | undefined {
	return (request) => {
		const cost = typeCost(request);
		return cost <= maximumCost
			? undefined
			: overLimit(
					"TYPE_COST_LIMIT_EXCEEDED",
					(amount) => `The operation's type cost is ${amount}`,
					cost,
					maximumCost,
				);
	};
}

/** A fragment's measure, once per fragment, so a fragment spread many times is measured once. */
function perFragment(
	context: ValidationContext,
	measure: (selections: SelectionSetNode, of: (name: string) => number) => number,
): (selections: SelectionSetNode) => number {
	const known = new Map<string, number>();
	const of = (name: string): number => {
		const cached = known.get(name);
		if (cached !== undefined) return cached;
		known.set(name, 0);
		const selections = context.getFragment(name)?.selectionSet;
		const value = selections === undefined ? 0 : measure(selections, of);
		known.set(name, value);
		return value;
	};
	return (selections) => measure(selections, of);
}

/**
 * **A validation rule refusing an operation whose fields nest deeper than `maximumDepth`.** A root
 * field is depth 1; a fragment adds none; introspection and `__typename` are not counted.
 */
export function depthLimit(maximumDepth: number): ValidationRule {
	return (context) => {
		const depthOf = perFragment(context, (selections, fragment) => {
			let deepest = 0;
			for (const selection of selections.selections) {
				const depth =
					selection.kind === Kind.FIELD
						? selection.name.value.startsWith("__")
							? 0
							: 1 + (selection.selectionSet === undefined ? 0 : depthOf(selection.selectionSet))
						: selection.kind === Kind.INLINE_FRAGMENT
							? depthOf(selection.selectionSet)
							: fragment(selection.name.value);
				deepest = Math.max(deepest, depth);
			}
			return deepest;
		});
		return {
			OperationDefinition(operation) {
				const depth = depthOf(operation.selectionSet);
				if (depth > maximumDepth) {
					context.reportError(
						coded(
							"DEPTH_LIMIT_EXCEEDED",
							`The operation nests fields ${String(depth)} deep, beyond the limit of ${String(maximumDepth)}`,
							{ depth, maximumDepth },
						),
					);
				}
			},
		};
	};
}

/**
 * **A validation rule refusing an operation with more than `maximumAliases` aliases**, counting each
 * fragment once for every place it is spread. Aliases are how one document asks for one field many
 * times with many inputs, each of which the call memo has to call for.
 */
export function aliasLimit(maximumAliases: number): ValidationRule {
	return (context) => {
		const aliasesIn = perFragment(context, (selections, fragment) => {
			let count = 0;
			for (const selection of selections.selections) {
				if (selection.kind === Kind.FIELD) {
					count += selection.alias === undefined ? 0 : 1;
					if (selection.selectionSet !== undefined) count += aliasesIn(selection.selectionSet);
				} else if (selection.kind === Kind.INLINE_FRAGMENT) {
					count += aliasesIn(selection.selectionSet);
				} else {
					count += fragment(selection.name.value);
				}
			}
			return count;
		});
		return {
			OperationDefinition(operation) {
				const aliases = aliasesIn(operation.selectionSet);
				if (aliases > maximumAliases) {
					context.reportError(
						coded(
							"ALIAS_LIMIT_EXCEEDED",
							`The operation uses ${String(aliases)} aliases, beyond the limit of ${String(maximumAliases)}`,
							{ aliases, maximumAliases },
						),
					);
				}
			},
		};
	};
}

// ---------------------------------------------------------------------------------------------
// GraphQL names back to wire keys.
// ---------------------------------------------------------------------------------------------

/**
 * How one argument or input field reaches the handler's input, each key only where its default
 * does not hold: `wire` where the wire key is not the GraphQL name, the flags where they are true.
 */
export interface WireRule {
	/** The wire key, where it differs from the GraphQL name. */
	readonly wire?: string;
	/** An explicit `null` is dropped, as an absent key: optional and not `| null` in TypeSpec. */
	readonly dropNull?: boolean;
	/**
	 * An absent value is written as `null`: required and `| null` in TypeSpec. GraphQL cannot require
	 * a nullable input, so absence is the only way a caller can say the `null` the operation requires
	 * be stated.
	 */
	readonly nullIfAbsent?: boolean;
	/** Arguments only: a mutation's `input`, whose converted value merges into the input's root. */
	readonly merge?: boolean;
}

/**
 * **The rules for every input object type's fields that need one, by type name, then field name.**
 * `graphql.gen.ts` writes them as one literal and hands it to every resolver.
 *
 * The mapping lives in code, not in the schema's `extensions`: a schema rebuilt from its SDL, merged
 * or transformed keeps every type and field name and drops every extension, and a resolver that read
 * its wire keys from there would hand the handler GraphQL names. An optional filter so renamed would
 * have been ignored, silently, by the looseObject validating the input.
 */
export type InputRules = Readonly<Record<string, Readonly<Record<string, WireRule>>>>;

const NO_RULE: WireRule = {};

/**
 * A coerced GraphQL input value, rewritten into the wire shape the handler's validators expect.
 *
 * **The wire never changes; only names do.** Enums and scalars already yield wire values - an
 * enum's internal value IS the wire value - so only input objects are rewritten: each field goes
 * under its wire key, and an explicit `null` on a `dropNull` field is left out, exactly as REST sees
 * an omitted key. A `T | null` field keeps its `null`. A `type` the field definition no longer
 * carries leaves the value as it is.
 */
export function toWire(
	value: unknown,
	type: GraphQLInputType | undefined,
	rules: InputRules,
): unknown {
	if (value === null || value === undefined) return value;
	if (isNonNullType(type)) return toWire(value, type.ofType, rules);
	if (isListType(type)) {
		return Array.isArray(value)
			? value.map((item: unknown) => toWire(item, type.ofType, rules))
			: toWire(value, type.ofType, rules);
	}
	if (isInputObjectType(type)) {
		const given = value as Readonly<Record<string, unknown>>;
		const wire: Record<string, unknown> = {};
		const typeRules = rules[type.name] ?? {};
		for (const field of Object.values(type.getFields())) {
			const rule = typeRules[field.name] ?? NO_RULE;
			const key = rule.wire ?? field.name;
			if (!own(given, field.name)) {
				if (rule.nullIfAbsent === true) wire[key] = null;
				continue;
			}
			const item = given[field.name];
			if (item === null && rule.dropNull === true) continue;
			wire[key] = toWire(item, field.type, rules);
		}
		return wire;
	}
	return value;
}

/**
 * Assembled a key the operation does not declare. Unreachable from a schema this emitter built; what
 * a schema transform that renamed an argument or input field produces. Masked, like the classes above:
 * the handler is never called with a key its validator would let through unread.
 */
export class InputAssemblyError extends Error {
	readonly operationId: string;
	readonly key: string;

	constructor(operationId: string, key: string) {
		super(`${operationId} was assembled an input key it does not declare: ${key}`);
		this.name = "InputAssemblyError";
		this.operationId = operationId;
		this.key = key;
	}
}

/**
 * The keys a merged request schema declares, read from its `shape`: Zod gives an object schema, and
 * no other, a `shape`, the object of its keys.
 */
function declaredKeysOf(schema: ZodType): ReadonlySet<string> | undefined {
	const shape = (schema as { readonly shape?: object }).shape;
	return shape === undefined ? undefined : new Set(Object.keys(shape));
}

/** The arguments the field being resolved declares. */
function argumentsOf(info: GraphQLResolveInfo): readonly GraphQLArgument[] {
	const field = info.parentType.getFields()[info.fieldName];
	// graphql-js calls a resolver only for a field `schema.getField` found its type has.
	if (field === undefined) {
		throw new Error(`${info.parentType.name}.${info.fieldName}: no such field`);
	}
	return field.args;
}

/**
 * A field's arguments, as the wire keys of the handler's merged input.
 *
 * **The rules are the call's own** (`CallRuntime.args`), and only the argument TYPES are read from the
 * field definition, to convert an input object. An argument goes under its wire key, an explicit
 * `null` on a `dropNull` argument is left out, and a `merge` argument - a mutation's `input`, Relay's
 * single argument - IS the merged input, so its converted fields land at the root. Every key placed
 * from an argument or an input object must be one the operation declares; a `JSON` input, an open
 * body's, carries what the request carries and is validated by the schema itself.
 */
function argumentsToWire(
	call: CallRuntime,
	args: Readonly<Record<string, unknown>>,
	info: GraphQLResolveInfo,
	rules: InputRules,
): Record<string, unknown> {
	const wire: Record<string, unknown> = {};
	const declared = declaredKeysOf(call.input);
	const place = (key: string): void => {
		if (declared !== undefined && !declared.has(key)) {
			throw new InputAssemblyError(call.operationId, key);
		}
	};
	const types = new Map(
		argumentsOf(info).map((argument) => [argument.name, argument.type] as const),
	);
	const names = new Set([...Object.keys(args), ...Object.keys(call.args)]);
	for (const name of names) {
		const rule = own(call.args, name) ? (call.args[name] ?? NO_RULE) : NO_RULE;
		const key = rule.wire ?? name;
		if (!own(args, name)) {
			if (rule.nullIfAbsent === true) {
				place(key);
				wire[key] = null;
			}
			continue;
		}
		// graphql-js gives an argument its value or leaves it out of `args`, never `undefined`.
		const value = args[name];
		if (value === null && rule.dropNull === true) continue;
		const type = types.get(name);
		const converted = toWire(value, type, rules);
		if (rule.merge === true) {
			// A null states no key; anything else that is no object is refused, as a REST body is.
			if (converted === null) continue;
			if (typeof converted !== "object" || Array.isArray(converted)) {
				throw coded("BAD_USER_INPUT", `The input to ${call.operationId} is not valid`, {
					issues: [
						{
							code: "invalid_type",
							expected: "object",
							path: [name],
							wirePath: [],
							message: "the input must be an object, as the request it stands for is",
						},
					],
				});
			}
			if (isInputObjectType(getNamedType(type))) {
				for (const merged of Object.keys(converted)) place(merged);
			}
			Object.assign(wire, converted);
		} else {
			place(key);
			wire[key] = converted;
		}
	}
	return wire;
}

/**
 * **The resolver of every output field that calls no handler**: its own property of the source, read
 * by the wire key, never through the prototype chain as graphql-js's default resolver reads it.
 */
export function wireField(key: string): GraphQLFieldResolver<Record<string, unknown>, unknown> {
	return (source) => (own(source, key) ? source[key] : undefined);
}

// ---------------------------------------------------------------------------------------------
// Unions.
// ---------------------------------------------------------------------------------------------

/**
 * The member each projected value belongs to. **Decided by the ARM the handler returned, never by
 * the shape of the body**: two members can share every field, and only the status tells them apart.
 */
const MEMBERS = new WeakMap<object, string>();

function tagged(value: unknown, type: string): unknown {
	if (typeof value === "object" && value !== null) MEMBERS.set(value, type);
	return value;
}

/** `resolveType` for result unions: the member the projection tagged. */
export function memberTypeOf(value: unknown): string | undefined {
	// `WeakMap.prototype.get` answers `undefined` for a key it does not hold, one that is no object
	// included (ECMA-262), so nothing untagged needs telling apart first.
	return MEMBERS.get(value as object);
}

/** `resolveType` for discriminated unions: the member the discriminator's wire value names. */
export function discriminatedTypeOf(
	property: string,
	mapping: Readonly<Record<string, string>>,
): (value: unknown) => string | undefined {
	return (value) => {
		if (typeof value !== "object" || value === null || !own(value, property)) return undefined;
		const tag = (value as Readonly<Record<string, unknown>>)[property];
		return typeof tag === "string" && own(mapping, tag) ? mapping[tag] : undefined;
	};
}

/**
 * How a `@discriminator` base resolves a value: the discriminator's wire key, the subtype each of its
 * values names (or a nested base's own rule) with the validator a value must pass to be it, and the
 * base's own object type otherwise.
 */
export interface BaseResolution {
	readonly property: string;
	readonly mapping: Readonly<Record<string, BaseMember>>;
	readonly base: string;
}

/** A subtype's validator: the Zod schema `schemas.gen.ts` exports for it, by its `safeParse`. */
export interface SubtypeValidator {
	readonly safeParse: (value: unknown) => { readonly success: boolean };
}

/** The subtype a discriminator value names, or a nested base and its own rule. */
export type BaseMember =
	| { readonly schema: SubtypeValidator; readonly type: string }
	| { readonly schema: SubtypeValidator; readonly rule: BaseResolution };

/**
 * `resolveType` for a `@discriminator` base's interface: the subtype its discriminator names where
 * that subtype's validator accepts the value, a nested base resolved again by its own rule, and the
 * base's own object type for any other value.
 *
 * **The library validates a base as the document does**: the dispatch to its subtypes, then the base
 * itself (OAS 3.1.1 § 4.8.25), so `{ kind: "golden", weight: 8 }` that is no valid `Golden` is a
 * `Dog`. Its parsed output does not say which arm matched; the subtype's own validator, imported by the
 * name the library publishes for it, does.
 */
export function baseTypeOf(rule: BaseResolution): (value: unknown) => string {
	return (value) => resolvedBase(rule, value as Readonly<Record<string, unknown>>);
}

function resolvedBase(rule: BaseResolution, value: Readonly<Record<string, unknown>>): string {
	const tag = own(value, rule.property) ? value[rule.property] : undefined;
	const member = typeof tag === "string" && own(rule.mapping, tag) ? rule.mapping[tag] : undefined;
	if (member === undefined || !member.schema.safeParse(value).success) return rule.base;
	return "type" in member ? member.type : resolvedBase(member.rule, value);
}

/** Merges consumer extension fields over generated ones; throws on a collision, naming both. */
export function extendFields<F>(
	typeName: string,
	generated: Record<string, F>,
	extension: Record<string, F> | undefined,
): Record<string, F> {
	if (extension === undefined) return generated;
	for (const name of Object.keys(extension)) {
		if (own(generated, name)) {
			throw new Error(
				`The extension's field ${typeName}.${name} collides with the generated field ` +
					`${typeName}.${name}; rename the extension's field`,
			);
		}
	}
	return { ...generated, ...extension };
}

// ---------------------------------------------------------------------------------------------
// Calling the handler.
// ---------------------------------------------------------------------------------------------

/**
 * **The per-request call memo, keyed on the GraphQL context value**, so 50 books by one author
 * cost one `Authors.read`, and request B is never answered from request A's call: each request has
 * its own context object, and a `WeakMap` lets its calls go when it does.
 */
const MEMO = new WeakMap<object, Map<string, Promise<unknown>>>();

/** JSON with every object's keys sorted, so `{a, b}` and `{b, a}` are one call. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item: unknown) => canonical(item)).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Readonly<Record<string, unknown>>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------------------------
// Connections: Relay cursors over page-token backends.
// ---------------------------------------------------------------------------------------------

/**
 * **Where a page of a connection starts, and how much of it the client asked for.** A backend pages
 * by a page-level token; a Relay cursor names an EDGE. So a cursor is the token of the page its edge
 * is in (`null` for the first page) and how many of that page's items precede the next edge: `after`
 * a cursor, the resolver asks the backend for that page again and skips those items.
 */
interface PagePosition {
	/** The connection's plan: the keys of the handler's input and of its page that it reads. */
	readonly connection: NonNullable<CallRuntime["connection"]>;
	readonly token: string | null;
	readonly skip: number;
	/** The client's `first`, when it gave one: Relay §4.4 slices the edges to it. */
	readonly first: number | undefined;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** `Number.isSafeInteger`, as the type guard it is: false for every value that is not a number. */
function isSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value);
}

/**
 * A cursor: `[token, skip]` as JSON, each UTF-16 code unit as two bytes, base64url. Written out here
 * rather than with `btoa` or `TextEncoder`, so the runtime copy needs no global a consumer's `lib`
 * might not declare. Opaque, as Relay §3.1 asks a client to treat it.
 */
function encodeCursor(token: string | null, skip: number): string {
	const text = JSON.stringify([token, skip]);
	const bytes: number[] = [];
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		bytes.push(unit >> 8, unit & 0xff);
	}
	let cursor = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const [a = 0, b = 0, c = 0] = bytes.slice(index, index + 3);
		const triple = (a << 16) | (b << 8) | c;
		const count = Math.min(3, bytes.length - index) + 1;
		for (let digit = 0; digit < count; digit += 1) {
			cursor += BASE64URL.charAt((triple >> (18 - digit * 6)) & 63);
		}
	}
	return cursor;
}

/** The position a cursor this runtime issued names, or `undefined` for anything else. */
function decodeCursor(
	cursor: string,
): { readonly token: string | null; readonly skip: number } | undefined {
	const bytes: number[] = [];
	for (let index = 0; index < cursor.length; index += 4) {
		const digits = cursor
			.slice(index, index + 4)
			.split("")
			.map((char) => BASE64URL.indexOf(char));
		if (digits.length < 2 || digits.some((digit) => digit < 0)) return undefined;
		const [a = 0, b = 0, c = 0, d = 0] = digits;
		const triple = (a << 18) | (b << 12) | (c << 6) | d;
		bytes.push((triple >> 16) & 0xff);
		if (digits.length > 2) bytes.push((triple >> 8) & 0xff);
		if (digits.length > 3) bytes.push(triple & 0xff);
	}
	if (bytes.length % 2 !== 0) return undefined;
	let text = "";
	for (let index = 0; index < bytes.length; index += 2) {
		text += String.fromCharCode(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
	const [token, skip] = parsed as [unknown, unknown];
	if (token !== null && typeof token !== "string") return undefined;
	if (!isSafeInteger(skip) || skip < 0) return undefined;
	return { token, skip };
}

/**
 * **A Relay connection from one page, as relay.dev/graphql/connections.htm defines it.**
 *
 * - The page's items from `skip` on, sliced to `first` where the client gave one (§4.4).
 * - Every edge has a cursor (§3.1): the position just after it. The last edge's, where the page was
 *   used whole and the backend has another, is the next page's start.
 * - `startCursor` and `endCursor` are the first and last edges' (§5.1). With no edges, `endCursor`
 *   is where this page began when `first: 0` cut its items, so none is lost, else the next page's
 *   start, so a client can still go on.
 * - `hasNextPage` is true while the backend has another page or the slice left items over. Paging is
 *   forward only, so `hasPreviousPage` is false, which §5.1 permits.
 */
function connectionOf(
	call: CallRuntime,
	body: unknown,
	position: PagePosition | undefined,
): unknown {
	if (position === undefined) {
		throw new Error(`${call.operationId} is projected as a connection without a connection plan`);
	}
	const { connection } = position;
	const page =
		typeof body === "object" && body !== null ? (body as Readonly<Record<string, unknown>>) : {};
	const raw = own(page, connection.items) ? page[connection.items] : undefined;
	const items: readonly unknown[] = Array.isArray(raw) ? raw : [];
	const given = own(page, connection.next) ? page[connection.next] : undefined;
	const next = typeof given === "string" || typeof given === "number" ? String(given) : null;
	const window = items.slice(position.skip);
	const sliced = window.slice(0, position.first);
	const cut = sliced.length < window.length;
	const edges = sliced.map((node, index) => ({
		node,
		cursor:
			index === sliced.length - 1 && !cut && next !== null
				? encodeCursor(next, 0)
				: encodeCursor(position.token, position.skip + index + 1),
	}));
	const last = edges[edges.length - 1];
	return {
		edges,
		nodes: sliced,
		pageInfo: {
			hasNextPage: next !== null || cut,
			hasPreviousPage: false,
			startCursor: edges[0]?.cursor ?? null,
			endCursor:
				last?.cursor ??
				(cut
					? encodeCursor(position.token, position.skip)
					: next === null
						? null
						: encodeCursor(next, 0)),
		},
	};
}

/**
 * The page a connection field's arguments name, with the handler's input set to ask the backend for
 * it: `after` decoded into the page's token, refused as `BAD_USER_INPUT` when it is no cursor this
 * connection issued; a negative `first` refused as Relay §4.4 requires; and, resuming partway into a
 * page, the page size raised by the items skipped, up to the operation's maximum, so the window holds
 * `first` items where the maximum allows.
 * `undefined` for a call that is no connection.
 */
function pagePositionOf(
	call: CallRuntime,
	args: Readonly<Record<string, unknown>>,
	input: Record<string, unknown>,
): PagePosition | undefined {
	const connection = call.connection;
	if (connection === undefined) return undefined;
	const first = typeof args["first"] === "number" ? args["first"] : undefined;
	if ((first ?? 0) < 0) {
		throw coded("BAD_USER_INPUT", "first must not be negative", {
			issues: [
				{
					code: "too_small",
					path: ["first"],
					wirePath: [connection.first],
					message: "Relay §4.4: first must be 0 or more",
				},
			],
		});
	}
	const cursor = input[connection.after];
	if (typeof cursor !== "string") return { connection, token: null, skip: 0, first };
	const decoded = decodeCursor(cursor);
	if (decoded === undefined) {
		throw coded("BAD_USER_INPUT", "after is not a cursor this connection issued", {
			issues: [
				{
					code: "invalid_format",
					path: ["after"],
					wirePath: [connection.after],
					message: "not a cursor of this connection",
				},
			],
		});
	}
	if (decoded.token === null) delete input[connection.after];
	else input[connection.after] = decoded.token;
	/**
	 * `first` is written under `connection.first` already (inputs.ts plans it there), so with no item
	 * skipped this writes the same size again. Skipping, the page asked for holds the skipped items
	 * too, **but never more than the operation accepts**: past its maximum the window is shorter than
	 * `first`, which Relay allows, and the last edge's cursor goes on from where it ends. A `first`
	 * beyond the maximum on its own is sent as it is, for the operation's schema to refuse by name.
	 */
	if (first !== undefined) {
		const wanted = first + decoded.skip;
		input[connection.first] =
			connection.maximum === undefined
				? wanted
				: Math.min(wanted, Math.max(first, connection.maximum));
	}
	return { connection, token: decoded.token, skip: decoded.skip, first };
}

/** The value of a declared response header, where the arm declares it and the handler set it. */
function declaredHeader(arm: ResponseArm, headers: unknown, name: string): unknown {
	const declared = arm.headers?.find((header) => header.name.toLowerCase() === name);
	if (declared === undefined || typeof headers !== "object" || headers === null) return undefined;
	return own(headers, declared.name)
		? (headers as Readonly<Record<string, unknown>>)[declared.name]
		: undefined;
}

/**
 * What a handler returned, as the field's value: the arm by `armFor`, the body parsed against that
 * arm's schema exactly as the REST route parses it, then the arm's projection.
 */
/** Statuses to the code design.md gives each: `STATUS_CODES` in graphql.gen.ts. */
export type StatusCodes = Readonly<Record<string, string>>;

/** The statuses a mutation answers as a member rather than at top level: 4xx, but 401, 403, 429. */
const isMemberStatus = (status: number): boolean =>
	status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;

function project(
	call: CallRuntime,
	result: unknown,
	position: PagePosition | undefined,
	codes: StatusCodes,
): unknown {
	const answer: { readonly status?: unknown; readonly body?: unknown; readonly headers?: unknown } =
		typeof result === "object" && result !== null ? result : {};
	const { status } = answer;
	// A status is a number: `"503"` is declared by no arm, though `armFor` would read it as a 5xx.
	if (typeof status !== "number") throw new UndeclaredStatusError(call.operationId, result);
	const arm = armFor(call.arms, status);
	if (arm === undefined) throw new UndeclaredStatusError(call.operationId, result);
	let body: unknown;
	if (arm.schema !== undefined) {
		const parsed = arm.schema.safeParse(answer.body);
		if (!parsed.success) {
			throw new ResponseContractError(call.operationId, status, parsed.error.issues);
		}
		body = parsed.data;
	}
	const projection = call.projection[String(arm.status)];
	if (projection === undefined) throw new UnprojectedStatusError(call.operationId, status);
	switch (projection.as) {
		case "value":
			return body;
		case "connection":
			return connectionOf(call, body, position);
		case "null":
			return null;
		case "true":
			return true;
		case "member":
			return tagged(body, projection.type);
		case "wrap":
			return tagged(
				projection.hasBody ? { value: body } : { success: status >= 200 && status < 300 },
				projection.type,
			);
		case "error":
			throw topLevel(call, arm, answer.headers, status, body, projection.code);
		case "byStatus":
			if (projection.nullOn404 && status === 404) return null;
			if (projection.member !== undefined && isMemberStatus(status)) {
				return tagged(body, projection.member);
			}
			throw topLevel(
				call,
				arm,
				answer.headers,
				status,
				body,
				codes[String(status)] ?? `STATUS_${String(status)}`,
			);
	}
}

/** A top-level error for a declared status: its code, the status, the body, and `Retry-After`. */
function topLevel(
	call: CallRuntime,
	arm: ResponseArm,
	headers: unknown,
	status: number,
	body: unknown,
	code: string,
): GraphQLError {
	const extensions: Record<string, unknown> = { status };
	if (body !== undefined) extensions["body"] = body;
	const retryAfter = declaredHeader(arm, headers, "retry-after");
	if (retryAfter !== undefined) extensions["retryAfter"] = retryAfter;
	return coded(code, `${call.operationId} answered ${status}`, extensions);
}

/**
 * **The handler object, built once per context value**, so a `handlersFor` that builds its object for
 * a request builds it once per request rather than once per call. Keyed by `handlersFor` as well:
 * two schemas sharing a context value each get their own object. A context that is no object, which
 * a `WeakMap` cannot hold, is handed to `handlersFor` on every call.
 */
const HANDLERS = new WeakMap<object, WeakMap<object, object>>();

function handlersOf<X extends object>(handlersFor: (context: X) => object, context: X): object {
	if ((typeof context !== "object" && typeof context !== "function") || context === null) {
		return handlersFor(context);
	}
	let byContext = HANDLERS.get(handlersFor);
	if (byContext === undefined) {
		byContext = new WeakMap();
		HANDLERS.set(handlersFor, byContext);
	}
	let handlers = byContext.get(context);
	if (handlers === undefined) {
		handlers = handlersFor(context);
		byContext.set(context, handlers);
	}
	return handlers;
}

/**
 * **The call, without its projection**: authorisation, the caller context, the request schema and
 * the handler. What the memo shares between fields, because a field's projection is its own: two
 * fields reaching one operation name their result and wrapper types after themselves.
 */
async function callOnce<X extends object, C>(
	call: CallRuntime,
	handlersFor: (context: X) => object,
	deps: GraphQLDeps<X, C>,
	context: X,
	input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
	const ctx = await admitted(call, deps, context);
	return invoke(call, handlersFor, context, ctx, validated(call, input));
}

/** **Who may call**: authorisation, then the caller context, before anything of the input is read. */
async function admitted<X extends object, C>(
	call: CallRuntime,
	deps: GraphQLDeps<X, C>,
	context: X,
): Promise<C> {
	const verdict = await deps.authorize(context, call.security);
	if (verdict === "unauthenticated") {
		throw coded("UNAUTHENTICATED", `${call.operationId} requires an authenticated caller`);
	}
	if (verdict === "forbidden") {
		throw coded("FORBIDDEN", `The caller may not call ${call.operationId}`);
	}
	const ctx = deps.context(context, call.authentication);
	if (ctx === null) {
		throw coded("UNAUTHENTICATED", `${call.operationId} requires an authenticated caller`);
	}
	return ctx;
}

/**
 * **Validation is the HTTP surface's**: the same per-operation Zod schemas, so the handler receives
 * exactly what the REST route's handler would, defaults applied.
 */
function validated(call: CallRuntime, input: Readonly<Record<string, unknown>>): unknown {
	const parsed = call.input.safeParse(input);
	if (!parsed.success) {
		throw coded("BAD_USER_INPUT", `The input to ${call.operationId} is not valid`, {
			issues: parsed.error.issues,
		});
	}
	return parsed.data;
}

function invoke<X extends object, C>(
	call: CallRuntime,
	handlersFor: (context: X) => object,
	context: X,
	ctx: C,
	parsed: unknown,
): Awaitable<unknown> {
	const handlers = handlersOf(handlersFor, context) as Readonly<
		Record<string, ((ctx: C, input: unknown) => Awaitable<unknown>) | undefined>
	>;
	const handler = handlers[call.operationId];
	if (typeof handler !== "function") {
		throw new Error(`handlersFor returned no handler for ${call.operationId}`);
	}
	return handler.call(handlers, ctx, parsed);
}

// ---------------------------------------------------------------------------------------------
// Batched links: one call to a batch read for the distinct values of a wave of parents.
// ---------------------------------------------------------------------------------------------

/** How a link calls a batch read, as `graphql.gen.ts` writes it. */
export interface BatchRuntime {
	/** The handler input's wire key of the list parameter one call fills with every value. */
	readonly wire: string;
	/** The item's wire key holding the value it was asked for. */
	readonly key: string;
	/** The answer's wire key holding the items, where the answer is no list itself. */
	readonly items?: string | undefined;
	/** The most values one call carries: the list parameter's `@maxItems`. */
	readonly size?: number | undefined;
}

/** One field's value, waiting for the batch that answers it. */
interface Waiting {
	readonly value: unknown;
	readonly resolve: (item: unknown) => void;
	readonly reject: (error: unknown) => void;
}

/** The values one batch read carries next, and how to send them: one call's fixed input, per request. */
interface BatchQueue {
	readonly waiting: Waiting[];
	readonly send: (waiting: readonly Waiting[]) => Promise<void>;
}

/**
 * **The batches a request has yet to send, beside its call memo**, keyed by the memo's own map: a
 * mutation clears the memo as it starts, and its queues go with it, so nothing read before a
 * mutation answers a field after it.
 */
const QUEUES = new WeakMap<
	Map<string, Promise<unknown>>,
	{ readonly queues: Map<string, BatchQueue>; scheduled: boolean }
>();

/**
 * **Once every resolver of this wave has run**: after the microtask queue drains, by Node's
 * `setImmediate`, or `setTimeout(0)` where there is none, as on Workers. A microtask would split a
 * wave whose parents settled at different microtask depths. Reached through `globalThis`, since the
 * runtime copy assumes no global beyond ECMAScript's.
 */
function afterWave(run: () => void): void {
	const timers = globalThis as {
		readonly setImmediate?: (run: () => void) => unknown;
		readonly setTimeout?: (run: () => void, delay: number) => unknown;
	};
	if (typeof timers.setImmediate === "function") timers.setImmediate(run);
	else if (typeof timers.setTimeout === "function") timers.setTimeout(run, 0);
	else void Promise.resolve().then(run);
}

/** An issue about a value checked alone, at the bound key rather than at its index in a list of one. */
function aloneIssue(wire: string, issue: { readonly path: readonly PropertyKey[] }): unknown {
	const [head, index, ...rest] = issue.path;
	return head === wire && index === 0 ? { ...issue, path: [wire, ...rest] } : issue;
}

/**
 * **Send one batch read for `waiting`, and settle each.**
 *
 * 1. Admission once, first, as for every call: an unauthenticated caller is told so before any value
 *    is read.
 * 2. Each value alone through the operation's schema, so a value it refuses is that field's
 *    `BAD_USER_INPUT` and the rest are sent. Values that parse alike are one.
 * 3. Chunks of the parameter's `@maxItems`, one call each, the answer projected once and its items
 *    matched to the parsed values by `key`, the first item a key names winning. A value with no item
 *    is `null`.
 * 4. A 404 from a chunk of several values says one of them is missing, as an all-or-nothing batch
 *    read answers, so each is sent again alone: one dangling id never blanks its siblings.
 */
async function sendBatch<X extends object, C>(
	call: CallRuntime,
	batch: BatchRuntime,
	input: Readonly<Record<string, unknown>>,
	waiting: readonly Waiting[],
	handlersFor: (context: X) => object,
	deps: GraphQLDeps<X, C>,
	context: X,
	codes: StatusCodes,
): Promise<void> {
	let ctx: C;
	try {
		ctx = await admitted(call, deps, context);
	} catch (error) {
		for (const entry of waiting) entry.reject(error);
		return;
	}
	const groups = new Map<string, { readonly parsed: unknown; readonly waiting: Waiting[] }>();
	for (const entry of waiting) {
		const alone = call.input.safeParse({ ...input, [batch.wire]: [entry.value] });
		if (!alone.success) {
			entry.reject(
				coded("BAD_USER_INPUT", `The input to ${call.operationId} is not valid`, {
					issues: alone.error.issues.map((issue) => aloneIssue(batch.wire, issue)),
				}),
			);
			continue;
		}
		const sent = (alone.data as Readonly<Record<string, unknown>>)[batch.wire];
		const parsed = Array.isArray(sent) ? (sent as readonly unknown[])[0] : sent;
		const key = canonical(parsed);
		const group = groups.get(key) ?? { parsed, waiting: [] };
		group.waiting.push(entry);
		groups.set(key, group);
	}
	const send = async (
		chunk: readonly { readonly parsed: unknown; readonly waiting: Waiting[] }[],
	) => {
		const settle = (item: (parsed: unknown) => unknown) => {
			for (const group of chunk)
				for (const entry of group.waiting) entry.resolve(item(group.parsed));
		};
		let answer: unknown;
		try {
			const values = chunk.map((group) => group.waiting[0]?.value);
			const result = await invoke(
				call,
				handlersFor,
				context,
				ctx,
				validated(call, { ...input, [batch.wire]: values }),
			);
			answer = project(call, result, undefined, codes);
		} catch (error) {
			for (const group of chunk) for (const entry of group.waiting) entry.reject(error);
			return;
		}
		if (answer === null) {
			if (chunk.length > 1) {
				await Promise.all(chunk.map((group) => send([group])));
				return;
			}
			settle(() => null);
			return;
		}
		const list =
			batch.items === undefined
				? answer
				: typeof answer === "object" && own(answer, batch.items)
					? (answer as Readonly<Record<string, unknown>>)[batch.items]
					: undefined;
		const items = new Map<string, unknown>();
		for (const item of Array.isArray(list) ? (list as readonly unknown[]) : []) {
			if (typeof item !== "object" || item === null || !own(item, batch.key)) continue;
			const key = canonical((item as Readonly<Record<string, unknown>>)[batch.key]);
			if (!items.has(key)) items.set(key, item);
		}
		settle((parsed) => items.get(canonical(parsed)) ?? null);
	};
	const all = [...groups.values()];
	const size = batch.size === undefined || batch.size < 1 ? all.length : batch.size;
	// Counted rather than stepped, so no size can make it a loop that never ends.
	const chunks = Array.from({ length: Math.ceil(all.length / size) }, (_, index) =>
		all.slice(index * size, (index + 1) * size),
	);
	await Promise.all(chunks.map(send));
}

/**
 * **A wire path below the handler's input, as the path of the GraphQL argument the client wrote**,
 * or `undefined` where no argument wrote it (a link's bound key, a supplied header).
 *
 * The inverse of `argumentsToWire`, by the same rules: a root key is a named argument's wire key, or
 * a field of a `merge` argument's input object (`["input", "ownerId"]`); below that, each input
 * object field by its own wire key, and a list index as itself.
 */
function argumentPathOf(
	wirePath: readonly PropertyKey[],
	call: CallRuntime,
	info: GraphQLResolveInfo,
	rules: InputRules,
): PropertyKey[] | undefined {
	/** The field of an input object type a wire key belongs to, by that type's rules. */
	const fieldByWire = (type: GraphQLInputType, wire: PropertyKey | undefined) => {
		const named = getNamedType(type);
		if (!isInputObjectType(named)) return undefined;
		const typeRules = rules[named.name] ?? {};
		return Object.values(named.getFields()).find(
			(candidate) => (typeRules[candidate.name]?.wire ?? candidate.name) === wire,
		);
	};
	const below = (type: GraphQLInputType, path: readonly PropertyKey[]): PropertyKey[] => {
		const [step, ...more] = path;
		if (step === undefined) return [];
		if (isNonNullType(type)) return below(type.ofType, path);
		// An issue below a list steps by the item's index.
		if (isListType(type)) return [step, ...below(type.ofType, more)];
		const field = fieldByWire(type, step);
		return field === undefined ? [...path] : [field.name, ...below(field.type, more)];
	};
	// A wire key is a string: a head that is none, or an empty path's, matches no argument.
	const [head, ...rest] = wirePath;
	for (const argument of argumentsOf(info)) {
		const rule = own(call.args, argument.name) ? (call.args[argument.name] ?? NO_RULE) : NO_RULE;
		if (rule.merge === true) {
			const field = fieldByWire(argument.type, head);
			if (field !== undefined) return [argument.name, field.name, ...below(field.type, rest)];
		} else if ((rule.wire ?? argument.name) === head) {
			return [argument.name, ...below(argument.type, rest)];
		}
	}
	return undefined;
}

/**
 * A request-schema refusal with each issue's `path` the GraphQL path the client wrote and its
 * `wirePath` the handler's input path, which is the REST route's own. Any other error as it is.
 */
function asArgumentIssues(
	error: unknown,
	call: CallRuntime,
	info: GraphQLResolveInfo,
	rules: InputRules,
): unknown {
	if (!(error instanceof GraphQLError) || error.extensions["code"] !== "BAD_USER_INPUT")
		return error;
	const issues = error.extensions["issues"];
	if (!Array.isArray(issues)) return error;
	return new GraphQLError(error.message, {
		extensions: {
			...error.extensions,
			issues: issues.map((issue: { readonly path: readonly PropertyKey[] }) => ({
				...issue,
				path: argumentPathOf(issue.path, call, info, rules) ?? issue.path,
				wirePath: issue.path,
			})),
		},
	});
}

/**
 * The resolver for one root field or link: typespec-http-graphql's pipeline, in this order.
 *
 * 1. A link whose bound parent property is `null` or absent answers `null` WITHOUT calling the
 *    handler (or anything else). A link bound to a list answers one item per value, each called and
 *    projected as a link bound to that value alone, and `null` for a `null` value.
 * 2. The input: the arguments at their wire keys, then the bound properties, then the supplied keys.
 * 3. The memo, for queries and links only: mutations are never memoised. It shares the call, and
 *    each field projects the answer by its own plan.
 * 4. `authorize`, then `context`, then the request schema, then the handler, then `armFor`, the
 *    arm's schema, and the arm's projection.
 */
export function resolverFor<X extends object, C>(
	call: CallRuntime,
	handlersFor: (context: X) => object,
	deps: GraphQLDeps<X, C>,
	rules: InputRules,
	codes: StatusCodes = {},
): GraphQLFieldResolver<unknown, X> {
	/** One call, with the parent's bound values given: the memo, the call and its projection. */
	const resolveBound = (
		bound: Readonly<Record<string, unknown>>,
		args: Readonly<Record<string, unknown>>,
		context: X,
		info: GraphQLResolveInfo,
	): Promise<unknown> => {
		const input = { ...argumentsToWire(call, args, info, rules), ...bound, ...call.supplied };
		const position = pagePositionOf(call, args, input);
		// The memo is keyed on the context value: any object, a function included.
		const keyed =
			(typeof context === "object" || typeof context === "function") && context !== null;
		const memoised = call.kind !== "mutation" && keyed;
		const asIssues = (error: unknown): never => {
			throw asArgumentIssues(error, call, info, rules);
		};
		/**
		 * **A mutation forgets what this request has read.** Mutations in one document run in turn, and
		 * each may change what a read answers, so a read memoised before one would answer stale after it:
		 * a link in the second mutation's result was answered from the first's. DataLoader's own rule,
		 * to clear after a mutation; cleared as it starts, since nothing else runs while it does.
		 */
		if (call.kind === "mutation" && keyed) MEMO.delete(context);
		if (!memoised) {
			return callOnce(call, handlersFor, deps, context, input).then(
				(result) => project(call, result, position, codes),
				asIssues,
			);
		}
		const key = `${call.operationId}\u0000${canonical(input)}`;
		let calls = MEMO.get(context);
		if (calls === undefined) {
			calls = new Map();
			MEMO.set(context, calls);
		}
		let pending = calls.get(key);
		if (pending === undefined) {
			pending = callOnce(call, handlersFor, deps, context, input);
			calls.set(key, pending);
		}
		// Each field maps a shared refusal by its own arguments: two fields name theirs differently.
		return pending.then((result) => project(call, result, position, codes), asIssues);
	};

	/**
	 * **One value of a batched link, waiting for the batch that carries it**: enqueued at once, with
	 * the values of every other parent this wave reaches, and sent when the wave has run. The memo
	 * keeps each value's answer, so a later wave asking again is answered from it.
	 */
	const resolveBatched = (
		batch: BatchRuntime,
		bound: Readonly<Record<string, unknown>>,
		value: unknown,
		args: Readonly<Record<string, unknown>>,
		context: X,
		info: GraphQLResolveInfo,
	): Promise<unknown> => {
		const input = { ...argumentsToWire(call, args, info, rules), ...bound, ...call.supplied };
		const asIssues = (error: unknown): never => {
			throw asArgumentIssues(error, call, info, rules);
		};
		const send = (waiting: readonly Waiting[]) =>
			sendBatch(call, batch, input, waiting, handlersFor, deps, context, codes);
		const keyed =
			(typeof context === "object" || typeof context === "function") && context !== null;
		// A context that is no object has no memo to batch in: each value is a batch of its own.
		if (!keyed) {
			return new Promise((resolve, reject) => {
				void send([{ value, resolve, reject }]);
			}).then(undefined, asIssues);
		}
		let calls = MEMO.get(context);
		if (calls === undefined) {
			calls = new Map();
			MEMO.set(context, calls);
		}
		const queueKey = `${call.operationId}\u0000batch\u0000${canonical(input)}`;
		const valueKey = `${queueKey}\u0000${canonical(value)}`;
		let pending = calls.get(valueKey);
		if (pending === undefined) {
			let request = QUEUES.get(calls);
			if (request === undefined) {
				request = { queues: new Map(), scheduled: false };
				QUEUES.set(calls, request);
			}
			const { queues } = request;
			let queue = queues.get(queueKey);
			if (queue === undefined) {
				queue = { waiting: [], send };
				queues.set(queueKey, queue);
			}
			const waiting = queue.waiting;
			pending = new Promise((resolve, reject) => {
				waiting.push({ value, resolve, reject });
			});
			calls.set(valueKey, pending);
			if (!request.scheduled) {
				request.scheduled = true;
				const state = request;
				afterWave(() => {
					state.scheduled = false;
					const due = [...state.queues.values()];
					state.queues.clear();
					for (const each of due) void each.send(each.waiting);
				});
			}
		}
		return pending.then(undefined, asIssues);
	};

	return (source, args: Readonly<Record<string, unknown>>, context, info) => {
		const parent = typeof source === "object" && source !== null ? source : {};
		const bound: Record<string, unknown> = {};
		const { batch } = call;
		let list: { readonly wire: string; readonly values: readonly unknown[] } | undefined;
		let batched: unknown;
		for (const binding of call.bound) {
			const value = own(parent, binding.parent)
				? (parent as Readonly<Record<string, unknown>>)[binding.parent]
				: undefined;
			if (value === null || value === undefined) return null;
			// The parent's read schema holds a bound list to an array; anything else is one value.
			if (binding.list === true) {
				list = { wire: binding.wire, values: Array.isArray(value) ? value : [value] };
			} else if (binding.wire === batch?.wire) {
				batched = value;
			} else {
				bound[binding.wire] = value;
			}
		}
		const one = (value: unknown, wire: string): Promise<unknown> =>
			batch === undefined
				? resolveBound({ ...bound, [wire]: value }, args, context, info)
				: resolveBatched(batch, bound, value, args, context, info);
		if (list === undefined) {
			return batch === undefined
				? resolveBound(bound, args, context, info)
				: resolveBatched(batch, bound, batched, args, context, info);
		}
		const { wire, values } = list;
		return values.map((value) => (value === null || value === undefined ? null : one(value, wire)));
	};
}

/** One arm of a link chosen by a kind, as `graphql.gen.ts` writes it. */
export interface KeyedArm<X extends object> {
	/** The wire values of the kind that choose this arm. */
	readonly values: readonly string[];
	/**
	 * The union member each answer is, where the arm answers one object type. An arm answering a
	 * result union has none here: its projection tags each answer's member by the arm the handler
	 * returned.
	 */
	readonly member?: string;
	/** The arm's own link resolver, `resolverFor` of its call. */
	readonly resolve: GraphQLFieldResolver<unknown, X>;
}

/**
 * **The resolver for a link chosen by a kind**: the parent's own `property` names the arm, and only
 * that arm's operation is called, so a reference whose target depends on a kind costs one call per
 * parent rather than one per target.
 *
 * A kind that is no string, or one no arm names, is `null` without a call, as an absent bound value
 * is. Otherwise the arm resolves exactly as a link of its own does, and each answer it makes, every
 * item of a list arm's, is tagged with the arm's member, which the field's union reads with
 * `memberTypeOf`: the member is decided by the arm, never by the shape of the body.
 */
export function keyedResolver<X extends object>(
	property: string,
	arms: readonly KeyedArm<X>[],
): GraphQLFieldResolver<unknown, X> {
	const armOf = new Map<string, KeyedArm<X>>();
	for (const arm of arms) for (const value of arm.values) armOf.set(value, arm);
	return (source, args, context, info) => {
		const parent = typeof source === "object" && source !== null ? source : {};
		const kind = own(parent, property)
			? (parent as Readonly<Record<string, unknown>>)[property]
			: undefined;
		const arm = typeof kind === "string" ? armOf.get(kind) : undefined;
		if (arm === undefined) return null;
		const answer: unknown = arm.resolve(source, args, context, info);
		const { member } = arm;
		if (member === undefined) return answer;
		const tag = (value: unknown): unknown =>
			value instanceof Promise
				? value.then((settled: unknown) => tagged(settled, member))
				: tagged(value, member);
		return Array.isArray(answer) ? answer.map(tag) : tag(answer);
	};
}
