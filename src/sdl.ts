import { buildSchema, validateSchema } from "graphql";
import type {
	AppliedDirective,
	DefaultLiteral,
	ArgumentPlan,
	DirectiveArgument,
	InputFieldPlan,
	OutputFieldPlan,
	SchemaPlan,
	TypeDef,
	TypeRef,
} from "./model.js";

/**
 * **`schema.graphql`, from the plan: the published SDL, with applied directives.**
 *
 * Printed here rather than by graphql-js's `printSchema`, because `printSchema` drops applied
 * directives and `@cost`/`@listSize` are the point of publishing them. Checked with `buildSchema`
 * and `validateSchema` before it is returned, and graded against the schema `createSchema` builds
 * by `test/emit/sdl-agreement.test.ts`, so the two renderings of one plan cannot drift.
 */

/**
 * The cost directive definitions, as IBM's specification writes them
 * (https://ibm.github.io/graphql-specs/cost-spec.html). `runtime.ts`'s `CostDirective` and
 * `ListSizeDirective` are the same definitions; the SDL agreement oracle compares the two.
 */
const COST_DIRECTIVES = `directive @cost(weight: String!) on ARGUMENT_DEFINITION | ENUM | FIELD_DEFINITION | INPUT_FIELD_DEFINITION | OBJECT | SCALAR

directive @listSize(assumedSize: Int, slicingArguments: [String!], sizedFields: [String!], requireOneSlicingArgument: Boolean = true) on FIELD_DEFINITION`;

/** A GraphQL string literal. JSON's escapes are a subset of GraphQL's, so JSON's spelling is one. */
function quoted(text: string): string {
	return JSON.stringify(text);
}

function isBlank(line: string): boolean {
	return /^[ \t]*$/.test(line);
}

/**
 * Whether `text` survives as a block string printed one line per line at a fixed indent.
 *
 * A block string's value is dedented by the common indentation and loses leading and trailing
 * blank lines (GraphQL spec, BlockStringValue), so a description that starts or ends with a blank
 * line, contains `\r`, or whose every line is indented would read back differently. Those are
 * printed as an ordinary string instead.
 */
function blockSafe(text: string): boolean {
	if (text.includes("\r")) return false;
	const lines = text.split("\n");
	if (isBlank(lines[0] ?? "") || isBlank(lines[lines.length - 1] ?? "")) return false;
	return lines.some((line) => !isBlank(line) && !/^[ \t]/.test(line));
}

function description(text: string | undefined, indent: string): string {
	if (text === undefined) return "";
	if (!blockSafe(text)) return `${indent}${quoted(text)}\n`;
	const body = text
		.replaceAll('"""', '\\"""')
		.split("\n")
		.map((line) => (line === "" ? "" : `${indent}${line}`))
		.join("\n");
	return `${indent}"""\n${body}\n${indent}"""\n`;
}

function deprecated(reason: string | undefined): string {
	return reason === undefined ? "" : ` @deprecated(reason: ${quoted(reason)})`;
}

function typeRef(ref: TypeRef): string {
	const inner = ref.kind === "named" ? ref.name : `[${typeRef(ref.of)}]`;
	return ref.nonNull ? `${inner}!` : inner;
}

