import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphQLSchema } from "graphql";
import { type Context, Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { applyFieldNamePipeline } from "../names/upstream-naming.js";
import { compileFixture } from "../support/compile-fixture.js";
import { executeThroughYoga } from "../support/yoga.js";

/**
 * **A list parameter under `@encode`, as the document publishes it, through REST and GraphQL.**
 *
 * The expected input is read from the document `@typespec/openapi3` publishes, not from either
 * server: a parameter it publishes as `type: string` reaches the handler as the text sent, and one it
 * publishes as `type: array` as that text split by its `style` (OAS 3.1.1 § 4.8.12.4: `|` for
 * `pipeDelimited`, a space for `spaceDelimited`, `,` otherwise), each item as its `items` type. The
 * REST request sends the text; the GraphQL request writes the same value as its argument's type
 * states it, a list for an array and the text for a string. One handler records both.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

interface Row {
	readonly field: string;
	/** The route the document publishes the operation under. */
	readonly route: string;
	readonly path: string;
	/** The parameter's wire name, and where it is sent. */
	readonly name: string;
	readonly in: "query" | "path" | "header";
	readonly text: string;
}

const ROWS: readonly Row[] = [
	{ field: "q", route: "/q", path: "/q?ids=1%7C2", name: "ids", in: "query", text: "1|2" },
	{ field: "p", route: "/p/{ids}", path: "/p/a,b", name: "ids", in: "path", text: "a,b" },
	{ field: "h", route: "/h", path: "/h", name: "x-tags", in: "header", text: "a,b" },
	{ field: "c", route: "/c", path: "/c?tags=a,b", name: "tags", in: "query", text: "a,b" },
	{ field: "s", route: "/s", path: "/s?tags=a,b", name: "tags", in: "query", text: "a,b" },
];

interface Parameter {
	readonly name: string;
	readonly in: string;
	readonly style?: string;
	readonly schema: { readonly type: string; readonly items?: { readonly type: string } };
}

let parameters: Readonly<Record<string, readonly Parameter[]>>;
const seen = new Map<string, unknown[]>();
const handlers = Object.fromEntries(
	ROWS.map((row) => [
		row.field,
		(_c: unknown, input: unknown) => {
			seen.get(row.field)?.push(input);
			return { status: 200, body: { id: "ok" } };
		},
	]),
);
const rest = new Hono();
let schema: GraphQLSchema;

beforeAll(async () => {
	const compiled = await compileFixture(here, "encoded-lists", {
		withServer: true,
		withDocument: true,
	});
	const document = JSON.parse(readFileSync(join(compiled.documentDir, "openapi.json"), "utf8")) as {
		readonly paths: Readonly<
			Record<string, { readonly get: { readonly parameters: readonly Parameter[] } }>
		>;
	};
	parameters = Object.fromEntries(
		Object.entries(document.paths).map(([route, item]) => [route, item.get.parameters]),
	);
	const routes = (await import(join(compiled.serverDir, "app.gen.ts"))) as {
		readonly registerRoutes: (app: Hono, handlersFor: () => object, deps: object) => void;
	};
	routes.registerRoutes(rest, () => handlers, {
		authorize: () => async (_c: Context, next: () => Promise<void>) => {
			await next();
		},
		context: () => ({ subject: "lists" }),
		noContext: (c: Context) => c.json({ title: "Unauthorized" }, 401),
		notAcceptable: (c: Context) => c.body(null, 406),
		invalid: (result: { readonly success: boolean }, c: Context) =>
			result.success ? undefined : c.json({ title: "Bad Request" }, 400),
	});
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
		readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
	};
	schema = generated.createSchema(() => handlers, {
		authorize: () => "allow",
		context: () => ({ subject: "lists" }),
	});
}, 300_000);

const DELIMITERS: Readonly<Record<string, string>> = { pipeDelimited: "|", spaceDelimited: " " };

/** The value the document says the text of `row` is, by the parameter it publishes. */
function publishedValueOf(row: Row): unknown {
	const parameter = parameters[row.route]?.find(
		(candidate) => candidate.name === row.name && candidate.in === row.in,
	);
	if (parameter === undefined) throw new Error(`the document publishes no ${row.in} ${row.name}`);
	if (parameter.schema.type !== "array") return row.text;
	const items = row.text.split(DELIMITERS[parameter.style ?? ""] ?? ",");
	return parameter.schema.items?.type === "integer" ? items.map(Number) : items;
}

describe("a list parameter under @encode", () => {
	it.each(ROWS)("$field: $in $name is handed as the document publishes it", async (row) => {
		const expected = { [row.name]: publishedValueOf(row) };

		seen.set(row.field, []);
		const response = await rest.request(
			row.path,
			row.in === "header" ? { headers: { [row.name]: row.text } } : {},
		);
		expect(response.status).toBe(200);
		expect(seen.get(row.field)).toEqual([expected]);

		seen.set(row.field, []);
		const argument = applyFieldNamePipeline(row.name);
		const result = await executeThroughYoga(
			schema,
			{ query: `{ ${row.field}(${argument}: ${JSON.stringify(expected[row.name])}) { id } }` },
			{},
		);
		expect(result).toEqual({ status: 200, data: { [row.field]: { id: "ok" } } });
		expect(seen.get(row.field)).toEqual([expected]);
	});
});
