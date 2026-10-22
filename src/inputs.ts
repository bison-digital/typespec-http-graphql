import type { Program } from "@typespec/compiler";
import { getDeprecationDetails, getDoc } from "@typespec/compiler";
import {
	type HttpOperationParameter,
	resolveRequestVisibility,
	type Visibility,
} from "@typespec/http";
import {
	type ArgumentPlan,
	asNullable,
	type ConnectionPlan,
	type InputFieldPlan,
	named,
	type TypeRef,
} from "./model.js";
import { fieldNameOf, typeNameOf } from "./names.js";
import type { LinkField, RootField } from "./surface.js";
import { inputDeprecation, type TypeHint, type TypeProjector } from "./types.js";

/**
 * A field's arguments, a mutation's input object, and the headers that are HTTP mechanics rather
 * than arguments: `design.md` § Arguments and input.
 *
 * **Every wire key here is a key of the handler's merged input**, exactly as `typespec-http-zod`
 * declares its validators: a path, query, header or cookie parameter under its wire name (a header's
 * as declared, `If-None-Match`), a named body under `EmittedRoute.bodyProperty`, and a spread body's
 * properties under their JSON names. The resolver writes each argument back under its key, so the
 * handler receives what the REST route's handler receives.
 */

export interface FieldInputs {
	readonly arguments: readonly ArgumentPlan[];
	readonly supplied: Readonly<Record<string, string>>;
}

/**
 * What becomes of one parameter.
 *
 * - **A header whose type is one string literal is supplied by the resolver** (a `content-type` of
 *   `"application/merge-patch+json"`, a declared `accept`): it has one possible value, so asking a
 *   caller for it would be asking for nothing.
 * - **An optional header `@inputHeader` names is an argument** (an `Idempotency-Key`): it belongs to
 *   the one call it is sent with, which the `/graphql` request's own headers cannot say.
 * - **Any other optional header is omitted**, neither asked for nor supplied, whatever its name. A
 *   precondition (`If-None-Match`) would take a GraphQL read down the conditional 304 path, and a
 *   tracing or client header (`X-Request-Id`) is the caller's transport rather than an argument of
 *   the field; the operation can be called without either.
 * - **A required header that is not a single literal is an argument** (a required `If-Match`): the
 *   operation cannot be called without it.
 * - Every other parameter is an argument.
 */
export function dispositionOf(
	parameter: HttpOperationParameter,
	inputHeaders: ReadonlySet<string>,
): "argument" | "supplied" | "omitted" {
	// A cookie is transport state, as a header is: the /graphql request carries its own.
	if (parameter.type !== "header" && parameter.type !== "cookie") return "argument";
	if (parameter.param.type.kind === "String") return "supplied";
	if (parameter.param.optional) {
		return parameter.type === "header" && inputHeaders.has(parameter.param.name)
			? "argument"
			: "omitted";
	}
	return "argument";
}

/**
 * Every single-literal header, as wire key to value: the negotiated `accept` among them, since the
 * library selects an operation on a shared route only by an `accept` the operation declares as one.
 */
function suppliedOf(field: RootField | LinkField): Record<string, string> {
	const supplied: Record<string, string> = {};
	for (const parameter of field.operation.parameters.parameters) {
		if (
			dispositionOf(parameter, field.inputHeaders) === "supplied" &&
			parameter.param.type.kind === "String"
		) {
			supplied[parameter.name] = parameter.param.type.value;
		}
	}
	return supplied;
}

/**
 * What an anonymous type reached from this field is named after: `Books` for a root field,
 * `BookAuthor` for the link `author` on `Book`.
 */
function enclosingOf(field: RootField | LinkField, projector: TypeProjector): TypeHint {
	if ("bindings" in field) {
		const parent = projector.outputNameOf(field.parent) ?? typeNameOf(field.parent.name);
		return { name: `${parent}${typeNameOf(field.name)}`, owner: `link ${parent}.${field.name}` };
	}
	return { name: typeNameOf(field.name), owner: `${field.kind} ${field.name}` };
}

