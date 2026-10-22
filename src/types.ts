import type {
	DiagnosticTarget,
	DiscriminatedUnion,
	Discriminator,
	Enum,
	Model,
	ModelProperty,
	Namespace,
	Program,
	Scalar,
	TemplatedType,
	Type,
	Union,
	Value,
} from "@typespec/compiler";
import {
	getDeprecationDetails,
	getDiscriminatedUnion,
	getDiscriminatedUnionFromInheritance,
	getDiscriminator,
	getDoc,
	getEncode,
	getFriendlyName,
	getSourceLocation,
	getTypeName,
	isArrayModelType,
	isNeverType,
	isNullType,
	isTemplateDeclaration,
	isTemplateInstance,
	isType,
	isUnknownType,
	resolveEncodedName,
} from "@typespec/compiler";
import {
	createMetadataInfo,
	getVisibilitySuffix,
	isHeader,
	isQueryParam,
	type MetadataInfo,
	Visibility,
} from "@typespec/http";
import { isReadonlyProperty } from "@typespec/openapi";
import {
	asNullable,
	type BaseMember,
	type DefaultLiteral,
	type InputFieldPlan,
	listOf,
	named,
	type OutputFieldPlan,
	RUNTIME_SCALARS,
	type RuntimeScalar,
	type TypeDef,
	type TypeRef,
} from "./model.js";
import { enumValueNameOf, fieldNameOf, type NameBook, typeNameOf } from "./names.js";

/**
 * TypeSpec types to GraphQL types: `design.md` § Types, rule for rule.
 *
 * **Every rule that decides which properties a type has is `@typespec/http`'s own**, called the way
 * `@typespec/openapi3` and `typespec-http-zod` call it: `createMetadataInfo` with `Read` canonical and
 * a read-only property shareable, `isPayloadProperty` at the position's visibility, `isOptional` for
 * PATCH (and a read-only property in a request, where openapi3 publishes OpenAPI 3.0 alone),
 * `isTransformed` before a visibility suffix and before reading a request at its own
 * visibility, and `resolveEncodedName(..., "application/json")` for every key. The GraphQL type and the Zod schema
 * that validates the same value therefore agree on which keys exist and what they are called; a
 * field this module invented would be a field the validator refuses.
 *
 * **Every name is claimed in the NameBook**, a type under its GraphQL name and each field or enum
 * value as `<Type>.<member>`, so two TypeSpec things converting to one GraphQL name are a recorded
 * collision rather than a silent merge. `plan.ts` drops what reaches one.
 */

/**
 * **Where an input field's deprecation goes.** GraphQL refuses `@deprecated` on a non-null input
 * field or argument ("Required input field … cannot be deprecated"), yet deprecating a field while it
 * is still required is the ordinary first step of a migration. So a required one carries the reason
 * in its description, and only a nullable one carries `deprecationReason`.
 */
export function inputDeprecation(
	type: TypeRef,
	description: string | undefined,
	reason: string | undefined,
): { readonly description: string | undefined; readonly deprecationReason: string | undefined } {
	if (reason === undefined || !type.nonNull) return { description, deprecationReason: reason };
	const note = `Deprecated: ${reason}`;
	return {
		description: description === undefined ? note : `${description}\n\n${note}`,
		deprecationReason: undefined,
	};
}

/**
 * **The names GraphQL already owns**, which no type of the spec's may take: the root types, the
 * built-in scalars, and every scalar this runtime defines. A model named `Query` crashed the
 * emitter, one named `String` failed `createSchema` at start-up, and one named `Duration` shadowed
 * the scalar or collided with it depending on declaration order.
 */
const RESERVED_NAMES: ReadonlyMap<string, string> = new Map([
	...(["Query", "Mutation", "Subscription"] as const).map(
		(name) => [name, "a GraphQL root type"] as const,
	),
	...(["String", "Int", "Float", "Boolean", "ID"] as const).map(
		(name) => [name, "a scalar GraphQL builds in"] as const,
	),
	...RUNTIME_SCALARS.map((name) => [name, "a scalar this emitter's runtime defines"] as const),
]);

/** A type that became `JSON` for a reason a spec author should hear (`projected-as-json`). */
export interface ProjectionWarning {
	readonly what: string;
	readonly reason: string;
	/** The type projected as `JSON`, which a `@json` declaration names to accept it. */
	readonly target: Type;
}

/**
 * An anonymous type that members of two or more declared models hold, named after the first of them
 * declared (`anonymous-type-shared`): an alias's type, or a member inherited from an instance whose
 * composed name leaves out an argument.
 */
export interface SharedTypeWarning {
	readonly name: string;
	/** Each member holding it, `Namespace.Model.member`, in declaration order. */
	readonly holders: readonly string[];
	readonly target: DiagnosticTarget;
}

/**
 * What an anonymous type is named after, and who owns that name.
 *
 * **An anonymous model or union has no name of its own**, so it is named from its enclosing type and
 * member (`Widget.nested` is `WidgetNested`). A caller projecting a type at the top of a field (a
 * response body, an argument) passes the hint it would be named by there.
 */
export interface TypeHint {
	readonly name: string;
	readonly owner: string;
	/** Where the type is shared: every member holding it, the name being the first's. */
	readonly holders?: readonly string[];
}

/**
 * The runtime scalars, as the schema declares them.
 *
 * **Names and `@specifiedBy` URLs are upstream's `SCALAR_MAPPINGS`** (`@typespec/graphql`,
 * `src/lib/scalar-mappings.ts`), with the two departures `design.md` names: a standard scalar used
 * directly gets the custom scalar too, and a value whose wire form is a JSON number is never
 * `String`. `json` is that wire form, which input coercion checks. `src/runtime.ts` declares the same
 * scalars with the same descriptions and URLs; the SDL == runtime oracle holds the two equal.
 */
export const SCALAR_DEFINITIONS: {
	readonly [K in RuntimeScalar]: {
		readonly description: string;
		readonly specifiedBy: string | undefined;
		readonly json: "string" | "number" | "integer" | "any";
	};
} = {
	Long: {
		description: "A 64-bit integer, as a JSON number.",
		specifiedBy: "http://scalars.graphql.org/jakobmerrild/long.html",
		json: "integer",
	},
	BigInteger: {
		description: "An integer, as a JSON number, which carries it exactly within ±2^53 - 1.",
		specifiedBy: undefined,
		json: "integer",
	},
	Numeric: {
		description: "A number of any kind, as a JSON number.",
		specifiedBy: undefined,
		json: "number",
	},
	BigDecimal: {
		description: "A decimal number, as a JSON number.",
		specifiedBy: "https://scalars.graphql.org/chillicream/decimal.html",
		json: "number",
	},
	UTCDateTime: {
		description: "A UTC date and time, as an RFC 3339 string.",
		specifiedBy: "https://scalars.graphql.org/chillicream/date-time.html",
		json: "string",
	},
	UTCDateTimeHuman: {
		description: "A UTC date and time, as an RFC 7231 HTTP-date string.",
		specifiedBy: "https://datatracker.ietf.org/doc/html/rfc7231#section-7.1.1.1",
		json: "string",
	},
	UTCDateTimeUnix: {
		description: "A UTC date and time, as Unix seconds.",
		specifiedBy: undefined,
		json: "integer",
	},
	OffsetDateTime: {
		description: "A date and time with an offset, as an RFC 3339 string.",
		specifiedBy: "https://scalars.graphql.org/chillicream/date-time.html",
		json: "string",
	},
	OffsetDateTimeHuman: {
		description: "A date and time with an offset, as an RFC 7231 HTTP-date string.",
		specifiedBy: "https://datatracker.ietf.org/doc/html/rfc7231#section-7.1.1.1",
		json: "string",
	},
	OffsetDateTimeUnix: {
		description: "A date and time with an offset, as Unix seconds.",
		specifiedBy: undefined,
		json: "integer",
	},
	PlainDate: {
		description: "A calendar date with no time or zone, as an ISO 8601 string.",
		specifiedBy: "https://scalars.graphql.org/andimarek/local-date.html",
		json: "string",
	},
	PlainTime: {
		description: "A time of day with no date or zone, as an ISO 8601 string.",
		specifiedBy: "https://scalars.graphql.org/apollographql/localtime-v0.1.html",
		json: "string",
	},
	Duration: {
		description: "A duration, as an ISO 8601 string.",
		specifiedBy: "https://www.iso.org/standard/70907.html",
		json: "string",
	},
	DurationSeconds: {
		description: "A duration, as a number of seconds.",
		specifiedBy: undefined,
		json: "number",
	},
	DurationMilliseconds: {
		description: "A duration, as a number of milliseconds.",
		specifiedBy: undefined,
		json: "number",
	},
	Bytes: {
		description: "Bytes, as a base64 string.",
		specifiedBy: "https://datatracker.ietf.org/doc/html/rfc4648#section-4",
		json: "string",
	},
	BytesUrl: {
		description: "Bytes, as a base64url string.",
		specifiedBy: "https://datatracker.ietf.org/doc/html/rfc4648#section-5",
		json: "string",
	},
	URL: {
		description: "A URL, as a string.",
		specifiedBy: "https://url.spec.whatwg.org/",
		json: "string",
	},
	JSON: {
		description: "Any JSON value.",
		specifiedBy: undefined,
		json: "any",
	},
};

