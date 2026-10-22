import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	getPagingOperation,
	isArrayModelType,
	isList,
	type Model,
	type ModelProperty,
	type Program,
	type Type,
} from "@typespec/compiler";
import {
	type HttpOperation,
	type HttpOperationParameter,
	isBody,
	isBodyRoot,
	resolveRequestVisibility,
	type Visibility,
} from "@typespec/http";
import {
	getNamedType,
	type GraphQLField,
	type GraphQLOutputType,
	type GraphQLSchema,
	isAbstractType,
	isLeafType,
	isListType,
	isNonNullType,
	isObjectType,
} from "graphql";
import type { EmittedRoute, EmittedService, RouteSchemaNames } from "typespec-http-zod";
import type { ResponseArm } from "typespec-http-zod/runtime";
import type { ZodType } from "zod";
import { compileFixture, servicesOfProgram } from "./compile-fixture.js";
import { Untranslatable, WireWalk } from "./wire-walk.js";

/**
 * **What the verdict oracle needs from one compiled fixture, read without the emitter's help.**
 *
 * One compile, one program: the emitter's output, the library's view of the same program
 * (`servicesOfProgram`), and the declarations read back from `graphql.tsp`'s TEXT, so which
 * operation a root field calls is the spec's statement, not the emitter's. The schema the emitted
 * module builds is used only to ROUTE a request: which arguments exist and what type a variable
 * needs, which fields to select. Every expected value comes from `WireWalk` and the library's Zod.
 */

export interface RootField {
	readonly name: string;
	readonly kind: "query" | "mutation";
	readonly operationId: string;
	readonly operation: HttpOperation;
	readonly route: EmittedRoute;
	readonly names: RouteSchemaNames;
	readonly visibility: Visibility;
}

export interface Call {
	readonly operationId: string;
	readonly input: unknown;
}

/**
 * The input as it was handed, safe from a handler that mutates it. A value structured clone cannot
 * copy (a stream, a `Blob` a REST route hands over) is recorded as itself.
 */
function cloneOf(input: unknown): unknown {
	try {
		return structuredClone(input);
	} catch {
		return input;
	}
}

/** One handler object for every operation: it records each call, and answers what it is told to. */
export class Recorder {
	readonly calls: Call[] = [];
	answer: (operationId: string, input: unknown) => unknown = (operationId) => {
		throw new Error(`no answer scripted for ${operationId}`);
	};

	readonly handlers: object = new Proxy(
		{},
		{
			get: (_target, key) =>
				typeof key === "string"
					? (_context: unknown, input: unknown) => {
							this.calls.push({ operationId: key, input: cloneOf(input) });
							return this.answer(key, input);
						}
					: undefined,
		},
	);

	reset(): void {
		this.calls.length = 0;
	}
}

export interface Fixture {
	readonly name: string;
	/** Where the published `typespec-hono` wrote, when the fixture was loaded `withServer`. */
	readonly serverDir: string;
	readonly program: Program;
	readonly walk: WireWalk;
	readonly library: Readonly<Record<string, unknown>>;
	readonly schema: GraphQLSchema;
	readonly roots: readonly RootField[];
	readonly recorder: Recorder;
	/** Declarations whose root field the built schema does not carry, with why they are missing. */
	readonly missing: readonly string[];
}

export type Loaded =
	| { readonly fixture: Fixture }
	| { readonly skip: string; readonly detail: string };

const DECLARATION = /@@(queryField|mutationField)\(\s*([^,]+?)\s*,\s*"([^"]+)"\s*\)/g;

/**
 * The operation a declaration's reference names: the operation whose qualified path (namespaces,
 * interface, name) ends with the reference's segments, and only if exactly one does. The corpus's
 * declarations are fully qualified, so ops the corpus names alike in different namespaces
 * (`Standard.array` under several) resolve apart; the library's ids for them are deduplicated and
 * say nothing about which is which.
 */