/** One parameter as an input field, under its wire name. Optional is nullable; a null is dropped. */
function parameterField(
	program: Program,
	parameter: HttpOperationParameter,
	projector: TypeProjector,
	visibility: Visibility,
	enclosing: TypeHint,
): InputFieldPlan {
	const type = projector.input(
		parameter.param.type,
		visibility,
		{
			name: `${enclosing.name}${typeNameOf(parameter.name)}`,
			owner: `${enclosing.owner}(${parameter.name})`,
		},
		parameter.param,
	);
	const fieldType = parameter.param.optional ? asNullable(type) : type;
	return {
		name: fieldNameOf(parameter.name),
		wire: parameter.name,
		type: fieldType,
		...inputDeprecation(
			fieldType,
			getDoc(program, parameter.param),
			getDeprecationDetails(program, parameter.param)?.message,
		),
		dropNull: parameter.param.optional && type.nonNull,
		nullIfAbsent: !parameter.param.optional && !type.nonNull,
		defaultValue: projector.defaultLiteralOf(parameter.param.defaultValue, fieldType),
	};
}

/**
 * The request body's contribution to the merged input, as input fields.
 *
 * **Where the library names the body** (`EmittedRoute.bodyProperty`, or `rawBodyProperty`), it is one
 * field under that key, of the body's input type, nullable where the document lets the body be
 * absent. **Otherwise the body is spread**: each property the request sends at its visibility is a
 * field of its own, under its JSON name, because that is what the handler's merged input holds.
 * Flattening is also Relay's mutation-input convention.
 */
function bodyFields(
	program: Program,
	field: RootField | LinkField,
	projector: TypeProjector,
	visibility: Visibility,
	enclosing: TypeHint,
): InputFieldPlan[] | "open" {
	const body = field.operation.parameters.body;
	if (body === undefined) return [];
	const key = field.route.bodyProperty ?? field.route.rawBodyProperty;
	if (key !== undefined) {
		const type = projector.input(
			body.type,
			visibility,
			{
				name: `${enclosing.name}${typeNameOf(key)}`,
				owner: `${enclosing.owner} body`,
			},
			body.property,
		);
		return [
			{
				name: fieldNameOf(key),
				wire: key,
				type: field.route.optionalBody ? asNullable(type) : type,
				description: body.property === undefined ? undefined : getDoc(program, body.property),
				deprecationReason: undefined,
				dropNull: field.route.optionalBody && type.nonNull,
				nullIfAbsent: !field.route.optionalBody && !type.nonNull,
				defaultValue: undefined,
			},
		];
	}
	// surface.ts refuses every other unnamed body: `non-json-request`, `non-object-body`.
	if (body.type.kind !== "Model")
		throw new Error(`${field.name}: an unnamed body that is no model`);
	if (projector.openSpreadBody(body.type, visibility)) return "open";
	return [...projector.inputFieldsOf(body.type, visibility, enclosing)];
}

/**
 * **The input of an operation whose spread body is open, as one `JSON` value merged as the input.**
 * The body's additional properties are keys of the handler's input itself, so no closed input type
 * can carry them; the value a client sends is the handler's wire input, keys as the wire spells them,
 * and the operation's Zod schema validates it, as for every `JSON` position.
 */
const OPEN_INPUT: ArgumentPlan = {
	name: "input",
	wire: "input",
	type: named("JSON", true),
	description:
		"The operation's whole input, as the HTTP request carries it: its body is open, so no GraphQL input type can state it.",
	deprecationReason: undefined,
	dropNull: false,
	nullIfAbsent: false,
	defaultValue: undefined,
	merge: true,
};

/** An input field as an argument of its own, keeping its key, null rules, deprecation and default. */
function argumentOf(input: InputFieldPlan): ArgumentPlan {
	return {
		name: input.name,
		wire: input.wire,
		type: input.type,
		description: input.description,
		deprecationReason: input.deprecationReason,
		dropNull: input.dropNull,
		nullIfAbsent: input.nullIfAbsent,
		defaultValue: input.defaultValue,
		merge: false,
	};
}

/**
 * `first` or `after`, writing the key of the paging parameter it replaces, with that parameter's doc
 * and null rule: a null `first` is an absent page size, as Relay means it, where the size is optional.
 */
