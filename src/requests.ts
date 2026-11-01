import type { Program } from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import type { EmittedRoute } from "typespec-http-zod";
import {
	type ArgumentPlan,
	type CallPlan,
	named,
	type OutputFieldPlan,
	type SchemaPlan,
	type TypeDef,
	type TypeRef,
} from "./model.js";
import { typeNameOf } from "./names.js";

/**
 * **What this emitter planned, as requests a client can send**: one GraphQL document per root field,
 * and the variables a REST request's values make, for a tool that writes requests for the HTTP
 * surface (typespec-postman's collection) to write them for this one too.
 *
 * **Read after this emitter has run, never computed again.** A field's document has to match the
 * schema this emitter serves, the names it chose and the declarations it dropped, and only the plan
 * knows them. The plan is recorded as each service is written, so `graphqlRequestsOf` is a read of
 * what was emitted: `undefined` until `$onEmit` has run on the program, and nothing at all written,
 * reported or planned by asking.
 */

/** One root field, as a request that calls it. */
export interface GraphQLRequest {
	readonly kind: "query" | "mutation";
	/** The root field's name, as `graphql.tsp` gives it. */
	readonly field: string;
	/** The operation the field calls, as typespec-http-zod's service holds it. */
	readonly operation: HttpOperation;
	/** The field's description: `graphql.tsp`'s, else the operation's. */
	readonly description: string | undefined;
	/**
	 * One named operation calling the field: every argument a variable, and the field's type
	 * selected to its leaf fields, `__typename` first, a union's members each by a fragment. A field
	 * that cannot answer under the name another of its selection set already answers under, such as
	 * an enum `status` beside a problem's `Int!` one, is aliased, so the schema accepts the document.
	 */
	readonly document: string;
	/**
	 * **The member typenames a success answers**, where the field's type is a union: a mutation's
	 * success members, a query's members. `undefined` where the field is one type.
	 */
	readonly successTypenames: readonly string[] | undefined;
	/**
	 * **Where a success answer holds a value of the REST response's body.** For a path into a 2xx
	 * arm's JSON body, by wire names, the path below `data` at which each success member's selection
	 * holds that value, its alias where the document gives one, keyed by the member's typename, or
	 * for a field of one object type by that type's name. A member whose selection does not hold it
	 * has no entry; nor has a connection, a leaf, or a member that answers no body.
	 */
	readonly resultPathsOf: (wire: readonly string[]) => ReadonlyMap<string, readonly string[]>;
	/**
	 * The variables for the values a REST request sends: its parameters by wire name, and its body.
	 * Merged as the handler's input merges them, then renamed to the arguments' and input fields'
	 * GraphQL names, an enum's wire value to its GraphQL value. `missing` names each required
	 * argument or input field no value fills.
	 */
	readonly variables: (input: RequestValues) => {
		readonly value: Readonly<Record<string, unknown>>;
		readonly missing: readonly string[];
	};
}

/** What a REST request sends, as a tool that writes one holds it. */
export interface RequestValues {
	/** Path, query, header and cookie values, by the parameter's wire name. */
	readonly parameters: Readonly<Record<string, unknown>>;
	/** The JSON body, where the request has one. */
	readonly body?: unknown;
}

/** One service's requests, by its namespace's full name. */
export interface GraphQLServiceRequests {
	readonly service: string;
	readonly requests: readonly GraphQLRequest[];
}

/** What `emitService` planned for one service, recorded once it is written. */
export interface PlannedRecord {
	readonly service: string;
	readonly plan: SchemaPlan;
	/** Each root field's operation and route, by field: the plan's fields know only operation ids. */
	readonly roots: ReadonlyMap<
		string,
		{ readonly operation: HttpOperation; readonly route: EmittedRoute }
	>;
}

const RECORDED = new WeakMap<Program, PlannedRecord[]>();

/** Marks `program` as emitted by this copy, before any service is planned. */
export function beginRecord(program: Program): void {
	RECORDED.set(program, []);
}

