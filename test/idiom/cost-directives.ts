import {
	type ConstDirectiveNode,
	type ConstValueNode,
	type GraphQLArgument,
	type GraphQLField,
	type GraphQLSchema,
	getNamedType,
	getNullableType,
	isInterfaceType,
	isListType,
	isNonNullType,
	isObjectType,
	isScalarType,
	Kind,
	print,
} from "graphql";

/**
 * **Every way a schema's use of the IBM cost directives departs from the GraphQL Cost Directives
 * Specification** (ibm.github.io/graphql-specs/cost-spec.html), one line each, citing the section it
 * breaks. The rules are the specification's §9, Validation, stated as it states them:
 *
 * - §9.1: `@cost` defines one argument, `weight: String!`, is not repeatable, and is defined on
 *   ARGUMENT_DEFINITION, ENUM, FIELD_DEFINITION, INPUT_FIELD_DEFINITION, OBJECT and SCALAR;
 * - §7.1: a weight's value is a serialised Float;
 * - §9.1.1: `@cost` is not used on a field of an interface;
 * - §9.2: `@listSize` defines `assumedSize: Int`, `slicingArguments: [String!]`,
 *   `sizedFields: [String!]` and `requireOneSlicingArgument: Boolean = true`, is not repeatable,
 *   and is defined on FIELD_DEFINITION alone;
 * - §9.2.1: `@listSize` is used on a field returning a list, or uses `sizedFields`;
 * - §9.2.2: each sized field is defined on the annotated field's type, and returns a list;
 * - §9.2.3: each slicing argument is defined on the annotated field, as `Int` or `Int!`;
 * - §9.2.4: `assumedSize` beside `slicingArguments` only where no slicing argument has a default
 *   value and `requireOneSlicingArgument` is `false`.
 *
 * Applied directives are read from the schema's AST, as `buildSchema` keeps them.
 */
export function costViolations(schema: GraphQLSchema): string[] {
	const violations: string[] = [];
	const cost = schema.getDirective("cost");
	if (cost !== undefined && cost !== null) {
		const [weight, ...more] = cost.args;
		if (weight?.name !== "weight" || String(weight.type) !== "String!" || more.length > 0) {
			violations.push("@cost does not define exactly weight: String! (§9.1)");
		}
		if (cost.isRepeatable) violations.push("@cost is repeatable (§9.1)");
		const wanted = [
			"ARGUMENT_DEFINITION",
			"ENUM",
			"FIELD_DEFINITION",
			"INPUT_FIELD_DEFINITION",
			"OBJECT",
			"SCALAR",
		];
		if (cost.locations.toSorted().join() !== wanted.join()) {
			violations.push(`@cost is defined on ${cost.locations.toSorted().join(" | ")} (§9.1)`);
		}
	}
	const listSize = schema.getDirective("listSize");
	if (listSize !== undefined && listSize !== null) {
		const shape = listSize.args.map(
			(arg) =>
				`${arg.name}: ${String(arg.type)}${arg.astNode?.defaultValue === undefined ? "" : ` = ${print(arg.astNode.defaultValue)}`}`,
		);
		const wanted = [
			"assumedSize: Int",
			"slicingArguments: [String!]",
			"sizedFields: [String!]",
			"requireOneSlicingArgument: Boolean = true",
		];
		if (shape.toSorted().join() !== wanted.toSorted().join()) {
			violations.push(`@listSize defines (${shape.join(", ")}) (§9.2)`);
		}
		if (listSize.isRepeatable) violations.push("@listSize is repeatable (§9.2)");
		if (listSize.locations.join() !== "FIELD_DEFINITION") {
			violations.push(`@listSize is defined on ${listSize.locations.join(" | ")} (§9.2)`);
		}
	}

	for (const type of Object.values(schema.getTypeMap())) {
		if (type.name.startsWith("__")) continue;
		for (const directive of type.astNode?.directives ?? []) {
			if (directive.name.value === "cost")
				violations.push(...weightViolations(type.name, directive));
		}
		if (!isObjectType(type) && !isInterfaceType(type)) continue;
		for (const field of Object.values(type.getFields())) {
			const coordinate = `${type.name}.${field.name}`;
			for (const directive of field.astNode?.directives ?? []) {
				if (directive.name.value === "cost") {
					violations.push(...weightViolations(coordinate, directive));
					if (isInterfaceType(type)) {
						violations.push(`${coordinate} carries @cost on an interface field (§9.1.1)`);
					}
				}
				if (directive.name.value === "listSize") {
					violations.push(...listSizeViolations(coordinate, field, directive));
				}
			}
			for (const arg of field.args) {
				for (const directive of arg.astNode?.directives ?? []) {
					if (directive.name.value === "cost") {
						violations.push(...weightViolations(`${coordinate}(${arg.name}:)`, directive));
					}
				}
			}
		}
	}
	return violations;
}

