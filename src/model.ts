import type { EmittedRoute, RouteSchemaNames, SecurityRequirement } from "typespec-http-zod";

/** A GraphQL type reference: a named type or a list, either possibly non-null. */
export type TypeRef =
	| { readonly kind: "named"; readonly name: string; readonly nonNull: boolean }
	| { readonly kind: "list"; readonly of: TypeRef; readonly nonNull: boolean };

/** A reference to one named type, never a list. */
export type NamedRef = Extract<TypeRef, { readonly kind: "named" }>;

export function named(name: string, nonNull: boolean): NamedRef {
	return { kind: "named", name, nonNull };
}
export function listOf(of: TypeRef, nonNull: boolean): TypeRef {
	return { kind: "list", of, nonNull };
}
export function asNullable(ref: TypeRef): TypeRef {
	return { ...ref, nonNull: false };
}

export type DirectiveArgument = string | number | boolean | readonly string[];

export interface AppliedDirective {
	readonly name: "cost" | "listSize";
	readonly arguments: Readonly<Record<string, DirectiveArgument>>;
}

/**
 * A TypeSpec default as the GraphQL literal it is: what `schema.graphql` prints after `=`, and the
 * `default.literal` graphql.gen.ts gives graphql-js, so introspection shows it too.
 */
export type DefaultLiteral =
	| { readonly kind: "INT" | "FLOAT" | "STRING" | "ENUM"; readonly value: string }
	| { readonly kind: "BOOLEAN"; readonly value: boolean }
	| { readonly kind: "NULL" };

export interface ArgumentPlan {
	readonly name: string;
	/** The key this argument fills in the handler's merged input. Unused when `merge` is set. */
	readonly wire: string;
	readonly type: TypeRef;
	readonly description: string | undefined;
	/** Set only where GraphQL allows it, a nullable argument; a required one carries it in `description`. */
	readonly deprecationReason: string | undefined;
	/** Optional and not `| null` in TypeSpec: an explicit GraphQL null is dropped, as an absent key. */
	readonly dropNull: boolean;
	/**
	 * Required and `| null` in TypeSpec: GraphQL cannot require a nullable input, so an absent one is
	 * written as the `null` the caller could not otherwise state.
	 */
	readonly nullIfAbsent: boolean;
	readonly defaultValue: DefaultLiteral | undefined;
	/** The argument's converted value IS the handler's merged input (a mutation's `input`), not one key of it. */
	readonly merge: boolean;
}

export interface InputFieldPlan {
	readonly name: string;
	readonly wire: string;
	readonly type: TypeRef;
	readonly description: string | undefined;
	readonly deprecationReason: string | undefined;
	/** Optional and not `| null` in TypeSpec: an explicit GraphQL null is dropped, as an absent key. */
	readonly dropNull: boolean;
	/** Required and `| null` in TypeSpec: an absent field is written as `null`. See `ArgumentPlan`. */
	readonly nullIfAbsent: boolean;
	readonly defaultValue: DefaultLiteral | undefined;
}

/** How one declared response arm becomes a GraphQL value. Keyed by the arm's StatusKey as a string. */
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

export interface ConnectionPlan {
	/** The wire key of the response's `@pageItems` array. */
	readonly items: string;
	/** The wire key of the response's `@continuationToken`. */
	readonly next: string;
	/** The wire keys `first` and `after` fill. */
	readonly first: string;
	readonly after: string;
	/**
	 * The item type, for naming: `<Item>Connection`, `<Item>Edge`. Always a named type: an edge's
	 * `node` is one item, never a list (Relay § 3.2), so a page of lists is no connection.
	 */
	readonly item: NamedRef;
	/**
	 * The largest page size the operation accepts, from its page size's `@maxValue` and
	 * `@maxValueExclusive` and those of the scalars its type extends; `undefined` where none is
	 * stated. Resuming partway into a page, the resolver asks for no more than this.
	 */
	readonly maximum: number | undefined;
	/**
	 * What bounds a page when `first` is absent and has no default: `maximum`.
	 * `@listSize(assumedSize:)`, so a cost analysis can bound an unsliced connection. Never beside a
	 * default, which the cost specification reads in its place (§8.2, §9.2.4).
	 */
	readonly assumedSize: number | undefined;
}

export interface CallPlan {
	readonly kind: "query" | "mutation" | "link";
	readonly operationId: string;
	readonly authentication: "none" | "optional" | "required";
	readonly security: readonly SecurityRequirement[];
	/** The const name of the merged Zod input schema in graphql.gen.ts (`<operationId>GraphQLInput`). */
	readonly inputSchema: string;
	/** RouteSchemaNames.responses: the arms const in schemas.gen.ts. */
	readonly responses: string;
	/**
	 * Link bindings: wire key in the handler input <- parent's wire key. `list` where the parent's
	 * value is a list, called once per item.
	 */
	readonly bound: readonly {
		readonly wire: string;
		readonly parent: string;
		readonly list?: true;
	}[];
	/** Keys the resolver supplies itself: the negotiated accept and single-literal headers. */
	readonly supplied: Readonly<Record<string, string>>;
	readonly projection: Readonly<Record<string, Projection>>;
	readonly connection: ConnectionPlan | undefined;
}

