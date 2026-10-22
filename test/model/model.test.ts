import { assertName } from "graphql";
import { describe, expect, it } from "vitest";
import { asNullable, listOf, named, RUNTIME_SCALARS } from "../../src/model.js";
import { SCALAR_DEFINITIONS } from "../../src/types.js";

describe("TypeRef constructors", () => {
	it("build the shapes every stage speaks", () => {
		expect(named("Widget", true)).toEqual({ kind: "named", name: "Widget", nonNull: true });
		expect(listOf(named("Widget", true), false)).toEqual({
			kind: "list",
			of: { kind: "named", name: "Widget", nonNull: true },
			nonNull: false,
		});
	});

	it("asNullable clears only the outer non-null, and copies", () => {
		const list = listOf(named("Widget", true), true);
		expect(asNullable(list)).toEqual({
			kind: "list",
			of: { kind: "named", name: "Widget", nonNull: true },
			nonNull: false,
		});
		expect(list.nonNull).toBe(true);
	});
});

describe("RUNTIME_SCALARS", () => {
	it("are distinct GraphQL names, none of them built in", () => {
		expect(new Set(RUNTIME_SCALARS).size).toBe(RUNTIME_SCALARS.length);
		for (const name of RUNTIME_SCALARS) {
			expect(() => assertName(name)).not.toThrow();
			expect(["String", "Int", "Float", "Boolean", "ID"]).not.toContain(name);
		}
	});

	it("each have exactly one definition in types.ts", () => {
		expect(Object.keys(SCALAR_DEFINITIONS).sort()).toEqual([...RUNTIME_SCALARS].sort());
	});
});
