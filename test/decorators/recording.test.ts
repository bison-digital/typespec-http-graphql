import { fileURLToPath } from "node:url";
import { getSourceLocation, type Operation } from "@typespec/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { linkDeclarationsOf, rootDeclarationsOf } from "../../src/decorators.js";
import { compileFixture, type CompiledFixture } from "../support/compile-fixture.js";
import { byCodeUnit } from "../support/by-code-unit.js";

/**
 * **What the three decorators record, read back through the accessors the emitter uses.**
 *
 * The compiler loads the BUILT decorators (`dist/src/tsp-index.js`, through `lib/main.tsp`) while
 * this suite reads through the source accessors. They meet because the state keys are the
 * compiler's own `Symbol.for` of the library name, so this also proves the two halves agree on
 * where the declarations live.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let compiled: CompiledFixture;
beforeAll(async () => {
	compiled = await compileFixture(here, "main", { outName: "recording", withoutGraphQL: true });
}, 300_000);

const idOf = (operation: Operation): string => `${operation.interface?.name}.${operation.name}`;

describe("the decorators record", () => {
	it("every root declaration, with its kind, name and operation", () => {
		const roots = rootDeclarationsOf(compiled.program).map((d) => [
			d.kind,
			d.name,
			idOf(d.operation),
		]);
		expect(roots.toSorted(byCodeUnit)).toEqual(
			[
				["query", "book", "BooksApi.read"],
				["query", "books", "BooksApi.list"],
				["mutation", "createBook", "BooksApi.create"],
				["query", "booksAgain", "BooksApi.list"],
			].toSorted(byCodeUnit),
		);
	});

	/**
	 * **The same operation declared twice is recorded twice, in the order written.** A store keyed by
	 * the operation would keep one, and `surface.ts` could never report `declared-twice`.
	 */
	it("an operation declared twice, twice and in the order written", () => {
		const list = rootDeclarationsOf(compiled.program).filter(
			(d) => idOf(d.operation) === "BooksApi.list",
		);
		expect(list.map((d) => d.name)).toEqual(["books", "booksAgain"]);
	});

	it("every link, with its parent, name, operation and parameters as written", () => {
		const links = linkDeclarationsOf(compiled.program).map((d) => [
			d.parent.name,
			d.name,
			idOf(d.operation),
			d.parameters,
		]);
		expect(links).toHaveLength(3);
		expect(links).toContainEqual(["Book", "author", "Authors.read", { authorId: "author_id" }]);
		expect(links).toContainEqual(["Author", "books", "BooksApi.list", { authorId: "id" }]);
		// Omitted parameters are an empty map, not `undefined`, so a reader never has to ask.
		expect(links).toContainEqual(["Author", "everything", "BooksApi.list", {}]);
	});

	/**
	 * **A diagnostic about a declaration points at the declaration**, in `graphql.tsp`, not at the
	 * operation or model in `rest.tsp`: that is the line a spec author has to change.
	 */
	it("where each declaration was written, for a diagnostic to point at", () => {
		const declarations = [
			...rootDeclarationsOf(compiled.program),
			...linkDeclarationsOf(compiled.program),
		];
		expect(declarations).toHaveLength(7);
		for (const declaration of declarations) {
			expect(getSourceLocation(declaration.node).file.path).toMatch(/graphql\.tsp$/);
		}
	});

	/**
	 * **The decorators check nothing.** A duplicate declaration compiled here, and nothing this
	 * library defines was reported for it: a check in a decorator would run for every emitter.
	 */
	it("and report nothing, so another emitter never sees a GraphQL diagnostic", () => {
		expect(compiled.diagnostics.filter((d) => d.code.startsWith("typespec-http-graphql/"))).toEqual(
			[],
		);
	});
});
