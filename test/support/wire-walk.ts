import {
	type Enum,
	getDiscriminatedUnion,
	getDiscriminatedUnionFromInheritance,
	getDiscriminator,
	getEncode,
	isArrayModelType,
	isNeverType,
	isNullType,
	isUnknownType,
	type Model,
	type ModelProperty,
	type Program,
	resolveEncodedName,
	type Type,
	type Union,
} from "@typespec/compiler";
import { createMetadataInfo, isMetadata, type MetadataInfo, Visibility } from "@typespec/http";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isReadonlyProperty } from "@typespec/openapi";
import {
	applyBaseNamePipeline,
	applyEnumMemberPipeline,
	applyFieldNamePipeline,
} from "../names/upstream-naming.js";

/**
 * **The independent translator between a wire value and its GraphQL value, for oracles.**
 *
 * Given a TypeSpec type and a value as it crosses the HTTP wire, it answers what the GraphQL surface
 * must answer for it (`output`), how a client writes it as GraphQL input (`input`), and the reverse
 * (`wireOf`). It is the expected side of the verdict and replay oracles, so it is built from
 * nothing the emitter wrote:
 *
 * - **names** come from the vendored upstream pipeline (`test/names/upstream-naming.ts`): a field
 *   is `applyFieldNamePipeline` of the property's JSON wire name, an enum value
 *   `applyEnumMemberPipeline` of its member's name (or of the literal, for a union of literals);
 * - **shapes** come from design.md's type table, restated here by hand, and from TypeSpec's own
 *   libraries (`@typespec/compiler`, `@typespec/http`'s metadata);
 * - nothing is read from `src/`, the emitted modules or the schema they build. The architecture
 *   suite refuses an import of any of them.
 *
 * design.md § Types, as restated: a model is an object type of its payload properties at the
 * position's visibility, unless it has none or its name is one GraphQL owns, when it is `JSON`; a
 * string enum or a union of literals is an enum; `T | null` and an optional property are nullable;
 * `T[]` a list; `Record<T>` and `unknown` are `JSON`; a discriminated union is a GraphQL union as
 * output and `JSON` as input; a `@discriminator` base is an interface its own object type and each
 * subtype implement as output, and `JSON` as input; every other union is `JSON`; every scalar crosses
 * unchanged, because "one scalar, one wire form".
 *
 * **Which object type a base's value is comes from the document**, `@typespec/openapi3`'s, when one
 * is given: by OAS 3.1.1 § 4.8.25 the subtype the base's `discriminator.mapping` names where the value
 * validates against that subtype's schema (Ajv), decided again for a nested base, and otherwise the
 * base itself. The value is answered with its `__typename`.
 *
 * A shape this restatement does not cover throws `Untranslatable`, which an oracle counts as a
 * skip under a ceiling rather than guessing at.
 */

export class Untranslatable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Untranslatable";
	}
}

/** The part of a published schema the base rule reads: its discriminator. */
interface PublishedSchema {
	readonly discriminator?: {
		readonly propertyName: string;
		readonly mapping?: Readonly<Record<string, string>>;
	};
}

/** design.md: "A name GraphQL already owns is never a type of the spec's." Restated by hand. */
const RESERVED = new Set([
	"Query",
	"Mutation",
	"Subscription",
	"String",
	"Int",
	"Float",
	"Boolean",
	"ID",
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
	"Bytes",
	"BytesUrl",
	"URL",
	"JSON",
]);