export interface OutputFieldPlan {
	readonly name: string;
	/** The key on the parent's wire value; equal to `name` unless the wire name is not GraphQL style. */
	readonly wire: string;
	readonly type: TypeRef;
	readonly description: string | undefined;
	readonly deprecationReason: string | undefined;
	readonly arguments: readonly ArgumentPlan[];
	readonly call: CallPlan | undefined;
	readonly directives: readonly AppliedDirective[];
}

/**
 * **How a `@discriminator` base resolves a value to an object type**: the discriminator's wire key,
 * the member each of its values names (or a nested base's own rule), and the base's own object type
 * for every other value.
 */
export interface BaseResolution {
	readonly property: string;
	readonly mapping: Readonly<Record<string, BaseMember>>;
	readonly base: string;
}

/**
 * **A subtype a discriminator value names, and the validator a value must pass to be it**: the
 * identifier `schemas.gen.ts` exports the subtype's validator under, as the library publishes it
 * (`EmittedService.typeSchemaNames`). A nested base carries its own rule beside its validator.
 */
export type BaseMember =
	| { readonly schema: string; readonly type: string }
	| { readonly schema: string; readonly rule: BaseResolution };

export type ResolveTypePlan =
	| {
			readonly kind: "discriminator";
			readonly property: string;
			readonly mapping: Readonly<Record<string, string>>;
	  }
	| { readonly kind: "member" };

export type TypeDef =
	| {
			readonly kind: "object";
			readonly name: string;
			readonly description: string | undefined;
			readonly fields: readonly OutputFieldPlan[];
			/** The interfaces it implements, by name, sorted. */
			readonly interfaces?: readonly string[];
	  }
	| {
			/**
			 * The fields a source model (an `extends` base or a spread source) gives every reached
			 * output type built from it, where two or more are: what a client selects across them.
			 * A `@discriminator` base's interface is also a field's type, so it names the object types
			 * a value may be (`members`) and how one is chosen (`resolveBy`).
			 */
			readonly kind: "interface";
			readonly name: string;
			readonly description: string | undefined;
			readonly fields: readonly OutputFieldPlan[];
			/** The interfaces it implements, by name: a nested base's, its parent base's. */
			readonly interfaces?: readonly string[];
			/** The object types a value of a `@discriminator` base may be, the base's own among them. */
			readonly members?: readonly string[];
			readonly resolveBy?: { readonly kind: "base"; readonly rule: BaseResolution };
	  }
	| {
			readonly kind: "input";
			readonly name: string;
			readonly description: string | undefined;
			readonly fields: readonly InputFieldPlan[];
	  }
	| {
			readonly kind: "enum";
			readonly name: string;
			readonly description: string | undefined;
			readonly values: readonly {
				readonly name: string;
				readonly wire: string | number;
				readonly description: string | undefined;
				readonly deprecationReason: string | undefined;
			}[];
	  }
	| {
			readonly kind: "union";
			readonly name: string;
			readonly description: string | undefined;
			readonly members: readonly string[];
			readonly resolveBy: ResolveTypePlan;
	  }
	| {
			readonly kind: "scalar";
			readonly name: string;
			readonly description: string | undefined;
			readonly specifiedBy: string | undefined;
			/** The JSON type its wire value has, which input coercion checks. */
			readonly json: "string" | "number" | "integer" | "any";
	  };

/** Everything one service's GraphQL schema is, before it is written anywhere. */
export interface SchemaPlan {
	readonly types: readonly TypeDef[]; // every named type except Query and Mutation, by name
	readonly query: readonly OutputFieldPlan[]; // never empty: `_empty: Boolean` when nothing is declared
	readonly mutation: readonly OutputFieldPlan[];
	/** Operations a handler must exist for: every root and link target, sorted. */
	readonly operations: readonly {
		readonly route: EmittedRoute;
		readonly names: RouteSchemaNames;
	}[];
	/**
	 * Every status a `byStatus` projection may meet, to the code design.md gives it: written once into
	 * graphql.gen.ts where one is planned, and empty where none is.
	 */
	readonly statusCodes: Readonly<Record<string, string>>;
	/** True when any field carries @cost or @listSize, so the directive definitions are declared. */
	readonly usesCost: boolean;
}

/** The scalars the runtime defines; types.ts never invents another name. */
export const RUNTIME_SCALARS = [
	"Long",
	"BigInteger",
	"Numeric",
	"BigDecimal",
	"UTCDateTime",
	"UTCDateTimeHuman",
	"UTCDateTimeUnix",
	"OffsetDateTime",
	"OffsetDateTimeHuman",
	"OffsetDateTimeUnix",
	"PlainDate",
	"PlainTime",
	"Duration",
	"DurationSeconds",
	"DurationMilliseconds",
	"Bytes",
	"BytesUrl",
	"URL",
	"JSON",
] as const;
export type RuntimeScalar = (typeof RUNTIME_SCALARS)[number];
