import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertName } from "graphql";
import { describe, expect, it } from "vitest";
import { enumValueNameOf, fieldNameOf, isGraphQLName, typeNameOf } from "../../src/names.js";
import {
	applyBaseNamePipeline,
	applyEnumMemberPipeline,
	applyFieldNamePipeline,
} from "./upstream-naming.js";

/**
 * **Every name agrees with `@typespec/graphql`'s, graded against that package's own pipeline.**
 *
 * `upstream-naming.ts` is upstream's `naming.ts`, vendored at a pinned commit as a test oracle
 * only: nothing in `src/` imports it. An expectation that comes from upstream's code rather than
 * from this package's is what stops a "fix" here quietly renaming every type a consumer has.
 *
 * **The one departure is graded as exactly as the agreement.** Where upstream produces a name
 * starting `__`, which GraphQL reserves and graphql-js refuses, this package collapses the leading
 * underscores to one. The departures are listed, so the set cannot grow unnoticed.
 */

const CORPUS = [
	"Widget",
	"Acme.Widgets.Widget",
	"widget_record",
	"HTTPStatus",
	"XMLParser",
	"Widget[]",
	"2fa-settings",
	"created_at",
	"x-request-id",
	"Widgets_read",
	"WidgetTools_create",
	"id",
	"in-progress",
	"active",
	"v2",
	"Read",
	"$x",
	"a b",
	"9lives",
	"--",
	"Ü",
	"_private",
	"__typename",
	"page-size",
	"ETag",
	"If-Match",
	"userID",
	"URLValue",
	"ipv4Address",
	"OAuth2Token",
	"snake_case_name",
	"SCREAMING_CASE",
	"Foo123Bar",
	"APIKey",
	"getHTTPResponseCode",
	"Page<Widget>",
	"IPv6",
	"",
	"  spaced  ",
	"_-x",
	"___x",
	"x__y",
] as const;

/** Where upstream's name is invalid, by function and input, and what upstream produced. */
const DEPARTURES = [
	["type", "--", "__"],
	["type", "__typename", "__Typename"],
	["type", "_-x", "__X"],
	["type", "___x", "___X"],
	["field", "--", "__"],
	["field", "__typename", "__typename"],
	["field", "  spaced  ", "__spaced"],
	["field", "_-x", "__x"],
	["field", "___x", "___x"],
	["enum", "--", "__"],
	["enum", "__typename", "__TYPENAME"],
	["enum", "  spaced  ", "__SPACED"],
	["enum", "_-x", "__X"],
	["enum", "___x", "___X"],
];

const PAIRS = [
	["type", typeNameOf, applyBaseNamePipeline],
	["field", fieldNameOf, applyFieldNamePipeline],
	["enum", enumValueNameOf, applyEnumMemberPipeline],
] as const;

describe("names agree with upstream's pipeline", () => {
	it("the corpus is large enough to mean something", () => {
		expect(CORPUS.length).toBeGreaterThanOrEqual(30);
	});

	it("produces upstream's name wherever upstream's is valid, and departs only where it is not", () => {
		const departures: string[][] = [];
		for (const [kind, ours, theirs] of PAIRS) {
			for (const raw of CORPUS) {
				const expected = theirs(raw);
				const actual = ours(raw);
				if (isGraphQLName(expected)) {
					expect(actual, `${kind} ${JSON.stringify(raw)}`).toBe(expected);
				} else {
					departures.push([kind, raw, expected]);
					expect(actual, `${kind} ${JSON.stringify(raw)}`).toBe(expected.replace(/^_+/, "_"));
				}
				expect(() => assertName(actual)).not.toThrow();
			}
		}
		expect(departures).toEqual(DEPARTURES);
	});
});

describe("the vendored oracle", () => {
	const here = fileURLToPath(new URL(".", import.meta.url));
	const vendored = readFileSync(join(here, "upstream-naming.ts"), "utf8");

	it("names where it came from: repository, path, commit and licence", () => {
		const header = vendored.slice(0, vendored.indexOf("*/"));
		expect(header).toContain("https://github.com/microsoft/typespec");
		expect(header).toContain("packages/graphql/src/lib/naming.ts");
		expect(header).toContain("Commit: e5df94a8d5cf0ba64dd60b78d1494eef9e3a11bc");
		expect(header).toContain("MIT");
		expect(header).toContain("Copyright (c) Microsoft Corporation");
	});

	it("is a test oracle only: no module of the package imports it", () => {
		const src = fileURLToPath(new URL("../../src/", import.meta.url));
		const sources = readdirSync(src).filter((file) => file.endsWith(".ts"));
		expect(sources.length).toBeGreaterThan(0);
		for (const file of sources) {
			expect(readFileSync(join(src, file), "utf8"), file).not.toContain("upstream-naming");
		}
	});
});
