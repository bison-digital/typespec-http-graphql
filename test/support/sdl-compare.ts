import {
	buildASTSchema,
	type ConstDirectiveNode,
	Kind,
	lexicographicSortSchema,
	parse,
	print,
	printSchema,
	visit,
} from "graphql";

/**
 * **Two SDLs compared as schemas, not as text**: the comparison the idiom and equivalence oracles
 * make between a hand-written schema and the emitted one. Descriptions are set aside and every list
 * sorted, so names, types, nullability, arguments, enum values, union members, interfaces and
 * directive definitions count; applied directives, which `printSchema` drops, are compared by
 * coordinate on their own.
 */

/** The schema an SDL describes, without descriptions, every list sorted, printed. */
export function normalised(sdl: string): string {
	const document = visit(parse(sdl), {
		enter(node) {
			return "description" in node && node.description !== undefined
				? { ...node, description: undefined }
				: undefined;
		},
	});
	return printSchema(lexicographicSortSchema(buildASTSchema(document)));
}

/** Every applied directive, as `<coordinate> @name(args sorted)`, sorted. */
export function appliedDirectives(sdl: string): string[] {
	const found: string[] = [];
	const record = (at: string, directives: readonly ConstDirectiveNode[] | undefined): void => {
		for (const directive of directives ?? []) {
			const sorted = {
				...directive,
				arguments: [...(directive.arguments ?? [])].toSorted((a, b) =>
					a.name.value.localeCompare(b.name.value),
				),
			};
			found.push(`${at} ${print(sorted)}`);
		}
	};
	for (const definition of parse(sdl).definitions) {
		switch (definition.kind) {
			case Kind.OBJECT_TYPE_DEFINITION:
			case Kind.INTERFACE_TYPE_DEFINITION:
				record(definition.name.value, definition.directives);
				for (const field of definition.fields ?? []) {
					const at = `${definition.name.value}.${field.name.value}`;
					record(at, field.directives);
					for (const argument of field.arguments ?? []) {
						record(`${at}(${argument.name.value}:)`, argument.directives);
					}
				}
				break;
			case Kind.INPUT_OBJECT_TYPE_DEFINITION:
				record(definition.name.value, definition.directives);
				for (const field of definition.fields ?? []) {
					record(`${definition.name.value}.${field.name.value}`, field.directives);
				}
				break;
			case Kind.ENUM_TYPE_DEFINITION:
				record(definition.name.value, definition.directives);
				for (const value of definition.values ?? []) {
					record(`${definition.name.value}.${value.name.value}`, value.directives);
				}
				break;
			case Kind.SCALAR_TYPE_DEFINITION:
			case Kind.UNION_TYPE_DEFINITION:
				record(definition.name.value, definition.directives);
				break;
			default:
				break;
		}
	}
	return found.toSorted();
}
