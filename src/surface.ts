import {
	type DiagnosticTarget,
	getDiscriminator,
	getMaxItems,
	isArrayModelType,
	isList,
	isNullType,
	type Model,
	type ModelProperty,
	type NoTarget,
	type Operation,
	type Program,
	resolveEncodedName,
	type Type,
	walkPropertiesInherited,
} from "@typespec/compiler";
import { $ } from "@typespec/compiler/typekit";
import {
	createMetadataInfo,
	type HttpOperation,
	type HttpOperationParameter,
	Visibility,
} from "@typespec/http";
import {
	type EmittedRoute,
	type EmittedService,
	isJsonMediaType,
	resultMembersOf,
	type RouteSchemaNames,
} from "typespec-http-zod";
import {
	inputHeaderDeclarationsOf,
	type LinkDeclaration,
	linkDeclarationsOf,
	type RootDeclaration,
	rootDeclarationsOf,
} from "./decorators.js";
import { fieldNameOf, isGraphQLName } from "./names.js";

/**
 * **The declared GraphQL surface of one service, checked.**
 *
 * The decorators record and check nothing, so every check on a declaration is made here, and only
 * when this emitter runs. A failed check DROPS the declaration and says why, as a warning: the
 * operation is still served over HTTP, and an error would cost a consumer their OpenAPI document.
 *
 * **Every declaration this service owns ends up in exactly one place**: `roots`, `links` or
 * `dropped`. `roots + links + dropped === declared` is what makes a silent drop arithmetically
 * impossible, and the emitter asserts it.
 *
 * Checked here: everything in `design.md` § "Checks on a declaration" except
 * `link-target-unreachable`, which needs to know which types the schema reaches and is decided when
 * the schema is planned.
 */

/** What every field a declaration makes carries, beside what it calls. */
export interface FieldDeclared {
	/** The field's description from `graphql.tsp`, in place of the operation's doc comment. */
	readonly description: string | undefined;
	/**
	 * The operation's optional headers `@inputHeader` takes as input, by TypeSpec name: arguments of
	 * a query field or link, fields of a mutation's input.
	 */
	readonly inputHeaders: ReadonlySet<string>;
}

export interface RootField extends FieldDeclared {
	readonly kind: "query" | "mutation";
	readonly name: string;
	readonly route: EmittedRoute;
	readonly names: RouteSchemaNames;
	readonly operation: HttpOperation;
	readonly node: DiagnosticTarget;
}

export interface LinkBinding {
	/** The operation's parameter, by its TypeSpec name. */
	readonly parameter: string;
	/** Its key in the handler's merged input: the validator key, which is the parameter's wire name. */
	readonly wire: string;
	readonly property: ModelProperty;
	/** The parent's JSON wire key (`resolveEncodedName`, "application/json"). */
	readonly parentWire: string;
	/**
	 * **The property is a list of values the parameter accepts**: the link calls the operation once
	 * per value and is a list field. At most one binding of a link is one.
	 */
	readonly list: boolean;
}

export interface LinkField extends FieldDeclared {
	readonly parent: Model;
	readonly name: string;
	readonly route: EmittedRoute;
	readonly names: RouteSchemaNames;
	readonly operation: HttpOperation;
	readonly bindings: readonly LinkBinding[];
	/**
	 * Where a binding is a list, the list's `@maxItems`: the most calls one parent's field makes, which
	 * its cost directives state. `undefined` for a link bound to no list.
	 */
	readonly maxItems: number | undefined;
	readonly node: DiagnosticTarget;
}

export interface SurfaceDiagnostic {
	/** One of the codes `lib.ts` declares, without the library prefix. */
	readonly code: string;
	readonly target: DiagnosticTarget | typeof NoTarget;
	readonly format: Readonly<Record<string, string>>;
}

export interface Surface {
	readonly roots: readonly RootField[];
	readonly links: readonly LinkField[];
	/** Declarations dropped, each with the diagnostic that says why. */
	readonly dropped: readonly SurfaceDiagnostic[];
	/**
	 * Warnings on declarations that are still emitted (query-not-safe), and on `@inputHeader`s that
	 * change nothing (input-header-ignored).
	 */
	readonly warnings: readonly SurfaceDiagnostic[];
	/** Root and link declarations this service owns, before any check. */
	readonly declared: number;
}

/** What a failed check reports, before it is pointed at the declaration that failed it. */
interface Failure {
	readonly code: string;
	readonly format: Readonly<Record<string, string>>;
}

