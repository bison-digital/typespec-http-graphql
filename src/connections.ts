import type { ModelProperty, PagingProperty, Program, Scalar, Type } from "@typespec/compiler";
import {
	getMaxValue,
	getMaxValueExclusive,
	getPagingOperation,
	isArrayModelType,
	isList,
	isNullType,
	resolveEncodedName,
} from "@typespec/compiler";
import {
	type HttpOperation,
	type HttpOperationParameter,
	isBody,
	isBodyRoot,
	isMetadata,
} from "@typespec/http";
import { type ConnectionPlan, listOf, named, type OutputFieldPlan, type TypeRef } from "./model.js";
import type { TypeProjector } from "./types.js";

/**
 * Relay connections (relay.dev/graphql/connections.htm) from TypeSpec's **core** paging decorators,
 * read through the compiler's own `getPagingOperation`: `design.md` § Connections.
 *
 * **All five markers, or not a connection.** `@list` on the operation, `@pageItems` and
 * `@continuationToken` as top-level properties of the response body, `@continuationToken` and
 * `@pageSize` on request parameters. Only a forward continuation token maps onto a Relay cursor, so
 * offset and link paging are not connections either. Anything short of that is warned
 * `not-a-connection` and projected as its declared type, so a partial decoration never yields a
 * connection that cannot page.
 */

export type ConnectionVerdict =
	| { readonly kind: "connection"; readonly plan: ConnectionPlan }
	| { readonly kind: "not-a-connection"; readonly missing: readonly string[] }
	| { readonly kind: "plain" }; // no @list on the operation

/**
 * A response paging property's path below the BODY, which is where the runtime reads it.
 *
 * `getPagingOperation` paths start at the operation's return type, so a response declared
 * `{ @statusCode _: 200; @body body: Page }` puts `body` in front of every property: measured,
 * `body.items`. That leading `@body` is the body itself, not a level of nesting.
 */
function bodyPathOf(program: Program, property: PagingProperty): readonly ModelProperty[] {
	const [first, ...rest] = property.path;
	return first !== undefined && (isBody(program, first) || isBodyRoot(program, first))
		? rest
		: property.path;
}

/** The response property a marker names, as the body's top-level JSON key; or why it is not one. */
function responseKeyOf(
	program: Program,
	property: PagingProperty | undefined,
	marker: string,
	missing: string[],
): string | undefined {
	if (property === undefined) {
		missing.push(`${marker} on the response`);
		return undefined;
	}
	const path = bodyPathOf(program, property);
	if (isMetadata(program, property.property)) {
		missing.push(`${marker} on the response body rather than a header`);
		return undefined;
	}
	if (path.length !== 1) {
		const found = path.map((step) => step.name).join(".");
		missing.push(`${marker} as a top-level property of the response body (found at ${found})`);
		return undefined;
	}
	return resolveEncodedName(program, property.property, "application/json");
}

/**
 * The HTTP parameter a request marker names, whose `name` is its key in the handler's input; or why
 * it is not one.
 */
function parameterOf(
	operation: HttpOperation,
	property: PagingProperty | undefined,
	marker: string,
	missing: string[],
): HttpOperationParameter | undefined {
	if (property === undefined) {
		missing.push(`${marker} on a request parameter`);
		return undefined;
	}
	const parameter = operation.parameters.parameters.find(
		(candidate) => candidate.param === property.property,
	);
	if (parameter === undefined) {
		const found = property.path.map((step) => step.name).join(".");
		missing.push(`${marker} on a request parameter (found at ${found})`);
		return undefined;
	}
	return parameter;
}

export function connectionOf(
	program: Program,
	operation: HttpOperation,
	projector: TypeProjector,
): ConnectionVerdict {
	if (!isList(program, operation.operation)) return { kind: "plain" };
	const [paging] = getPagingOperation(program, operation.operation);
	// The compiler refuses `@list` without `@pageItems` with the error `missing-paging-items`.
	if (paging === undefined)
		throw new Error(`${operation.operation.name}: @list with no @pageItems`);
	const missing: string[] = [];
	const items = responseKeyOf(program, paging.output.pageItems, "@pageItems", missing);
	const next = responseKeyOf(
		program,
		paging.output.continuationToken,
		"@continuationToken",
		missing,
	);
	const after = parameterOf(
		operation,
		paging.input.continuationToken,
		"@continuationToken",
		missing,
	);
	const first = parameterOf(operation, paging.input.pageSize, "@pageSize", missing);
	const others: readonly (readonly [PagingProperty | undefined, string])[] = [
		[paging.input.offset, "@offset"],
		[paging.input.pageIndex, "@pageIndex"],
		[paging.output.nextLink, "@nextLink"],
		[paging.output.prevLink, "@prevLink"],
		[paging.output.firstLink, "@firstLink"],
		[paging.output.lastLink, "@lastLink"],
	];
	for (const [present, marker] of others) {
		if (present !== undefined) missing.push(`cursor paging rather than ${marker}`);
	}
	const array = paging.output.pageItems.property.type;
	// The compiler's `@pageItems` refuses every type but an array model: `decorator-wrong-target`.
	if (array.kind !== "Model" || !isArrayModelType(array))
		throw new Error(`${operation.operation.name}: @pageItems on an array`);
	if (isListOf(array.indexer.value)) {
		missing.push("@pageItems on an array of single items, not of lists");
	}
	if (
		missing.length > 0 ||
		items === undefined ||
		next === undefined ||
		after === undefined ||
		first === undefined
	) {
		return { kind: "not-a-connection", missing };
	}
	const item = projector.output(array.indexer.value);
	const maximum = maximumOf(program, first.param);
	// Only a list projects as one, and `isListOf` refused those above.
	if (item.kind !== "named") throw new Error(`${operation.operation.name}: a list item`);
	return {
		kind: "connection",
		plan: {
			items,
			next,
			first: first.name,
			after: after.name,
			item,
			maximum,
			assumedSize: first.param.defaultValue === undefined ? maximum : undefined,
		},
	};
}