export function record(program: Program, planned: PlannedRecord): void {
	const records = RECORDED.get(program);
	if (records === undefined) throw new Error("record: beginRecord was not called for this program");
	records.push(planned);
}

/**
 * Every root field this emitter served for `program`, per service, as a request; `undefined` where
 * this emitter has not run on `program`. A service that declared no field has no entry.
 */
export function graphqlRequestsOf(program: Program): readonly GraphQLServiceRequests[] | undefined {
	return RECORDED.get(program)?.map((planned) => ({
		service: planned.service,
		requests: [
			...planned.plan.query.flatMap((field) => requestOf(planned, "query", field)),
			...planned.plan.mutation.flatMap((field) => requestOf(planned, "mutation", field)),
		],
	}));
}

function requestOf(
	planned: PlannedRecord,
	kind: "query" | "mutation",
	field: OutputFieldPlan,
): GraphQLRequest[] {
	const root = planned.roots.get(`${kind}:${field.name}`);
	if (root === undefined || field.call === undefined) return [];
	const defs = new Map(planned.plan.types.map((def) => [def.name, def]));
	const { call } = field;
	const written = writtenRequestOf(defs, kind, field, call);
	return [
		{
			kind,
			field: field.name,
			operation: root.operation,
			description: field.description,
			document: written.document,
			successTypenames: written.successTypenames,
			resultPathsOf: written.resultPathsOf,
			variables: (input) => variablesOf(defs, root.route, field, call, input),
		},
	];
}

// ---------------------------------------------------------------------------------------------
// Documents: a selection tree, the aliases that make it valid, and the text it prints as.
// ---------------------------------------------------------------------------------------------

const TYPENAME_TYPE: TypeRef = named("String", true);

/**
 * **One field a document selects.** `wire` is the key of the parent's JSON body the field's value
 * comes from, where it comes from one, so the tree that prints the document also says where a body's
 * value is in the answer. `alias` is written by `aliasConflicts` alone.
 */
interface FieldNode {
	readonly kind: "field";
	readonly name: string;
	readonly type: TypeRef;
	readonly wire: string | undefined;
	readonly selections: readonly Selection[] | undefined;
	alias: string | undefined;
}

/** `... on <on> { }`: one member of a union. */
interface FragmentNode {
	readonly kind: "fragment";
	readonly on: string;
	readonly selections: readonly Selection[];
}

type Selection = FieldNode | FragmentNode;

function fieldNode(
	name: string,
	type: TypeRef,
	wire: string | undefined,
	selections?: readonly Selection[],
): FieldNode {
	return { kind: "field", name, type, wire, selections, alias: undefined };
}

function typenameNode(): FieldNode {
	return fieldNode("__typename", TYPENAME_TYPE, undefined);
}

function innermost(ref: TypeRef): string {
	return ref.kind === "named" ? ref.name : innermost(ref.of);
}

/** A ref as GraphQL writes a type: `[Book!]!`. */
function typeText(ref: TypeRef): string {
	return `${ref.kind === "list" ? `[${typeText(ref.of)}]` : ref.name}${ref.nonNull ? "!" : ""}`;
}

/** The plan's definition of a type the plan selects: every name a selection reaches is one. */
function defOf(defs: ReadonlyMap<string, TypeDef>, name: string): TypeDef {
	const def = defs.get(name);
	if (def === undefined) {
		throw new Error(`typespec-http-graphql internal invariant: the plan defines no type ${name}`);
	}
	return def;
}

/** A built-in scalar, which the plan does not define, or a scalar or enum it does. */
function isLeaf(defs: ReadonlyMap<string, TypeDef>, ref: TypeRef): boolean {
	const kind = defs.get(innermost(ref))?.kind;
	return kind === undefined || kind === "scalar" || kind === "enum";
}

/**
 * **A field a request may select without asking for more calls**: a property of the body, not a link,
 * and taking no required argument. A leaf such field is selected; an object one only as a payload.
 */
function callsNothing(field: OutputFieldPlan): boolean {
	return (
		field.call === undefined &&
		field.keyed === undefined &&
		!field.arguments.some(
			(argument) => argument.type.nonNull && argument.defaultValue === undefined,
		)
	);
}