/** An operation of this service, with everything the library published about it. */
interface Owned {
	readonly operationId: string;
	readonly route: EmittedRoute;
	readonly names: RouteSchemaNames;
	readonly operation: HttpOperation;
}

/**
 * **The operations `emitted` serves, keyed by the TypeSpec operation itself.**
 *
 * By identity, never by name: a name is not unique across interfaces, and the library keys its own
 * maps by operation id for the same reason. A declaration whose operation is not here belongs to
 * another service, and is that service's to check and to count.
 */
function ownedOperations(emitted: EmittedService): ReadonlyMap<Operation, Owned> {
	const owned = new Map<Operation, Owned>();
	for (const [operationId, operation] of emitted.operations) {
		const route = emitted.routes.find((candidate) => candidate.operationId === operationId);
		const names = emitted.schemaNames.get(operationId);
		if (route === undefined || names === undefined) {
			throw new Error(
				`typespec-http-zod published '${operationId}' without its route or schema names.`,
			);
		}
		owned.set(operation.operation, { operationId, route, names, operation });
	}
	return owned;
}

/** A multipart body is parts, one of which is usually a file: no JSON value carries it. */
function isMultipart(contentType: string): boolean {
	return (contentType.split(";")[0]?.trim().toLowerCase() ?? "").startsWith("multipart/");
}

/**
 * What a body that cannot be merged is, for the message: why it has no properties to merge.
 * `undefined` where it can be merged.
 *
 * **The rule `typespec-http-mcp` refuses a tool's body by**, reimplemented here. An array is a
 * model with an integer-keyed indexer. A model carrying `@discriminator` is validated as a union of
 * its variants, with no single set of properties. A typed index signature beside declared keys
 * would lose its value type in the merge; an `unknown`-valued one is ordinary openness and merges.
 */
function unmergeableBodyOf(program: Program, type: Type | undefined): string | undefined {
	if (type === undefined) return undefined;
	if (type.kind === "Scalar") return `the scalar '${type.name}'`;
	if (type.kind !== "Model") return `a ${type.kind.toLowerCase()}`;
	if (type.indexer?.key?.name === "integer") return "an array";
	if (getDiscriminator(program, type) !== undefined) {
		return `the discriminated union '${type.name}'`;
	}
	for (let model: Model | undefined = type; model !== undefined; model = model.baseModel) {
		const indexer = model.indexer;
		if (indexer?.key?.name === "string" && indexer.value?.kind !== "Intrinsic") {
			return "a model with a typed index signature";
		}
	}
	return undefined;
}

/** A served member that is not JSON, as a message names it: what it is, and its media type. */
function nonJsonMemberOf(
	member: ReturnType<typeof resultMembersOf>[number] & { readonly mediaType: string },
): string {
	const kind =
		member.serving === "stream"
			? "a stream"
			: member.serving === "binary"
				? "bytes"
				: member.serving === "none"
					? "parts"
					: "text";
	return `${kind} as ${member.mediaType}`;
}

/**
 * **Whether a GraphQL field can call this operation at all**: not HEAD, a JSON request whose body
 * can be merged into one input, and responses that are JSON in every media type they offer. The rules `typespec-http-mcp` refuses a tool
 * by, reimplemented here because a tool argument and a GraphQL argument are both JSON, and never
 * imported from a sibling.
 */