function operationNamed(
	services: readonly EmittedService[],
	reference: string,
): string | undefined {
	const wanted = reference
		.replace(/^global\./, "")
		.split(".")
		.map((segment) => segment.replaceAll("`", ""));
	const found: string[] = [];
	for (const service of services) {
		for (const [operationId, operation] of service.operations) {
			const path = [operation.operation.name];
			if (operation.operation.interface !== undefined)
				path.unshift(operation.operation.interface.name);
			for (
				let namespace = operation.operation.interface?.namespace ?? operation.operation.namespace;
				namespace !== undefined && namespace.name !== "";
				namespace = namespace.namespace
			) {
				path.unshift(namespace.name);
			}
			const tail = path.slice(-wanted.length);
			if (
				tail.length === wanted.length &&
				tail.every((segment, index) => segment === wanted[index])
			) {
				found.push(operationId);
			}
		}
	}
	return found.length === 1 ? found[0] : undefined;
}

/**
 * Compile `entry` once and read back everything an oracle needs; or why it cannot. `withServer`
 * also runs the published `typespec-hono` in the same compile, for an oracle that serves REST beside.
 */
export async function loadFixture(
	name: string,
	entry: string,
	outDir: string,
	options: {
		readonly withServer?: boolean;
		readonly expectedErrors?: readonly string[];
		/** The `openapi-versions` openapi3 publishes, for a corpus scenario: see `openapi-versions.ts`. */
		readonly openApiVersions?: readonly string[] | undefined;
		/** Where `@typespec/openapi3` published the spec's document, in a compile of its own. */
		readonly documentDir?: string;
	} = {},
): Promise<Loaded> {
	let compiled;
	try {
		compiled = await compileFixture(dirname(entry), basename(entry, ".tsp"), {
			outDir,
			withServer: options.withServer === true,
			expectedErrors: options.expectedErrors ?? [],
			openApiVersions: options.openApiVersions,
		});
	} catch (error) {
		return {
			skip: "emitter-threw",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	const errors = compiled.diagnostics.filter((d) => d.severity === "error");
	if (errors.length > 0)
		return { skip: "compile-error", detail: errors.map((e) => e.code).join(", ") };
	const module = join(outDir, "graphql.gen.ts");
	if (!existsSync(module)) return { skip: "nothing-emitted", detail: name };
	const program = compiled.program;
	const services = await servicesOfProgram(program, join(outDir, "library"));
	const library = (await import(join(outDir, "schemas.gen.ts"))) as Readonly<
		Record<string, unknown>
	>;
	const generated = (await import(module)) as {
		readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
	};
	const recorder = new Recorder();
	const schema = generated.createSchema(() => recorder.handlers, {
		authorize: () => "allow",
		context: () => ({ subject: "verdicts" }),
	});

	const text = [entry, join(dirname(entry), "graphql.tsp")]
		.filter((file, index, all) => existsSync(file) && all.indexOf(file) === index)
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
	const roots: RootField[] = [];
	const missing: string[] = [];
	for (const match of text.matchAll(DECLARATION)) {
		const [, decorator, reference = "", field = ""] = match;
		const operationId = operationNamed(services, reference);
		const service = services.find(
			(candidate) => operationId !== undefined && candidate.operations.has(operationId),
		);
		const operation = operationId === undefined ? undefined : service?.operations.get(operationId);
		const route = service?.routes.find((candidate) => candidate.operationId === operationId);
		const names = operationId === undefined ? undefined : service?.schemaNames.get(operationId);
		if (
			operationId === undefined ||
			operation === undefined ||
			route === undefined ||
			names === undefined
		) {
			missing.push(`${field}: no operation ${reference}`);
			continue;
		}
		const kind = decorator === "queryField" ? "query" : "mutation";
		const root = kind === "query" ? schema.getQueryType() : schema.getMutationType();
		if (root?.getFields()[field] === undefined) {
			missing.push(`${field}: not served`);
			continue;
		}
		roots.push({
			name: field,
			kind,
			operationId,
			operation,
			route,
			names,
			visibility: resolveRequestVisibility(program, operation.operation, operation.verb),
		});
	}
	return {
		fixture: {
			name,
			serverDir: compiled.serverDir,
			program,
			walk: new WireWalk(
				program,
				options.documentDir === undefined ? undefined : publishedComponentsIn(options.documentDir),
			),
			library,
			schema,
			roots,
			recorder,
			missing,
		},
	};
}

// -------------------------------------------------------------------------------------------------
// Routing: what to select, and what type a variable takes. Read from the schema, decides no value.
// -------------------------------------------------------------------------------------------------

/** The field of a root type, by name. */
export function fieldOf(fixture: Fixture, root: RootField): GraphQLField<unknown, unknown> {
	const type =
		root.kind === "query" ? fixture.schema.getQueryType() : fixture.schema.getMutationType();
	const field = type?.getFields()[root.name];
	if (field === undefined) throw new Error(`${root.name} is not a field of the schema`);
	return field;
}

/**
 * A selection of every field a value of `type` carries, except links (fields with arguments or a
 * cost, which call another operation): `__typename` on every object, a fragment for every possible
 * type of an abstract type, and a connection's `nodes` alone.
 */
export function selectionOf(
	schema: GraphQLSchema,
	type: GraphQLOutputType,
	depth = 0,
	seen: ReadonlyMap<string, number> = new Map(),
	alias?: string,
): string {
	const named = getNamedType(type);
	if (isLeafType(named)) return "";
	if (depth > 10) return "{ __typename }";
	const count = seen.get(named.name) ?? 0;
	const next = new Map(seen).set(named.name, count + 1);
	if (isAbstractType(named)) {
		const members = schema
			.getPossibleTypes(named)
			.map(
				(member) =>
					`... on ${member.name} ${selectionOf(schema, member, depth + 1, next, member.name)}`,
			);
		return `{ __typename ${members.join(" ")} }`;
	}
	if (!isObjectType(named)) return "{ __typename }";
	const fields = named.getFields();
	if (
		fields["edges"] !== undefined &&
		fields["pageInfo"] !== undefined &&
		fields["nodes"] !== undefined
	) {
		return `{ __typename nodes ${selectionOf(schema, fields["nodes"].type, depth + 1, next)} }`;
	}
	const selected = Object.values(fields)
		.filter(
			(field) =>
				field.args.length === 0 && (field.extensions as { cost?: unknown }).cost === undefined,
		)
		// Deep enough for every body the oracles propose (three levels) and the corpus's own (four).
		.filter((field) => isLeafType(getNamedType(field.type)) || count < 5)
		/**
		 * Inside a fragment on an abstract type, every field is aliased `<Member>__<field>`: two members
		 * may carry one field name with two types, which GraphQL refuses to merge unaliased.
		 * `asExpected` takes the prefix off again.
		 */
		.map(
			(field) =>
				`${alias === undefined ? "" : `${alias}__${field.name}: `}${field.name} ${selectionOf(schema, field.type, depth + 1, next)}`,
		);
	return `{ __typename ${selected.join(" ")} }`;
}

/**
 * The components of the document `@typespec/openapi3` published beside the fixture: its one
 * `openapi.json`, or a versioned spec's last version's. `undefined` where it published none.
 */
function publishedComponentsIn(dir: string): Readonly<Record<string, unknown>> | undefined {
	if (!existsSync(dir)) return undefined;
	const [file] = readdirSync(dir)
		.filter((name) => /^openapi(\..+)?\.json$/.test(name))
		.toSorted((a, b) =>
			a === "openapi.json" ? -1 : b === "openapi.json" ? 1 : b.localeCompare(a),
		);
	if (file === undefined) return undefined;
	const document = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
		readonly components?: Readonly<Record<string, unknown>>;
	};
	return document.components;
}

/**
 * Data as an oracle's expected value states it: without `__typename`, which routes a selection, but
 * where the expected value names the object type a value resolved to, as a base's value does.
 */
export function asExpected(value: unknown, expected: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item, index) =>
			asExpected(item, Array.isArray(expected) ? expected[index] : undefined),
		);
	}
	if (typeof value !== "object" || value === null) return value;
	const stated = (typeof expected === "object" && expected !== null ? expected : {}) as Readonly<
		Record<string, unknown>
	>;
	const typename = (value as { readonly __typename?: unknown }).__typename;
	const prefix = typeof typename === "string" ? `${typename}__` : undefined;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "__typename" || Object.hasOwn(stated, "__typename"))
			.map(([key, item]) => {
				const name =
					prefix !== undefined && key.startsWith(prefix) ? key.slice(prefix.length) : key;
				return [name, key === "__typename" ? item : asExpected(item, stated[name])];
			}),
	);
}

