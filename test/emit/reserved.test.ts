import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertObjectType, getNamedType, type GraphQLSchema, validateSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { type CompiledFixture, compileFixture } from "../support/compile-fixture.js";
import { sdlAgreement } from "../support/sdl-agreement.js";

/**
 * **A model, enum or union named as GraphQL already names something is `JSON`, with a warning.**
 * `Query`, `Mutation` and `Subscription` are root types; `String`, `Int`, `Float`, `Boolean` and `ID`
 * are built in; `Duration`, `URL`, `JSON` and the rest are this runtime's scalars. A user type under
 * one of those names crashed the emitter (`Query`), failed createSchema at start-up (`String`), or
 * shadowed the scalar depending on declaration order (`Duration`), or advertised a subscription root
 * the runtime lacks (`Subscription`).
 */
const here = fileURLToPath(new URL(".", import.meta.url));

interface Generated {
	readonly createSchema: (handlersFor: (context: object) => object, deps: object) => GraphQLSchema;
}

let compiled: CompiledFixture;
let schema: GraphQLSchema;
beforeAll(async () => {
	compiled = await compileFixture(join(here, "reserved"), "main", { outName: "emit-reserved" });
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as Generated;
	schema = generated.createSchema(() => ({}), {
		authorize: () => "allow" as const,
		context: () => "caller",
	});
}, 300_000);

describe("a type named as GraphQL already names something", () => {
	it("compiles without crashing, and createSchema builds a valid schema", () => {
		expect(validateSchema(schema)).toEqual([]);
	});

	it("projects each such type as JSON, keeping the built-in and runtime scalars intact", () => {
		const fields = assertObjectType(schema.getType("Report")).getFields();
		const typeOf = (name: string) => getNamedType(fields[name]?.type)?.name;
		for (const name of ["query", "subscription", "label", "window", "kind"]) {
			expect(typeOf(name), name).toBe("JSON");
		}
		expect(typeOf("id")).toBe("String");
		expect(typeOf("length")).toBe("Duration");
		expect(schema.getType("Duration")?.toString()).toBe("Duration");
		expect(assertObjectType(schema.getType("Query")).getFields()["report"]).toBeDefined();
		expect(schema.getSubscriptionType()).toBeUndefined();
	});

	it("warns once per reserved name, saying it is reserved", () => {
		const warned = compiled.messages
			.filter((m) => m.code === "typespec-http-graphql/projected-as-json")
			.map((m) => m.message);
		expect(warned).toHaveLength(5);
		for (const message of warned) expect(message).toMatch(/reserved/);
	});

	it("publishes the SDL the runtime builds, with no stray subscription root", () => {
		const sdl = readFileSync(join(compiled.outDir, "schema.graphql"), "utf8");
		const agreement = sdlAgreement(sdl, schema);
		expect(agreement.sdl).toBe(agreement.runtime);
		expect(agreement.disagreements).toEqual([]);
	});
});