function servabilityOf(program: Program, owned: Owned): Failure | undefined {
	const { operationId, route } = owned;
	if (route.verb === "HEAD") return { code: "head-operation", format: { operationId } };

	/**
	 * **Two inputs the handler's input carries under one key**, as the library reads them from the
	 * facts it renders the input from (`EmittedRoute.sharedInputKeys`): a GraphQL field could pass
	 * only one. The library warns `shared-input-key` too; this warning states this emitter's own
	 * consequence, that the declaration is dropped.
	 */
	const [shared] = route.sharedInputKeys;
	if (shared !== undefined) {
		return {
			code: "shared-input-key",
			format: { operationId, name: shared.key, locations: `${shared.first} and ${shared.second}` },
		};
	}

	const types = route.requestContentTypes;
	/**
	 * A raw body is handed to the handler unparsed: the bytes a signature covers, a file, or text
	 * under a media type nothing parses. A GraphQL argument is a JSON value, so it cannot be any of
	 * them, whatever media type the body is declared under.
	 */
	if (route.rawBodyProperty !== undefined) {
		const raw = route.rawBodyBinary ? "raw bytes" : "raw text";
		return {
			code: "non-json-request",
			format: { operationId, types: types.length === 0 ? raw : `${raw} as ${types.join(", ")}` },
		};
	}
	/**
	 * Multipart, or only media types that are not JSON. Where JSON is declared beside another type,
	 * the resolver sends JSON and the other is simply unreachable from GraphQL, which is no defect.
	 */
	if (types.some(isMultipart) || (types.length > 0 && !types.some(isJsonMediaType))) {
		return { code: "non-json-request", format: { operationId, types: types.join(", ") } };
	}
	/**
	 * **A body the library NAMED is one field of the input, whatever its type**, so only an unnamed
	 * body has to be mergeable. Measured on `typespec-http-zod` 0.28: it names a scalar, array,
	 * union, enum, record or typed-index `@bodyRoot` body, and leaves a plain or a discriminated
	 * model unnamed, so of the bodies refused here only a discriminated model reaches this today.
	 * The rest are checked anyway, so a library that stopped naming them is refused, not merged.
	 */
	if (route.bodyProperty === undefined) {
		const unmergeable = unmergeableBodyOf(program, owned.operation.parameters.body?.type);
		if (unmergeable !== undefined) {
			return { code: "non-object-body", format: { operationId, types: unmergeable } };
		}
	}

	/**
	 * **Every member of every response with a body must be served as JSON**, not merely one of them.
	 *
	 * Unlike a request, where the resolver chooses JSON and an alternative simply goes unused, a
	 * response is the HANDLER's choice. The handler's result type is the server's, member for member,
	 * so a status offering JSON and `application/octet-stream` (or an event stream) lets the handler
	 * return the bytes, and no GraphQL type can project them. The renderer treats a non-JSON member as
	 * an invariant broken, so the operation is refused here, where it can be said why.
	 *
	 * Read off the library's own members rather than re-derived, so a stream, raw bytes and a body
	 * under a non-JSON type are decided exactly as every server built on it decides them.
	 */
	const members = resultMembersOf(route.responses, (response) => response.schema !== undefined);
	for (const [index, response] of route.responses.entries()) {
		// A member with a media type has a body, a schema or not (parts have none). The library lists
		// none for a body declared `void`, as `@typespec/openapi3` publishes it with no content.
		const refused = members.filter(
			(member): member is typeof member & { readonly mediaType: string } =>
				member.index === index && member.mediaType !== undefined && member.serving !== "json",
		);
		if (refused.length === 0) continue;
		return {
			code: "non-json-response",
			format: {
				operationId,
				status: String(response.status),
				types: refused.map(nonJsonMemberOf).join(", "),
			},
		};
	}
	return undefined;
}

/** A property's type with `null` removed: the link resolves to `null` itself rather than calling. */
function nonNullVariantsOf(type: Type): readonly Type[] {
	if (type.kind !== "Union") return [type];
	return [...type.variants.values()]
		.map((variant) => variant.type)
		.filter((variant) => !isNullType(variant));
}

/** The parameters a link may fill: path, query, header and cookie. A body property is not one. */
function bindableParameterOf(
	operation: HttpOperation,
	name: string,
): HttpOperationParameter | undefined {
	return operation.parameters.parameters.find((parameter) => parameter.param.name === name);
}

function propertyOf(model: Model, name: string): ModelProperty | undefined {
	for (const property of walkPropertiesInherited(model)) {
		if (property.name === name) return property;
	}
	return undefined;
}

/** How a link reads in a message: its parent and its name, as `graphql.tsp` wrote them. */
function linkLabel(declaration: LinkDeclaration): string {
	return `${declaration.parent.name}.${declaration.name}`;
}

/**
 * **The types a parameter accepts a bound value of: its own, and each scalar it extends.** A
 * parameter that narrows its type (`@pattern(...) scalar CheckedId extends string`) is filled from a
 * property of the type it narrows, `string`, as a constraint on the parameter itself would be: the
 * operation's Zod schema checks the value at call time, and refuses one that breaks it as
 * `BAD_USER_INPUT` at the link, as it refuses any other input.
 */
function acceptedTypesOf(type: Type): readonly Type[] {
	const accepted: Type[] = [type];
	for (
		let scalar = type.kind === "Scalar" ? type.baseScalar : undefined;
		scalar !== undefined;
		scalar = scalar.baseScalar
	) {
		accepted.push(scalar);
	}
	return accepted;
}

