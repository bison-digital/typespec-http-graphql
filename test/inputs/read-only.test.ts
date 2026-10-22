import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphQLSchema } from "graphql";
import { type Context, Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";
import { executeThroughYoga } from "../support/yoga.js";

/**
 * **A request's read-only property, as the document publishes it at each OpenAPI version, through
 * REST and GraphQL.**
 *
 * The expected verdict is read from the document `@typespec/openapi3` publishes, not from either
 * server: the request body's schema, and the schemas it refers to, name each property `required` or
 * not and `readOnly` or not. OAS 3.0.4 makes a read-only property's `required` "take effect on the
 * response only", so a 3.0 request may leave it out; at 3.1 `readOnly` is an annotation (OAS 3.1.1
 * § 4.8.24.3.2) and `required` holds in a request too. One handler records what each server hands it.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

interface Schema {
	readonly $ref?: string;
	readonly required?: readonly string[];
	readonly properties?: Readonly<Record<string, Schema & { readonly readOnly?: boolean }>>;
	readonly allOf?: readonly Schema[];
}

interface Document {
	readonly openapi: string;
	readonly paths: Readonly<
		Record<
			string,
			{
				readonly post: {
					readonly requestBody: {
						readonly content: Readonly<Record<string, { readonly schema: Schema }>>;
					};
				};
			}
		>
	>;
	readonly components: { readonly schemas: Readonly<Record<string, Schema>> };
}

interface Served {
	readonly version: string;
	readonly document: Document;
	readonly rest: Hono;
	readonly schema: GraphQLSchema;
	readonly sdl: string;
	readonly seen: unknown[];
}

const WIDGET = { id: "w1", name: "gear", part: { id: "p1", sku: "G-1" } };

async function serve(version: string): Promise<Served> {
	const seen: unknown[] = [];
	const handlers = {
		create: (_c: unknown, input: unknown) => {
			seen.push(input);
			return { status: 200, body: WIDGET };
		},
	};
	const compiled = await compileFixture(here, "read-only", {
		outName: `read-only-${version}`,
		withServer: true,
		withDocument: true,
		openApiVersions: [version],
	});
	const document = JSON.parse(
		readFileSync(join(compiled.documentDir, "openapi.json"), "utf8"),
	) as Document;
	const rest = new Hono();
	const routes = (await import(join(compiled.serverDir, "app.gen.ts"))) as {
		readonly registerRoutes: (app: Hono, handlersFor: () => object, deps: object) => void;
	};
	routes.registerRoutes(rest, () => handlers, {
		authorize: () => async (_c: Context, next: () => Promise<void>) => {
			await next();
		},
		context: () => ({ subject: "widgets" }),
		noContext: (c: Context) => c.json({ title: "Unauthorized" }, 401),
		notAcceptable: (c: Context) => c.body(null, 406),
		invalid: (result: { readonly success: boolean }, c: Context) =>
			result.success ? undefined : c.json({ title: "Bad Request" }, 400),
	});
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
		readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
	};
	const schema = generated.createSchema(() => handlers, {
		authorize: () => "allow",
		context: () => ({ subject: "widgets" }),
	});
	const sdl = readFileSync(join(compiled.outDir, "schema.graphql"), "utf8");
	return { version, document, rest, schema, sdl, seen };
}

let served: readonly Served[];

beforeAll(async () => {
	served = [await serve("3.0.0"), await serve("3.1.0")];
}, 300_000);

/** The component a schema refers to, by its `$ref` or the one `allOf` holds. */
function resolved(document: Document, schema: Schema): Schema {
	const ref = schema.$ref ?? schema.allOf?.find((part) => part.$ref !== undefined)?.$ref;
	if (ref === undefined) return schema;
	const name = ref.replace("#/components/schemas/", "");
	const component = document.components.schemas[name];
	if (component === undefined) throw new Error(`the document publishes no ${name}`);
	return component;
}

/**
 * **Whether the document lets a request leave out `path`**, a property under the create body: not in
 * its schema's `required`, or `readOnly` there where the document is OpenAPI 3.0.
 */
function mayLeaveOut(document: Document, path: readonly string[]): boolean {
	let schema = resolved(
		document,
		document.paths["/widgets"]?.post.requestBody.content["application/json"]?.schema ?? {},
	);
	for (const [index, key] of path.entries()) {
		const property = schema.properties?.[key];
		if (property === undefined) throw new Error(`the document publishes no ${path.join(".")}`);
		if (index === path.length - 1) {
			const required = schema.required?.includes(key) === true;
			return !required || (document.openapi.startsWith("3.0.") && property.readOnly === true);
		}
		schema = resolved(document, property);
	}
	throw new Error("an empty path");
}

interface Row {
	readonly name: string;
	/** The property left out of the body sent. */
	readonly leftOut?: readonly string[];
}

const ROWS: readonly Row[] = [
	{ name: "every property sent" },
	{ name: "the widget's read-only id left out", leftOut: ["id"] },
	{ name: "the part's read-only id left out", leftOut: ["part", "id"] },
];

/** `WIDGET` without the property at `path`. */
function without(path: readonly string[] | undefined): Record<string, unknown> {
	const body = structuredClone(WIDGET) as Record<string, unknown>;
	if (path === undefined) return body;
	let holder = body;
	for (const key of path.slice(0, -1)) holder = holder[key] as Record<string, unknown>;
	delete holder[path.at(-1) ?? ""];
	return body;
}

/** A GraphQL input object literal for a JSON object: its keys bare, every leaf a string. */
const literalOf = (value: unknown): string =>
	typeof value === "object" && value !== null
		? `{ ${Object.entries(value)
				.map(([key, item]) => `${key}: ${literalOf(item)}`)
				.join(", ")} }`
		: JSON.stringify(value);

describe.each(["3.0.0", "3.1.0"])("published at OpenAPI %s", (version) => {
	const at = (): Served => {
		const found = served.find((each) => each.version === version);
		if (found === undefined) throw new Error(`no compile at ${version}`);
		return found;
	};

	it("is the document openapi3 published", () => {
		expect(at().document.openapi).toBe(version);
	});

	it.each(ROWS)("$name: both servers answer as the document says", async (row) => {
		const { document, rest, schema, seen } = at();
		const body = without(row.leftOut);
		const accepted = row.leftOut === undefined || mayLeaveOut(document, row.leftOut);

		seen.length = 0;
		const response = await rest.request("/widgets", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(accepted ? 200 : 400);
		expect(seen).toEqual(accepted ? [body] : []);

		seen.length = 0;
		const result = await executeThroughYoga(
			schema,
			{ query: `mutation { createWidget(input: ${literalOf(body)}) { ... on Widget { id } } }` },
			{},
		);
		if (accepted) {
			expect(result).toEqual({ status: 200, data: { createWidget: { id: "w1" } } });
			expect(seen).toEqual([body]);
		} else {
			expect(result).toMatchObject({
				errors: [{ message: expect.stringMatching(/to include required field "id"/) }],
			});
			expect(seen).toEqual([]);
		}
	});

	it("types each read-only input field as the document lets a request send it", () => {
		const { document, sdl } = at();
		const nullable = (path: readonly string[]): string =>
			mayLeaveOut(document, path) ? "String" : "String!";
		expect(sdl).toContain(`input CreateWidgetInput {\n  id: ${nullable(["id"])}\n`);
		expect(sdl).toContain(`input PartInput {\n  id: ${nullable(["part", "id"])}\n`);
	});
});
