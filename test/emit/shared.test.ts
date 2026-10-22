import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertObjectType, getNamedType, type GraphQLSchema, validateSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { type CompiledFixture, compileFixture } from "../support/compile-fixture.js";

/**
 * **An anonymous type members of two declared models hold is one GraphQL type, named after the first
 * declared, and warned.** Named after whichever holder `graphql.tsp` reached first, a field added
 * before it renamed the type a client selects; the fixture's `paint` and `high` come first there.
 */
const here = fileURLToPath(new URL(".", import.meta.url));

interface Generated {
	readonly createSchema: (handlersFor: (context: object) => object, deps: object) => GraphQLSchema;
}

let compiled: CompiledFixture;
let schema: GraphQLSchema;
beforeAll(async () => {
	compiled = await compileFixture(join(here, "shared"), "main", { outName: "emit-shared" });
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as Generated;
	schema = generated.createSchema(() => ({}), {
		authorize: () => "allow" as const,
		context: () => "caller",
	});
}, 300_000);

const fieldTypeOf = (type: string, field: string): string | undefined =>
	getNamedType(assertObjectType(schema.getType(type)).getFields()[field]?.type)?.name;

describe("an anonymous type two declared models hold", () => {
	it("builds a valid schema", () => {
		expect(validateSchema(schema)).toEqual([]);
	});

	it("is one type, named after the holder declared first", () => {
		expect(fieldTypeOf("Lamp", "tone")).toBe("LampTone");
		expect(fieldTypeOf("Paint", "tone")).toBe("LampTone");
		expect(schema.getType("PaintTone")).toBeUndefined();
		expect(fieldTypeOf("Low", "contents")).toBe("LowContents");
		expect(fieldTypeOf("High", "contents")).toBe("LowContents");
		expect(schema.getType("HighContents")).toBeUndefined();
	});

	it("is warned once each, naming the holders and the name", () => {
		expect(
			compiled.messages
				.filter((m) => m.code === "typespec-http-graphql/anonymous-type-shared")
				.map((m) => m.message)
				.toSorted(),
		).toEqual([
			"'Shared.Lamp.tone', 'Shared.Paint.tone' hold one anonymous type, named 'LampTone' after the first of them declared, so declaring another holder before it renames the GraphQL type. Declare it as a model, union or enum to give it a name of its own.",
			"'Shared.Low.contents', 'Shared.High.contents' hold one anonymous type, named 'LowContents' after the first of them declared, so declaring another holder before it renames the GraphQL type. Declare it as a model, union or enum to give it a name of its own.",
		]);
	});
});
