import { fileURLToPath } from "node:url";
import type { Program } from "@typespec/compiler";
import type { EmittedService } from "typespec-http-zod";
import { beforeAll, describe, expect, it } from "vitest";
import { named } from "../../src/model.js";
import { NameBook } from "../../src/names.js";
import { queryResultOf } from "../../src/results.js";
import { TypeProjector } from "../../src/types.js";
import { emittedServicesOf } from "../support/compile-fixture.js";
import { refusalsOf } from "../support/refused-fixtures.js";

/**
 * **A body declared `never` still plans, passed over as the library passes over it.**
 *
 * `typespec-http-zod` refuses one with the error `never-body`, and an emit carries on past a
 * library's error. The library declares no schema for such a body, so were it read here as a body,
 * the planner's agreement with the library's arms would fail and the emitter would throw on a
 * program the library had already refused.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let program: Program;
let service: EmittedService;
beforeAll(async () => {
	const emitted = await emittedServicesOf(
		here,
		"refused-never",
		"refused-never",
		refusalsOf("results/refused-never"),
	);
	const [only] = emitted.services;
	if (only === undefined) throw new Error("refused-never.tsp declares no service");
	program = emitted.program;
	service = only;
});

function query(fieldName: string) {
	const operationId = `Widgets_${fieldName}`;
	const route = service.routes.find((candidate) => candidate.operationId === operationId);
	const operation = service.operations.get(operationId);
	if (route === undefined || operation === undefined) throw new Error(`no ${operationId}`);
	const projector = new TypeProjector(program, new NameBook(), service.typeSchemaNames);
	return queryResultOf(program, route, operation, projector, fieldName, undefined);
}

describe("a body declared never", () => {
	it("is passed over for the status's other body", () => {
		expect(query("nevered")).toEqual({
			type: named("Widget", false),
			projection: { "200": { as: "value" } },
		});
	});

	it("is no body on an error status", () => {
		expect(query("gone")).toEqual({
			type: named("Widget", false),
			projection: { "200": { as: "value" }, "410": { as: "error", code: "GONE" } },
		});
	});
});