/** A property's list, and the type of its items, where its one non-null variant is an array. */
function boundListOf(type: Type): { readonly array: Type; readonly items: Type } | undefined {
	const [only, ...others] = nonNullVariantsOf(type);
	if (only === undefined || others.length > 0) return undefined;
	if (only.kind !== "Model" || !isArrayModelType(only)) return undefined;
	return { array: only, items: only.indexer.value };
}

/** A link that failed a check, or the bindings of one that passed them all. */
type LinkCheck =
	| { readonly failure: Failure }
	| { readonly bindings: readonly LinkBinding[]; readonly maxItems: number | undefined };

/**
 * The checks on a link, in order, after its name: safety, servability, then its bindings. The
 * bindings are checked by kind, every parameter before any property, so the diagnostic names the
 * first thing to fix rather than whichever binding happened to be written first.
 */
function checkLink(program: Program, declaration: LinkDeclaration, owned: Owned): LinkCheck {
	const link = linkLabel(declaration);
	const { operationId, route, operation } = owned;
	if (route.verb !== "GET") {
		return { failure: { code: "link-not-safe", format: { link, operationId, verb: route.verb } } };
	}
	const unservable = servabilityOf(program, owned);
	if (unservable !== undefined) return { failure: unservable };

	const entries = Object.entries(declaration.parameters);
	for (const [parameter] of entries) {
		if (bindableParameterOf(operation, parameter) === undefined) {
			return {
				failure: { code: "unknown-link-parameter", format: { link, parameter, operationId } },
			};
		}
	}
	for (const [, property] of entries) {
		if (propertyOf(declaration.parent, property) === undefined) {
			return {
				failure: {
					code: "unknown-link-property",
					format: { link, property, model: declaration.parent.name },
				},
			};
		}
	}
	const bindings: LinkBinding[] = [];
	let maxItems: number | undefined;
	for (const [parameterName, propertyName] of entries) {
		const parameter = bindableParameterOf(operation, parameterName);
		const property = propertyOf(declaration.parent, propertyName);
		if (parameter === undefined || property === undefined) continue;
		/**
		 * **The parent value is the READ body**, so a bound property that body never carries, being
		 * visible only on create or update, or an HTTP header, would leave the link `null` on every
		 * request. Refused here, by the same payload rule the library builds the read schema with.
		 */
		if (!createMetadataInfo(program).isPayloadProperty(property, Visibility.Read)) {
			return {
				failure: {
					code: "link-property-unreadable",
					format: { link, property: propertyName, model: declaration.parent.name },
				},
			};
		}
		/**
		 * **Assignability is the compiler's own relation**, the one it checks a decorator argument or
		 * a property override with, so `int32` fills an `int64` parameter and a `string` does not, to
		 * the parameter's type or to a scalar it extends (`acceptedTypesOf`). Each non-null variant
		 * must be assignable, which is the rule for the union as a whole.
		 */
		const accepted = acceptedTypesOf(parameter.param.type);
		const accepts = (type: Type): boolean =>
			nonNullVariantsOf(type).every((variant) =>
				accepted.some((target) => $(program).type.isAssignableTo(variant, target)),
			);
		const list = accepts(property.type) ? undefined : boundListOf(property.type);
		if (list === undefined ? !accepts(property.type) : !accepts(list.items)) {
			return {
				failure: {
					code: "link-type-mismatch",
					format: { link, parameter: parameterName, property: propertyName },
				},
			};
		}
		if (list !== undefined) {
			const failure = listFailureOf(program, declaration, bindings, list.array, property, owned);
			if (failure !== undefined) return { failure };
			maxItems = getMaxItems(program, property) ?? getMaxItems(program, list.array);
		}
		bindings.push({
			parameter: parameterName,
			wire: parameter.name,
			property,
			parentWire: resolveEncodedName(program, property, "application/json"),
			list: list !== undefined,
		});
	}
	return { bindings, maxItems };
}

/**
 * **Why a list cannot bind this link**, or `undefined` where it can. One list per link, so a field
 * is one list rather than the product of two; an operation that is no `@list` page, so each value
 * is one item rather than a page of them; and an `@maxItems`, so the calls one parent's field makes
 * have a bound the response validator holds the parent to and the cost directives can state.
 */
