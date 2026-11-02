import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppliedDirective, OutputFieldPlan, TypeDef } from "../../src/model.js";
import { planService, type PlannedService } from "../../src/plan.js";
import { type Surface, surfaceOf } from "../../src/surface.js";
import { serviceOf } from "../support/service-of.js";

/**
 * **A field's `weight` multiplies the weight it is given for the calls it makes** (`FieldOptions`),
 * over `weights.tsp`, every expected weight worked by hand: a root field and a mutation by their
 * own, a list link by its list's `@maxItems`, a batched link by `ceil(L / n)`, a link chosen by a
 * kind as its costliest arm. A weight that is no number of calls drops the declaration.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let planned: PlannedService;
let surface: Surface;

beforeAll(async () => {
	const { program, emitted } = await serviceOf(here, "weights");
	surface = surfaceOf(program, emitted);
	planned = planService(program, emitted, surface);
}, 300_000);

const directivesOf = (field: OutputFieldPlan | undefined): readonly AppliedDirective[] =>
	field?.directives ?? [];

function root(name: string): OutputFieldPlan | undefined {
	return [...planned.plan.query, ...planned.plan.mutation].find((field) => field.name === name);
}

function link(name: string): OutputFieldPlan | undefined {
	const book = planned.plan.types.find(
		(def): def is Extract<TypeDef, { kind: "object" }> =>
			def.kind === "object" && def.name === "Book",
	);
	return book?.fields.find((field) => field.name === name);
}

const cost = (weight: string): AppliedDirective => ({ name: "cost", arguments: { weight } });

describe("a field's weight", () => {
	it("multiplies a root field's and a mutation's weight, and is 1 where none is stated", () => {
		expect(directivesOf(root("book"))).toEqual([cost("2")]);
		expect(directivesOf(root("createBook"))).toEqual([cost("2")]);
		expect(directivesOf(root("editor"))).toEqual([cost("1")]);
	});

	it("multiplies a connection's weight, and leaves its list size as it was", () => {
		const [weight, size] = directivesOf(root("books"));
		expect(weight).toEqual(cost("3"));
		expect(size?.name).toBe("listSize");
	});

	it("multiplies a list link's calls per value, and a batched link's calls per batch", () => {
		expect(directivesOf(link("editors"))).toEqual([
			cost("6"),
			{ name: "listSize", arguments: { assumedSize: 3 } },
		]);
		expect(directivesOf(link("tagged"))).toEqual([
			cost("0.2"),
			{ name: "listSize", arguments: { assumedSize: 4 } },
		]);
	});

	it("writes a product to fifteen digits, and one past the largest double as that double", () => {
		expect(directivesOf(link("editorsLight"))[0]).toEqual(cost("0.3"));
		expect(directivesOf(link("editorsHeavy"))[0]).toEqual(cost("1.7976931348623157e+308"));
		expect(directivesOf(link("free"))).toEqual([cost("0")]);
	});

	it("weighs a link chosen by a kind as its costliest arm, each arm by its own weight", () => {
		expect(directivesOf(link("subject"))).toEqual([cost("5")]);
	});

	it("drops a declaration whose weight is no number of calls, naming it", () => {
		const refused = surface.dropped.filter((diagnostic) => diagnostic.code === "invalid-weight");
		expect(refused.map((diagnostic) => diagnostic.format)).toEqual([
			{ weight: "1e", declaration: "@queryField 'authors' on 'Authors_batchGet'" },
			{ weight: "-1", declaration: "@link 'signed' on 'Book'" },
			{ weight: "two", declaration: "@link 'words' on 'Book'" },
			{ weight: "", declaration: "@link 'empty' on 'Book'" },
			{ weight: "1e400", declaration: "@link 'huge' on 'Book'" },
			{ weight: "1e-400", declaration: "@link 'tiny' on 'Book'" },
		]);
		expect(root("authors")).toBeUndefined();
		expect(["signed", "words", "empty", "huge", "tiny"].map(link)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});