/** The GraphQL built-in scalars a TypeSpec scalar can map to; they need no definition. */
type BuiltinScalar = "String" | "Boolean" | "Int" | "Float";

function isBuiltinScalar(name: BuiltinScalar | RuntimeScalar): name is BuiltinScalar {
	return name === "String" || name === "Boolean" || name === "Int" || name === "Float";
}

/** `design.md`'s scalar table, keyed by the standard scalar a type is or extends. */
const STANDARD_SCALARS: Readonly<Record<string, BuiltinScalar | RuntimeScalar>> = {
	string: "String",
	boolean: "Boolean",
	int8: "Int",
	int16: "Int",
	int32: "Int",
	uint8: "Int",
	uint16: "Int",
	float: "Float",
	float32: "Float",
	float64: "Float",
	int64: "Long",
	uint32: "Long",
	safeint: "Long",
	uint64: "BigInteger",
	integer: "BigInteger",
	numeric: "Numeric",
	decimal: "BigDecimal",
	decimal128: "BigDecimal",
	utcDateTime: "UTCDateTime",
	offsetDateTime: "OffsetDateTime",
	plainDate: "PlainDate",
	plainTime: "PlainTime",
	duration: "Duration",
	bytes: "Bytes",
	url: "URL",
};

/** One standard scalar's encodings, looked up by an encoding that may be absent. */
const encodings = (
	rows: Readonly<Record<string, RuntimeScalar>>,
): ReadonlyMap<string | undefined, RuntimeScalar> => new Map(Object.entries(rows));

/**
 * **The encodings that decide a scalar's wire form**, and so its GraphQL scalar, keyed by the
 * standard scalar a type is or extends. Each scalar's own encoding (RFC 3339, ISO 8601, base64) is
 * its row in the table above, so naming it changes nothing.
 */
const ENCODED_SCALARS: Readonly<Record<string, ReadonlyMap<string | undefined, RuntimeScalar>>> = {
	utcDateTime: encodings({
		rfc3339: "UTCDateTime",
		rfc7231: "UTCDateTimeHuman",
		unixTimestamp: "UTCDateTimeUnix",
	}),
	offsetDateTime: encodings({
		rfc3339: "OffsetDateTime",
		rfc7231: "OffsetDateTimeHuman",
		unixTimestamp: "OffsetDateTimeUnix",
	}),
	duration: encodings({
		ISO8601: "Duration",
		seconds: "DurationSeconds",
		milliseconds: "DurationMilliseconds",
	}),
	bytes: encodings({ base64: "Bytes", base64url: "BytesUrl" }),
};

/**
 * **The array encodings that are a query parameter's style, not its type**: `@typespec/openapi3`'s
 * `isParameterStyleEncoding`, which the library's `encodedTypeOf` copies. Such a parameter stays a
 * list, split before the handler sees it.
 */
const PARAMETER_STYLES: ReadonlySet<string | undefined> = new Set([
	"ArrayEncoding.pipeDelimited",
	"ArrayEncoding.spaceDelimited",
	"ArrayEncoding.commaDelimited",
	"ArrayEncoding.newlineDelimited",
]);

/**
 * What the property a value arrives in says about its wire form, read once where the property is.
 * A value with no property (a variant, a list reached at the top of a field) has no carrier.
 */
interface Carrier {
	/** The type the property is declared with. */
	readonly type: Type;
	/** Its own `@encode`, which wins over its type's, unless it is a query parameter's style. */
	readonly encode: ReturnType<typeof getEncode>;
	/** A header, whose date-time is RFC 7231 (`#headerEncodingOf`). */
	readonly header: boolean;
}

/** GraphQL's `Int`: a signed 32-bit integer. */
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/** The JSON type each built-in scalar's values have, for matching a default to its type. */
const BUILT_IN_JSON: Readonly<Record<string, "string" | "integer" | "number" | "boolean">> = {
	String: "string",
	ID: "string",
	Int: "integer",
	Float: "number",
	Boolean: "boolean",
};

/** Where a type is being projected: as output, or as request input at one visibility. */
interface Position {
	readonly input: boolean;
	readonly visibility: Visibility;
}

const OUTPUT: Position = { input: false, visibility: Visibility.Read };

/** A property's JSON wire key: its `@encodedName` for `application/json`, or its name. */
const wireOf = (program: Program, property: ModelProperty): string =>
	resolveEncodedName(program, property, "application/json");

/**
 * **The model a property's type was declared in**, which names an anonymous type: through each
 * spread or `is` copy that still holds the source's own type, the deepest model whose own property
 * it is. An inherited property is its base's already (`propertiesOf`).
 *
 * - **Its own property**: a visibility transform's copy (`Create<Dial>`) names the source model,
 *   but the type it reshapes is no property of that model, so the copying model declares it.
 * - **A name that tells it apart**: a template instance whose composed name leaves out an argument
 *   (`Crate<"box">` is `Crate`) declares nothing, so `Box is Crate<"box">` declares what it copies.
 */
function declaringModelOf(property: ModelProperty): Model | undefined {
	const owners: Model[] = [];
	for (
		let current: ModelProperty | undefined = property;
		current !== undefined;
		current = current.sourceProperty?.type === current.type ? current.sourceProperty : undefined
	) {
		const model: Model | undefined = current.model;
		if (model?.properties.get(current.name) === current && namesItself(model)) owners.push(model);
	}
	return owners.at(-1);
}

/** A model whose name is its own: declared, or an instance whose composed name keeps every argument. */
function namesItself(model: Model): boolean {
	if (model.name === "") return false;
	if (!isTemplateInstance(model)) return true;
	return model.templateMapper.args.every(
		(arg) => isType(arg) && typeof (arg as { name?: unknown }).name === "string",
	);
}

/** An owner as an input claims it: `as input`, and the view's suffix where the request reshapes it. */
function ownerAt(owner: string, position: Position): string {
	if (!position.input) return owner;
	const suffix = getVisibilitySuffix(position.visibility, Visibility.Read);
	return `${owner} as input${suffix === "" ? "" : ` at ${suffix}`}`;
}

/** A declared model as what its members' anonymous types are named after. */
function holderOf(program: Program, model: Model): TypeHint {
	return { name: declaredNameOf(program, model), owner: `model ${getTypeName(model)}` };
}

/** A member under what holds it: `Widget.nested` is `WidgetNested`. */
function memberOf(holder: TypeHint, property: ModelProperty): TypeHint {
	return {
		name: `${holder.name}${typeNameOf(property.name)}`,
		owner: `${holder.owner}.${property.name}`,
	};
}

/** A type named after the member holding it: an anonymous model or union, or a list of one. */
function namedByHint(type: Type): boolean {
	switch (type.kind) {
		case "Union":
			return type.name === undefined;
		case "Model":
			return type.name === "" || (isArrayModelType(type) && namedByHint(type.indexer.value));
		default:
			return false;
	}
}

/**
 * A model's properties with `extends` flattened in, base first, one per wire key.
 *
 * **Base first, and a redeclared property keeps the base's position with the derived type**, so a
 * derived model reads `id, name, ...own` as its declaration does, and a discriminator narrowed to a
 * literal in a derived model is that literal. `walkPropertiesInherited` yields own properties first,
 * which would put every inherited `id` last.
 *
 * **By wire key, as openapi3's `allOf` composes them**: a derived model is its base's schema and its
 * own, so a redeclaration under another `@encodedName` is a second property. `@encodedName(
 * "application/json", "type") kind` on a base and `kind: "bird"` on its subtype publish `Bird` with
 * both `type` and `kind`, and the library validates both.
 */
function propertiesOf(program: Program, model: Model): ModelProperty[] {
	const chain: Model[] = [];
	for (let current: Model | undefined = model; current !== undefined; current = current.baseModel) {
		chain.unshift(current);
	}
	const byWire = new Map<string, ModelProperty>();
	for (const ancestor of chain) {
		for (const property of ancestor.properties.values()) {
			byWire.set(wireOf(program, property), property);
		}
	}
	return [...byWire.values()];
}

/**
 * **`types` in the order the spec declares them**: by source file, in the order the program loaded
 * its files, then by position, a type the compiler made with no place after the rest as it came.
 *
 * The compiler files a namespace's models as it begins checking each, and checks one early wherever
 * something checked before it names it, so `namespace.models` is the order the checker met them:
 * `Easel { paint: Paint }`, declared first, files `Paint` before a `Lamp` declared ahead of it, and an
 * augment decorator naming a type, as `@link` names an operation, moves it the same way.
 */
