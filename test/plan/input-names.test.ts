import { fileURLToPath } from "node:url";
import { buildSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import type { SchemaPlan } from "../../src/model.js";
import { planService } from "../../src/plan.js";
import { renderSdl } from "../../src/sdl.js";
import { surfaceOf } from "../../src/surface.js";
import { serviceOf } from "../support/service-of.js";

/**
 * **A model named as an input type is keeps its name as one** (`input-names.tsp`), as
 * `@typespec/graphql` names it (`applyInputSuffix`), and HotChocolate: `AuthorInput`, not
 * `AuthorInputInput`. Where the model is also an output type, the output owns the name and the input
 * type keeps the suffix, so no two types share one.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let plan: SchemaPlan;

beforeAll(async () => {
	const { program, emitted } = await serviceOf(here, "input-names");
	plan = planService(program, emitted, surfaceOf(program, emitted)).plan;
}, 300_000);

describe("an input type whose model is named as one", () => {
	it("keeps the model's name, and is the type the fields that take it name", () => {
		const inputs = plan.types.filter((def) => def.kind === "input").map((def) => def.name);
		expect(inputs).toContain("AuthorInput");
		expect(inputs).not.toContain("AuthorInputInput");
		// A model named as no input type is takes the suffix, as before.
		expect(inputs).toContain("DraftInput");
		expect(inputs).not.toContain("Draft");
		const create = plan.types.find((def) => def.name === "CreateBookInput");
		if (create?.kind !== "input") throw new Error("no CreateBookInput");
		const authors = create.fields.find((field) => field.name === "authors");
		expect(authors?.type).toEqual({
			kind: "list",
			nonNull: true,
			of: { kind: "named", name: "AuthorInput", nonNull: true },
		});
	});

	it("keeps the suffix where the model's output type owns the name", () => {
		const shelves = plan.types
			.filter((def) => def.name.startsWith("ShelfInput"))
			.map((def) => `${def.kind} ${def.name}`);
		expect(shelves.toSorted()).toEqual(["input ShelfInputInput", "object ShelfInput"]);
	});

	it("keeps the suffix on both where two input types are planned from one model", () => {
		const editions = plan.types
			.filter((def) => def.name.startsWith("EditionCreateInput"))
			.map((def) => `${def.kind} ${def.name}`);
		expect(editions.toSorted()).toEqual([
			"input EditionCreateInputCreateInput",
			"input EditionCreateInputInput",
		]);
	});

	it("writes a schema graphql-js builds", () => {
		const schema = buildSchema(renderSdl(plan));
		expect(schema.getType("AuthorInput")?.toString()).toBe("AuthorInput");
		expect(schema.getType("ShelfInputInput")?.toString()).toBe("ShelfInputInput");
	});
});
