import type { Program } from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import type { EmittedRoute } from "typespec-http-zod";
import type { ArgumentPlan, OutputFieldPlan, SchemaPlan, TypeDef, TypeRef } from "./model.js";
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
	 * selected to its leaf fields, `__typename` first, a union's members each by a fragment.
	 */
	readonly document: string;
	/**
	 * **The member typenames a success answers**, where the field's type is a union: a mutation's
	 * success members, a query's members. `undefined` where the field is one type.
	 */
	readonly successTypenames: readonly string[] | undefined;
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
	return [
		{
			kind,
			field: field.name,
			operation: root.operation,
			description: field.description,
			document: documentOf(defs, kind, field),
			successTypenames: successTypenamesOf(defs, field),
			variables: (input) => variablesOf(defs, root.route, field, input),
		},
	];
}

// ---------------------------------------------------------------------------------------------
// Documents.
// ---------------------------------------------------------------------------------------------

const BUILT_IN_SCALARS: ReadonlySet<string> = new Set(["String", "Int", "Float", "Boolean", "ID"]);

function innermost(ref: TypeRef): string {
	return ref.kind === "named" ? ref.name : innermost(ref.of);
}

/** A ref as GraphQL writes a type: `[Book!]!`. */
function typeText(ref: TypeRef): string {
	return `${ref.kind === "list" ? `[${typeText(ref.of)}]` : ref.name}${ref.nonNull ? "!" : ""}`;
}

function isLeaf(defs: ReadonlyMap<string, TypeDef>, ref: TypeRef): boolean {
	const name = innermost(ref);
	if (BUILT_IN_SCALARS.has(name)) return true;
	const def = defs.get(name);
	return def === undefined || def.kind === "scalar" || def.kind === "enum";
}

/**
 * **A field a request selects without asking for more calls**: a leaf that is a property of the
 * body, not a link, and takes no required argument.
 */
function selectable(defs: ReadonlyMap<string, TypeDef>, field: OutputFieldPlan): boolean {
	if (field.call !== undefined || field.keyed !== undefined) return false;
	if (
		field.arguments.some((argument) => argument.type.nonNull && argument.defaultValue === undefined)
	) {
		return false;
	}
	return isLeaf(defs, field.type);
}

/**
 * The lines selecting a named type: `__typename`, then its leaf fields; a union's members each by a
 * fragment of theirs; a wrapper's `value` below it.
 */
function selectionOf(defs: ReadonlyMap<string, TypeDef>, name: string, indent: string): string[] {
	const def = defs.get(name);
	const lines = [`${indent}__typename`];
	if (def?.kind === "union") {
		for (const member of def.members) {
			lines.push(
				`${indent}... on ${member} {`,
				...leavesOf(defs, member, `${indent}  `),
				`${indent}}`,
			);
		}
		return lines;
	}
	return [...lines, ...leavesOf(defs, name, indent)];
}

/** The leaf fields of an object or interface; a wrapper's `value`, selected to its own leaves. */
function leavesOf(defs: ReadonlyMap<string, TypeDef>, name: string, indent: string): string[] {
	const def = defs.get(name);
	if (def?.kind !== "object" && def?.kind !== "interface") return [];
	const lines: string[] = [];
	for (const field of def.fields) {
		if (selectable(defs, field)) {
			lines.push(`${indent}${field.name}`);
		} else if (field.name === "value" && def.fields.length === 1 && !isLeaf(defs, field.type)) {
			lines.push(
				`${indent}value {`,
				...selectionOf(defs, innermost(field.type), `${indent}  `),
				`${indent}}`,
			);
		}
	}
	return lines;
}

/**
 * **The document for one root field**: an operation named after the field, every argument a
 * variable of the argument's own type, and the result selected by `selectionOf`. A connection is
 * selected through `nodes`, its items' leaves, and `pageInfo`'s cursor.
 */
function documentOf(
	defs: ReadonlyMap<string, TypeDef>,
	kind: "query" | "mutation",
	field: OutputFieldPlan,
): string {
	const declared = field.arguments.map(
		(argument) => `$${argument.name}: ${typeText(argument.type)}`,
	);
	const passed = field.arguments.map((argument) => `${argument.name}: $${argument.name}`);
	const head = `${kind} ${typeNameOf(field.name)}${declared.length === 0 ? "" : `(${declared.join(", ")})`} {`;
	const call = `  ${field.name}${passed.length === 0 ? "" : `(${passed.join(", ")})`}`;
	const result = innermost(field.type);
	if (isLeaf(defs, field.type)) return [head, call, "}"].join("\n");
	const body =
		field.call?.connection === undefined
			? selectionOf(defs, result, "    ")
			: connectionSelection(defs, result);
	return [head, `${call} {`, ...body, "  }", "}"].join("\n");
}

function connectionSelection(defs: ReadonlyMap<string, TypeDef>, connection: string): string[] {
	const def = defs.get(connection);
	const nodes =
		def?.kind === "object" ? def.fields.find((field) => field.name === "nodes") : undefined;
	return [
		"    __typename",
		...(nodes === undefined
			? []
			: ["    nodes {", ...selectionOf(defs, innermost(nodes.type), "      "), "    }"]),
		"    pageInfo {",
		"      hasNextPage",
		"      endCursor",
		"    }",
	];
}

/** A union field's success members: those a 2xx arm projects onto. */
function successTypenamesOf(
	defs: ReadonlyMap<string, TypeDef>,
	field: OutputFieldPlan,
): readonly string[] | undefined {
	if (defs.get(innermost(field.type))?.kind !== "union" || field.call === undefined)
		return undefined;
	const names = new Set<string>();
	for (const [key, projection] of Object.entries(field.call.projection)) {
		if (!key.startsWith("2")) continue;
		if (projection.as === "member" || projection.as === "wrap") names.add(projection.type);
	}
	return [...names];
}

// ---------------------------------------------------------------------------------------------
// Variables: a REST request's values, as the arguments of the field that calls the same handler.
// ---------------------------------------------------------------------------------------------

function own(record: unknown, key: string): boolean {
	return (
		typeof record === "object" &&
		record !== null &&
		Object.prototype.hasOwnProperty.call(record, key)
	);
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
	if (value === null || value === undefined) return value;
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
	if (def?.kind !== "input" || typeof value !== "object" || Array.isArray(value)) return value;
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
	input: RequestValues,
): { readonly value: Readonly<Record<string, unknown>>; readonly missing: readonly string[] } {
	const merged = mergedInput(route, input);
	const value: Record<string, unknown> = {};
	const missing: string[] = [];
	const required = (argument: ArgumentPlan) =>
		argument.type.nonNull && argument.defaultValue === undefined;
	for (const argument of field.arguments) {
		// A cursor is this schema's own, never a REST value: a request starts at the first page.
		if (field.call?.connection !== undefined && argument.name === "after") continue;
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