function inDeclarationOrder<T extends Type>(program: Program, types: Iterable<T>): T[] {
	const files = new Map([...program.sourceFiles.keys()].map((path, index) => [path, index]));
	const placed = [...types].map((type, index) => {
		const location = type.node === undefined ? undefined : getSourceLocation(type.node);
		const file = location === undefined ? undefined : files.get(location.file.path);
		return { type, index, file: file ?? Infinity, pos: location?.pos ?? Infinity };
	});
	placed.sort((a, b) => a.file - b.file || a.pos - b.pos || a.index - b.index);
	return placed.map(({ type }) => type);
}

/**
 * **A declaration's own name: its `@friendlyName` where one is applied**, as `@typespec/openapi3`'s
 * `getOpenAPITypeName` and typespec-http-zod read it first, so a type reads the same in the document,
 * the validators and the schema: `@friendlyName("Located{name}", P) model Located<P>` makes
 * `Located<Conflict>` `LocatedConflict` in all three.
 *
 * Where none is, upstream's `composeTemplateName` (`src/lib/template-composition.ts`): `Page<Widget>`
 * is `PageOfWidget`, `Map<string, Widget>` is `MapOfStringAndWidget`, an array argument
 * `WidgetArray`. An enum takes no template parameters, so it is its own name.
 */
function templateNameOf(program: Program, type: TemplatedType | Enum): string {
	const friendly = getFriendlyName(program, type);
	if (friendly !== undefined) return friendly;
	const name = type.name ?? "";
	if (!isTemplateInstance(type)) return name;
	const args = type.templateMapper.args.filter(
		(arg): arg is Type => isType(arg) && typeof (arg as { name?: unknown }).name === "string",
	);
	if (args.length === 0) return name;
	return `${name}Of${args.map((arg) => templateArgumentNameOf(program, arg)).join("And")}`;
}

function templateArgumentNameOf(program: Program, arg: Type): string {
	if (arg.kind === "Model" && isArrayModelType(arg)) return typeNameOf(getTypeName(arg));
	// Any template instance, an interface's or an operation's too, as upstream's `resolveArgName`.
	if (isTemplateInstance(arg)) return templateNameOf(program, arg);
	return typeNameOf(getTypeName(arg));
}

/**
 * The models a model is built from, transitively: its `extends` bases and the models it spreads,
 * each a candidate interface. An array, a `Record` and an anonymous model are no interface's source.
 */
function sourceModelsOf(model: Model): Model[] {
	const found: Model[] = [];
	const visit = (current: Model): void => {
		const next = [
			...(current.baseModel === undefined ? [] : [current.baseModel]),
			...current.sourceModels
				.filter((source) => source.usage === "spread")
				.map((source) => source.model),
		];
		for (const source of next) {
			if (found.includes(source) || source === model) continue;
			if (source.name === "" || source.indexer !== undefined) continue;
			found.push(source);
			visit(source);
		}
	};
	visit(model);
	return found;
}

/** The GraphQL name a declared model, union or enum gets: PascalCase, its `@friendlyName` or templates composed. */
function declaredNameOf(program: Program, type: Model | Union | Enum): string {
	return typeNameOf(templateNameOf(program, type));
}

/**
 * **Whether every document `@typespec/openapi3` publishes from this compile is OpenAPI 3.0**: its
 * `openapi-versions` option, read from the compile's options whether or not openapi3 is emitted, as
 * `typespec-http-zod` reads it. None listed is openapi3's default, `["3.0.0"]` (`openapi.js`).
 */
function publishesOpenApi30Only(program: Program): boolean {
	const options = program.compilerOptions.options?.["@typespec/openapi3"] as
		| { readonly "openapi-versions"?: readonly string[] }
		| undefined;
	return (options?.["openapi-versions"] ?? []).every((version) => version.startsWith("3.0."));
}

export class TypeProjector {
	readonly #program: Program;
	readonly #book: NameBook;
	readonly #metadata: MetadataInfo;
	/**
	 * **Whether a request may leave out a required read-only property**: where openapi3 publishes
	 * OpenAPI 3.0 alone, whose `readOnly` makes `required` "take effect on the response only" (OAS
	 * 3.0.4), and the library's validator lets a request leave it out (`isOptionalAt`). At 3.1
	 * `readOnly` is an annotation, and `required` holds in a request too.
	 */
	readonly #readOnlyOptional: boolean;
	readonly #typeSchemaNames: ReadonlyMap<Type, string>;
	readonly #defs = new Map<string, TypeDef>();
	/** Names registered by `define`, which may be defined again identically without a collision. */
	readonly #generated = new Set<string>();
	readonly #outputs = new Map<Type, TypeRef>();
	readonly #inputs = new Map<Visibility, Map<Type, TypeRef>>();
	/**
	 * Shared by output and input: a union of literals is one GraphQL type in both positions, named
	 * by the member that reached it first.
	 */
	readonly #enums = new Map<Type, TypeRef>();
	/** Each model projected to an object type, by its effective payload model: only a model is a key. */
	readonly #objects = new Map<Model, string>();
	/**
	 * Each `@discriminator` base's own object type. Apart from `#objects`: a value of the base's type
	 * is any member of its interface, so the base names no one object type a field of it projects to.
	 */
	readonly #baseObjects = new Map<Model, string>();
	/** Each `@discriminator` base's interface, registered as it is reached; its fields come later. */
	readonly #baseInterfaces = new Map<Model, string>();
	readonly #warnings: ProjectionWarning[] = [];
	readonly #warned = new Set<Type>();
	/** Each anonymous type a declared model's member holds, by its first such member: `#heldBy`. */
	#holdings: ReadonlyMap<Type, TypeHint> | undefined;
	readonly #shared: SharedTypeWarning[] = [];
	readonly #sharedWarned = new Set<Type>();