function listFailureOf(
	program: Program,
	declaration: LinkDeclaration,
	bindings: readonly LinkBinding[],
	array: Type,
	property: ModelProperty,
	owned: Owned,
): Failure | undefined {
	const link = linkLabel(declaration);
	const other = bindings.find((binding) => binding.list);
	if (other !== undefined) {
		return {
			code: "link-list-not-bindable",
			format: {
				link,
				property: property.name,
				reason: `it already binds the list '${other.property.name}'`,
			},
		};
	}
	if (isList(program, owned.operation.operation)) {
		return {
			code: "link-list-not-bindable",
			format: {
				link,
				property: property.name,
				reason: `'${owned.operationId}' answers a page, and a field cannot be a list of pages`,
			},
		};
	}
	if (getMaxItems(program, property) === undefined && getMaxItems(program, array) === undefined) {
		return { code: "link-list-unbounded", format: { link, property: property.name } };
	}
	return undefined;
}

/**
 * **Why an `@inputHeader` naming `parameter` changes nothing**, or `undefined` where it names an
 * optional header, of one value or more, which it takes as input.
 */
function inputHeaderIgnoredBecause(
	parameter: HttpOperationParameter | undefined,
): string | undefined {
	if (parameter === undefined) return "is not a parameter of it";
	if (parameter.type !== "header") return `is a ${parameter.type} parameter, not a header`;
	if (parameter.param.type.kind === "String") {
		return "has one literal value, which the resolver supplies";
	}
	if (!parameter.param.optional) return "is a required header, which is input already";
	return undefined;
}

