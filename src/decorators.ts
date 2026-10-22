import type {
	DecoratorContext,
	DiagnosticTarget,
	Enum,
	Model,
	ModelProperty,
	Operation,
	Program,
	Scalar,
	Type,
	Union,
} from "@typespec/compiler";
import { GraphQLKeys } from "./lib.js";

/**
 * The decorators that declare a GraphQL surface, and the accessors that read what they recorded.
 *
 * **They record, and check nothing.** A decorator runs whenever the spec compiles, for every
 * emitter: a check made here would stop `@typespec/openapi3` writing its document over a GraphQL
 * name. Every check is made by `surface.ts`, which runs only when this emitter does, and fails a
 * declaration with a warning that drops it.
 *
 * **Recorded once per application, never de-duplicated.** An operation named twice as a root field
 * is a mistake `surface.ts` reports as `declared-twice`, and it can only see it if both applications
 * were kept. A set keyed by the operation would have silently kept one.
 */

/** What `FieldOptions` arrives as: the plain object the spec wrote. */
export interface FieldOptions {
	readonly description?: string;
}

/** One `@queryField` or `@mutationField` application. */
export interface RootDeclaration {
	readonly kind: "query" | "mutation";
	readonly name: string;
	readonly operation: Operation;
	/** The field's own description, in place of the operation's, where `graphql.tsp` gives one. */
	readonly description: string | undefined;
	readonly node: DiagnosticTarget;
}

/** One `@link` application. */
export interface LinkDeclaration {
	readonly parent: Model;
	readonly name: string;
	readonly operation: Operation;
	/** Parameter name → property name, both as written in TypeSpec. */
	readonly parameters: Readonly<Record<string, string>>;
	/** The field's own description, in place of the operation's, where `graphql.tsp` gives one. */
	readonly description: string | undefined;
	readonly node: DiagnosticTarget;
}

/** One `@inputHeader` application: an operation's optional header, taken as input. */
export interface InputHeaderDeclaration {
	readonly operation: Operation;
	/** The header parameter, named as TypeSpec declares it. */
	readonly parameter: string;
	readonly node: DiagnosticTarget;
}

/** One `@json` application: a projection as `JSON` the spec accepts. */
export interface JsonDeclaration {
	readonly target: ModelProperty | Model | Union | Enum | Scalar;
	readonly node: DiagnosticTarget;
}

/**
 * Append one application under its decorated type.
 *
 * **Keyed by the decorated type, as TypeSpec's own state is**, with every application to that type
 * kept in an array. The compiler applies all of a type's decorators, augments included, when it
 * checks that type, so one type's applications are contiguous and the flattened map is the order
 * they were applied in.
 */
function record<T>(program: Program, key: symbol, target: Type, declaration: T): void {
	const state = program.stateMap(key);
	const existing = (state.get(target) as readonly T[] | undefined) ?? [];
	state.set(target, [...existing, declaration]);
}

function recorded<T>(program: Program, key: symbol): readonly T[] {
	return [...program.stateMap(key).values()].flatMap((entries) => entries as readonly T[]);
}

export const $queryField = (
	context: DecoratorContext,
	target: Operation,
	name: string,
	options?: FieldOptions,
): void => {
	record<RootDeclaration>(context.program, GraphQLKeys.roots, target, {
		kind: "query",
		name,
		operation: target,
		description: options?.description,
		node: context.decoratorTarget,
	});
};

export const $mutationField = (
	context: DecoratorContext,
	target: Operation,
	name: string,
	options?: FieldOptions,
): void => {
	record<RootDeclaration>(context.program, GraphQLKeys.roots, target, {
		kind: "mutation",
		name,
		operation: target,
		description: options?.description,
		node: context.decoratorTarget,
	});
};

/**
 * `parameters` arrives as the plain object the spec wrote (`#{ authorId: "author_id" }` is
 * `{ authorId: "author_id" }`), and absent when the operation needs nothing from the parent.
 */
export const $link = (
	context: DecoratorContext,
	target: Model,
	name: string,
	operation: Operation,
	parameters?: Record<string, string>,
	options?: FieldOptions,
): void => {
	record<LinkDeclaration>(context.program, GraphQLKeys.links, target, {
		parent: target,
		name,
		operation,
		parameters: parameters ?? {},
		description: options?.description,
		node: context.decoratorTarget,
	});
};

export const $inputHeader = (
	context: DecoratorContext,
	target: Operation,
	parameter: string,
): void => {
	record<InputHeaderDeclaration>(context.program, GraphQLKeys.inputHeaders, target, {
		operation: target,
		parameter,
		node: context.decoratorTarget,
	});
};

export const $json = (
	context: DecoratorContext,
	target: ModelProperty | Model | Union | Enum | Scalar,
): void => {
	record<JsonDeclaration>(context.program, GraphQLKeys.json, target, {
		target,
		node: context.decoratorTarget,
	});
};

/** Every root declaration, in application order. */
export function rootDeclarationsOf(program: Program): readonly RootDeclaration[] {
	return recorded<RootDeclaration>(program, GraphQLKeys.roots);
}

/** Every link declaration, in application order. */
export function linkDeclarationsOf(program: Program): readonly LinkDeclaration[] {
	return recorded<LinkDeclaration>(program, GraphQLKeys.links);
}

/** Every `@inputHeader` declaration, in application order. */
export function inputHeaderDeclarationsOf(program: Program): readonly InputHeaderDeclaration[] {
	return recorded<InputHeaderDeclaration>(program, GraphQLKeys.inputHeaders);
}

/** Every `@json` declaration, in application order. */
export function jsonDeclarationsOf(program: Program): readonly JsonDeclaration[] {
	return recorded<JsonDeclaration>(program, GraphQLKeys.json);
}
