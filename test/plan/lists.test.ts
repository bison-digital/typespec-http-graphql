import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { OutputFieldPlan, TypeDef } from "../../src/model.js";
import { planService } from "../../src/plan.js";
import { surfaceOf } from "../../src/surface.js";
import { serviceOf } from "../support/service-of.js";

/**
 * **A list bounded by `@maxItems` is planned with `@listSize(assumedSize:)`** (cost specification
 * §8.1), over `../limits/lists.tsp`, where `emitted.test.ts` measures the Type Cost it gives; here
 * the plan itself, read from `src/` so the mutation run sees it.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let fields: readonly OutputFieldPlan[];

beforeAll(async () => {
	const { program, emitted } = await serviceOf(join(here, "..", "limits"), "lists");
	const { plan } = planService(program, emitted, surfaceOf(program, emitted));
	const book = plan.types.find(
		(def): def is Extract<TypeDef, { kind: "object" }> =>
			def.kind === "object" && def.name === "Book",
	);
	fields = book?.fields ?? [];
}, 300_000);

const directivesOf = (name: string) => fields.find((field) => field.name === name)?.directives;

describe("an object's list field", () => {
	it("states the bound of its property, and of its array type", () => {
		expect(directivesOf("tags")).toEqual([{ name: "listSize", arguments: { assumedSize: 10 } }]);
		expect(directivesOf("shelves")).toEqual([{ name: "listSize", arguments: { assumedSize: 3 } }]);
		expect(directivesOf("labels")).toEqual([{ name: "listSize", arguments: { assumedSize: 5 } }]);
	});

	it("states none where nothing bounds it, nor on a field that is no list", () => {
		expect(directivesOf("notes")).toEqual([]);
		// Encoded as one string: `@listSize` is for a field that returns a list (§9.2.1).
		expect(fields.find((field) => field.name === "extra")?.type).toEqual({
			kind: "named",
			name: "String",
			nonNull: true,
		});
		expect(directivesOf("extra")).toEqual([]);
		expect(directivesOf("title")).toEqual([]);
		expect(directivesOf("id")).toEqual([]);
	});
});
