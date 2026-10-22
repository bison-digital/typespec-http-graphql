import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture, type CompiledFixture } from "../support/compile-fixture.js";

/**
 * **The removability oracle: adding a GraphQL surface changes nothing any other emitter writes.**
 *
 * `design.md` promises that dropping GraphQL is deleting `graphql.tsp` and this emitter's line in
 * `tspconfig.yaml`, and nothing else. That holds only if the decorators and this emitter leave the
 * REST output untouched, so the same REST fixture is compiled twice:
 * - **without** the surface: `rest.tsp` alone, emitting `@typespec/openapi3` and the published
 *   `typespec-hono` (which runs `typespec-http-zod` itself);
 * - **with** it: `main.tsp`, which also imports `graphql.tsp`, emitting the same two AND this
 *   emitter, as a consumer's `tspconfig.yaml` would.
 *
 * Every file the two REST emitters wrote must be byte-identical across the two. A decorator that
 * wrote a `@doc`, an emitter that mutated a shared type, a diagnostic that stopped openapi3 writing:
 * each shows up here as a differing or missing file.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let without: CompiledFixture;
let withSurface: CompiledFixture;
beforeAll(async () => {
	without = await compileFixture(here, "rest", {
		outName: "removability-without",
		withoutGraphQL: true,
		withDocument: true,
		withServer: true,
	});
	withSurface = await compileFixture(here, "main", {
		outName: "removability-with",
		withDocument: true,
		withServer: true,
	});
}, 300_000);

/** Every file under `root`, as a path relative to it, sorted. */
function filesUnder(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else found.push(relative(root, full));
		}
	};
	walk(root);
	return found.toSorted();
}

/** The same relative file list, and the same bytes in each file. */
function expectIdenticalTrees(a: string, b: string): void {
	const files = filesUnder(a);
	expect(filesUnder(b)).toEqual(files);
	for (const file of files) {
		expect(readFileSync(join(b, file), "utf8"), file).toBe(readFileSync(join(a, file), "utf8"));
	}
}

describe("adding graphql.tsp leaves the REST output byte-identical", () => {
	it("writes the OpenAPI document byte for byte the same", () => {
		// Non-vacuity: an emitter that wrote nothing would leave two equal, empty trees.
		expect(filesUnder(without.documentDir)).toEqual(["openapi.json"]);
		expectIdenticalTrees(without.documentDir, withSurface.documentDir);
	});

	it("writes the typespec-hono server and its validators byte for byte the same", () => {
		expect(filesUnder(without.serverDir)).toEqual(
			expect.arrayContaining(["app.gen.ts", "schemas.gen.ts"]),
		);
		expectIdenticalTrees(without.serverDir, withSurface.serverDir);
	});

	it("ran this emitter in the arm with the surface, so its presence is what was compared", () => {
		expect(filesUnder(withSurface.outDir)).toContain("graphql-runtime.gen.ts");
	});
});

/**
 * **A link the checker meets before the interface it names, and the order every other emitter
 * writes.** `@link`'s operation argument is checked when its model is, so in a spec that declares
 * its models first, `Gadgets` is checked before `Status` and `Widgets`. An emitter that wrote in the
 * order the checker met its types moved every route, validator and request in `app.gen.ts` and
 * `schemas.gen.ts`, none of them changed.
 */
describe("a link to an interface declared after its model leaves the REST output byte-identical", () => {
	let rest: CompiledFixture;
	let both: CompiledFixture;
	beforeAll(async () => {
		rest = await compileFixture(here, "order-rest", {
			outName: "order-without",
			withoutGraphQL: true,
			withDocument: true,
			withServer: true,
		});
		both = await compileFixture(here, "order-main", {
			outName: "order-with",
			withDocument: true,
			withServer: true,
		});
	}, 300_000);

	it("writes the typespec-hono server and its validators byte for byte the same", () => {
		expect(filesUnder(rest.serverDir)).toEqual(
			expect.arrayContaining(["app.gen.ts", "schemas.gen.ts"]),
		);
		expectIdenticalTrees(rest.serverDir, both.serverDir);
	});

	it("writes the OpenAPI document byte for byte the same", () => {
		expectIdenticalTrees(rest.documentDir, both.documentDir);
	});

	it("declares the routes as the spec declares its interfaces", () => {
		const routes = [
			...readFileSync(join(both.serverDir, "schemas.gen.ts"), "utf8").matchAll(
				/^export const (\w+)_readResponses = /gm,
			),
		].map((match) => match[1]);
		expect(routes).toEqual(["Status", "Widgets", "Gadgets"]);
	});
});