/** The declarations whose operation belongs to `emitted`'s service, checked. */
export function surfaceOf(program: Program, emitted: EmittedService): Surface {
	const owned = ownedOperations(emitted);
	const dropped: SurfaceDiagnostic[] = [];
	const warnings: SurfaceDiagnostic[] = [];
	const drop = (node: DiagnosticTarget, failure: Failure): void => {
		dropped.push({ code: failure.code, target: node, format: failure.format });
	};

	const rootDeclarations = rootDeclarationsOf(program).filter((declaration) =>
		owned.has(declaration.operation),
	);
	const linkDeclarations = linkDeclarationsOf(program).filter((declaration) =>
		owned.has(declaration.operation),
	);

	// ---- @inputHeader: each names an optional header of its operation, or changes nothing. ----

	/**
	 * **An `@inputHeader` names an optional header, of one value or more, of its operation.** Anything
	 * else is already decided: a required header is an argument, a header of one literal is supplied,
	 * and a query, path or cookie parameter is no header the `/graphql` request could carry. Warned,
	 * not dropped: no field depends on it.
	 */
	const inputHeaders = new Map<Operation, Set<string>>();
	for (const declaration of inputHeaderDeclarationsOf(program)) {
		const operation = owned.get(declaration.operation);
		if (operation === undefined) continue;
		const reason = inputHeaderIgnoredBecause(
			bindableParameterOf(operation.operation, declaration.parameter),
		);
		if (reason !== undefined) {
			warnings.push({
				code: "input-header-ignored",
				target: declaration.node,
				format: { parameter: declaration.parameter, operationId: operation.operationId, reason },
			});
			continue;
		}
		const taken = inputHeaders.get(declaration.operation) ?? new Set<string>();
		taken.add(declaration.parameter);
		inputHeaders.set(declaration.operation, taken);
	}
	const declaredFor = (
		operation: HttpOperation,
		description: string | undefined,
	): FieldDeclared => ({
		description,
		inputHeaders: inputHeaders.get(operation.operation) ?? new Set(),
	});

	// ---- Root fields: name, servability, declared twice, collisions, then the safety warning. ----

	/**
	 * **The first declaration of an operation is the one kept**, whatever happens to it: a second
	 * declaration is reported as `declared-twice` even where the first failed another check, because
	 * both statements are in `graphql.tsp` and both are worth fixing.
	 */
	const firstDeclaration = new Map<Operation, RootDeclaration>();
	for (const declaration of rootDeclarations) {
		if (!firstDeclaration.has(declaration.operation)) {
			firstDeclaration.set(declaration.operation, declaration);
		}
	}

	const candidates: (RootDeclaration & { readonly owned: Owned })[] = [];
	for (const declaration of rootDeclarations) {
		const operation = owned.get(declaration.operation);
		if (operation === undefined) continue;
		const { operationId } = operation;
		if (!isGraphQLName(declaration.name)) {
			const decorator = declaration.kind === "query" ? "@queryField" : "@mutationField";
			drop(declaration.node, {
				code: "invalid-graphql-name",
				format: { name: declaration.name, declaration: `${decorator} on '${operationId}'` },
			});
			continue;
		}
		const unservable = servabilityOf(program, operation);
		if (unservable !== undefined) {
			drop(declaration.node, unservable);
			continue;
		}
		if (firstDeclaration.get(declaration.operation) !== declaration) {
			drop(declaration.node, { code: "declared-twice", format: { operationId } });
			continue;
		}
		candidates.push({ ...declaration, owned: operation });
	}

	/**
	 * **Per root type.** `Query.thing` and `Mutation.thing` are two fields and no collision; two
	 * `Query.thing` are, and every party is dropped rather than one chosen by declaration order.
	 */
	const roots: RootField[] = [];
	for (const candidate of candidates) {
		const parties = candidates.filter(
			(other) => other.kind === candidate.kind && other.name === candidate.name,
		);
		const first = parties[0];
		if (parties.length > 1 && first !== undefined) {
			const second = candidate === first ? parties[1] : candidate;
			drop(candidate.node, {
				code: "graphql-name-collision",
				format: {
					name: candidate.name,
					first: first.owned.operationId,
					second: second?.owned.operationId ?? candidate.owned.operationId,
				},
			});
			continue;
		}
		if (candidate.kind === "query" && candidate.owned.route.verb !== "GET") {
			warnings.push({
				code: "query-not-safe",
				target: candidate.node,
				format: {
					name: candidate.name,
					operationId: candidate.owned.operationId,
					verb: candidate.owned.route.verb,
				},
			});
		}
		roots.push({
			kind: candidate.kind,
			name: candidate.name,
			route: candidate.owned.route,
			names: candidate.owned.names,
			operation: candidate.owned.operation,
			...declaredFor(candidate.owned.operation, candidate.description),
			node: candidate.node,
		});
	}

	// ---- Links: name, safety, servability, bindings, then collisions. ----

	const checkedLinks: (LinkDeclaration & {
		readonly owned: Owned;
		readonly bindings: readonly LinkBinding[];
		readonly maxItems: number | undefined;
	})[] = [];
	for (const declaration of linkDeclarations) {
		const operation = owned.get(declaration.operation);
		if (operation === undefined) continue;
		if (!isGraphQLName(declaration.name)) {
			drop(declaration.node, {
				code: "invalid-graphql-name",
				format: { name: declaration.name, declaration: `@link on '${declaration.parent.name}'` },
			});
			continue;
		}
		const checked = checkLink(program, declaration, operation);
		if ("failure" in checked) {
			drop(declaration.node, checked.failure);
			continue;
		}
		checkedLinks.push({
			...declaration,
			owned: operation,
			bindings: checked.bindings,
			maxItems: checked.maxItems,
		});
	}

	/**
	 * **A link is one more field of its parent's type**, so it collides with another link of that
	 * parent by name, and with any property whose GraphQL name (`fieldNameOf` of its JSON wire name)
	 * is the link's. Every property is counted, whatever its visibility: which properties reach the
	 * output type is decided later, and a link that shadowed one would change meaning with it.
	 */
	const links: LinkField[] = [];
	for (const link of checkedLinks) {
		const parties = checkedLinks.filter(
			(other) => other.parent === link.parent && other.name === link.name,
		);
		const first = parties[0];
		if (parties.length > 1 && first !== undefined) {
			const second = link === first ? parties[1] : link;
			drop(link.node, {
				code: "graphql-name-collision",
				format: {
					name: link.name,
					first: `${linkLabel(first)} -> ${first.owned.operationId}`,
					second: `${linkLabel(second ?? link)} -> ${(second ?? link).owned.operationId}`,
				},
			});
			continue;
		}
		const shadowed = [...walkPropertiesInherited(link.parent)].find(
			(property) =>
				fieldNameOf(resolveEncodedName(program, property, "application/json")) === link.name,
		);
		if (shadowed !== undefined) {
			drop(link.node, {
				code: "graphql-name-collision",
				format: {
					name: link.name,
					first: `${link.parent.name}.${shadowed.name}`,
					second: `${linkLabel(link)} -> ${link.owned.operationId}`,
				},
			});
			continue;
		}
		links.push({
			parent: link.parent,
			name: link.name,
			route: link.owned.route,
			names: link.owned.names,
			operation: link.owned.operation,
			bindings: link.bindings,
			maxItems: link.maxItems,
			...declaredFor(link.owned.operation, link.description),
			node: link.node,
		});
	}

	return {
		roots,
		links,
		dropped,
		warnings,
		declared: rootDeclarations.length + linkDeclarations.length,
	};
}
