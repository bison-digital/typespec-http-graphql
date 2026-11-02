import { fileURLToPath } from "node:url";
import type { Model, ModelProperty } from "@typespec/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { boundListOf, maxItemsOf } from "../../src/lists.js";
import { type CompiledService, serviceOf } from "../support/service-of.js";

/**
 * **What a property's list is, and the most items it holds** (`lists.ts`), over `lists.tsp`: a list
 * is a property whose one non-null variant is an array, and its bound is the property's `@maxItems`,
 * else its array type's.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let compiled: CompiledService;
let shelf: Model;

beforeAll(async () => {
	compiled = await serviceOf(here, "lists");
	const found = compiled.emitted.service.namespace.models.get("Shelf");
	if (found === undefined) throw new Error("no Shelf");
	shelf = found;
}, 300_000);

const property = (name: string): ModelProperty => {
	const found = shelf.properties.get(name);
	if (found === undefined) throw new Error(`no ${name}`);
	return found;
};

describe("a property's list", () => {
	it("is its type's one non-null variant, an array, with that array's items", () => {
		const tags = boundListOf(property("tags").type);
		expect(tags?.array).toBe(property("tags").type);
		expect(tags?.items.kind).toBe("Scalar");
		const maybe = boundListOf(property("maybe").type);
		expect(maybe?.array.kind).toBe("Model");
		expect(maybe?.array).not.toBe(property("maybe").type);
		const codes = boundListOf(property("codes").type);
		expect((codes?.array as Model | undefined)?.name).toBe("Codes");
	});

	it("is no list where two variants are not null, or where the one is no array", () => {
		expect(boundListOf(property("either").type)).toBeUndefined();
		expect(boundListOf(property("title").type)).toBeUndefined();
	});

	it("holds at most its own @maxItems, else its array type's, and nothing otherwise", () => {
		expect(maxItemsOf(compiled.program, property("tags"))).toBe(2);
		expect(maxItemsOf(compiled.program, property("maybe"))).toBe(5);
		expect(maxItemsOf(compiled.program, property("codes"))).toBe(4);
		expect(maxItemsOf(compiled.program, property("pairs"))).toBeUndefined();
		expect(maxItemsOf(compiled.program, property("either"))).toBeUndefined();
		expect(maxItemsOf(compiled.program, property("flag"))).toBeUndefined();
	});
});
