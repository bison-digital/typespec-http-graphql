import { fileURLToPath } from "node:url";
import type { Program } from "@typespec/compiler";
import type { EmittedService } from "typespec-http-zod";
import { beforeAll, describe, expect, it } from "vitest";
import { named } from "../../src/model.js";
import { NameBook } from "../../src/names.js";
import { mutationResultOf } from "../../src/results.js";
import { TypeProjector } from "../../src/types.js";
import { emittedServicesOf } from "../support/compile-fixture.js";
import { refusalsOf } from "../support/refused-fixtures.js";

/**
 * **A status range the library refuses still plans, keyed as the library keyed it.**
 *
 * `typespec-http-zod` refuses a range outside 100 to 599, or short of whole classes, with the error
 * `unsupported-status-code-range`, and keys it all the same: below 100 or above 599 as `default`,
 * and every class it reaches as that class. An emit carries on past a library's error, so this
 * emitter plans the operation; were its own keys not the library's, a body the library declares
 * would have no arm here, and planning would throw where it should only stand beside the error.
 *
 * `serviceOf` refuses a fixture with an error, which is why this one is read through
 * `emittedServicesOf` itself, naming the one error it expects.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let program: Program;
let service: EmittedService;
beforeAll(async () => {
	const emitted = await emittedServicesOf(
		here,
		"refused-ranges",
		"refused-ranges",
		refusalsOf("results/refused-ranges"),
	);
	const [only] = emitted.services;
	if (only === undefined) throw new Error("refused-ranges.tsp declares no service");
	program = emitted.program;
	service = only;
});

function mutation(fieldName: string) {
	const operationId = `Widgets_${fieldName}`;
	const route = service.routes.find((candidate) => candidate.operationId === operationId);
	const operation = service.operations.get(operationId);
	if (route === undefined || operation === undefined) throw new Error(`no ${operationId}`);
	const projector = new TypeProjector(program, new NameBook(), service.typeSchemaNames);
	return mutationResultOf(program, route, operation, projector, fieldName);
}

describe("a status range the library refuses", () => {
	it("is refused by the library", () => {
		const refused = program.diagnostics
			.filter((diagnostic) => diagnostic.code === "typespec-http-zod/unsupported-status-code-range")
			.map((diagnostic) => /'(\d+)' to '(\d+)'/.exec(diagnostic.message)?.slice(1).join("-"));
		expect(new Set(refused)).toEqual(new Set(["0-99", "500-999", "499-500"]));
	});

	it.each([
		// Below 100: the library's `default`.
		["below", "BelowResult", { default: { as: "byStatus", nullOn404: false, member: "Below" } }],
		// Above 599: `default`, and the class it starts in.
		[
			"above",
			"AboveResult",
			{
				"5XX": { as: "byStatus", nullOn404: false },
				default: { as: "byStatus", nullOn404: false, member: "Above" },
			},
		],
		// 499 to 500: both classes it reaches, by one code each.
		[
			"straddle",
			"StraddleResult",
			{
				"4XX": { as: "byStatus", nullOn404: false, member: "Straddle" },
				"5XX": { as: "byStatus", nullOn404: false },
			},
		],
	])("plans %s under the keys the library gave it", (fieldName, union, ranged) => {
		expect(mutation(fieldName)).toEqual({
			type: named(union, false),
			projection: { "200": { as: "member", type: "Widget" }, ...ranged },
		});
	});
});