/**
 * The selection of a named type: `__typename`, then its leaf fields; a union's members each by a
 * fragment of theirs, one with no leaf of its own by its `__typename`; a wrapper's `value`, and a
 * discriminated union's payload under its envelope, below it.
 */
function selectionOf(defs: ReadonlyMap<string, TypeDef>, name: string): Selection[] {
	const def = defOf(defs, name);
	if (def.kind === "union") {
		const discriminator =
			def.resolveBy.kind === "discriminator" ? def.resolveBy.property : undefined;
		return [
			typenameNode(),
			...def.members.map((member): FragmentNode => {
				const leaves = leavesOf(defs, member, discriminator);
				return {
					kind: "fragment",
					on: member,
					selections: leaves.length === 0 ? [typenameNode()] : leaves,
				};
			}),
		];
	}
	return [typenameNode(), ...leavesOf(defs, name, undefined)];
}

/**
 * The leaf fields of an object or interface, and the one field below them a request also selects:
 * a wrapper's `value`, or, in a member of a union `discriminator` resolves, the envelope beside the
 * discriminator, each selected to its own leaves. Neither is selected where it calls a handler.
 */
function leavesOf(
	defs: ReadonlyMap<string, TypeDef>,
	name: string,
	discriminator: string | undefined,
): FieldNode[] {
	const def = defOf(defs, name);
	if (def.kind !== "object" && def.kind !== "interface") return [];
	const [first, second] = def.fields;
	const payload =
		def.fields.length === 1 && first?.name === "value"
			? first
			: def.fields.length === 2 && first?.wire === discriminator
				? second
				: undefined;
	const nodes: FieldNode[] = [];
	for (const field of def.fields) {
		if (!callsNothing(field)) continue;
		if (isLeaf(defs, field.type)) {
			nodes.push(fieldNode(field.name, field.type, field.wire));
		} else if (field === payload) {
			nodes.push(
				fieldNode(field.name, field.type, field.wire, selectionOf(defs, innermost(field.type))),
			);
		}
	}
	return nodes;
}

/** A connection, through `nodes`, its items' selection, and `pageInfo`'s cursor. */
function connectionSelection(defs: ReadonlyMap<string, TypeDef>, connection: string): Selection[] {
	const fieldOf = (type: string, name: string): OutputFieldPlan => {
		const def = defOf(defs, type);
		const found =
			def.kind === "object" ? def.fields.find((field) => field.name === name) : undefined;
		if (found === undefined) {
			throw new Error(`typespec-http-graphql internal invariant: ${type} has no ${name} field`);
		}
		return found;
	};
	const nodes = fieldOf(connection, "nodes");
	const pageInfo = fieldOf(connection, "pageInfo");
	const page = innermost(pageInfo.type);
	const leaf = (name: string) => {
		const field = fieldOf(page, name);
		return fieldNode(field.name, field.type, undefined);
	};
	return [
		typenameNode(),
		isLeaf(defs, nodes.type)
			? fieldNode(nodes.name, nodes.type, undefined)
			: fieldNode(nodes.name, nodes.type, undefined, selectionOf(defs, innermost(nodes.type))),
		fieldNode(pageInfo.name, pageInfo.type, undefined, [leaf("hasNextPage"), leaf("endCursor")]),
	];
}

/** A selection set's fields, those of its fragments included, in the order the document writes them. */
function fieldsOf(selections: readonly Selection[]): FieldNode[] {
	return selections.flatMap((selection) =>
		selection.kind === "field" ? [selection] : fieldsOf(selection.selections),
	);
}

/**
 * **A field's response shape**, as SameResponseShape (spec 5.3.2) compares one: its list and non-null
 * wrapping and its leaf type, with every composite type one shape, `{}`, whose selections are
 * compared below. Two fields can answer under one response name only where their shapes are equal,
 * which is Apollo Federation's query planner's `typesCanBeMerged`. No type is named `{}`.
 */
