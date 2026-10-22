import { describe, expect, it } from "vitest";
import { z } from "zod";
import { baseTypeOf, discriminatedTypeOf } from "../../src/runtime.js";

/**
 * **A discriminated union's `resolveType`: the member its discriminator's wire value names**
 * (design.md § Types). TypeSpec's `@discriminator` values are strings, and only the body's own
 * property is read: anything else names no member, so graphql-js refuses the value rather than
 * resolving it as the wrong type.
 */

const petType = discriminatedTypeOf("kind", { cat: "Cat", dog: "Dog", "1": "One" });

describe("discriminatedTypeOf", () => {
	it.each([
		["the member the wire value names", { kind: "cat", name: "Tom" }, "Cat"],
		["another member", { kind: "dog" }, "Dog"],
		["no member for a value the mapping does not hold", { kind: "fish" }, undefined],
		["no member for a key the mapping only inherits", { kind: "toString" }, undefined],
		["no member for a wire value that is not a string", { kind: 1 }, undefined],
		["no member for a body with no discriminator", {}, undefined],
		[
			"no member for a discriminator the body only inherits",
			Object.create({ kind: "cat" }) as object,
			undefined,
		],
		["no member for null", null, undefined],
		["no member for a value that is not an object", "cat", undefined],
	])("answers %s", (_case, value, expected) => {
		expect(petType(value)).toBe(expected);
	});

	/** A string has properties of its own, its characters: none of them is a discriminator. */
	it("reads no property of a string, even one the discriminator names", () => {
		const byFirst = discriminatedTypeOf("0", { c: "Cat" });
		expect(byFirst({ "0": "c" })).toBe("Cat");
		expect(byFirst("cat")).toBeUndefined();
	});
});

/**
 * **A `@discriminator` base's `resolveType`: the subtype its discriminator names where that
 * subtype's validator accepts the value, a nested base by its own rule, and the base's own object type
 * for every other value** (design.md § Types). The values reach it as the library parsed them, and
 * the validators are Zod schemas as `schemas.gen.ts` declares them: `Salmon` adds `river`, `Shark`
 * its own discriminator `sharktype`, and `SawShark` adds `teeth`.
 */
const salmonSchema = z.object({ kind: z.literal("salmon"), age: z.int32(), river: z.string() });
const sawSharkSchema = z.object({
	kind: z.literal("shark"),
	age: z.int32(),
	sharktype: z.literal("saw"),
	teeth: z.int32(),
});
const sharkSchema = z.union([
	z.discriminatedUnion("sharktype", [sawSharkSchema]),
	z.object({ kind: z.literal("shark"), age: z.int32(), sharktype: z.string() }),
]);

const fishType = baseTypeOf({
	property: "kind",
	mapping: {
		salmon: { schema: salmonSchema, type: "Salmon" },
		shark: {
			schema: sharkSchema,
			rule: {
				property: "sharktype",
				mapping: { saw: { schema: sawSharkSchema, type: "SawShark" } },
				base: "Shark",
			},
		},
	},
	base: "Fish",
});

describe("baseTypeOf", () => {
	it.each([
		["the subtype the discriminator names", { kind: "salmon", age: 1, river: "Tay" }, "Salmon"],
		[
			"the base, for a value naming a subtype it is no valid instance of",
			{ kind: "salmon", age: 1 },
			"Fish",
		],
		[
			"a nested base's subtype, by its own discriminator",
			{ kind: "shark", age: 1, sharktype: "saw", teeth: 3 },
			"SawShark",
		],
		[
			"a nested base, for a value naming its subtype that is no valid instance of it",
			{ kind: "shark", age: 1, sharktype: "saw" },
			"Shark",
		],
		[
			"a nested base, for a value its mapping does not hold",
			{ kind: "shark", age: 1, sharktype: "nurse" },
			"Shark",
		],
		["the base, for a value that is no valid nested base", { kind: "shark", age: 1 }, "Fish"],
		["the base, for a value the mapping does not hold", { kind: "trout", age: 1 }, "Fish"],
		["the base, for a key the mapping only inherits", { kind: "toString", age: 1 }, "Fish"],
		["the base, for a wire value that is not a string", { kind: 1, age: 1 }, "Fish"],
		["the base, for a body with no discriminator", { age: 1 }, "Fish"],
		[
			"the base, for a discriminator the body only inherits",
			Object.assign(Object.create({ kind: "salmon" }) as object, { age: 1, river: "Tay" }),
			"Fish",
		],
	])("answers %s", (_case, value, expected) => {
		expect(fishType(value)).toBe(expected);
	});

	it("answers the base for a wire value that is not a string, though its text is a mapped value", () => {
		const levelType = baseTypeOf({
			property: "level",
			mapping: { "1": { schema: z.object({ level: z.unknown() }), type: "First" } },
			base: "Level",
		});
		expect(levelType({ level: "1" })).toBe("First");
		expect(levelType({ level: 1 })).toBe("Level");
	});
});