const own = (record: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(record, key);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Where a value sits: output (Read), or request input at the operation's visibility. */
interface Position {
	readonly input: boolean;
	readonly visibility: Visibility;
}

const OUTPUT: Position = { input: false, visibility: Visibility.Read };

export class WireWalk {
	readonly #program: Program;
	readonly #metadata: MetadataInfo;
	readonly #openApi30Only: boolean;
	readonly #components: Readonly<Record<string, unknown>> | undefined;
	readonly #ajv = new Ajv2020({ strict: false, validateFormats: false, validateSchema: false });

	/** `components`: the document's, by which a base's value is decided; without, one is untranslatable. */
	constructor(program: Program, components?: Readonly<Record<string, unknown>>) {
		this.#program = program;
		this.#components = components;
		// `@typespec/openapi3`'s own view (`openapi.js`): `Read` canonical, a read-only property shared.
		this.#metadata = createMetadataInfo(program, {
			canonicalVisibility: Visibility.Read,
			canShareProperty: (property) => isReadonlyProperty(program, property),
		});
		const options = program.compilerOptions.options?.["@typespec/openapi3"] as
			| { readonly "openapi-versions"?: readonly string[] }
			| undefined;
		const versions = options?.["openapi-versions"] ?? ["3.0.0"];
		this.#openApi30Only = versions.every((version) => version.startsWith("3.0."));
	}

	/** The JSON wire name of a property, as REST carries it. */
	wireName(property: ModelProperty): string {
		return resolveEncodedName(this.#program, property, "application/json");
	}

	/** The GraphQL field or argument name for a wire key, by the upstream pipeline. */
	fieldName(wire: string): string {
		return applyFieldNamePipeline(wire);
	}

	/** The properties a model's JSON value carries at a position: payload, not metadata, not never. */
	payloadOf(model: Model, requested: Visibility): ModelProperty[] {
		const effective = this.#effective(model, requested);
		/**
		 * openapi3 publishes a model the request's visibility does not transform as its canonical
		 * schema (`reduceContext`), so a request carries its read-only properties, optional at 3.0
		 * (`isOptional`).
		 */
		const visibility =
			requested !== Visibility.Read && !this.#metadata.isTransformed(effective, requested)
				? Visibility.Read
				: requested;
		const properties: ModelProperty[] = [];
		const seen = new Set<string>();
		for (
			let current: Model | undefined = effective;
			current !== undefined;
			current = current.baseModel
		) {
			const own: ModelProperty[] = [];
			// One property per wire key, the most derived: openapi3 composes a derived model with `allOf`,
			// so a redeclaration under another `@encodedName` is a second key on the wire.
			for (const property of current.properties.values()) {
				if (seen.has(this.wireName(property))) continue;
				seen.add(this.wireName(property));
				if (!this.#metadata.isPayloadProperty(property, visibility) || isNeverType(property.type)) {
					continue;
				}
				own.push(property);
			}
			properties.unshift(...own);
		}
		return properties;
	}

	/**
	 * Whether a request property is optional at a visibility: PATCH makes every property optional,
	 * and a read-only one is optional where openapi3 publishes OpenAPI 3.0 alone, whose `readOnly`
	 * makes `required` "take effect on the response only" (OAS 3.0.4, Fixed Fields of the Schema
	 * Object). Which versions openapi3 publishes is its own `openapi-versions` option, `["3.0.0"]`
	 * where it is unset (`openapi.js`).
	 */
	isOptional(property: ModelProperty, visibility: Visibility): boolean {
		return (
			this.#metadata.isOptional(property, visibility) ||
			(this.#openApi30Only && isReadonlyProperty(this.#program, property))
		);
	}

	#effective(model: Model, visibility: Visibility): Model {
		const effective = this.#metadata.getEffectivePayloadType(model, visibility);
		return effective.kind === "Model" ? effective : model;
	}

	/** True when design.md projects this type as the `JSON` scalar at this position. */
	isJson(type: Type, position: Position = OUTPUT): boolean {
		switch (type.kind) {
			case "Intrinsic":
				return isUnknownType(type) || isNullType(type);
			case "Union": {
				const present = this.#present(type);
				const [only] = present;
				if (present.length === 1 && only !== undefined) return this.isJson(only, position);
				if (present.every((variant) => variant.kind === "String" || variant.kind === "Number")) {
					return false;
				}
				if (this.#isStringish(present)) return false;
				const [discriminated] = getDiscriminatedUnion(this.#program, type);
				if (discriminated === undefined || position.input) return true;
				return discriminated.defaultVariant !== undefined;
			}
			case "Model": {
				if (isArrayModelType(type)) return false;
				if (type.indexer !== undefined && type.properties.size === 0) return true;
				// design.md: a model with additional properties is `JSON`, being open.
				for (
					let current: Model | undefined = type;
					current !== undefined;
					current = current.baseModel
				) {
					if (current.indexer !== undefined && !isArrayModelType(current)) return true;
				}
				const effective = this.#effective(type, position.visibility);
				const discriminator = getDiscriminator(this.#program, effective);
				if (discriminator !== undefined && effective.derivedModels.length > 0) {
					if (position.input) return true;
					/**
					 * An interface, unless a name it takes is one GraphQL owns, or a subtype has no object
					 * type to be: a nested base is decided by its own subtypes in turn.
					 */
					const name = applyBaseNamePipeline(effective.name);
					if (RESERVED.has(name) || RESERVED.has(`${name}Interface`)) return true;
					const [hierarchy] = getDiscriminatedUnionFromInheritance(effective, discriminator);
					return [...hierarchy.variants.values()].some((derived) => this.isJson(derived));
				}
				if (this.payloadOf(effective, position.visibility).length === 0) return true;
				return effective.name !== "" && RESERVED.has(applyBaseNamePipeline(effective.name));
			}
			case "Enum":
				return RESERVED.has(applyBaseNamePipeline(type.name));
			default:
				return false;
		}
	}

	#present(union: Union): Type[] {
		return [...union.variants.values()]
			.map((variant) => variant.type)
			.filter((type) => !isNullType(type));
	}

	#isStringish(present: readonly Type[]): boolean {
		const isString = (type: Type): boolean =>
			type.kind === "Scalar" && this.#program.checker.isStdType(type, "string");
		return (
			present.some(isString) && present.every((type) => type.kind === "String" || isString(type))
		);
	}

	/** The enum value name a wire value takes, by its member's name (or the literal's own value). */
	#enumName(type: Enum | Union, value: unknown): string {
		if (type.kind === "Enum") {
			for (const member of type.members.values()) {
				if ((member.value ?? member.name) === value) return applyEnumMemberPipeline(member.name);
			}
			throw new Untranslatable(`${String(value)} is no member of enum ${type.name}`);
		}
		for (const variant of type.variants.values()) {
			if (
				(variant.type.kind === "String" || variant.type.kind === "Number") &&
				variant.type.value === value
			) {
				return applyEnumMemberPipeline(String(variant.type.value));
			}
		}
		throw new Untranslatable(`${String(value)} is no literal of the union`);
	}

	#wireOfEnum(type: Enum | Union, name: unknown): unknown {
		if (type.kind === "Enum") {
			for (const member of type.members.values()) {
				if (applyEnumMemberPipeline(member.name) === name) return member.value ?? member.name;
			}
			throw new Untranslatable(`${String(name)} names no member of enum ${type.name}`);
		}
		for (const variant of type.variants.values()) {
			if (
				(variant.type.kind === "String" || variant.type.kind === "Number") &&
				applyEnumMemberPipeline(String(variant.type.value)) === name
			) {
				return variant.type.value;
			}
		}
		throw new Untranslatable(`${String(name)} names no literal of the union`);
	}

	// ---------------------------------------------------------------------------------------------
	// Output: what the GraphQL surface must answer for a wire value.
	// ---------------------------------------------------------------------------------------------

	/**
	 * The GraphQL data a fully selected field of `type` answers for the wire `value`, without
	 * `__typename`. An absent value is `null`, as graphql-js answers a nullable field it cannot find.
	 */
	output(type: Type, value: unknown): unknown {
		if (value === null || value === undefined) return null;
		if (this.isJson(type)) return value;
		switch (type.kind) {
			case "Scalar":
			case "String":
			case "Number":
			case "Boolean":
			case "StringTemplate":
				return value;
			case "Enum":
				return this.#enumName(type, value);
			case "EnumMember":
				return this.#enumName(type.enum, value);
			case "UnionVariant":
				return this.output(type.type, value);
			case "Union":
				return this.#outputUnion(type, value);
			case "Model":
				return this.#outputModel(type, value);
			default:
				throw new Untranslatable(`no output rule for a ${type.kind}`);
		}
	}

	#outputUnion(union: Union, value: unknown): unknown {
		const present = this.#present(union);
		const [only] = present;
		if (present.length === 1 && only !== undefined) return this.output(only, value);
		if (present.every((type) => type.kind === "String" || type.kind === "Number")) {
			return this.#enumName(union, value);
		}
		if (this.#isStringish(present)) return value;
		const [discriminated] = getDiscriminatedUnion(this.#program, union);
		if (discriminated === undefined) throw new Untranslatable("a union design.md projects as JSON");
		if (!isRecord(value)) throw new Untranslatable("a discriminated value that is not an object");
		const { envelope, discriminatorPropertyName, envelopePropertyName } = discriminated.options;
		if (envelope === "none") {
			const key = value[discriminatorPropertyName];
			const variant = typeof key === "string" ? discriminated.variants.get(key) : undefined;
			if (variant === undefined) throw new Untranslatable(`no variant ${String(key)}`);
			return this.output(variant, value);
		}
		const key = value[discriminatorPropertyName];
		const variant = typeof key === "string" ? discriminated.variants.get(key) : undefined;
		if (variant === undefined) throw new Untranslatable(`no variant ${String(key)}`);
		return {
			[applyFieldNamePipeline(discriminatorPropertyName)]: key,
			[applyFieldNamePipeline(envelopePropertyName)]: this.output(
				variant,
				value[envelopePropertyName],
			),
		};
	}

	#outputModel(model: Model, value: unknown): unknown {
		if (isArrayModelType(model)) {
			if (!Array.isArray(value)) throw new Untranslatable("a list value that is not an array");
			return value.map((item: unknown) => this.output(model.indexer.value, item));
		}
		const effective = this.#effective(model, Visibility.Read);
		if (!isRecord(value)) throw new Untranslatable("an object value that is not an object");
		const discriminator = getDiscriminator(this.#program, effective);
		if (discriminator !== undefined && effective.derivedModels.length > 0) {
			return this.#outputBase(effective, discriminator.propertyName, value);
		}
		return this.#fieldsOf(effective, value);
	}

	/** A model's own fields, each the output of its property's value, or `null` where it is absent. */
	#fieldsOf(model: Model, value: Readonly<Record<string, unknown>>): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const property of this.payloadOf(model, Visibility.Read)) {
			const wire = this.wireName(property);
			const discriminating = this.#discriminatingDeclarationOf(model, wire);
			result[applyFieldNamePipeline(wire)] = own(value, wire)
				? this.#delimited(property)
					? value[wire]
					: this.output(discriminating?.type ?? property.type, value[wire])
				: null;
		}
		return result;
	}

	/**
	 * design.md: a discriminator is output as the base it discriminates declares it, on every member;
	 * the declaration that base or one above it makes, `undefined` for any other property. The
	 * discriminator is the wire key the document's `discriminator.propertyName` names (OAS 3.1.1
	 * § 4.8.25), so a property is found by the key it is sent under.
	 */
	#discriminatingDeclarationOf(model: Model, wire: string): ModelProperty | undefined {
		for (
			let current: Model | undefined = model;
			current !== undefined;
			current = current.baseModel
		) {
			if (getDiscriminator(this.#program, current)?.propertyName !== wire) continue;
			for (let above: Model | undefined = current; above !== undefined; above = above.baseModel) {
				for (const declared of above.properties.values()) {
					if (this.wireName(declared) === wire) return declared;
				}
			}
			return undefined;
		}
		return undefined;
	}

	/**
	 * A base's value, as the type the document says it is (OAS 3.1.1 § 4.8.25), with its `__typename`:
	 * the subtype the mapping names where the value validates against its schema, and otherwise the
	 * base, its own fields and the discriminator where only its subtypes declare it.
	 */
	#outputBase(
		base: Model,
		discriminatorName: string,
		value: Readonly<Record<string, unknown>>,
	): Record<string, unknown> {
		const components = this.#components;
		if (components === undefined) throw new Untranslatable("a base's value, with no document");
		const published = (
			components["schemas"] as Readonly<Record<string, PublishedSchema>> | undefined
		)?.[base.name];
		if (published?.discriminator === undefined) {
			throw new Untranslatable(`no published base ${base.name}`);
		}
		const discriminator = getDiscriminator(this.#program, base);
		if (discriminator === undefined) throw new Untranslatable(`${base.name} discriminates nothing`);
		const [hierarchy] = getDiscriminatedUnionFromInheritance(base, discriminator);
		const tag = value[published.discriminator.propertyName];
		const derived = typeof tag === "string" ? hierarchy.variants.get(tag) : undefined;
		if (typeof tag === "string" && derived !== undefined) {
			const ref = published.discriminator.mapping?.[tag];
			if (ref === undefined)
				throw new Untranslatable(`${base.name} publishes no mapping for ${tag}`);
			if (this.#ajv.validate({ $ref: ref, components }, value)) {
				const output = this.output(derived, value);
				return isRecord(output) && own(output, "__typename")
					? { ...output }
					: { __typename: applyBaseNamePipeline(derived.name), ...(output as object) };
			}
		}
		const fields = this.#fieldsOf(base, value);
		if (this.#discriminatingDeclarationOf(base, discriminatorName) === undefined) {
			fields[applyFieldNamePipeline(discriminatorName)] = value[discriminatorName] ?? null;
		}
		return { __typename: applyBaseNamePipeline(base.name), ...fields };
	}

	// ---------------------------------------------------------------------------------------------
	// Input: how a client writes a wire value as GraphQL input, and back.
	// ---------------------------------------------------------------------------------------------

	/** The GraphQL input value a client sends for the wire `value` of `type` at `visibility`. */
	input(type: Type, value: unknown, visibility: Visibility): unknown {
		const position: Position = { input: true, visibility };
		if (value === null || value === undefined) return value;
		if (this.isJson(type, position)) return value;
		switch (type.kind) {
			case "Scalar":
			case "String":
			case "Number":
			case "Boolean":
			case "StringTemplate":
				return value;
			case "Enum":
				return this.#enumName(type, value);
			case "EnumMember":
				return this.#enumName(type.enum, value);
			case "UnionVariant":
				return this.input(type.type, value, visibility);
			case "Union": {
				const present = this.#present(type);
				const [only] = present;
				if (present.length === 1 && only !== undefined) return this.input(only, value, visibility);
				if (present.every((variant) => variant.kind === "String" || variant.kind === "Number")) {
					return this.#enumName(type, value);
				}
				if (this.#isStringish(present)) return value;
				throw new Untranslatable("an input union design.md does not project");
			}
			case "Model": {
				if (isArrayModelType(type)) {
					if (!Array.isArray(value)) return this.input(type.indexer.value, value, visibility);
					return value.map((item: unknown) => this.input(type.indexer.value, item, visibility));
				}
				if (!isRecord(value)) throw new Untranslatable("an input object that is not an object");
				const result: Record<string, unknown> = {};
				for (const property of this.payloadOf(type, visibility)) {
					const wire = this.wireName(property);
					if (own(value, wire))
						result[applyFieldNamePipeline(wire)] = this.#delimited(property)
							? value[wire]
							: this.input(property.type, value[wire], visibility);
				}
				return result;
			}
			default:
				throw new Untranslatable(`no input rule for a ${type.kind}`);
		}
	}

	/**
	 * The wire value a GraphQL input value reaches the handler as.
	 *
	 * README: "An explicit `null` for an optional field that is not `| null` is treated as absent, as
	 * REST sees an omitted key. A `| null` field keeps its `null`." Restated here for object fields;
	 * `dropNull(key)` tells the caller the same for a top-level argument.
	 */
	wireOf(type: Type, value: unknown, visibility: Visibility): unknown {
		const position: Position = { input: true, visibility };
		if (value === null || value === undefined) return value;
		if (this.isJson(type, position)) return value;
		switch (type.kind) {
			case "Enum":
				return this.#wireOfEnum(type, value);
			case "EnumMember":
				return this.#wireOfEnum(type.enum, value);
			case "UnionVariant":
				return this.wireOf(type.type, value, visibility);
			case "Union": {
				const present = this.#present(type);
				const [only] = present;
				if (present.length === 1 && only !== undefined) return this.wireOf(only, value, visibility);
				if (present.every((variant) => variant.kind === "String" || variant.kind === "Number")) {
					return this.#wireOfEnum(type, value);
				}
				return value;
			}
			case "Model": {
				if (isArrayModelType(type)) {
					// GraphQL § Input Coercion, list: a value that is not a list is a list of one.
					return Array.isArray(value)
						? value.map((item: unknown) => this.wireOf(type.indexer.value, item, visibility))
						: [this.wireOf(type.indexer.value, value, visibility)];
				}
				if (!isRecord(value)) return value;
				const result: Record<string, unknown> = {};
				for (const property of this.payloadOf(type, visibility)) {
					const wire = this.wireName(property);
					const name = applyFieldNamePipeline(wire);
					if (!own(value, name)) continue;
					const item = value[name];
					if (item === null && this.dropsNull(property, visibility)) continue;
					result[wire] = this.wireOfProperty(property, item, visibility);
				}
				return result;
			}
			default:
				return value;
		}
	}

	/**
	 * design.md: an array a payload property encodes as delimited text
	 * (`@encode(ArrayEncoding.commaDelimited)`) is that text, a `String`, in both directions; the
	 * library validates it as `z.string()`. A parameter so encoded stays a list: the library splits it.
	 */
	#delimited(property: ModelProperty): boolean {
		return (
			!isMetadata(this.#program, property) &&
			getEncode(this.#program, property)?.encoding?.startsWith("ArrayEncoding.") === true
		);
	}

	/** `wireOf` for one property's value, honouring the property's own encoding. */
	wireOfProperty(property: ModelProperty, value: unknown, visibility: Visibility): unknown {
		return this.#delimited(property) ? value : this.wireOf(property.type, value, visibility);
	}

	/** True when a `null` for this property means "absent": optional, and not `| null` itself. */
	dropsNull(property: ModelProperty, visibility: Visibility): boolean {
		return this.isOptional(property, visibility) && !this.isNullable(property.type);
	}

	/** True when `null` is one of the type's own values (`T | null`, `null`, `unknown`). */
	isNullable(type: Type): boolean {
		if (type.kind === "Intrinsic") return isNullType(type) || isUnknownType(type);
		if (type.kind === "Union")
			return [...type.variants.values()].some((variant) => isNullType(variant.type));
		if (type.kind === "UnionVariant") return this.isNullable(type.type);
		return false;
	}
}