function shapeOf(defs: ReadonlyMap<string, TypeDef>, ref: TypeRef): string {
	const inner =
		ref.kind === "list" ? `[${shapeOf(defs, ref.of)}]` : isLeaf(defs, ref) ? ref.name : "{}";
	return `${inner}${ref.nonNull ? "!" : ""}`;
}

/**
 * Whether `field` can answer under the response name `holder` answers under: Federation's rule, the
 * same field with a response shape that merges. Two fields of one name on two members of a union
 * need only that; two different fields never share a name. Merging is an equivalence, so the first
 * field under a name stands for every one.
 */
function fits(
	defs: ReadonlyMap<string, TypeDef>,
	holder: FieldNode | undefined,
	field: FieldNode,
): boolean {
	return (
		holder === undefined ||
		(holder.name === field.name && shapeOf(defs, holder.type) === shapeOf(defs, field.type))
	);
}

/**
 * **The response name a field answers under**: its own where it fits beside the field already there,
 * else graphql-tools' alias (`buildOperationNodeForField`), the field's name and type with `!` as
 * `NonNull`, `[` as `List` and `]` dropped, so `status: Int!` beside an enum is
 * `statusIntNonNull: status`. Where that is a name another field of the set is selected by, or holds
 * a shape this one cannot merge with, Federation's `__alias_<n>` follows it.
 */
function responseNameOf(
	defs: ReadonlyMap<string, TypeDef>,
	groups: ReadonlyMap<string, readonly FieldNode[]>,
	reserved: ReadonlySet<string>,
	field: FieldNode,
): string {
	if (fits(defs, groups.get(field.name)?.[0], field)) return field.name;
	const spelled = `${field.name}${typeText(field.type).replaceAll("!", "NonNull").replaceAll("[", "List").replaceAll("]", "")}`;
	for (let count = -1; ; count += 1) {
		const candidate = count < 0 ? spelled : `${spelled}__alias_${count}`;
		if (!reserved.has(candidate) && fits(defs, groups.get(candidate)?.[0], field)) {
			return candidate;
		}
	}
}

/**
 * **Aliases each field that cannot merge with the one already answering under its name**, so the
 * document passes OverlappingFieldsCanBeMerged. Federation's rule: across a set's fragments the first
 * field keeps its name and a later one is compared with it, never with the last one written; a
 * composite field's selections are merged with those answering beside it and the same is done below.
 * An alias never takes the name a field of the set is selected by.
 */
function aliasConflicts(defs: ReadonlyMap<string, TypeDef>, set: readonly FieldNode[]): void {
	const reserved = new Set(set.map((field) => field.name));
	const groups = new Map<string, FieldNode[]>();
	for (const field of set) {
		const responseName = responseNameOf(defs, groups, reserved, field);
		if (responseName !== field.name) field.alias = responseName;
		groups.set(responseName, [...(groups.get(responseName) ?? []), field]);
	}
	for (const group of groups.values()) {
		aliasConflicts(
			defs,
			group.flatMap((field) => fieldsOf(field.selections ?? [])),
		);
	}
}

function printed(selections: readonly Selection[], indent: string): string[] {
	return selections.flatMap((selection) => {
		const inner = `${indent}  `;
		if (selection.kind === "fragment") {
			return [
				`${indent}... on ${selection.on} {`,
				...printed(selection.selections, inner),
				`${indent}}`,
			];
		}
		const head = `${indent}${selection.alias === undefined ? "" : `${selection.alias}: `}${selection.name}`;
		return selection.selections === undefined
			? [head]
			: [`${head} {`, ...printed(selection.selections, inner), `${indent}}`];
	});
}

/**
 * Where in a selection the body's value at `wire` is answered: each key by the response name of the
 * field that reads it, and each index into a list as it is.
 */
function located(selections: readonly Selection[], wire: readonly string[]): string[] | undefined {
	const [head, ...rest] = wire;
	if (head === undefined) return [];
	const node = selections.find(
		(selection): selection is FieldNode => selection.kind === "field" && selection.wire === head,
	);
	if (node === undefined) return undefined;
	const below = within(node.type, node.selections, rest);
	return below === undefined ? undefined : [node.alias ?? node.name, ...below];
}