/**
 * Whether a page's item projects as a list, which an edge's `node` cannot be: an array, alone or
 * `| null`, or a union variant naming one. Any other union is one value (`JSON`).
 */
function isListOf(type: Type): boolean {
	if (type.kind === "UnionVariant") return isListOf(type.type);
	if (type.kind === "Model") return isArrayModelType(type);
	if (type.kind !== "Union") return false;
	const present = [...type.variants.values()]
		.map((variant) => variant.type)
		.filter((variant) => !isNullType(variant));
	const [only] = present;
	return present.length === 1 && only !== undefined && isListOf(only);
}

/**
 * **The largest page size the operation accepts**, `undefined` where nothing bounds it: the least of
 * each whole `@maxValue`, and each whole `@maxValueExclusive` less one, that the page size property
 * declares and that every scalar its type extends declares, as the operation's Zod schema enforces
 * them all.
 *
 * It bounds a page twice. **Resuming after a cursor partway into a page**, the resolver asks the
 * backend for the items skipped as well, never past this. **Where `first` has no default**, it is
 * `@listSize(assumedSize:)`; never beside a default, which the cost specification reads as if the
 * query had sent it (§8.2), and beside which it allows no `assumedSize` (§9.2.4).
 */
function maximumOf(program: Program, pageSize: ModelProperty): number | undefined {
	const bounds: number[] = [];
	const read = (target: ModelProperty | Scalar): void => {
		const inclusive = getMaxValue(program, target);
		if (inclusive !== undefined) bounds.push(inclusive);
		const exclusive = getMaxValueExclusive(program, target);
		if (exclusive !== undefined) bounds.push(exclusive - 1);
	};
	read(pageSize);
	for (
		let scalar: Scalar | undefined = pageSize.type.kind === "Scalar" ? pageSize.type : undefined;
		scalar !== undefined;
		scalar = scalar.baseScalar
	) {
		read(scalar);
	}
	// A page holds a whole number of items, so a fraction bounds nothing: `@listSize(assumedSize:)`
	// is an `Int`, and a fractional maximum on a `float64` page size states no count.
	const whole = bounds.filter((bound) => Number.isSafeInteger(bound));
	return whole.length === 0 ? undefined : Math.min(...whole);
}

function field(name: string, type: TypeRef, description: string): OutputFieldPlan {
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

/**
 * Registers `<Item>Connection`, `<Item>Edge` and `PageInfo` (once), and returns the connection
 * TypeRef, nullable as every root field and link is.
 *
 * **The shapes are the Relay specification's, with GitHub's and PostGraphile's `nodes` shortcut.**
 * The runtime assembles these objects under their GraphQL names, so every field's wire key is its
 * name. `PageInfo` is defined by every connection, which the projector makes idempotent; a model of
 * the spec's own named `PageInfo` collides with it and is reported, never merged.
 */
export function defineConnection(plan: ConnectionPlan, projector: TypeProjector): TypeRef {
	const item = plan.item.name;
	/**
	 * **The item's own nullability**: a page of `(T | null)[]` answers `null` items, and a non-null
	 * `node` would turn each into an error that nulls the whole connection.
	 */
	const node = named(item, plan.item.nonNull);
	projector.define({
		kind: "object",
		name: "PageInfo",
		description:
			"Where a page sits in its connection, as the Relay connection specification defines it.",
		fields: [
			field("hasNextPage", named("Boolean", true), "Whether a further page follows this one."),
			field("hasPreviousPage", named("Boolean", true), "Always false: paging is forward only."),
			field(
				"startCursor",
				named("String", false),
				"The first edge's cursor; null when the page has no edges.",
			),
			field(
				"endCursor",
				named("String", false),
				"The last edge's cursor, to pass as `after` for the next page; null when there is none.",
			),
		],
	});
	projector.define({
		kind: "object",
		name: `${item}Edge`,
		description: `One ${item} in a connection.`,
		fields: [
			field("node", node, `The ${item}.`),
			field(
				"cursor",
				named("String", true),
				"An opaque cursor: pass it as `after` for the items after this edge.",
			),
		],
	});
	projector.define({
		kind: "object",
		name: `${item}Connection`,
		description: `A page of ${item}, as a Relay connection.`,
		fields: [
			field(
				"edges",
				listOf(named(`${item}Edge`, true), true),
				"The page's items, each with its cursor.",
			),
			field("nodes", listOf(node, true), "The page's items."),
			field("pageInfo", named("PageInfo", true), "Where this page sits in the connection."),
		],
	});
	return named(`${item}Connection`, false);
}