/** True when a type is a list somewhere below its non-null wrapper. */
export const isListOutput = (type: GraphQLOutputType): boolean =>
	isListType(type) || (isNonNullType(type) && isListType(type.ofType));

// -------------------------------------------------------------------------------------------------
// The handler's input: the library's groups, and how a client writes them in GraphQL.
// -------------------------------------------------------------------------------------------------

/** design.md § Connections: all five core paging markers, the response's two at the body's top level. */
export function pagingOf(
	program: Program,
	operation: HttpOperation,
):
	| {
			readonly first: string;
			readonly after: string;
			readonly items: string;
			readonly next: string;
			readonly item: Type;
	  }
	| undefined {
	if (!isList(program, operation.operation)) return undefined;
	const [paging] = getPagingOperation(program, operation.operation);
	if (paging === undefined) return undefined;
	const top = (
		property:
			| { readonly path: readonly ModelProperty[]; readonly property: ModelProperty }
			| undefined,
	): ModelProperty | undefined => {
		if (property === undefined) return undefined;
		const [first, ...rest] = property.path;
		const path =
			first !== undefined && (isBody(program, first) || isBodyRoot(program, first))
				? rest
				: property.path;
		return path.length === 1 ? property.property : undefined;
	};
	const items = top(paging.output.pageItems);
	const next = top(paging.output.continuationToken);
	const param = (property: { readonly property: ModelProperty } | undefined) =>
		property === undefined
			? undefined
			: operation.parameters.parameters.find((candidate) => candidate.param === property.property);
	const after = param(paging.input.continuationToken);
	const first = param(paging.input.pageSize);
	const other = [
		paging.input.offset,
		paging.input.pageIndex,
		paging.output.nextLink,
		paging.output.prevLink,
		paging.output.firstLink,
		paging.output.lastLink,
	];
	if (
		items === undefined ||
		next === undefined ||
		after === undefined ||
		first === undefined ||
		other.some((marker) => marker !== undefined)
	) {
		return undefined;
	}
	if (items.type.kind !== "Model" || !isArrayModelType(items.type)) return undefined;
	return {
		first: first.name,
		after: after.name,
		items: items.name,
		next: next.name,
		item: items.type.indexer.value,
	};
}

