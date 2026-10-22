import {
	type GraphQLInputType,
	type GraphQLObjectType,
	type GraphQLOutputType,
	type GraphQLSchema,
	getNamedType,
	getNullableType,
	isEnumType,
	isInterfaceType,
	isListType,
	isNonNullType,
	isObjectType,
	isScalarType,
	isSpecifiedScalarType,
	isUnionType,
} from "graphql";

/**
 * **Every way a schema's connections depart from the GraphQL Cursor Connections Specification**
 * (relay.dev/graphql/connections.htm), one line each, citing the section it breaks.
 *
 * A type is a connection when its name ends in `Connection` (§2.1), and every field returning one is
 * graded for its arguments. The rules are the specification's, stated as it states them:
 * - §2.1.1: an `edges` field returning a list that wraps an edge type;
 * - §2.1.2: a `pageInfo` field returning a non-null `PageInfo`;
 * - §3.1.1: an edge's `node` is a scalar, enum, object, interface or union, never a list;
 * - §3.1.2: an edge's `cursor` serialises as a String;
 * - §4.1: forward pagination takes `first: Int` and `after: String`;
 * - §5.1: `PageInfo` has `hasPreviousPage` and `hasNextPage` as `Boolean!`, and `startCursor` and
 *   `endCursor` serialising as Strings.
 *
 * "Serialises as a String" admits `String`, `ID` and a custom scalar, as the specification does,
 * since a custom scalar's wire form is not visible in a schema.
 */
export function relayViolations(schema: GraphQLSchema): string[] {
	const violations: string[] = [];
	const types = Object.values(schema.getTypeMap()).filter((type) => !type.name.startsWith("__"));
	const connections = types.filter((type) => type.name.endsWith("Connection"));
	for (const connection of connections) {
		if (isObjectType(connection)) violations.push(...connectionViolations(connection));
		else violations.push(`${connection.name} is not an object type (§2)`);
	}
	if (connections.length > 0) violations.push(...pageInfoViolations(schema));
	for (const type of types) {
		if (!isObjectType(type) && !isInterfaceType(type)) continue;
		for (const field of Object.values(type.getFields())) {
			if (!getNamedType(field.type).name.endsWith("Connection")) continue;
			const first = field.args.find((argument) => argument.name === "first");
			if (
				first === undefined ||
				isNonNullType(first.type) ||
				getNamedType(first.type).name !== "Int"
			) {
				violations.push(`${type.name}.${field.name} has no first: Int argument (§4.1)`);
			}
			const after = field.args.find((argument) => argument.name === "after");
			if (
				after === undefined ||
				isNonNullType(after.type) ||
				getNamedType(after.type).name !== "String"
			) {
				violations.push(`${type.name}.${field.name} has no after: String argument (§4.1)`);
			}
		}
	}
	return violations;
}

function serialisesAsString(type: GraphQLOutputType | GraphQLInputType): boolean {
	const nullable = getNullableType(type);
	return (
		isScalarType(nullable) &&
		(nullable.name === "String" || nullable.name === "ID" || !isSpecifiedScalarType(nullable))
	);
}

function connectionViolations(connection: GraphQLObjectType): string[] {
	const violations: string[] = [];
	const fields = connection.getFields();
	const edges = fields["edges"];
	if (edges === undefined) {
		violations.push(`${connection.name} has no edges field (§2.1.1)`);
	} else {
		const list = getNullableType(edges.type);
		if (!isListType(list)) {
			violations.push(`${connection.name}.edges does not return a list (§2.1.1)`);
		} else {
			const edge = getNullableType(list.ofType);
			if (isObjectType(edge)) violations.push(...edgeViolations(edge));
			else
				violations.push(`${connection.name}.edges is not a list of an edge object type (§2.1.1)`);
		}
	}
	const pageInfo = fields["pageInfo"];
	if (pageInfo === undefined) {
		violations.push(`${connection.name} has no pageInfo field (§2.1.2)`);
	} else if (!isNonNullType(pageInfo.type) || getNamedType(pageInfo.type).name !== "PageInfo") {
		violations.push(`${connection.name}.pageInfo is not PageInfo! (§2.1.2)`);
	}
	return violations;
}

function edgeViolations(edge: GraphQLObjectType): string[] {
	const violations: string[] = [];
	const fields = edge.getFields();
	const node = fields["node"];
	if (node === undefined) {
		violations.push(`${edge.name} has no node field (§3.1.1)`);
	} else {
		const type = getNullableType(node.type);
		if (isListType(type)) {
			violations.push(`${edge.name}.node returns a list (§3.1.1)`);
		} else if (
			!(
				isScalarType(type) ||
				isEnumType(type) ||
				isObjectType(type) ||
				isInterfaceType(type) ||
				isUnionType(type)
			)
		) {
			violations.push(
				`${edge.name}.node is not a scalar, enum, object, interface or union (§3.1.1)`,
			);
		}
	}
	const cursor = fields["cursor"];
	if (cursor === undefined) violations.push(`${edge.name} has no cursor field (§3.1.2)`);
	else if (!serialisesAsString(cursor.type)) {
		violations.push(`${edge.name}.cursor does not serialise as a String (§3.1.2)`);
	}
	return violations;
}

function pageInfoViolations(schema: GraphQLSchema): string[] {
	const pageInfo = schema.getType("PageInfo");
	if (!isObjectType(pageInfo)) return ["PageInfo is not an object type (§5)"];
	const violations: string[] = [];
	const fields = pageInfo.getFields();
	for (const name of ["hasPreviousPage", "hasNextPage"]) {
		const field = fields[name];
		if (
			field === undefined ||
			!isNonNullType(field.type) ||
			getNamedType(field.type).name !== "Boolean"
		) {
			violations.push(`PageInfo.${name} is not Boolean! (§5.1)`);
		}
	}
	for (const name of ["startCursor", "endCursor"]) {
		const field = fields[name];
		if (field === undefined || !serialisesAsString(field.type)) {
			violations.push(`PageInfo.${name} does not serialise as a String (§5.1)`);
		}
	}
	return violations;
}
