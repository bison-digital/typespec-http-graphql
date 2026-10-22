import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";

/**
 * **A `@friendlyName` names its type the same in the OpenAPI document, the validators and the
 * GraphQL schema.** `@typespec/openapi3`'s `getOpenAPITypeName` reads it first, and so does
 * typespec-http-zod; read here too, `Located<Conflict>` is not `LocatedConflict` in two of them and
 * `LocatedOfConflict` in the third.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let sdl = "";
let components: readonly string[] = [];
let validators = "";

beforeAll(async () => {
	const compiled = await compileFixture(here, "friendly", { withDocument: true });
	sdl = readFileSync(join(compiled.outDir, "schema.graphql"), "utf8");
	const document = JSON.parse(readFileSync(join(compiled.documentDir, "openapi.json"), "utf8")) as {
		readonly components: { readonly schemas: Readonly<Record<string, unknown>> };
	};
	components = Object.keys(document.components.schemas);
	validators = readFileSync(join(compiled.outDir, "schemas.gen.ts"), "utf8");
}, 300_000);

describe("a @friendlyName", () => {
	it.each([
		["a template instance", "WidgetBox"],
		["a template spreading its argument", "LocatedConflict"],
		["a declaration", "Gizmo"],
	])("names %s, %s, in all three artefacts", (_what, name) => {
		expect(components).toContain(name);
		expect(validators).toMatch(new RegExp(`^export type ${name} = `, "m"));
		expect(sdl).toMatch(new RegExp(`^type ${name} [{]`, "m"));
	});

	it("names an instance where it is a template's argument", () => {
		expect(sdl).toMatch(/^type ShelfOfWidgetBox [{]/m);
		expect(sdl).toContain("union CreateWidgetResult = Widget | LocatedConflict");
	});

	it("leaves no composed name for a type it names", () => {
		expect(sdl).not.toMatch(/BoxOfWidget|LocatedOfConflict|\bGadget\b/);
	});
});