/** §7.1: "the value of the String may be a serialized Float"; every implementation must accept one. */
function weightViolations(coordinate: string, directive: ConstDirectiveNode): string[] {
	const weight = argumentOf(directive, "weight");
	if (weight?.kind !== Kind.STRING || !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(weight.value)) {
		return [`${coordinate} has a @cost weight that is not a serialised Float (§7.1)`];
	}
	return [];
}

function listSizeViolations(
	coordinate: string,
	field: GraphQLField<unknown, unknown>,
	directive: ConstDirectiveNode,
): string[] {
	const violations: string[] = [];
	const sizedFields = stringsOf(argumentOf(directive, "sizedFields"));
	const slicing = stringsOf(argumentOf(directive, "slicingArguments"));
	const assumedSize = argumentOf(directive, "assumedSize");
	const requireOne = argumentOf(directive, "requireOneSlicingArgument");

	if (!isListType(getNullableType(field.type)) && sizedFields.length === 0) {
		violations.push(
			`${coordinate} carries @listSize but returns no list and sizes no field (§9.2.1)`,
		);
	}
	const returned = getNamedType(field.type);
	for (const name of sizedFields) {
		const sized =
			isObjectType(returned) || isInterfaceType(returned) ? returned.getFields()[name] : undefined;
		if (sized === undefined) {
			violations.push(
				`${coordinate} sizes ${name}, which ${returned.name} does not define (§9.2.2)`,
			);
		} else if (!isListType(getNullableType(sized.type))) {
			violations.push(
				`${coordinate} sizes ${returned.name}.${name}, which returns no list (§9.2.2)`,
			);
		}
	}
	const slicingArguments: GraphQLArgument[] = [];
	for (const name of slicing) {
		const arg = field.args.find((candidate) => candidate.name === name);
		if (arg === undefined) {
			violations.push(`${coordinate} slices by ${name}, which it does not define (§9.2.3)`);
			continue;
		}
		slicingArguments.push(arg);
		const nullable = isNonNullType(arg.type) ? arg.type.ofType : arg.type;
		if (!isScalarType(nullable) || nullable.name !== "Int") {
			violations.push(
				`${coordinate} slices by ${name}, which is ${String(arg.type)}, not Int (§9.2.3)`,
			);
		}
	}
	if (assumedSize !== undefined && slicing.length > 0) {
		const defaulted = slicingArguments.filter((arg) => arg.astNode?.defaultValue !== undefined);
		if (defaulted.length > 0) {
			violations.push(
				`${coordinate} has assumedSize beside slicing argument ${defaulted.map((arg) => arg.name).join(", ")}, which has a default value (§9.2.4)`,
			);
		}
		if (requireOne?.kind !== Kind.BOOLEAN || requireOne.value) {
			violations.push(
				`${coordinate} has assumedSize beside slicingArguments without requireOneSlicingArgument: false (§9.2.4)`,
			);
		}
	}
	return violations;
}

function argumentOf(directive: ConstDirectiveNode, name: string): ConstValueNode | undefined {
	return directive.arguments?.find((arg) => arg.name.value === name)?.value;
}

function stringsOf(value: ConstValueNode | undefined): string[] {
	if (value === undefined) return [];
	if (value.kind === Kind.STRING) return [value.value];
	if (value.kind !== Kind.LIST) return [];
	return value.values.flatMap((item) => (item.kind === Kind.STRING ? [item.value] : []));
}