	/**
	 * `typeSchemaNames`: the identifier `schemas.gen.ts` exports each declared type's validator under,
	 * as the library publishes it (`EmittedService.typeSchemaNames`), by which a base's `resolveType`
	 * tells a subtype's value from the base's.
	 */
	constructor(program: Program, book: NameBook, typeSchemaNames: ReadonlyMap<Type, string>) {
		this.#program = program;
		this.#book = book;
		this.#typeSchemaNames = typeSchemaNames;
		/**
		 * **openapi3's own metadata view, with its arguments** (`openapi.js`), as `typespec-http-zod`
		 * builds it: `Read` is canonical, and a read-only property is shareable, so a model whose
		 * request differs only by read-only properties is not transformed and the request is its
		 * canonical schema, those properties in it.
		 */
		this.#metadata = createMetadataInfo(program, {
			canonicalVisibility: Visibility.Read,
			canShareProperty: (property) => isReadonlyProperty(program, property),
		});
		this.#readOnlyOptional = publishesOpenApi30Only(program);
	}

	get warnings(): readonly ProjectionWarning[] {
		return this.#warnings;
	}

	/** Each anonymous type named after the first of the members holding it (`anonymous-type-shared`). */
	get shared(): readonly SharedTypeWarning[] {
		return this.#shared;
	}

	/**
	 * The output TypeRef for `type`, registering every TypeDef it reaches. Nullability from `| null`.
	 * `hint` names the type when it is anonymous and no declared model's member holds it; without one
	 * an anonymous model is `JSON`, warned.
	 */
	output(type: Type, hint?: TypeHint): TypeRef {
		return this.#ref(type, OUTPUT, this.#heldBy(type) ?? hint, undefined);
	}

	/**
	 * The input TypeRef for `type` under `visibility` (a Lifecycle visibility of the request).
	 *
	 * `property` is the parameter or body property the value arrives in, when there is one: its own
	 * `@encode` decides the wire form exactly as a model property's does, so an `@encode("seconds")`
	 * header is `DurationSeconds`, as the library's validator for it is a number.
	 */
	input(type: Type, visibility: Visibility, hint?: TypeHint, property?: ModelProperty): TypeRef {
		const carrier = property === undefined ? undefined : this.#carrierOf(property);
		return this.#ref(type, { input: true, visibility }, this.#heldBy(type) ?? hint, carrier);
	}

	/**
	 * The input fields a model contributes at `visibility`, without registering an input object for
	 * the model itself: what a spread request body adds to the input that merges it.
	 */
	inputFieldsOf(model: Model, visibility: Visibility, hint: TypeHint): readonly InputFieldPlan[] {
		const reading = this.#readingOf(this.#effectiveOf(model, visibility), visibility);
		return this.#inputFields(model, { input: true, visibility: reading }, hint);
	}

	/**
	 * **A TypeSpec default as the GraphQL literal of `ref`**, so `schema.graphql` and introspection
	 * show what the operation's Zod schema will fill in. `undefined` where the default has no spelling
	 * in that type: an object, array or scalar-constructor default, or one whose JSON type is not the
	 * GraphQL type's.
	 *
	 * **An enum's default is the name of the value whose wire value it is**, for a declared enum's
	 * member and a union of literals alike: `= DONE` for `Status.Done`, `= DARK` for `"dark"`.
	 */
	defaultLiteralOf(value: Value | undefined, ref: TypeRef): DefaultLiteral | undefined {
		if (value === undefined) return undefined;
		if (value.valueKind === "NullValue") return ref.nonNull ? undefined : { kind: "NULL" };
		if (ref.kind !== "named") return undefined;
		const def = this.#defs.get(ref.name);
		if (def?.kind === "enum") {
			const wire =
				value.valueKind === "EnumValue"
					? (value.value.value ?? value.value.name)
					: value.valueKind === "StringValue"
						? value.value
						: undefined;
			const member = def.values.find((candidate) => candidate.wire === wire);
			return member === undefined ? undefined : { kind: "ENUM", value: member.name };
		}
		const json = BUILT_IN_JSON[ref.name] ?? (def?.kind === "scalar" ? def.json : undefined);
		switch (value.valueKind) {
			case "StringValue":
				return json === "string" || json === "any"
					? { kind: "STRING", value: value.value }
					: undefined;
			case "BooleanValue":
				return json === "boolean" || json === "any"
					? { kind: "BOOLEAN", value: value.value }
					: undefined;
			case "NumericValue": {
				const number = value.value.asNumber();
				if (number === null || !(json === "number" || json === "integer" || json === "any")) {
					return undefined;
				}
				if (Number.isInteger(number)) return { kind: "INT", value: value.value.toString() };
				return json === "integer" ? undefined : { kind: "FLOAT", value: value.value.toString() };
			}
		}
		return undefined;
	}

	/**
	 * **Interfaces from the models output types are built from.** An `extends` base or a spread
	 * source (`...ProblemFields`) whose properties two or more reached object types carry becomes
	 * `<Name>Interface`, upstream's interface naming, and each of those types implements it, so a
	 * client selects the shared fields across a result union's members (`... on
	 * ProblemFieldsInterface { title detail }`).
	 *
	 * **An interface field is one every implementer projects identically.** A derived model may
	 * narrow a property (`kind: "cat"` over `kind: string`), and GraphQL requires an implementer's
	 * field to be a subtype of the interface's; such a field stays on the types alone. A source with
	 * no field so shared, or with only one implementer, makes no interface: it would add nothing a
	 * client can select. Answers the names it defined, for the plan to count as reached.
	 *
	 * **A `@discriminator` base's interface is already defined**, as a field's type, and is given its
	 * fields here, once every member's are: those of the base's own object type every member projects
	 * identically, the discriminator always among them. It is no source for another interface.
	 */
	defineInterfaces(reached: ReadonlySet<string>): string[] {
		const interfacesOf = new Map<string, string[]>();
		const implement = (implementer: string, name: string): void => {
			interfacesOf.set(implementer, [...(interfacesOf.get(implementer) ?? []), name]);
		};
		for (const [base, name] of this.#baseInterfaces) {
			const def = this.#defs.get(name);
			const own = this.#baseObjects.get(base);
			if (!reached.has(name) || def?.kind !== "interface" || own === undefined) continue;
			const members = def.members ?? [];
			const objects = members.map((member) => this.#objectDefOf(member));
			const fields = this.#objectDefOf(own)
				.fields.filter((field) =>
					objects.every((object) =>
						object.fields.some(
							(candidate) =>
								candidate.name === field.name &&
								JSON.stringify(candidate.type) === JSON.stringify(field.type),
						),
					),
				)
				.map((field) => ({ ...field, arguments: [], call: undefined, directives: [] }));
			this.#defs.set(name, { ...def, fields });
			for (const member of members) implement(member, name);
		}
		const sourcesByType = new Map<string, Set<Model>>();
		for (const [type, name] of [...this.#objects, ...this.#baseObjects]) {
			if (!reached.has(name)) continue;
			const sources = sourcesByType.get(name) ?? new Set<Model>();
			for (const source of sourceModelsOf(type)) {
				if (!this.#baseInterfaces.has(source)) sources.add(source);
			}
			sourcesByType.set(name, sources);
		}
		const implementersBySource = new Map<Model, string[]>();
		for (const [name, sources] of sourcesByType) {
			for (const source of sources) {
				implementersBySource.set(source, [...(implementersBySource.get(source) ?? []), name]);
			}
		}
		const defined: string[] = [];
		for (const [source, implementers] of implementersBySource) {
			if (implementers.length < 2) continue;
			const objects = implementers.map((name) => this.#objectDefOf(name));
			const fields = this.#payloadOf(source, Visibility.Read).flatMap((property) => {
				const name = fieldNameOf(wireOf(this.#program, property));
				const [first, ...others] = objects.map((def) =>
					def.fields.find((field) => field.name === name),
				);
				if (
					first === undefined ||
					others.some(
						(field) =>
							field === undefined || JSON.stringify(field.type) !== JSON.stringify(first.type),
					)
				) {
					return [];
				}
				return [
					{
						...first,
						description: getDoc(this.#program, property) ?? first.description,
						arguments: [],
						call: undefined,
						directives: [],
					},
				];
			});
			if (fields.length === 0) continue;
			const name = `${declaredNameOf(this.#program, source)}Interface`;
			const owner = `model ${getTypeName(source)} as an interface`;
			if (!this.#book.claim(name, owner)) continue;
			this.#register(
				{ kind: "interface", name, description: getDoc(this.#program, source), fields },
				owner,
			);
			defined.push(name);
			for (const implementer of implementers) implement(implementer, name);
		}
		for (const [name, interfaces] of interfacesOf) {
			const def = this.#objectDefOf(name);
			// The default sort orders strings by code unit, as `<` does (ECMA-262 `SortCompare`).
			this.#defs.set(name, { ...def, interfaces: [...new Set(interfaces)].toSorted() });
		}
		return defined;
	}

	/** The object type registered under a name `#objects` holds: it is set only once one is. */
	#objectDefOf(name: string): Extract<TypeDef, { kind: "object" }> {
		const def = this.#defs.get(name);
		if (def?.kind !== "object")
			throw new Error(`${name} is no object type this projector registered`);
		return def;
	}

	/**
	 * The GraphQL object type name a type projects to as output, after output(type) ran: a model's,
	 * or its effective payload model's. Set before the type's fields are, so a type that holds the
	 * one being projected already has it.
	 */
	outputNameOf(type: Type): string | undefined {
		// Looked up by any type, which finds nothing for a type that is no model.
		const objects: ReadonlyMap<Type, string> = this.#objects;
		return (
			objects.get(type) ??
			objects.get(this.#metadata.getEffectivePayloadType(type, Visibility.Read))
		);
	}

	/**
	 * **The GraphQL type a type became, by name, wherever this projector met it**: as output, or as
	 * input at any visibility; `undefined` for one it never projected. `JSON` for one projected as the
	 * scalar, which is how a `@json` declaration is told met from mistaken.
	 */
	projectedNameOf(type: Type): string | undefined {
		const innermost = (ref: TypeRef): string =>
			ref.kind === "named" ? ref.name : innermost(ref.of);
		const output = this.#outputs.get(type);
		if (output !== undefined) return innermost(output);
		for (const inputs of this.#inputs.values()) {
			const input = inputs.get(type);
			if (input !== undefined) return innermost(input);
		}
		return undefined;
	}

	/** Adds fields to an object TypeDef already registered (links). Throws if `typeName` is not an object. */
	addFields(typeName: string, fields: readonly OutputFieldPlan[]): void {
		const def = this.#defs.get(typeName);
		if (def?.kind !== "object") {
			throw new Error(`addFields: ${typeName} is not an object type this projector registered`);
		}
		for (const field of fields) {
			if (def.fields.some((existing) => existing.name === field.name)) {
				throw new Error(`addFields: ${typeName} already has a field ${field.name}`);
			}
		}
		this.#defs.set(typeName, { ...def, fields: [...def.fields, ...fields] });
	}

	/**
	 * Registers a TypeDef the emitter synthesises (connections, wrappers, result unions, mutation
	 * inputs).
	 *
	 * **Defining the same type twice is idempotent; defining a DIFFERENT type under a taken name is a
	 * collision**, recorded in the NameBook against the first owner, and the first definition is
	 * kept. `PageInfo` is defined by every connection; `CreateFooInput` defined by two mutations whose
	 * names both convert to `CreateFoo` is two types that cannot share one name.
	 */
	define(def: TypeDef): void {
		// A generated name is registered at once, and nothing deletes a def.
		const generated = this.#generated.has(def.name);
		if (generated && JSON.stringify(this.#defs.get(def.name)) === JSON.stringify(def)) return;
		const owner = generated
			? `generated ${def.kind} ${def.name} (a second, different definition)`
			: `generated ${def.kind} ${def.name}`;
		if (!this.#book.claim(def.name, owner)) return;
		this.#generated.add(def.name);
		this.#register(def, owner);
	}

	/** Every def, by name: the default sort orders strings by code unit (ECMA-262 `SortCompare`). */
	defs(): readonly TypeDef[] {
		return [...this.#defs.keys()].toSorted().map((name) => this.#defs.get(name) as TypeDef);
	}

	/** Stores a def and claims each member name, so two fields converting to one name collide. */
	#register(def: TypeDef, owner: string): void {
		this.#defs.set(def.name, def);
		if (def.kind === "object" || def.kind === "input") {
			for (const field of def.fields) {
				this.#book.claim(`${def.name}.${field.name}`, `${owner}: ${field.wire}`);
			}
		} else if (def.kind === "enum") {
			for (const value of def.values) {
				this.#book.claim(`${def.name}.${value.name}`, `${owner}: ${String(value.wire)}`);
			}
		}
	}

	#ref(
		type: Type,
		position: Position,
		hint: TypeHint | undefined,
		carrier: Carrier | undefined,
	): TypeRef {
		switch (type.kind) {
			case "Scalar":
				return this.#scalar(type, carrier);
			case "String":
			case "StringTemplate":
				return named("String", true);
			case "Boolean":
				return named("Boolean", true);
			case "Number":
				if (!Number.isInteger(type.value)) return named("Float", true);
				return type.value >= INT32_MIN && type.value <= INT32_MAX
					? named("Int", true)
					: this.#runtimeScalar("Long");
			case "Enum":
				return this.#enum(type);
			/**
			 * **One member of an enum, or one variant of a union, the usual way to write a
			 * discriminator** (`kind: PetKind.dog`): the enum itself, or the variant's own type. The
			 * value is still one the Zod schema checks exactly.
			 */
			case "EnumMember":
				return this.#enum(type.enum);
			case "UnionVariant":
				return this.#ref(type.type, position, hint, carrier);
			case "Union":
				return this.#union(type, position, hint, carrier);
			case "Model":
				return this.#model(type, position, hint, carrier);
			case "Intrinsic":
				if (isNullType(type)) return asNullable(this.#runtimeScalar("JSON"));
				// `unknown` admits `null`, as the library's `z.unknown()` does, so it is a nullable `JSON`.
				if (isUnknownType(type)) return asNullable(this.#runtimeScalar("JSON"));
				return this.#json(type, hint, `\`${type.name}\` has no GraphQL type`);
			default:
				return this.#json(type, hint, `a ${type.kind} has no GraphQL type`);
		}
	}

	/** What a property says about the wire form of the value it holds, read where the property is. */
	#carrierOf(property: ModelProperty): Carrier {
		const encode = getEncode(this.#program, property);
		const style = isQueryParam(this.#program, property) && PARAMETER_STYLES.has(encode?.encoding);
		return {
			type: property.type,
			encode: style ? undefined : encode,
			header: isHeader(this.#program, property),
		};
	}

	/** A standard scalar by the table; a declared scalar as its standard base; encodings applied. */
	#scalar(scalar: Scalar, carrier: Carrier | undefined): TypeRef {
		const base = this.#mappedBaseOf(scalar);
		const own = carrier?.encode;
		const encode = own ?? this.#encodeOf(scalar);
		const encoding =
			encode === undefined ? this.#headerEncodingOf(scalar, carrier) : encode.encoding;
		const encoded =
			base === undefined ? undefined : ENCODED_SCALARS[base.standard.name]?.get(encoding);
		if (encoded !== undefined && (encode === undefined || this.#carries(encode.type, encoded))) {
			return this.#runtimeScalar(encoded);
		}
		/**
		 * **An encoding no table names is the wire type it states**, as the library validates it
		 * (`encodedTypeOf`): `@encode("x-custom", string)` on an `int32` is a string on the wire, and
		 * so is `@encode(string)` on any number, the one type TypeSpec allows there, and on a scalar
		 * that extends no standard one. A scalar's own `@encode` naming the scalar itself states no
		 * other type.
		 */
		if (encode !== undefined && (own !== undefined || encode.type !== scalar)) {
			return this.#scalar(encode.type, undefined);
		}
		if (base === undefined) {
			return this.#json(scalar, undefined, `scalar ${scalar.name} extends no standard scalar`);
		}
		const { mapping } = base;
		return isBuiltinScalar(mapping) ? named(mapping, true) : this.#runtimeScalar(mapping);
	}

	/**
	 * **Whether a row of the encodings table holds for the wire type an `@encode` states.** The
	 * compiler holds every pairing to its wire type but ISO 8601 (`validateEncodeData`), which it lets
	 * a number state, as `@typespec/openapi3` then publishes and the library validates: a row read
	 * from text holds only where that type is text.
	 */
	#carries(wire: Scalar, scalar: RuntimeScalar): boolean {
		return (
			SCALAR_DEFINITIONS[scalar].json !== "string" || this.#mappedBaseOf(wire)?.mapping === "String"
		);
	}

	/**
	 * The nearest standard scalar the table maps, and its mapping. `unixTimestamp32` is standard
	 * itself, and maps as the `utcDateTime` it extends, under the `@encode` it carries.
	 */
	#mappedBaseOf(
		scalar: Scalar,
	): { readonly standard: Scalar; readonly mapping: BuiltinScalar | RuntimeScalar } | undefined {
		for (
			let current: Scalar | undefined = scalar;
			current !== undefined;
			current = current.baseScalar
		) {
			const mapping = this.#program.checker.isStdType(current)
				? STANDARD_SCALARS[current.name]
				: undefined;
			if (mapping !== undefined) return { standard: current, mapping };
		}
		return undefined;
	}

	/**
	 * **A date-time header with no `@encode` is RFC 7231**: TypeSpec's wire form for a header, and what
	 * `@typespec/openapi3` publishes for it (`isDateTimeHeader`). As there, only where the header's
	 * own type is `utcDateTime` or `offsetDateTime`, alone or with `| null`: a declared scalar, which
	 * it publishes as a `$ref`, and a header list's items stay RFC 3339.
	 */
	#headerEncodingOf(scalar: Scalar, carrier: Carrier | undefined): string | undefined {
		if (carrier === undefined || !carrier.header) return undefined;
		const checker = this.#program.checker;
		if (!checker.isStdType(scalar, "utcDateTime") && !checker.isStdType(scalar, "offsetDateTime")) {
			return undefined;
		}
		const own =
			carrier.type.kind === "Union"
				? [...carrier.type.variants.values()]
						.map((variant) => variant.type)
						.filter((type) => !isNullType(type))
				: [carrier.type];
		return own.length === 1 && own[0] === scalar ? "rfc7231" : undefined;
	}

	/** The nearest `@encode` on a scalar or its bases: a declared scalar inherits its base's encoding. */
	#encodeOf(scalar: Scalar): ReturnType<typeof getEncode> {
		for (
			let current: Scalar | undefined = scalar;
			current !== undefined;
			current = current.baseScalar
		) {
			const encode = getEncode(this.#program, current);
			if (encode !== undefined) return encode;
		}
		return undefined;
	}

	#runtimeScalar(name: RuntimeScalar): TypeRef {
		const { description, specifiedBy, json } = SCALAR_DEFINITIONS[name];
		const owner = `runtime scalar ${name}`;
		if (!this.#defs.has(name) && this.#book.claim(name, owner)) {
			this.#register({ kind: "scalar", name, description, specifiedBy, json }, owner);
		}
		return named(name, true);
	}

	/**
	 * `JSON` for a type whose GraphQL name is one GraphQL already owns (`RESERVED_NAMES`), warned
	 * once; `undefined` for any other name. The design's fallback for a shape GraphQL cannot state:
	 * the operation keeps its field, and the warning says which name to change.
	 */
	#reservedName(type: Type, hint: TypeHint | undefined, name: string): TypeRef | undefined {
		const owner = RESERVED_NAMES.get(name);
		if (owner === undefined) return undefined;
		return this.#json(
			type,
			hint,
			`its GraphQL name '${name}' is reserved, being ${owner}; rename it in TypeSpec`,
		);
	}

	/** `JSON`, with a `projected-as-json` warning saying why, once per type. */
	#json(type: Type, hint: TypeHint | undefined, reason: string): TypeRef {
		if (!this.#warned.has(type)) {
			this.#warned.add(type);
			this.#warnings.push({ what: hint?.owner ?? getTypeName(type), reason, target: type });
		}
		return this.#runtimeScalar("JSON");
	}

	#enum(type: Enum): TypeRef {
		const name = declaredNameOf(this.#program, type);
		const reserved = this.#reservedName(type, undefined, name);
		if (reserved !== undefined) return reserved;
		const owner = `enum ${getTypeName(type)}`;
		if (this.#book.claim(name, owner)) {
			this.#register(
				{
					kind: "enum",
					name,
					description: getDoc(this.#program, type),
					values: [...type.members.values()].map((member) => ({
						name: enumValueNameOf(member.name),
						wire: member.value ?? member.name,
						description: getDoc(this.#program, member),
						deprecationReason: getDeprecationDetails(this.#program, member)?.message,
					})),
				},
				owner,
			);
		}
		return named(name, true);
	}

	/**
	 * A union: `T | null` is a nullable `T`; literals are an enum; literals with `string` are
	 * `String`; a discriminated union is a GraphQL union as output and `JSON` as input; anything else
	 * is `JSON`, warned.
	 */
	#union(
		union: Union,
		position: Position,
		hint: TypeHint | undefined,
		carrier: Carrier | undefined,
	): TypeRef {
		const variants = [...union.variants.values()].map((variant) => variant.type);
		const present = variants.filter((type) => !isNullType(type));
		const finish = (ref: TypeRef): TypeRef =>
			present.length === variants.length ? ref : asNullable(ref);
		const [only, ...others] = present;
		if (only !== undefined && others.length === 0) {
			return finish(this.#ref(only, position, hint, carrier));
		}
		if (
			present.length > 0 &&
			present.every((type) => type.kind === "String" || type.kind === "Number")
		) {
			return finish(this.#literalEnum(union, hint));
		}
		const isString = (type: Type): boolean => this.#program.checker.isStdType(type, "string");
		if (
			present.some(isString) &&
			present.every((type) => type.kind === "String" || isString(type))
		) {
			return finish(named("String", true));
		}
		const [discriminated] = getDiscriminatedUnion(this.#program, union);
		if (discriminated !== undefined) {
			// An input union is JSON, validated by the operation's Zod schema (`@oneOf` is out of scope).
			if (position.input) return finish(this.#runtimeScalar("JSON"));
			return finish(this.#discriminatedUnion(union, discriminated, hint));
		}
		return finish(
			this.#json(union, hint, "its variants are neither all literals nor discriminated"),
		);
	}

	/** A union of string or numeric literals: an enum whose values are the literals, CONSTANT_CASE. */
	#literalEnum(union: Union, hint: TypeHint | undefined): TypeRef {
		const cached = this.#enums.get(union);
		if (cached !== undefined) return cached;
		const self =
			union.name === undefined
				? hint
				: { name: declaredNameOf(this.#program, union), owner: `union ${getTypeName(union)}` };
		if (self === undefined) {
			return this.#json(
				union,
				hint,
				"an anonymous union of literals here has nothing to be named after",
			);
		}
		const { name, owner } = self;
		const reservedLiteral = this.#reservedName(union, hint, name);
		if (reservedLiteral !== undefined) {
			this.#enums.set(union, reservedLiteral);
			return reservedLiteral;
		}
		this.#warnShared(union, self);
		const ref = named(name, true);
		this.#enums.set(union, ref);
		if (!this.#book.claim(name, owner)) return ref;
		const values = [...union.variants.values()].flatMap((variant) =>
			variant.type.kind === "String" || variant.type.kind === "Number"
				? [
						{
							name: enumValueNameOf(String(variant.type.value)),
							wire: variant.type.value,
							description: getDoc(this.#program, variant),
							deprecationReason: getDeprecationDetails(this.#program, variant)?.message,
						},
					]
				: [],
		);
		this.#register(
			{ kind: "enum", name, description: getDoc(this.#program, union), values },
			owner,
		);
		return ref;
	}

	/**
	 * A `@discriminated` union, as a GraphQL union whose `resolveType` reads the discriminator.
	 *
	 * **Without an envelope the members are the variant models themselves.** With one (the default,
	 * `{ kind, value }`), the wire value is the envelope, so each member is a generated object type
	 * `<Union><Variant>` carrying the discriminator and the variant under its envelope key: the fields a
	 * client selects are the ones the wire value has.
	 */
	#discriminatedUnion(
		union: Union,
		discriminated: DiscriminatedUnion,
		hint: TypeHint | undefined,
	): TypeRef {
		const cached = this.#outputs.get(union);
		if (cached !== undefined) return cached;
		// `@discriminated` decorates a declared union: an anonymous one is an expression, never decorated.
		const name = declaredNameOf(this.#program, union);
		const owner = `union ${getTypeName(union)}`;
		const reservedUnion = this.#reservedName(union, hint, name);
		if (reservedUnion !== undefined) return reservedUnion;
		if (discriminated.defaultVariant !== undefined) {
			return this.#json(union, hint, "its default variant carries no discriminator value");
		}
		const { envelope, discriminatorPropertyName, envelopePropertyName } = discriminated.options;
		const ref = named(name, true);
		const mapping: Record<string, string> = {};
		if (envelope === "none") {
			/**
			 * **Decided whole wherever it is reached.** A variant that holds the union reaches it again
			 * while its own fields are projected, and is answered by the whole union, so a later variant
			 * that makes it `JSON` makes that field `JSON` too; the union's name handed out first was a
			 * type never defined. Each variant is a model, cached as its projection starts, so this ends.
			 */
			for (const [key, type] of discriminated.variants) {
				this.#ref(
					type,
					OUTPUT,
					{ name: `${name}${typeNameOf(key)}`, owner: `${owner}.${key}` },
					undefined,
				);
				// By the name the variant took before its fields, which a variant mid-projection has.
				const member = this.outputNameOf(type);
				if (member === undefined) {
					return this.#json(
						union,
						hint,
						`variant ${key} is not a model that projects to an object type`,
					);
				}
				mapping[key] = member;
			}
		} else {
			// An envelope always projects, so the name is handed out first: a variant may be the union
			// itself, with no model between to end the recursion.
			this.#outputs.set(union, ref);
			for (const [key, type] of discriminated.variants) {
				const member = { name: `${name}${typeNameOf(key)}`, owner: `${owner}.${key}` };
				this.define({
					kind: "object",
					name: member.name,
					description: undefined,
					fields: [
						this.#plainField(discriminatorPropertyName, named("String", true)),
						// An anonymous variant is named after the property holding it, apart from its envelope.
						this.#plainField(
							envelopePropertyName,
							this.#ref(
								type,
								OUTPUT,
								{
									name: `${member.name}${typeNameOf(envelopePropertyName)}`,
									owner: `${member.owner}.${envelopePropertyName}`,
								},
								undefined,
							),
						),
					],
				});
				mapping[key] = member.name;
			}
		}
		if (this.#book.claim(name, owner)) {
			this.#register(
				{
					kind: "union",
					name,
					description: getDoc(this.#program, union),
					members: Object.values(mapping),
					resolveBy: { kind: "discriminator", property: discriminatorPropertyName, mapping },
				},
				owner,
			);
		}
		return ref;
	}

	/**
	 * **A `@discriminator` base model with derived models: the interface `<Name>Interface`, implemented
	 * by the base's own object type and by each subtype.**
	 *
	 * - **The base is a value of its own.** The library validates a base as the document does
	 *   (OAS 3.1.1 § 4.8.25): the dispatch to its subtypes, then the base itself, so a value whose
	 *   discriminator names no subtype is served as the base. A GraphQL union's members are object
	 *   types, so the base is one, `<Name>`, with its own fields; no subtype's.
	 * - **An interface, not a union.** Every member carries the base's fields, which an interface
	 *   guarantees and a union does not (GraphQL § 3.7, § 3.8); `<Name>Interface` is upstream's name for
	 *   a model that is both an object type and an interface (`naming.ts`).
	 * - **A nested base** (`Shark` under `Fish`) is its own interface, implementing its parent's, and
	 *   is resolved by its own rule.
	 * - **Resolved by the wire key the discriminator names**, `propertyName`, as openapi3 publishes
	 *   `discriminator.propertyName` and the library dispatches (`z.discriminatedUnion`), whatever
	 *   `@encodedName` the base's own declaration of that property carries.
	 * - **A subtype only where its own validator accepts the value**, imported by the name the
	 *   library publishes for it (`typeSchemaNames`): the library's dispatch to a subtype matched
	 *   exactly then (OAS 3.1.1 § 4.8.25), and otherwise the value is the base.
	 *
	 * Decided wherever it is reached, as a discriminated union without an envelope is: a derived model
	 * may hold its base, and each is a model, cached as its projection starts. The interface's fields
	 * are decided once every member's are, by `defineInterfaces`.
	 */
	#inheritanceInterface(model: Model, discriminator: Discriminator): TypeRef {
		const name = declaredNameOf(this.#program, model);
		const interfaceName = `${name}Interface`;
		const reservedBase =
			this.#reservedName(model, undefined, name) ??
			this.#reservedName(model, undefined, interfaceName);
		if (reservedBase !== undefined) return reservedBase;
		if (this.#carriesAdditionalProperties(model)) {
			return this.#json(
				model,
				undefined,
				"it carries additional properties, which a GraphQL object type cannot",
			);
		}
		const owner = `model ${getTypeName(model)}`;
		const [hierarchy] = getDiscriminatedUnionFromInheritance(model, discriminator);
		const property = discriminator.propertyName;
		const mapping: Record<string, BaseMember> = {};
		const members = [name];
		for (const [key, derived] of hierarchy.variants) {
			this.#model(derived, OUTPUT, undefined, undefined);
			// No validator the library publishes, a declaration refused whole: no value is one.
			const schema = this.#typeSchemaNames.get(derived);
			const nested = this.#baseInterfaces.get(derived);
			const nestedDef = nested === undefined ? undefined : this.#defs.get(nested);
			if (nestedDef?.kind === "interface" && nestedDef.resolveBy !== undefined) {
				if (schema !== undefined) mapping[key] = { schema, rule: nestedDef.resolveBy.rule };
				members.push(...(nestedDef.members ?? []));
				this.#defs.set(nestedDef.name, {
					...nestedDef,
					interfaces: [...new Set([...(nestedDef.interfaces ?? []), interfaceName])].toSorted(),
				});
				continue;
			}
			// By name, as for a discriminated union: a derived model holding its base is mid-projection.
			const member = this.outputNameOf(derived);
			if (member === undefined) {
				return this.#json(
					model,
					undefined,
					`derived model ${derived.name} does not project to an object type`,
				);
			}
			if (schema !== undefined) mapping[key] = { schema, type: member };
			members.push(member);
		}
		// Only once every subtype is an object type: a hierarchy that is `JSON` declares no base object.
		this.#baseObject(model, discriminator, name, owner);
		const interfaceOwner = `${owner} as an interface`;
		if (this.#book.claim(interfaceName, interfaceOwner)) {
			// A parent base names this one's interface as implementing its own, after this ran.
			const existing = this.#defs.get(interfaceName);
			const parents = existing?.kind === "interface" ? existing.interfaces : undefined;
			this.#register(
				{
					kind: "interface",
					name: interfaceName,
					description: getDoc(this.#program, model),
					fields: [],
					...(parents === undefined ? {} : { interfaces: parents }),
					members: [...new Set(members)],
					resolveBy: { kind: "base", rule: { property, mapping, base: name } },
				},
				interfaceOwner,
			);
			this.#baseInterfaces.set(model, interfaceName);
		}
		return named(interfaceName, true);
	}

	/**
	 * The base's own object type: its own fields, and the discriminator where no property of the base
	 * is sent under its wire key, as `@typespec/openapi3` adds it to the base (`type: string`) and the
	 * library validates it. Built once, and set before its fields, which may hold the base again.
	 */
	#baseObject(model: Model, discriminator: Discriminator, name: string, owner: string): void {
		if (this.#baseObjects.has(model)) return;
		this.#baseObjects.set(model, name);
		if (!this.#book.claim(name, owner)) return;
		const fields = this.#outputFields(model, { name, owner });
		if (this.#discriminatorDeclarationOf(model, discriminator.propertyName) === undefined) {
			fields.push(this.#plainField(discriminator.propertyName, named("String", true)));
		}
		this.#register(
			{ kind: "object", name, description: getDoc(this.#program, model), fields },
			owner,
		);
	}

	/** The property sent under `wire` on `model` or the nearest model above it, if any declares one. */
	#discriminatorDeclarationOf(model: Model, wire: string): ModelProperty | undefined {
		return this.#declaringOf(model, wire)?.declared;
	}

	/** The model declaring a property sent under `wire`, `model` or the nearest above it, with it. */
	#declaringOf(
		model: Model,
		wire: string,
	): { readonly owner: Model; readonly declared: ModelProperty } | undefined {
		for (
			let current: Model | undefined = model;
			current !== undefined;
			current = current.baseModel
		) {
			for (const declared of current.properties.values()) {
				if (wireOf(this.#program, declared) === wire) return { owner: current, declared };
			}
		}
		return undefined;
	}

	/**
	 * **A discriminator, as the base it discriminates declares it**, on every member of a hierarchy:
	 * `Golden`'s `kind: "golden"` is the `DogKind` its base declares, and a discriminator only subtypes
	 * declare is the `String` openapi3 adds to the base. One type for the discriminator across the
	 * hierarchy is what lets every base interface share it. Never null: the library refuses a body
	 * without it, even where the spec wrote it optional. The discriminator is the property sent under
	 * the wire key it names; `undefined` for any other property.
	 */
	#discriminatorFieldTypeOf(model: Model, property: ModelProperty): TypeRef | undefined {
		for (
			let current: Model | undefined = model;
			current !== undefined;
			current = current.baseModel
		) {
			const wire = wireOf(this.#program, property);
			if (getDiscriminator(this.#program, current)?.propertyName !== wire) continue;
			const declaring = this.#declaringOf(current, wire);
			if (declaring === undefined) return named("String", true);
			const { owner, declared } = declaring;
			const hint = {
				name: declaredNameOf(this.#program, owner),
				owner: `model ${getTypeName(owner)}`,
			};
			const type = this.#ref(
				declared.type,
				OUTPUT,
				this.#memberHint(hint, declared),
				this.#carrierOf(declared),
			);
			return { ...type, nonNull: true };
		}
		return undefined;
	}

	/** A field the emitter generates, named by converting its wire key. */
	#plainField(wire: string, type: TypeRef): OutputFieldPlan {
		return {
			name: fieldNameOf(wire),
			wire,
			type,
			description: undefined,
			deprecationReason: undefined,
			arguments: [],
			call: undefined,
			directives: [],
		};
	}

	#model(
		model: Model,
		position: Position,
		hint: TypeHint | undefined,
		carrier: Carrier | undefined,
	): TypeRef {
		if (isArrayModelType(model)) {
			/**
			 * **An array a property encodes is the text it encodes to.** On the wire,
			 * `@encode(ArrayEncoding.commaDelimited) value: string[]` is one string, `"a,b"`, the library
			 * validates any `@encode` by the type it states (`encodedTypeOf`), and the handler receives that
			 * string, so its GraphQL type is the wire type's. A QUERY parameter so encoded stays a list,
			 * its items as declared: the encoding is its style (`PARAMETER_STYLES`), and the library splits
			 * the text before the handler sees it.
			 */
			const encode = carrier?.encode;
			if (encode !== undefined) return this.#scalar(encode.type, undefined);
			const item =
				hint === undefined
					? undefined
					: { ...hint, name: `${hint.name}Item`, owner: `${hint.owner}[]` };
			return listOf(this.#ref(model.indexer.value, position, item, carrier), true);
		}
		if (model.indexer !== undefined && model.properties.size === 0) {
			return this.#runtimeScalar("JSON");
		}

		const effective = this.#effectiveOf(model, position.visibility);
		if (position.input) {
			position = { input: true, visibility: this.#readingOf(effective, position.visibility) };
		}
		const cache = position.input ? this.#inputCache(position.visibility) : this.#outputs;
		const cached = cache.get(effective);
		if (cached !== undefined) return cached;

		const discriminator = getDiscriminator(this.#program, effective);
		if (discriminator !== undefined && effective.derivedModels.length > 0) {
			// A polymorphic input is JSON, validated by the operation's Zod schema.
			return position.input
				? this.#runtimeScalar("JSON")
				: this.#inheritanceInterface(effective, discriminator);
		}

		/**
		 * **A model that carries additional properties is `JSON`.** `...Record<T>`, `extends Record<T>`
		 * or `is Record<T>` beside declared properties make the wire object open, and a GraphQL object
		 * or input type is closed: projected as one, every additional property was dropped both ways,
		 * silently. `JSON` carries the object exactly, and the library's Zod still validates it.
		 */
		if (this.#carriesAdditionalProperties(effective)) {
			return this.#json(
				effective,
				hint,
				"it carries additional properties, which a GraphQL object type cannot",
			);
		}

		/**
		 * **A request variant is suffixed only where the visibility reshapes the model**, by the
		 * predicate and suffix `typespec-http-zod` names its own declarations with
		 * (`isTransformed`, `getVisibilitySuffix(visibility, Visibility.Read)`): `BookCreate`
		 * there is `BookCreateInput` here. The predicate is `#readingOf`'s, already asked: a
		 * request it did not transform reads at `Read`, which `getVisibilitySuffix` leaves bare, and so
		 * is every output. **The suffix is this model's own reading**, an anonymous one's too: the
		 * cache is keyed by it, so a name carrying the holder's would be whichever holder came first.
		 */
		const suffix = getVisibilitySuffix(position.visibility, Visibility.Read);
		// An anonymous model is named after the member holding it; a declared one, itself.
		const self =
			effective.name === ""
				? hint
				: {
						name: declaredNameOf(this.#program, effective),
						owner: `model ${getTypeName(effective)}`,
					};
		if (self === undefined) {
			return this.#json(
				effective,
				undefined,
				"an anonymous model here has nothing to be named after",
			);
		}
		/**
		 * **A model with no payload property under this visibility is `JSON`.** GraphQL forbids an
		 * object or input type with no field (section 3.6.1: "must define one or more fields"), so an
		 * empty model, or one carrying only HTTP metadata, has no type of its own to be. `buildSchema`
		 * refused the `type Empty {}` this used to print.
		 */
		if (this.#payloadOf(effective, position.visibility).length === 0) {
			return this.#json(
				effective,
				hint,
				"it carries no property GraphQL can state, and a GraphQL type needs at least one field",
			);
		}
		const name = `${self.name}${suffix}${position.input ? "Input" : ""}`;
		const reservedModel = this.#reservedName(effective, hint, name);
		if (reservedModel !== undefined) {
			cache.set(effective, reservedModel);
			return reservedModel;
		}
		this.#warnShared(effective, self);
		const owner = ownerAt(self.owner, position);
		const ref = named(name, true);
		// By the effective model alone: a body of one model's spread properties IS that model.
		cache.set(effective, ref);
		if (!this.#book.claim(name, owner)) return ref;

		if (position.input) {
			const fields = this.#inputFields(effective, position, self);
			this.#register(
				{ kind: "input", name, description: getDoc(this.#program, effective), fields },
				owner,
			);
		} else {
			this.#objects.set(effective, name);
			const fields = this.#outputFields(effective, self);
			this.#register(
				{ kind: "object", name, description: getDoc(this.#program, effective), fields },
				owner,
			);
		}
		return ref;
	}

	/**
	 * An open request body, spread into a handler's input: its additional properties are keys of the
	 * input itself, which no closed GraphQL input object can carry. Warned as the model would be.
	 */
	openSpreadBody(model: Model, visibility: Visibility): boolean {
		const effective = this.#effectiveOf(model, visibility);
		if (!this.#carriesAdditionalProperties(effective)) return false;
		this.#json(
			effective,
			undefined,
			"it carries additional properties, which a GraphQL input type cannot",
		);
		return true;
	}

	/**
	 * **The visibility a request reads a model at: openapi3's `reduceContext`**, which
	 * `typespec-http-zod` validates by (`renderedVisibilityOf`, `rootVisibilityOf`). A model the
	 * request's visibility does not transform is its canonical schema, read at `Read`, a read-only
	 * property shared into it as `canShareProperty` says: a create body differing only by a read-only
	 * `id` carries the `id`, optional at 3.0 and required at 3.1 (`#readOnlyOptional`), which OAS
	 * 3.1.1 § 4.8.24.3.2 lets a caller send and the server ignore. A list keeps the visibility it
	 * was reached at, and never reaches here.
	 */
	#readingOf(model: Model, visibility: Visibility): Visibility {
		return this.#metadata.isTransformed(model, visibility) ? visibility : Visibility.Read;
	}

	/** The model a model's value is at a visibility: a body of one model's spread properties IS that model. */
	#effectiveOf(model: Model, visibility: Visibility): Model {
		const effective = this.#metadata.getEffectivePayloadType(model, visibility);
		// `getEffectivePayloadType` answers a model for a model (`@typespec/http`, `metadata.js`).
		if (effective.kind !== "Model")
			throw new Error(`${model.name}: a payload type that is no model`);
		return effective;
	}

	/** An indexer anywhere up the chain, beside declared properties: an open object on the wire. */
	#carriesAdditionalProperties(model: Model): boolean {
		for (
			let current: Model | undefined = model;
			current !== undefined;
			current = current.baseModel
		) {
			if (current.indexer !== undefined && !isArrayModelType(current)) return true;
		}
		return false;
	}

	#inputCache(visibility: Visibility): Map<Type, TypeRef> {
		const existing = this.#inputs.get(visibility);
		if (existing !== undefined) return existing;
		const cache = new Map<Type, TypeRef>();
		this.#inputs.set(visibility, cache);
		return cache;
	}

	/** The properties a model's JSON value carries at a visibility: payload, not metadata, not `never`. */
	#payloadOf(model: Model, visibility: Visibility): ModelProperty[] {
		return propertiesOf(this.#program, model).filter(
			(property) =>
				this.#metadata.isPayloadProperty(property, visibility) && !isNeverType(property.type),
		);
	}

	/**
	 * **A member is named after the model declaring it**, the hint only where no declared model does
	 * (an anonymous model's member). An inherited or spread property is its declaring model's member,
	 * one type wherever it is reached, so a name taken from the model holding it was whichever holder
	 * was projected first. A type that declared models' members hold is named by the first of them
	 * declared (`#heldBy`).
	 */
	#memberHint(hint: TypeHint, property: ModelProperty): TypeHint {
		const held = this.#heldBy(property.type);
		if (held !== undefined) return held;
		const declaring = declaringModelOf(property);
		return memberOf(declaring === undefined ? hint : holderOf(this.#program, declaring), property);
	}

	/**
	 * **What an anonymous type a declared model's member holds is named by: the first such member
	 * declared**, the program's namespaces walked as declared, its own members before its children's.
	 * The name is then the program's, never the order a surface reaches the type in, so a field added
	 * to `graphql.tsp` renames nothing.
	 *
	 * Each member is its declaring model's (`declaringModelOf`), so `Habitat.climate` reached through
	 * `Desert` and `Oasis` is one member. **Two members hold one type** only through an `alias`, which
	 * declares nothing, or by inheriting from an instance whose composed name leaves out an argument
	 * (`Low` and `High` both `extends Crate<"x">`): the hint then carries every holder, for
	 * `anonymous-type-shared`.
	 */
	#heldBy(type: Type): TypeHint | undefined {
		this.#holdings ??= this.#holdingsOf();
		return this.#holdings.get(type);
	}

	/** Every declared model's members, walked once: the map `#heldBy` reads. */
	#holdingsOf(): ReadonlyMap<Type, TypeHint> {
		const found = new Map<Type, { readonly hint: TypeHint; readonly holders: string[] }>();
		const visit = (namespace: Namespace): void => {
			for (const model of inDeclarationOrder(this.#program, namespace.models.values())) {
				if (isTemplateDeclaration(model)) continue;
				for (const property of propertiesOf(this.#program, model)) {
					if (!namedByHint(property.type)) continue;
					const declaring = declaringModelOf(property) ?? model;
					const member = `${getTypeName(declaring)}.${property.name}`;
					const entry = found.get(property.type);
					if (entry === undefined) {
						found.set(property.type, {
							hint: memberOf(holderOf(this.#program, declaring), property),
							holders: [member],
						});
					} else if (!entry.holders.includes(member)) {
						entry.holders.push(member);
					}
				}
			}
			for (const child of inDeclarationOrder(this.#program, namespace.namespaces.values())) {
				visit(child);
			}
		};
		visit(this.#program.getGlobalNamespaceType());
		return new Map(
			[...found].map(([held, { hint, holders }]) => [
				held,
				holders.length === 1 ? hint : { ...hint, holders },
			]),
		);
	}

	/**
	 * `anonymous-type-shared`, once per type, where a shared type takes the first holder's name. Only a
	 * hint `#heldBy` gave carries holders, so a type named by itself is never warned.
	 */
	#warnShared(type: Type, hint: TypeHint): void {
		if (hint.holders === undefined || this.#sharedWarned.has(type)) return;
		this.#sharedWarned.add(type);
		this.#shared.push({ name: hint.name, holders: hint.holders, target: type });
	}

	#outputFields(model: Model, hint: TypeHint): OutputFieldPlan[] {
		return this.#payloadOf(model, Visibility.Read).map((property) => {
			const wire = wireOf(this.#program, property);
			const discriminator = this.#discriminatorFieldTypeOf(model, property);
			const type =
				discriminator ??
				this.#ref(
					property.type,
					OUTPUT,
					this.#memberHint(hint, property),
					this.#carrierOf(property),
				);
			return {
				name: fieldNameOf(wire),
				wire,
				type: property.optional && discriminator === undefined ? asNullable(type) : type,
				description: getDoc(this.#program, property),
				deprecationReason: getDeprecationDetails(this.#program, property)?.message,
				arguments: [],
				call: undefined,
				directives: [],
			};
		});
	}

	#inputFields(model: Model, position: Position, hint: TypeHint): InputFieldPlan[] {
		return this.#payloadOf(model, position.visibility).map((property) => {
			const wire = wireOf(this.#program, property);
			const type = this.#ref(
				property.type,
				position,
				this.#memberHint(hint, property),
				this.#carrierOf(property),
			);
			const optional =
				this.#metadata.isOptional(property, position.visibility) ||
				(this.#readOnlyOptional && isReadonlyProperty(this.#program, property));
			const fieldType = optional ? asNullable(type) : type;
			return {
				name: fieldNameOf(wire),
				wire,
				type: fieldType,
				...inputDeprecation(
					fieldType,
					getDoc(this.#program, property),
					getDeprecationDetails(this.#program, property)?.message,
				),
				dropNull: optional && type.nonNull,
				nullIfAbsent: !optional && !type.nonNull,
				defaultValue: this.defaultLiteralOf(property.defaultValue, fieldType),
			};
		});
	}
}