const INDEX = /^(?:0|[1-9][0-9]*)$/;

function within(
	type: TypeRef,
	selections: readonly Selection[] | undefined,
	wire: readonly string[],
): string[] | undefined {
	const [head, ...rest] = wire;
	if (head === undefined) return [];
	if (type.kind === "list") {
		if (!INDEX.test(head)) return undefined;
		const below = within(type.of, selections, rest);
		return below === undefined ? undefined : [head, ...below];
	}
	return selections === undefined ? undefined : located(selections, wire);
}

/**
 * A union field's success members: those a 2xx arm projects onto, and every member of a union a
 * 2xx arm answers whole, as a discriminated union is.
 */
function successTypenamesOf(
	defs: ReadonlyMap<string, TypeDef>,
	type: TypeRef,
	call: CallPlan,
): readonly string[] | undefined {
	const def = defs.get(innermost(type));
	if (def?.kind !== "union") return undefined;
	const names = new Set<string>();
	for (const [key, projection] of Object.entries(call.projection)) {
		if (!key.startsWith("2")) continue;
		if (projection.as === "member" || projection.as === "wrap") names.add(projection.type);
		if (projection.as === "value") for (const member of def.members) names.add(member);
	}
	return [...names];
}

/** What a request is, written once from the plan: its document, and where its answer holds a value. */
export interface WrittenRequest {
	readonly document: string;
	readonly successTypenames: readonly string[] | undefined;
	readonly resultPathsOf: (wire: readonly string[]) => ReadonlyMap<string, readonly string[]>;
}

/**
 * **The request for one root field**, which `call` makes: an operation named after the field, every
 * argument a variable of the argument's own type, the result selected by `selectionOf` (a
 * connection through `nodes`, its items' selection, and `pageInfo`'s cursor), and each field that
 * cannot merge with another of its selection set aliased.
 */
export function writtenRequestOf(
	defs: ReadonlyMap<string, TypeDef>,
	kind: "query" | "mutation",
	field: OutputFieldPlan,
	call: CallPlan,
): WrittenRequest {
	const declared = field.arguments.map(
		(argument) => `$${argument.name}: ${typeText(argument.type)}`,
	);
	const passed = field.arguments.map((argument) => `${argument.name}: $${argument.name}`);
	const head = `${kind} ${typeNameOf(field.name)}${declared.length === 0 ? "" : `(${declared.join(", ")})`} {`;
	const line = `  ${field.name}${passed.length === 0 ? "" : `(${passed.join(", ")})`}`;
	const successTypenames = successTypenamesOf(defs, field.type, call);
	if (isLeaf(defs, field.type)) {
		return {
			document: [head, line, "}"].join("\n"),
			successTypenames,
			resultPathsOf: () => new Map(),
		};
	}
	const result = innermost(field.type);
	const selections =
		call.connection === undefined ? selectionOf(defs, result) : connectionSelection(defs, result);
	aliasConflicts(defs, fieldsOf(selections));
	return {
		document: [head, `${line} {`, ...printed(selections, "    "), "  }", "}"].join("\n"),
		successTypenames,
		resultPathsOf: (wire) =>
			call.connection === undefined
				? resultPathsIn(field, call, selections, successTypenames, wire)
				: new Map(),
	};
}

/**
 * Where each success member's selection holds the body's value at `wire`, below `data`: a member's
 * own fields by their wire keys, a wrapper's body under its `value`, and nothing in a wrapper that
 * answers no body.
 */
