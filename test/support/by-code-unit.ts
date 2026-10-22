/**
 * `Array.prototype.sort`'s default order, spelled out: each element as a string, compared by UTF-16
 * code unit. Passed where the type-aware lint asks for an explicit comparator, so the order an
 * assertion expects stays the order it always meant. `localeCompare` would not do: it is
 * locale-aware, and folds case.
 */
export function byCodeUnit(a: unknown, b: unknown): number {
	const left = String(a);
	const right = String(b);
	return left < right ? -1 : left > right ? 1 : 0;
}