/** What becomes of one parameter: design.md § Arguments and input, restated. */
export function dispositionOf(
	parameter: HttpOperationParameter,
): "argument" | "supplied" | "omitted" {
	// design.md: a cookie follows the header rule, being transport state as a header is.
	if (parameter.type !== "header" && parameter.type !== "cookie") return "argument";
	if (parameter.param.type.kind === "String") return "supplied";
	if (parameter.param.optional) return "omitted";
	return "argument";
}

/** The body's place in the handler's input: one key (`bodyProperty`), or its properties spread. */
export function bodyOf(
	root: RootField,
): { readonly key: string | undefined; readonly type: Type } | undefined {
	const body = root.operation.parameters.body;
	if (body === undefined) return undefined;
	return { key: root.route.bodyProperty ?? root.route.rawBodyProperty, type: body.type };
}

/** The Zod schema the library declared under an identifier, if it did. */
export function schemaNamed(fixture: Fixture, identifier: string | undefined): ZodType | undefined {
	if (identifier === undefined) return undefined;
	const value = fixture.library[identifier];
	return typeof value === "object" && value !== null && "safeParse" in value
		? (value as ZodType)
		: undefined;
}

export interface Arguments {
	/** The arguments to send: one per argument, or `{ input }` for a mutation. */
	readonly args: Readonly<Record<string, unknown>>;
}