function resultPathsIn(
	field: OutputFieldPlan,
	call: CallPlan,
	selections: readonly Selection[],
	successTypenames: readonly string[] | undefined,
	wire: readonly string[],
): ReadonlyMap<string, readonly string[]> {
	const wrapped = new Map<string, boolean>();
	for (const projection of Object.values(call.projection)) {
		if (projection.as === "wrap") wrapped.set(projection.type, projection.hasBody);
	}
	const paths = new Map<string, readonly string[]>();
	const add = (typename: string, within: readonly Selection[]) => {
		const hasBody = wrapped.get(typename);
		if (hasBody === false) return;
		const found = located(within, hasBody === true ? ["value", ...wire] : wire);
		if (found !== undefined) paths.set(typename, [field.name, ...found]);
	};
	if (successTypenames === undefined) {
		add(innermost(field.type), selections);
		return paths;
	}
	for (const typename of successTypenames) {
		const fragment = selections.find(
			(selection): selection is FragmentNode =>
				selection.kind === "fragment" && selection.on === typename,
		);
		if (fragment !== undefined) add(typename, fragment.selections);
	}
	return paths;
}

// ---------------------------------------------------------------------------------------------
// Variables: a REST request's values, as the arguments of the field that calls the same handler.
// ---------------------------------------------------------------------------------------------

function own(record: object, key: string): boolean {
	return Object.hasOwn(record, key);
}

/**
 * **One wire value as a GraphQL value of `ref`**, the inverse of the runtime's `toWire`: an input
 * object's fields under their GraphQL names, an enum's wire value as the value's GraphQL name, and
 * anything else as it is. `missing` collects each required input field no value fills.
 */
function fromWire(
	defs: ReadonlyMap<string, TypeDef>,
	value: unknown,
	ref: TypeRef,
	path: string,
	missing: string[],
): unknown {
	if (ref.kind === "list") {
		return Array.isArray(value)
			? value.map((item: unknown, index) =>
					fromWire(defs, item, ref.of, `${path}.${index}`, missing),
				)
			: value;
	}
	const def = defs.get(ref.name);
	if (def?.kind === "enum") {
		return def.values.find((candidate) => candidate.wire === value)?.name ?? value;
	}
	if (
		def?.kind !== "input" ||
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value)
	) {
		return value;
	}
	const converted: Record<string, unknown> = {};
	for (const field of def.fields) {
		if (own(value, field.wire)) {
			converted[field.name] = fromWire(
				defs,
				(value as Readonly<Record<string, unknown>>)[field.wire],
				field.type,
				`${path}.${field.name}`,
				missing,
			);
		} else if (field.type.nonNull && field.defaultValue === undefined) {
			missing.push(`${path}.${field.name}`);
		}
	}
	return converted;
}

/**
 * **The handler's input from a REST request's values**, merged as typespec-http-zod merges it: the
 * parameters by wire name, and the body under its named property or, unnamed, spread among them.
 */
function mergedInput(route: EmittedRoute, input: RequestValues): Readonly<Record<string, unknown>> {
	const merged: Record<string, unknown> = { ...input.parameters };
	if (input.body === undefined) return merged;
	if (route.bodyProperty !== undefined) merged[route.bodyProperty] = input.body;
	else if (typeof input.body === "object" && input.body !== null && !Array.isArray(input.body)) {
		Object.assign(merged, input.body);
	}
	return merged;
}

function variablesOf(
	defs: ReadonlyMap<string, TypeDef>,
	route: EmittedRoute,
	field: OutputFieldPlan,
	call: CallPlan,
	input: RequestValues,
): { readonly value: Readonly<Record<string, unknown>>; readonly missing: readonly string[] } {
	const merged = mergedInput(route, input);
	const value: Record<string, unknown> = {};
	const missing: string[] = [];
	const required = (argument: ArgumentPlan) =>
		argument.type.nonNull && argument.defaultValue === undefined;
	for (const argument of field.arguments) {
		// A cursor is this schema's own, never a REST value: a request starts at the first page.
		if (call.connection !== undefined && argument.name === "after") continue;
		if (argument.merge) {
			value[argument.name] = fromWire(defs, merged, argument.type, argument.name, missing);
			continue;
		}
		if (own(merged, argument.wire)) {
			value[argument.name] = fromWire(
				defs,
				merged[argument.wire],
				argument.type,
				argument.name,
				missing,
			);
		} else if (required(argument)) {
			missing.push(argument.name);
		}
	}
	return { value, missing };
}
