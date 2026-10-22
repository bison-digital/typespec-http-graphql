import { join } from "node:path";
import { buildSchema, type GraphQLSchema, isObjectType } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import type { OutputFieldPlan, SchemaPlan } from "../../src/model.js";
import { named } from "../../src/model.js";
import { renderSdl } from "../../src/sdl.js";
import { PLAN } from "../render/plan-fixture.js";
import { writePlanModule } from "../render/write-plan-module.js";
import { sdlAgreement } from "../support/sdl-agreement.js";

/**
 * **`schema.graphql` is the schema `createSchema` builds.** Both are rendered from one plan by two
 * renderers; this compares them through graphql-js, and checks that every applied directive the
 * plan carries parses back from the SDL. `test/emit/emit.test.ts` runs the same oracle over the
 * files the emitter writes.
 */

interface Generated {
	readonly createSchema: (handlersFor: (context: object) => object, deps: object) => GraphQLSchema;
}

const deps = { authorize: () => "allow" as const, context: () => "caller" };

function plannedDirectives(plan: SchemaPlan): number {
	return [
		...plan.query,
		...plan.mutation,
		...plan.types.flatMap((def) => (def.kind === "object" ? def.fields : [])),
	].reduce((count, field) => count + field.directives.length, 0);
}

describe("the hand-built plan's SDL agrees with its runtime schema", () => {
	let sdl: string;
	let runtime: GraphQLSchema;

	beforeAll(async () => {
		sdl = renderSdl(PLAN);
		const outDir = writePlanModule("sdl-agreement", { sealed: false });
		const generated = (await import(join(outDir, "graphql.gen.ts"))) as Generated;
		runtime = generated.createSchema(() => ({}), deps);
	});

	it("prints identically through buildSchema and through createSchema", () => {
		const agreement = sdlAgreement(sdl, runtime, PLAN);
		expect(agreement.sdl).toBe(agreement.runtime);
		expect(agreement.disagreements).toEqual([]);
	});

	it("applies every planned directive, and the comparison is not vacuous", () => {
		expect(plannedDirectives(PLAN)).toBeGreaterThanOrEqual(6);
		expect(sdlAgreement(sdl, runtime, PLAN).applied).toBe(plannedDirectives(PLAN));
	});

	it("declares the cost directives, scalars' @specifiedBy, and block descriptions", () => {
		expect(sdl).toContain(
			"directive @cost(weight: String!) on ARGUMENT_DEFINITION | ENUM | FIELD_DEFINITION | INPUT_FIELD_DEFINITION | OBJECT | SCALAR",
		);
		expect(sdl).toContain(
			'books(first: Int, after: String, status: BookStatus): BookConnection @cost(weight: "1") @listSize(slicingArguments: ["first"], sizedFields: ["edges", "nodes"], requireOneSlicingArgument: false)',
		);
		expect(sdl).toContain(
			'scalar UTCDateTime @specifiedBy(url: "https://scalars.graphql.org/chillicream/date-time.html")',
		);
		expect(sdl).toContain('  """\n  Add a book.\n\n  The author is optional.\n  """\n');
	});

	it("writes Query, then Mutation, then every type by name", () => {
		const order = [...sdl.matchAll(/^(?:type|interface|input|enum|union|scalar) (\w+)/gm)].map(
			(m) => m[1],
		);
		expect(order.slice(0, 2)).toEqual(["Query", "Mutation"]);
		expect(order.slice(2)).toEqual(PLAN.types.map((def) => def.name).toSorted());
	});
});

/** A field `name: String` carrying `text` as its description and its deprecation reason. */
function describedField(name: string, text: string): OutputFieldPlan {
	return {
		name,
		wire: name,
		type: named("String", false),
		description: text,
		deprecationReason: text,
		arguments: [],
		call: undefined,
		directives: [],
	};
}

describe("renderSdl keeps every description exactly", () => {
	const awkward = [
		"one line",
		"two\nlines",
		'has """ triple quotes',
		"\nstarts with a blank line",
		"ends with a blank line\n",
		"  every line\n  indented",
		"carriage\r\nreturn",
		'ends with a quote"',
		"ends with a backslash\\",
		"tab\tinside",
	];
	for (const text of awkward) {
		it(`reads back ${JSON.stringify(text)} unchanged`, () => {
			const plan: SchemaPlan = {
				types: [
					{
						kind: "object",
						name: "Awkward",
						description: text,
						fields: [describedField("value", text)],
					},
				],
				query: [
					{
						name: "awkward",
						wire: "awkward",
						type: named("Awkward", false),
						description: undefined,
						deprecationReason: undefined,
						arguments: [
							{
								name: "x",
								wire: "x",
								type: named("Int", false),
								description: text,
								deprecationReason: undefined,
								merge: false,
								dropNull: false,
								nullIfAbsent: false,
								defaultValue: undefined,
							},
						],
						call: undefined,
						directives: [],
					},
				],
				mutation: [],
				operations: [],
				statusCodes: {},
				usesCost: false,
			};
			const schema = buildSchema(renderSdl(plan));
			const type = schema.getType("Awkward");
			if (!isObjectType(type)) throw new Error("Awkward is not an object type");
			expect(type.description).toBe(text);
			expect(type.getFields()["value"]?.description).toBe(text);
			expect(type.getFields()["value"]?.deprecationReason).toBe(text);
			expect(schema.getQueryType()?.getFields()["awkward"]?.args[0]?.description).toBe(text);
		});
	}
});

describe("renderSdl refuses a plan graphql-js would not serve", () => {
	it("throws, naming the errors, for a union with an input member", () => {
		const plan: SchemaPlan = {
			types: [
				{ kind: "input", name: "NotAnObject", description: undefined, fields: [] },
				{
					kind: "union",
					name: "Broken",
					description: undefined,
					members: ["NotAnObject"],
					resolveBy: { kind: "member" },
				},
			],
			query: [
				{
					name: "broken",
					wire: "broken",
					type: named("Broken", false),
					description: undefined,
					deprecationReason: undefined,
					arguments: [],
					call: undefined,
					directives: [],
				},
			],
			mutation: [],
			operations: [],
			statusCodes: {},
			usesCost: false,
		};
		expect(() => renderSdl(plan)).toThrow(/schema\.graphql is not a valid schema/);
	});
});