function directiveValue(value: DirectiveArgument): string {
	if (typeof value === "string") return quoted(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return `[${value.map((item) => quoted(item)).join(", ")}]`;
}

function applied(directives: readonly AppliedDirective[]): string {
	return directives
		.map((directive) => {
			const args = Object.entries(directive.arguments).map(
				([name, value]) => `${name}: ${directiveValue(value)}`,
			);
			return args.length === 0 ? ` @${directive.name}` : ` @${directive.name}(${args.join(", ")})`;
		})
		.join("");
}

/** A default as the GraphQL literal `schema.graphql` prints after `=`. */
function defaultOf(literal: DefaultLiteral | undefined): string {
	if (literal === undefined) return "";
	switch (literal.kind) {
		case "NULL":
			return " = null";
		case "STRING":
			return ` = ${quoted(literal.value)}`;
		case "BOOLEAN":
			return ` = ${String(literal.value)}`;
		default:
			return ` = ${literal.value}`;
	}
}

/** One argument's text after its name: type, default, deprecation. */
function argumentText(arg: ArgumentPlan): string {
	return `${arg.name}: ${typeRef(arg.type)}${defaultOf(arg.defaultValue)}${deprecated(arg.deprecationReason)}`;
}

function argumentList(args: readonly ArgumentPlan[], indent: string): string {
	if (args.length === 0) return "";
	if (args.every((arg) => arg.description === undefined)) {
		return `(${args.map(argumentText).join(", ")})`;
	}
	const lines = args.map(
		(arg) => `${description(arg.description, `${indent}  `)}${indent}  ${argumentText(arg)}`,
	);
	return `(\n${lines.join("\n")}\n${indent})`;
}

function outputField(field: OutputFieldPlan): string {
	return `${description(field.description, "  ")}  ${field.name}${argumentList(field.arguments, "  ")}: ${typeRef(field.type)}${deprecated(field.deprecationReason)}${applied(field.directives)}`;
}

function inputField(field: InputFieldPlan): string {
	return `${description(field.description, "  ")}  ${field.name}: ${typeRef(field.type)}${defaultOf(field.defaultValue)}${deprecated(field.deprecationReason)}`;
}

function objectType(
	name: string,
	text: string | undefined,
	fields: readonly OutputFieldPlan[],
	interfaces: readonly string[] = [],
): string {
	const implemented = interfaces.length === 0 ? "" : ` implements ${interfaces.join(" & ")}`;
	return `${description(text, "")}type ${name}${implemented} {\n${fields.map(outputField).join("\n")}\n}`;
}

function typeDefinition(def: TypeDef): string {
	switch (def.kind) {
		case "object":
			return objectType(def.name, def.description, def.fields, def.interfaces);
		case "interface": {
			const implemented =
				def.interfaces === undefined || def.interfaces.length === 0
					? ""
					: ` implements ${def.interfaces.join(" & ")}`;
			return `${description(def.description, "")}interface ${def.name}${implemented} {\n${def.fields.map(outputField).join("\n")}\n}`;
		}
		case "input":
			return `${description(def.description, "")}input ${def.name} {\n${def.fields.map(inputField).join("\n")}\n}`;
		case "enum":
			return `${description(def.description, "")}enum ${def.name} {\n${def.values
				.map(
					(value) =>
						`${description(value.description, "  ")}  ${value.name}${deprecated(value.deprecationReason)}`,
				)
				.join("\n")}\n}`;
		case "union":
			return `${description(def.description, "")}union ${def.name} = ${def.members.join(" | ")}`;
		case "scalar":
			return `${description(def.description, "")}scalar ${def.name}${
				def.specifiedBy === undefined ? "" : ` @specifiedBy(url: ${quoted(def.specifiedBy)})`
			}`;
	}
}

/** The SDL of one service's schema: directive definitions, Query, Mutation, then types by name. */
export function renderSdl(plan: SchemaPlan): string {
	const definitions = [
		...(plan.usesCost ? [COST_DIRECTIVES] : []),
		objectType("Query", undefined, plan.query),
		...(plan.mutation.length > 0 ? [objectType("Mutation", undefined, plan.mutation)] : []),
		...plan.types
			.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
			.map(typeDefinition),
	];
	const sdl = `# GENERATED by typespec-http-graphql from the TypeSpec service definition. DO NOT EDIT.\n\n${definitions.join("\n\n")}\n`;

	/**
	 * **Checked before it is written.** `buildSchema` refuses SDL that does not parse or names an
	 * unknown type or directive; `validateSchema` refuses a schema graphql-js would not serve.
	 */
	let errors: readonly { readonly message: string }[];
	try {
		errors = validateSchema(buildSchema(sdl));
	} catch (error) {
		errors = [{ message: error instanceof Error ? error.message : String(error) }];
	}
	if (errors.length > 0) {
		throw new Error(
			`typespec-http-graphql internal invariant: schema.graphql is not a valid schema:\n` +
				errors.map((error) => `  ${error.message}`).join("\n"),
		);
	}
	return sdl;
}
