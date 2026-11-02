import {
	getMaxItems,
	isArrayModelType,
	isNullType,
	type ModelProperty,
	type Program,
	type Type,
} from "@typespec/compiler";

/**
 * **What a property's list is**: the array its type names and the most items it holds. One rule for
 * the two readers that need it, a link bound to a list and an object field that is one, so a list
 * bounded for one is bounded for the other.
 */

/** A type with `null` removed: its variants, or the type itself where it is no union. */
export function nonNullVariantsOf(type: Type): readonly Type[] {
	if (type.kind !== "Union") return [type];
	return [...type.variants.values()]
		.map((variant) => variant.type)
		.filter((variant) => !isNullType(variant));
}

/** A property's list, and the type of its items, where its one non-null variant is an array. */
export function boundListOf(
	type: Type,
): { readonly array: Type; readonly items: Type } | undefined {
	const [only, ...others] = nonNullVariantsOf(type);
	if (only === undefined || others.length > 0) return undefined;
	if (only.kind !== "Model" || !isArrayModelType(only)) return undefined;
	return { array: only, items: only.indexer.value };
}

/**
 * **The most items a property's list holds**: its own `@maxItems`, else its array type's, which the
 * operation's Zod schema enforces on every answer. `undefined` where neither states one, or where the
 * property is no list.
 */
export function maxItemsOf(program: Program, property: ModelProperty): number | undefined {
	const list = boundListOf(property.type);
	if (list === undefined) return undefined;
	return getMaxItems(program, property) ?? getMaxItems(program, list.array);
}
