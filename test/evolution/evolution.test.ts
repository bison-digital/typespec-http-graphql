import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CriticalityLevel, diff } from "@graphql-inspector/core";
import { BreakingChangeType, buildSchema, findSchemaChanges, type GraphQLSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";

/**
 * **A change a REST API makes without breaking its clients must not break the GraphQL schema.**
 *
 * `base.tsp` is a service, and each `EVOLVE:` comment in it one such change: an error response on a
 * mutation or a query, an optional response property, an optional query parameter on either kind of
 * field, a new operation with its field, a deprecated property. Each variant is compiled beside the
 * base, and the two `schema.graphql` files are judged by two judges this package did not write:
 *
 * - `@graphql-inspector/core`'s `diff`, whose `BREAKING` criticality is what schema registries gate a
 *   release on;
 * - graphql-js's own `findSchemaChanges`, whose breaking change types are the reference
 *   implementation's.
 *
 * Neither may call any evolution breaking, and each must see that the evolution changed something.
 * The control, removing a property, must be breaking to both, which proves the judges can say so.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const outRoot = join(here, "..", ".out-evolution");
const base = readFileSync(join(here, "base.tsp"), "utf8");

const EVOLUTIONS = [
	"add-error-response",
	"add-query-error-response",
	"optional-property",
	"optional-query-param",
	"optional-mutation-param",
	"add-operation",
	"deprecate",
] as const;

/**
 * The evolutions the schema itself does not show: a query's 404 is `null` on a field that is
 * nullable already, so only the resolver's projection changes. Each is proven applied by its
 * `graphql.gen.ts` differing from the base's instead.
 */
const SCHEMA_UNCHANGED: ReadonlySet<string> = new Set(["add-query-error-response"]);

/** The base with one evolution's markers turned into code, and every other marker left a comment. */
function variant(name: string): string {
	const line = new RegExp(`// EVOLVE:${name} `, "g");
	const inline = new RegExp(`/\\* EVOLVE:${name} ([^*]*)\\*/`, "g");
	const evolved = base.replace(line, "").replace(inline, "$1");
	if (evolved === base) throw new Error(`no marker EVOLVE:${name} in base.tsp`);
	return evolved;
}

const control = base
	.split("\n")
	.filter((text) => !text.includes("CONTROL:remove-property"))
	.join("\n");

async function schemaOf(name: string, source: string): Promise<GraphQLSchema> {
	const dir = join(outRoot, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "main.tsp"), source);
	await compileFixture(dir, "main", { outDir: join(dir, "emitted") });
	return buildSchema(readFileSync(join(dir, "emitted", "schema.graphql"), "utf8"));
}

interface Verdict {
	readonly inspector: readonly string[];
	readonly graphqlJs: readonly string[];
	readonly changed: number;
}

/** Each judge's breaking changes from the base to `next`, and how many changes either saw. */
async function judge(before: GraphQLSchema, next: GraphQLSchema): Promise<Verdict> {
	const inspected = await diff(before, next);
	const reference = findSchemaChanges(before, next);
	const breaking = new Set<string>(Object.values(BreakingChangeType));
	return {
		inspector: inspected
			.filter((change) => change.criticality.level === CriticalityLevel.Breaking)
			.map((change) => change.message),
		graphqlJs: reference
			.filter((change) => breaking.has(change.type))
			.map((change) => change.description),
		changed: Math.max(inspected.length, reference.length),
	};
}

let before: GraphQLSchema;
const verdicts = new Map<string, Verdict>();
let controlVerdict: Verdict;

beforeAll(async () => {
	before = await schemaOf("base", base);
	for (const name of EVOLUTIONS)
		verdicts.set(name, await judge(before, await schemaOf(name, variant(name))));
	controlVerdict = await judge(before, await schemaOf("control", control));
}, 300_000);

describe("a REST-compatible change leaves the GraphQL schema compatible", () => {
	it.each(EVOLUTIONS)("%s: changes the schema, and breaks nothing either judge can see", (name) => {
		const verdict = verdicts.get(name);
		if (SCHEMA_UNCHANGED.has(name)) {
			expect(verdict?.changed, name).toBe(0);
			const generated = (dir: string) =>
				readFileSync(join(outRoot, dir, "emitted", "graphql.gen.ts"), "utf8");
			expect(generated(name), name).not.toBe(generated("base"));
		} else {
			expect(verdict?.changed, name).toBeGreaterThan(0);
		}
		expect(verdict?.inspector, name).toEqual([]);
		expect(verdict?.graphqlJs, name).toEqual([]);
	});

	it("the control, a removed property, is breaking to both judges", () => {
		expect(controlVerdict.inspector.length).toBeGreaterThan(0);
		expect(controlVerdict.graphqlJs.length).toBeGreaterThan(0);
	});

	it("judged every evolution", () => {
		expect([...verdicts.keys()]).toEqual([...EVOLUTIONS]);
	});
});