const own = (record: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(record, key);

/**
 * The GraphQL arguments a client sends for the wire input `wire`. A connection's `after` is never
 * sent: it is a cursor a client takes from a response, not a wire value.
 */
/**
 * design.md: a spread body that carries additional properties makes the operation's
 * whole input one `JSON` argument, `input`, holding the handler's wire input as the request carries it.
 */
export function isOpenInput(root: RootField): boolean {
	const body = bodyOf(root);
	if (body === undefined || body.key !== undefined || body.type.kind !== "Model") return false;
	for (
		let current: Model | undefined = body.type;
		current !== undefined;
		current = current.baseModel
	) {
		if (current.indexer !== undefined && !isArrayModelType(current)) return true;
	}
	return false;
}

export function argumentsFor(
	fixture: Fixture,
	root: RootField,
	wire: Readonly<Record<string, unknown>>,
): Arguments {
	const { walk } = fixture;
	if (isOpenInput(root)) {
		const sent = Object.fromEntries(
			Object.entries(wire).filter(([key]) => {
				const parameter = root.operation.parameters.parameters.find(
					(candidate) => candidate.name === key,
				);
				return parameter === undefined || dispositionOf(parameter) === "argument";
			}),
		);
		return { args: { input: sent } };
	}
	const paging = root.kind === "query" ? pagingOf(fixture.program, root.operation) : undefined;
	const fields: Record<string, unknown> = {};
	for (const parameter of root.operation.parameters.parameters) {
		if (dispositionOf(parameter) !== "argument") continue;
		if (paging?.after === parameter.name) continue;
		if (!own(wire, parameter.name)) continue;
		const name = paging?.first === parameter.name ? "first" : walk.fieldName(parameter.name);
		fields[name] = walk.input(parameter.param.type, wire[parameter.name], root.visibility);
	}
	const body = bodyOf(root);
	if (body !== undefined) {
		if (body.key !== undefined) {
			if (own(wire, body.key))
				fields[walk.fieldName(body.key)] = walk.input(body.type, wire[body.key], root.visibility);
		} else if (body.type.kind === "Model") {
			Object.assign(fields, walk.input(body.type, wire, root.visibility) as object);
		} else {
			throw new Untranslatable("a spread body that is not a model");
		}
	}
	if (root.kind === "mutation")
		return {
			args: Object.keys(fields).length === 0 && !hasInput(fixture, root) ? {} : { input: fields },
		};
	return { args: fields };
}

function hasInput(fixture: Fixture, root: RootField): boolean {
	return fieldOf(fixture, root).args.some((arg) => arg.name === "input");
}

/**
 * The wire input a handler must receive for the GraphQL arguments `args`: README § Arguments and
 * input, restated. Each argument under its wire key; an explicit `null` for an optional field that is
 * not `| null` dropped, as REST sees an omitted key; an absent field that is required and `| null`
 * written as `null`, since GraphQL cannot require a nullable input and design.md reads absence as
 * the null the caller could not otherwise write; single-literal headers and the negotiated `accept`
 * supplied; every other header absent.
 */
export function handedFor(
	fixture: Fixture,
	root: RootField,
	args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const { walk } = fixture;
	if (isOpenInput(root)) {
		const handed: Record<string, unknown> = { ...((args["input"] ?? {}) as object) };
		for (const parameter of root.operation.parameters.parameters) {
			if (dispositionOf(parameter) === "supplied" && parameter.param.type.kind === "String") {
				handed[parameter.name] = parameter.param.type.value;
			}
		}
		const accept = root.names.selectedAccept;
		if (accept !== undefined) handed[accept.name] = accept.value;
		return handed;
	}
	const fields =
		root.kind === "mutation" ? ((args["input"] ?? {}) as Readonly<Record<string, unknown>>) : args;
	const paging = root.kind === "query" ? pagingOf(fixture.program, root.operation) : undefined;
	const handed: Record<string, unknown> = {};
	const place = (wireKey: string, property: ModelProperty, name: string, type: Type): void => {
		if (!own(fields, name)) {
			if (!property.optional && walk.isNullable(property.type)) handed[wireKey] = null;
			return;
		}
		const value = fields[name];
		if (value === null && property.optional && !walk.isNullable(property.type)) return;
		handed[wireKey] = walk.wireOf(type, value, root.visibility);
	};
	for (const parameter of root.operation.parameters.parameters) {
		const disposition = dispositionOf(parameter);
		if (disposition === "supplied" && parameter.param.type.kind === "String") {
			handed[parameter.name] = parameter.param.type.value;
			continue;
		}
		if (disposition === "omitted") continue;
		if (paging?.after === parameter.name) continue;
		const name = paging?.first === parameter.name ? "first" : walk.fieldName(parameter.name);
		place(parameter.name, parameter.param, name, parameter.param.type);
	}
	const accept = root.names.selectedAccept;
	if (accept !== undefined) handed[accept.name] = accept.value;
	const body = bodyOf(root);
	if (body !== undefined) {
		if (body.key !== undefined) {
			const property = root.operation.parameters.body?.property;
			const name = walk.fieldName(body.key);
			if (own(fields, name)) {
				const value = fields[name];
				if (!(value === null && root.route.optionalBody))
					handed[body.key] = walk.wireOf(body.type, value, root.visibility);
			} else if (
				property !== undefined &&
				!root.route.optionalBody &&
				walk.isNullable(property.type)
			) {
				handed[body.key] = null;
			}
		} else if (body.type.kind === "Model") {
			for (const property of walk.payloadOf(body.type, root.visibility)) {
				const wireKey = walk.wireName(property);
				const name = walk.fieldName(wireKey);
				if (!own(fields, name)) {
					if (!walk.isOptional(property, root.visibility) && walk.isNullable(property.type))
						handed[wireKey] = null;
					continue;
				}
				const value = fields[name];
				if (value === null && walk.dropsNull(property, root.visibility)) continue;
				handed[wireKey] = walk.wireOfProperty(property, value, root.visibility);
			}
		}
	}
	return handed;
}

/** The library's group schemas for an operation, each with the wire keys it owns. */
export interface Group {
	readonly name: "path" | "query" | "header" | "cookie" | "body";
	readonly schema: ZodType;
	/** For a named body, the key the whole body sits under; otherwise the group's own keys. */
	readonly key: string | undefined;
	readonly keys: ReadonlySet<string>;
}

export function groupsOf(fixture: Fixture, root: RootField): Group[] {
	const groups: Group[] = [];
	const parameters = root.operation.parameters.parameters;
	const keysOf = (type: HttpOperationParameter["type"]): Set<string> =>
		new Set(
			parameters.filter((parameter) => parameter.type === type).map((parameter) => parameter.name),
		);
	const add = (
		name: Group["name"],
		identifier: string | undefined,
		keys: Set<string>,
		key?: string,
	): void => {
		const schema = schemaNamed(fixture, identifier);
		if (schema !== undefined) groups.push({ name, schema, key, keys });
	};
	add("path", root.names.path, keysOf("path"));
	add("query", root.names.queryFields ?? root.names.query, keysOf("query"));
	add("header", root.names.header, keysOf("header"));
	add("cookie", root.names.cookie, keysOf("cookie"));
	const body = bodyOf(root);
	if (body !== undefined) {
		const keys =
			body.key !== undefined
				? new Set([body.key])
				: body.type.kind === "Model"
					? new Set(
							fixture.walk
								.payloadOf(body.type, root.visibility)
								.map((property) => fixture.walk.wireName(property)),
						)
					: new Set<string>();
		add("body", root.names.body, keys, body.key);
	}
	return groups;
}

export interface ZodVerdict {
	readonly accepted: boolean;
	readonly parsed: Record<string, unknown>;
	readonly issues: readonly {
		readonly code: string;
		readonly path: readonly PropertyKey[];
		readonly group: string;
	}[];
}

/** The library's verdict on a whole handler input, group by group, as the REST route validates it. */
export function zodVerdict(
	root: RootField,
	groups: readonly Group[],
	wire: Readonly<Record<string, unknown>>,
): ZodVerdict {
	const parsed: Record<string, unknown> = {};
	const issues: { code: string; path: readonly PropertyKey[]; group: string }[] = [];
	/**
	 * The negotiated `accept`: the library leaves it out of the header schema, because it selects the
	 * operation rather than constraining it, and says a handler receives exactly that literal.
	 */
	const accept = root.names.selectedAccept;
	if (accept !== undefined && wire[accept.name] === accept.value)
		parsed[accept.name] = accept.value;
	for (const group of groups) {
		const value =
			group.key !== undefined
				? wire[group.key]
				: Object.fromEntries(Object.entries(wire).filter(([key]) => group.keys.has(key)));
		// The library's `optionalBody`: a body the document lets the caller leave out.
		if (
			group.name === "body" &&
			group.key !== undefined &&
			value === undefined &&
			root.route.optionalBody
		) {
			continue;
		}
		const result = group.schema.safeParse(value);
		if (result.success) {
			if (group.key !== undefined) {
				if (result.data !== undefined) parsed[group.key] = result.data;
			} else {
				Object.assign(parsed, result.data);
			}
		} else {
			for (const issue of result.error.issues) {
				issues.push({
					code: issue.code,
					path: group.key === undefined ? issue.path : [group.key, ...issue.path],
					group: group.name,
				});
			}
		}
	}
	return { accepted: issues.length === 0, parsed, issues };
}

/** The TypeSpec type at a wire path below the handler's input, for asking whether it is JSON. */
export function typeAt(fixture: Fixture, root: RootField, path: readonly PropertyKey[]): Type[] {
	const [head, ...rest] = path;
	if (typeof head !== "string") return [];
	const body = bodyOf(root);
	let type: Type | undefined = root.operation.parameters.parameters.find(
		(parameter) => parameter.name === head,
	)?.param.type;
	if (type === undefined && body !== undefined) {
		if (body.key === head) type = body.type;
		else if (body.key === undefined && body.type.kind === "Model") {
			type = fixture.walk
				.payloadOf(body.type, root.visibility)
				.find((property) => fixture.walk.wireName(property) === head)?.type;
		}
	}
	const chain: Type[] = [];
	for (let index = 0; type !== undefined; index += 1) {
		chain.push(type);
		const step = rest[index];
		if (step === undefined) break;
		if (type.kind === "Model" && isArrayModelType(type)) type = type.indexer.value;
		else if (type.kind === "Model" && typeof step === "string") {
			type = fixture.walk
				.payloadOf(type, root.visibility)
				.find((property) => fixture.walk.wireName(property) === step)?.type;
		} else if (type.kind === "Union") {
			const present = [...type.variants.values()]
				.map((variant) => variant.type)
				.filter((variant) => variant.kind !== "Intrinsic");
			type = present.length === 1 ? present[0] : undefined;
			index -= 1;
		} else type = undefined;
	}
	return chain;
}

// -------------------------------------------------------------------------------------------------
// What design.md § Results gives a declared response, restated.
// -------------------------------------------------------------------------------------------------

/** The status a handler answers to land on `arm`: its own code, or the first in its range nothing else claims. */
export function statusFor(arm: ResponseArm, arms: readonly ResponseArm[]): number | undefined {
	if (typeof arm.status === "number") return arm.status;
	if (arm.status === "default") return undefined;
	const start = Number(arm.status[0]) * 100;
	for (let status = start; status < start + 100; status += 1) {
		if (!arms.some((other) => other.status === status)) return status;
	}
	return undefined;
}

/** The TypeSpec body type a declared status carries, read from the HttpOperation. */
export function bodyTypeAt(operation: HttpOperation, status: number): Type | undefined {
	for (const response of operation.responses) {
		const codes = response.statusCodes;
		const matches =
			codes === "*"
				? false
				: typeof codes === "number"
					? codes === status
					: status >= codes.start && status <= codes.end;
		if (!matches) continue;
		const body = response.responses.find((content) => content.body !== undefined)?.body;
		return body?.type;
	}
	return undefined;
}

export const isSuccess = (status: number): boolean => status >= 200 && status < 300;
export const isMember = (status: number): boolean =>
	status >= 400 && status < 500 && ![401, 403, 429].includes(status);

/**
 * The GraphQL value design.md § Results gives one arm's body: the body itself where the field's
 * type is the body's (one success body on a query, or a model member), `true` where every success is
 * bodyless, and otherwise the wrapper named for the arm (`{ value, status }`, or `{ status }`).
 */
export function expectedFor(
	fixture: Fixture,
	root: RootField,
	status: number,
	parsed: unknown,
	arms: readonly ResponseArm[],
): unknown {
	const { walk } = fixture;
	const paging = root.kind === "query" ? pagingOf(fixture.program, root.operation) : undefined;
	const body = bodyTypeAt(root.operation, status);
	if (paging !== undefined && body !== undefined) {
		const page = parsed as Readonly<Record<string, unknown>>;
		const items = (page[walk.wireName(bodyPropertyNamed(body, paging.items))] ??
			[]) as readonly unknown[];
		return { nodes: items.map((item) => walk.output(paging.item, item)) };
	}
	const successes = arms.filter((arm) => typeof arm.status === "number" && isSuccess(arm.status));
	const bodies = new Set(successes.map((arm) => bodyTypeAt(root.operation, arm.status as number)));
	const isObjectBody =
		body !== undefined && body.kind === "Model" && !walk.isJson(body) && !isArray(body);
	if (root.kind === "query") {
		if ([...bodies].every((type) => type === undefined)) return true;
		if (bodies.size === 1 && body !== undefined) return walk.output(body, parsed);
	}
	if (isObjectBody) return walk.output(body, parsed);
	// design.md: a wrapper carries `value` for a body, and `success` (true for a 2xx) when there is none.
	return body === undefined ? { success: isSuccess(status) } : { value: walk.output(body, parsed) };
}

const isArray = (type: Type): boolean =>
	type.kind === "Model" && type.indexer !== undefined && type.indexer.key.name === "integer";

function bodyPropertyNamed(body: Type, name: string) {
	if (body.kind !== "Model") throw new Untranslatable("a page that is not a model");
	for (let model: typeof body | undefined = body; model !== undefined; model = model.baseModel) {
		const property = model.properties.get(name);
		if (property !== undefined) return property;
	}
	throw new Untranslatable(`no page property ${name}`);
}

/** A document calling one root field with every argument as a variable. */
export function documentFor(
	fixture: Fixture,
	root: RootField,
	args: Readonly<Record<string, unknown>>,
): { query: string; variables: Record<string, unknown> } {
	const field = fieldOf(fixture, root);
	const declared = new Map(field.args.map((arg) => [arg.name, arg.type] as const));
	const definitions: string[] = [];
	const passed: string[] = [];
	const variables: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(args)) {
		const type = declared.get(name);
		// An argument the schema lacks is sent as a literal, so the document fails validation and the
		// verdict records GraphQL refusing it.
		if (type === undefined) {
			passed.push(`${name}: ${JSON.stringify(value)}`);
			continue;
		}
		definitions.push(`$${name}: ${String(type)}`);
		passed.push(`${name}: $${name}`);
		variables[name] = value;
	}
	const operation = root.kind === "query" ? "query" : "mutation";
	const head = definitions.length === 0 ? operation : `${operation}(${definitions.join(", ")})`;
	const call = passed.length === 0 ? root.name : `${root.name}(${passed.join(", ")})`;
	return { query: `${head} { ${call} ${selectionOf(fixture.schema, field.type)} }`, variables };
}
