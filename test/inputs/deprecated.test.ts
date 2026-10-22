import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, isInputObjectType, validateSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { mutationInputsOf } from "../../src/inputs.js";
import type { TypeDef } from "../../src/model.js";
import { NameBook } from "../../src/names.js";
import { TypeProjector } from "../../src/types.js";
import { compileFixture, type CompiledFixture } from "../support/compile-fixture.js";
import { rootField } from "../support/fields.js";
import { type CompiledService, serviceOf } from "../support/service-of.js";

/**
 * **A required input field deprecated in TypeSpec keeps its reason in its description.** GraphQL
 * refuses `@deprecated` on a non-null input field or argument ("Required input field … cannot be
 * deprecated"), and deprecating a field while it is still required is the ordinary first step of a
 * migration, so the emitter must not crash on it. An optional one keeps `@deprecated` itself.
 */
const here = fileURLToPath(new URL(".", import.meta.url));

let service: CompiledService;
let compiled: CompiledFixture;
beforeAll(async () => {
	service = await serviceOf(here, "deprecated");
	compiled = await compileFixture(here, "deprecated");
}, 120_000);

function fieldOf(types: TypeProjector, type: string, field: string) {
	const def = types
		.defs()
		.find(
			(candidate): candidate is Extract<TypeDef, { kind: "input" }> =>
				candidate.kind === "input" && candidate.name === type,
		);
	const found = def?.fields.find((candidate) => candidate.name === field);
	if (found === undefined) throw new Error(`${type} has no input field ${field}`);
	return found;
}

describe("a deprecated input field", () => {
	it("carries a required one's reason in its description, never as @deprecated", () => {
		const types = new TypeProjector(
			service.program,
			new NameBook(),
			service.emitted.typeSchemaNames,
		);
		mutationInputsOf(
			service.program,
			rootField(service, "Gizmos_create", "mutation", "createGizmo"),
			types,
		);
		for (const [field, reason] of [
			["name", "use label"],
			["xLegacy", "send X-Gizmo-Version instead"],
		] as const) {
			const plan = fieldOf(types, "CreateGizmoInput", field);
			expect(plan.type.nonNull, field).toBe(true);
			expect(plan.deprecationReason, field).toBeUndefined();
			expect(plan.description, field).toContain(`Deprecated: ${reason}`);
		}
	});

	it("keeps @deprecated on an optional one", () => {
		const types = new TypeProjector(
			service.program,
			new NameBook(),
			service.emitted.typeSchemaNames,
		);
		mutationInputsOf(
			service.program,
			rootField(service, "Gizmos_create", "mutation", "createGizmo"),
			types,
		);
		expect(fieldOf(types, "CreateGizmoInput", "nickname").deprecationReason).toBe(
			"dropped next release",
		);
	});

	it("emits a schema graphql-js builds, rather than crashing the emitter", () => {
		expect(compiled.messages.filter((message) => /crashed/.test(message.message))).toEqual([]);
		const schema = buildSchema(readFileSync(join(compiled.outDir, "schema.graphql"), "utf8"));
		expect(validateSchema(schema)).toEqual([]);
		const input = schema.getType("CreateGizmoInput");
		if (!isInputObjectType(input)) throw new Error("no CreateGizmoInput");
		expect(input.getFields()["name"]?.description).toContain("Deprecated: use label");
		expect(input.getFields()["nickname"]?.deprecationReason).toBe("dropped next release");
	});
});
