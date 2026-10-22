import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";
import { refusalsOf } from "../support/refused-fixtures.js";
import { costViolations } from "./cost-directives.js";
import { relayViolations } from "./relay.js";

/**
 * **Every schema any fixture in this package emits, against the two specifications it claims to
 * follow**, documents this package did not write: the GraphQL Cursor Connections Specification
 * (relay.dev/graphql/connections.htm) for every connection, and the GraphQL Cost Directives
 * Specification (ibm.github.io/graphql-specs/cost-spec.html) for every `@cost` and `@listSize`.
 *
 * **Swept, not listed.** Every `.tsp` under `test/` that no sibling imports is a fixture's entry
 * point, and each is compiled into a directory of this suite's own. A hand-kept list would go stale
 * the first time a suite added a fixture, and a connection shape only that fixture reaches would go
 * ungraded.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const testRoot = fileURLToPath(new URL("..", import.meta.url));

interface Entry {
	readonly dir: string;
	readonly name: string;
}

/** Every `.tsp` under `test/` that no `.tsp` beside it imports, outside generated directories. */
function fixtureEntries(): Entry[] {
	const entries: Entry[] = [];
	const walk = (dir: string): void => {
		const listing = readdirSync(dir, { withFileTypes: true });
		const specs = listing.filter((e) => e.isFile() && e.name.endsWith(".tsp")).map((e) => e.name);
		const imported = new Set(
			specs.flatMap((file) =>
				[...readFileSync(join(dir, file), "utf8").matchAll(/^import "\.\/([^"/]+\.tsp)";$/gm)].map(
					(match) => match[1] ?? "",
				),
			),
		);
		for (const file of specs) {
			if (!imported.has(file)) entries.push({ dir, name: file.slice(0, -".tsp".length) });
		}
		for (const entry of listing) {
			if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
				walk(join(dir, entry.name));
			}
		}
	};
	walk(testRoot);
	return entries;
}

/** Every `schema.graphql` under a directory: one per service that declared a field. */
function schemasUnder(dir: string): string[] {
	const found: string[] = [];
	const walk = (at: string): void => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const full = join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === "schema.graphql") found.push(full);
		}
	};
	walk(dir);
	return found;
}

const connectionsIn = (sdl: string): string[] =>
	Object.keys(buildSchema(sdl).getTypeMap()).filter((name) => name.endsWith("Connection"));

const graded: { readonly fixture: string; readonly sdl: string }[] = [];
const threw: string[] = [];

beforeAll(async () => {
	for (const entry of fixtureEntries()) {
		const id = `${relative(testRoot, entry.dir).replaceAll("/", "__")}__${entry.name}`;
		const outDir = join(here, ".out", "relay", id);
		try {
			await compileFixture(entry.dir, entry.name, {
				outDir,
				expectedErrors: refusalsOf(relative(testRoot, join(entry.dir, entry.name))),
			});
		} catch (error) {
			threw.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const file of schemasUnder(outDir)) {
			graded.push({ fixture: id, sdl: readFileSync(file, "utf8") });
		}
	}
}, 900_000);

describe("every connection every fixture emits keeps the Relay specification", () => {
	it("compiles every fixture under test/, without an error or the emitter throwing", () => {
		expect(threw).toEqual([]);
	});

	it("finds connections to grade", () => {
		const withConnections = graded.filter(({ sdl }) => connectionsIn(sdl).length > 0);
		// The idiom, acceptance and agreement fixtures alone declare seven.
		expect(withConnections.length).toBeGreaterThanOrEqual(3);
		expect(graded.flatMap(({ sdl }) => connectionsIn(sdl)).length).toBeGreaterThanOrEqual(7);
	});

	it("finds no departure from the specification in any of them", () => {
		const violations = graded.flatMap(({ fixture, sdl }) =>
			relayViolations(buildSchema(sdl)).map((violation) => `${fixture}: ${violation}`),
		);
		expect(violations).toEqual([]);
	});
});

/**
 * **The oracle, shown to fail on each section it grades.** Each arm plants one departure in a copy of
 * `expected.graphql` and names the one line it must produce, so a check that stopped looking would
 * fail here rather than pass everywhere.
 */