function pagingArgument(
	paging: InputFieldPlan,
	name: "first" | "after",
	wire: string,
	type: TypeRef,
): ArgumentPlan {
	return {
		name,
		wire,
		type,
		description: paging.description,
		deprecationReason: paging.deprecationReason,
		dropNull: paging.dropNull,
		nullIfAbsent: false,
		// `first` keeps the page size's default; `after` is a cursor, which has none.
		defaultValue: name === "first" ? paging.defaultValue : undefined,
		merge: false,
	};
}

/** Arguments of a query field or a link: every parameter not bound, not supplied, not paging (when a connection). */
export function queryInputsOf(
	program: Program,
	field: RootField | LinkField,
	projector: TypeProjector,
	connection: ConnectionPlan | undefined,
): FieldInputs {
	const operation = field.operation;
	const visibility = resolveRequestVisibility(program, operation.operation, operation.verb);
	const enclosing = enclosingOf(field, projector);
	const bound =
		"bindings" in field
			? new Set(field.bindings.map((binding) => binding.wire))
			: new Set<string>();
	const paging =
		connection === undefined ? new Set<string>() : new Set([connection.first, connection.after]);
	const args: ArgumentPlan[] = [];
	if (connection !== undefined) {
		/**
		 * **Relay's names, filling the operation's own paging parameters.** `first` writes the
		 * `@pageSize` parameter's key and `after` the request `@continuationToken`'s, so the size's
		 * default and `@maxValue` stay the operation's Zod schema's to enforce.
		 */
		const replaced = (wire: string): InputFieldPlan => {
			const parameter = operation.parameters.parameters.find(
				(candidate) => candidate.name === wire,
			);
			// connections.ts names a paging parameter only by the key of one it found here.
			if (parameter === undefined) throw new Error(`${field.name}: no paging parameter ${wire}`);
			return parameterField(program, parameter, projector, visibility, enclosing);
		};
		args.push(
			pagingArgument(replaced(connection.first), "first", connection.first, named("Int", false)),
		);
		args.push({
			...pagingArgument(
				replaced(connection.after),
				"after",
				connection.after,
				named("String", false),
			),
			description:
				"An opaque cursor from this connection, an edge's or `pageInfo.endCursor`: the items after it.",
		});
	}
	for (const parameter of operation.parameters.parameters) {
		if (bound.has(parameter.name) || paging.has(parameter.name)) continue;
		if (dispositionOf(parameter, field.inputHeaders) !== "argument") continue;
		args.push(argumentOf(parameterField(program, parameter, projector, visibility, enclosing)));
	}
	// A query field over a POST search takes its body as arguments, by the same placement rule.
	const body = bodyFields(program, field, projector, visibility, enclosing);
	if (body === "open") return { arguments: [OPEN_INPUT], supplied: suppliedOf(field) };
	for (const input of body) args.push(argumentOf(input));
	return { arguments: args, supplied: suppliedOf(field) };
}

/**
 * The `input: <Name>Input!` argument of a mutation, registering the input TypeDef.
 *
 * **Relay's single input, which IS the handler's merged input**: the argument is `merge: true`, so
 * the resolver merges its converted fields into the input root rather than under a key, and its
 * `wire` is unused.
 */
export function mutationInputsOf(
	program: Program,
	field: RootField,
	projector: TypeProjector,
): FieldInputs {
	const operation = field.operation;
	const visibility = resolveRequestVisibility(program, operation.operation, operation.verb);
	const enclosing = enclosingOf(field, projector);
	const fields: InputFieldPlan[] = [];
	for (const parameter of operation.parameters.parameters) {
		if (dispositionOf(parameter, field.inputHeaders) !== "argument") continue;
		fields.push(parameterField(program, parameter, projector, visibility, enclosing));
	}
	const body = bodyFields(program, field, projector, visibility, enclosing);
	const supplied = suppliedOf(field);
	if (body === "open") return { arguments: [OPEN_INPUT], supplied };
	fields.push(...body);
	if (fields.length === 0) return { arguments: [], supplied };
	const name = `${enclosing.name}Input`;
	projector.define({ kind: "input", name, description: undefined, fields });
	return {
		arguments: [
			{
				name: "input",
				wire: "input",
				type: named(name, true),
				description: undefined,
				deprecationReason: undefined,
				dropNull: false,
				nullIfAbsent: false,
				defaultValue: undefined,
				merge: true,
			},
		],
		supplied,
	};
}
