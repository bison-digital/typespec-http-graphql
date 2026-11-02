import { fileURLToPath } from "node:url";
import { buildSchema, isInterfaceType } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import type { OutputFieldPlan, SchemaPlan } from "../../src/model.js";
import { planService } from "../../src/plan.js";
import { renderSdl } from "../../src/sdl.js";
import { surfaceOf } from "../../src/surface.js";
import { serviceOf } from "../support/service-of.js";

/**
 * **An interface's list field states the bound its implementers' fields state** (`interface-lists.tsp`):
 * `@listSize` is a field definition's directive, so an analyser costing a selection on the interface
 * reads the interface's field, and finds the bound the book's and the magazine's fields carry.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let plan: SchemaPlan;

beforeAll(async () => {
	const { program, emitted } = await serviceOf(here, "interface-lists");
	plan = planService(program, emitted, surfaceOf(program, emitted)).plan;
}, 300_000);

const fieldsOf = (kind: "object" | "interface", name: string): readonly OutputFieldPlan[] => {
	const def = plan.types.find((candidate) => candidate.kind === kind && candidate.name === name);
	if (def?.kind !== "object" && def?.kind !== "interface") throw new Error(`no ${kind} ${name}`);
	return def.fields;
};
const directivesOf = (kind: "object" | "interface", type: string, field: string) =>
	fieldsOf(kind, type).find((candidate) => candidate.name === field)?.directives;

describe("an interface's list field", () => {
	it("states the bound every implementer's field states, and none where they state none", () => {
		const bound = [{ name: "listSize", arguments: { assumedSize: 4 } }];
		expect(directivesOf("object", "Book", "marks")).toEqual(bound);
		expect(directivesOf("object", "Magazine", "marks")).toEqual(bound);
		expect(directivesOf("interface", "PublicationInterface", "marks")).toEqual(bound);
		expect(directivesOf("interface", "PublicationInterface", "notes")).toEqual([]);
	});

	it("states none where its implementers' fields state different bounds", () => {
		const bounds = ["Poster", "Flyer", "Banner", "Sticker"].map((type) =>
			directivesOf("object", type, "stamps"),
		);
		expect(bounds.map((bound) => bound?.[0]?.arguments)).toEqual([
			{ assumedSize: 3 },
			{ assumedSize: 3 },
			{ assumedSize: 1 },
			{ assumedSize: 1 },
		]);
		expect(directivesOf("interface", "NoticeInterface", "stamps")).toEqual([]);
	});

	it("states a @discriminator base's bound, which its members share", () => {
		const bound = [{ name: "listSize", arguments: { assumedSize: 5 } }];
		expect(directivesOf("object", "Medal", "judges")).toEqual(bound);
		expect(directivesOf("interface", "PrizeInterface", "judges")).toEqual(bound);
	});

	it("writes it in the schema, which graphql-js builds", () => {
		const sdl = renderSdl(plan);
		const schema = buildSchema(sdl);
		const publication = schema.getType("PublicationInterface");
		if (!isInterfaceType(publication)) throw new Error("no PublicationInterface");
		const marks = publication.getFields()["marks"]?.astNode;
		expect(marks?.directives?.map((d) => d.name.value)).toEqual(["listSize"]);
	});
});
