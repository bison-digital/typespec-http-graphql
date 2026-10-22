import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertObjectType, buildSchema, validateSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture, type CompiledFixture } from "../support/compile-fixture.js";
import { appliedDirectives, normalised } from "../support/sdl-compare.js";

/**
 * **The emitted schema against one a person wrote by hand for the same domain.**
 *
 * Every other oracle checks that the output is CORRECT: valid, agreeing with the server, with the
 * runtime, with the Relay specification. None says whether it is GOOD. Apollo discourages schema
 * generators precisely because their output mirrors the backend rather than serving the client, so
 * the question this package has to answer is whether its output is the schema someone would have
 * written anyway. `expected.graphql` is that schema, for a bookshop's domain, written from
 * design.md's rules and never copied from emitted output.
 *
 * **Compared with descriptions set aside, and nothing else.** Both sides are parsed, stripped of
 * descriptions, rebuilt and printed with `lexicographicSortSchema`, so the order of fields, arguments
 * and types does not count and every name, type, nullability, argument, enum value, union member and
 * directive definition does. Descriptions are prose the emitter writes for synthesised types; one arm
 * below checks the fixture's own doc comments arrive. `printSchema` drops applied directives other
 * than `@deprecated` and `@specifiedBy`, so they are compared separately, by coordinate.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const expected = readFileSync(join(here, "expected.graphql"), "utf8");

let compiled: CompiledFixture;
let emitted = "";

beforeAll(async () => {
	compiled = await compileFixture(here, "main", { outName: "idiom" });
	emitted = readFileSync(join(compiled.outDir, "schema.graphql"), "utf8");
}, 300_000);

describe("the emitted schema is the one a person would write for this domain", () => {
	it("compiles the fixture with no diagnostic at all", () => {
		expect(compiled.diagnostics).toEqual([]);
	});

	it("compares against a schema that is valid in its own right", () => {
		const schema = buildSchema(expected);
		expect(validateSchema(schema)).toEqual([]);
		expect(schema.getQueryType()?.name).toBe("Query");
		expect(schema.getMutationType()?.name).toBe("Mutation");
	});

	it("is expected.graphql, descriptions set aside", () => {
		expect(normalised(emitted)).toBe(normalised(expected));
	});

	/** Non-vacuity: the normalisation keeps a one-character difference. */
	it("compares closely enough to see one nullability", () => {
		const planted = expected.replace(/(type Book \{[^}]*?authorId: String)\n/, "$1!\n");
		expect(planted).not.toBe(expected);
		expect(normalised(planted)).not.toBe(normalised(expected));
	});

	it("carries exactly the applied directives expected.graphql carries", () => {
		const wanted = appliedDirectives(expected);
		expect(wanted.length).toBeGreaterThanOrEqual(20);
		expect(appliedDirectives(emitted)).toEqual(wanted);
	});

	it("turns the fixture's doc comments into descriptions", () => {
		const schema = buildSchema(emitted);
		const book = assertObjectType(schema.getType("Book"));
		expect(book.description).toBe("A book, and what the bookshop knows about it.");
		expect(book.getFields()["authorId"]?.description).toBe(
			"The author who wrote the book: whose list of books it is on.",
		);
		expect(schema.getType("BookStatus")?.description).toBe("Where a book is on its way to print.");
	});
});

/**
 * **The oracle is the file `PROVENANCE.md` accounts for.** Its digest is recorded there beside every
 * change and the authority for it, so `expected.graphql` cannot be edited to agree with the emitter
 * without that edit, and its reason, being written down where a reviewer reads it.
 */
describe("expected.graphql has a recorded provenance", () => {
	it("is the file whose sha256 PROVENANCE.md records", () => {
		const here = fileURLToPath(new URL(".", import.meta.url));
		const digest = createHash("sha256")
			.update(readFileSync(join(here, "expected.graphql")))
			.digest("hex");
		const recorded = /`sha256 ([0-9a-f]{64})`/.exec(
			readFileSync(join(here, "PROVENANCE.md"), "utf8"),
		);
		expect(recorded?.[1]).toBe(digest);
	});
});