describe("the specification check sees every departure it claims to", () => {
	const expected = readFileSync(join(here, "expected.graphql"), "utf8");
	const plant = (pattern: RegExp, replacement: string): string[] => {
		const planted = expected.replace(pattern, replacement);
		expect(planted, `${pattern} found nothing to change`).not.toBe(expected);
		return relayViolations(buildSchema(planted));
	};

	it("passes the hand-written schema, so each plant below is the only difference", () => {
		expect(relayViolations(buildSchema(expected))).toEqual([]);
	});

	it("refuses a connection without pageInfo (§2.1.2)", () => {
		expect(plant(/(type AuthorConnection \{[^}]*?)pageInfo:/, "$1pageInformation:")).toEqual([
			"AuthorConnection has no pageInfo field (§2.1.2)",
		]);
	});

	it("refuses an edge whose node is a list (§3.1.1)", () => {
		expect(plant(/(type EditionEdge \{[^}]*?node: )Edition!/, "$1[Edition!]")).toEqual([
			"EditionEdge.node returns a list (§3.1.1)",
		]);
	});

	it("refuses a cursor that does not serialise as a String (§3.1.2)", () => {
		expect(plant(/(type EditorEdge \{[^}]*?cursor: )String/, "$1Int")).toEqual([
			"EditorEdge.cursor does not serialise as a String (§3.1.2)",
		]);
	});

	it("refuses a connection field without after (§4.1)", () => {
		expect(
			plant(/authors\(\s*first: Int = 50,?\s*after: String\s*\)/, "authors(first: Int = 50)"),
		).toEqual(["Query.authors has no after: String argument (§4.1)"]);
	});

	it("refuses a PageInfo whose hasNextPage may be null (§5.1)", () => {
		expect(plant(/hasNextPage: Boolean!/, "hasNextPage: Boolean")).toEqual([
			"PageInfo.hasNextPage is not Boolean! (§5.1)",
		]);
	});
});

describe("every schema every fixture emits keeps the IBM cost specification", () => {
	it("finds cost directives to grade", () => {
		const listSized = graded.filter(({ sdl }) => sdl.includes("@listSize("));
		expect(listSized.length).toBeGreaterThanOrEqual(3);
		expect(graded.filter(({ sdl }) => sdl.includes("@cost(")).length).toBe(graded.length);
	});

	it("finds no departure from the specification in any of them", () => {
		const violations = graded.flatMap(({ fixture, sdl }) =>
			costViolations(buildSchema(sdl)).map((violation) => `${fixture}: ${violation}`),
		);
		expect(violations).toEqual([]);
	});
});

/** The cost check, shown to fail on each section it grades, as the Relay check is above. */
describe("the cost specification check sees every departure it claims to", () => {
	const expected = readFileSync(join(here, "expected.graphql"), "utf8");
	const plant = (pattern: RegExp, replacement: string): string[] => {
		const planted = expected.replace(pattern, replacement);
		expect(planted, `${pattern} found nothing to change`).not.toBe(expected);
		return costViolations(buildSchema(planted));
	};

	it("passes the hand-written schema, so each plant below is the only difference", () => {
		expect(costViolations(buildSchema(expected))).toEqual([]);
	});

	it("refuses a @cost defined with a numeric weight (§9.1)", () => {
		expect(plant(/weight: String!/, "weight: Float!").length).toBeGreaterThan(0);
	});

	it("refuses a weight that is not a serialised Float (§7.1)", () => {
		expect(
			plant(/(publisher\([^)]*\): Publisher) @cost\(weight: "1"\)/, '$1 @cost(weight: "one")'),
		).toEqual(["Query.publisher has a @cost weight that is not a serialised Float (§7.1)"]);
	});

	it("refuses @cost on an interface field (§9.1.1)", () => {
		expect(
			plant(/(interface ProblemFieldsInterface \{[^}]*?title: String!)/, '$1 @cost(weight: "2")'),
		).toEqual(["ProblemFieldsInterface.title carries @cost on an interface field (§9.1.1)"]);
	});

	it("refuses a requireOneSlicingArgument that does not default to true (§9.2)", () => {
		expect(
			plant(/requireOneSlicingArgument: Boolean = true/, "requireOneSlicingArgument: Boolean"),
		).toEqual([
			"@listSize defines (assumedSize: Int, slicingArguments: [String!], sizedFields: [String!], requireOneSlicingArgument: Boolean) (§9.2)",
		]);
	});

	it("refuses a sized field the returned type does not define (§9.2.2)", () => {
		expect(
			plant(
				/(authors\([^)]*\): AuthorConnection[^@]*@cost\(weight: "1"\)\s*@listSize\([^)]*?)sizedFields: \["edges", "nodes"\]/s,
				'$1sizedFields: ["edges", "items"]',
			),
		).toEqual(["Query.authors sizes items, which AuthorConnection does not define (§9.2.2)"]);
	});

	it("refuses a slicing argument that is not an Int (§9.2.3)", () => {
		expect(
			plant(/authors\(first: Int = 50, after: String\)/, "authors(first: String, after: String)"),
		).toEqual(["Query.authors slices by first, which is String, not Int (§9.2.3)"]);
	});

	it("refuses assumedSize beside a slicing argument that has a default (§9.2.4)", () => {
		expect(
			plant(
				/(authors\([^)]*\): AuthorConnection[^@]*@cost\(weight: "1"\)\s*@listSize\()/s,
				"$1assumedSize: 50, ",
			),
		).toEqual([
			"Query.authors has assumedSize beside slicing argument first, which has a default value (§9.2.4)",
		]);
	});
});
