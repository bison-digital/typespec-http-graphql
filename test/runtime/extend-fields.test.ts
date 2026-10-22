import { describe, expect, it } from "vitest";
import { extendFields } from "../../src/runtime.js";

/**
 * **The escape hatch's merge** (design.md § The escape hatch): a consumer's hand-written fields join
 * the generated ones, and "a collision with a generated field throws when the schema is built,
 * naming both".
 */

const generated = { book: "generated book", author: "generated author" };

describe("extendFields", () => {
	it("hands back the generated fields where there is no extension", () => {
		expect(extendFields("Query", generated, undefined)).toBe(generated);
	});

	it("adds the extension's fields beside the generated ones", () => {
		expect(extendFields("Query", generated, { health: "extension health" })).toEqual({
			book: "generated book",
			author: "generated author",
			health: "extension health",
		});
	});

	it("throws on a field the generated type already has, naming both", () => {
		expect(() =>
			extendFields("Query", generated, { health: "extension health", author: "extension author" }),
		).toThrow(
			new Error(
				"The extension's field Query.author collides with the generated field Query.author; " +
					"rename the extension's field",
			),
		);
	});
});
