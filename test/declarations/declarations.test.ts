import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, NodeHost } from "@typespec/compiler";
import { type GraphQLSchema, graphql } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { type CompiledFixture, compileFixture } from "../support/compile-fixture.js";

/**
 * **What `graphql.tsp` can say beyond a field's name, graded through the emitted schema.**
 *
 * - `@json` accepts a projection as `JSON`, of a property's type or of a named model, union or
 *   scalar, so a spec whose every `JSON` is right can build under `warn-as-error` with no
 *   suppression in its models, while a dropped link still fails it.
 * - `@inputHeader` takes an optional header as the input of one operation: an `Idempotency-Key`
 *   belongs to the write it protects, which the `/graphql` request's own headers cannot say, and a
 *   reader's `Accept-Language` is an argument of every field that reads through the operation.
 * - A field's own description replaces the operation's, which is written for REST.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

let sdl = "";
let schema: GraphQLSchema;
let codes: readonly string[] = [];
/** `mistaken.tsp`: a `@json` on an object type, and `@inputHeader`s naming no optional header. */
let mistaken: CompiledFixture;
const received: {
	readonly operationId: string;
	readonly input: Readonly<Record<string, unknown>>;
}[] = [];

beforeAll(async () => {
	const compiled = await compileFixture(here, "main");
	codes = compiled.diagnostics.map((diagnostic) => diagnostic.code);
	sdl = readFileSync(join(compiled.outDir, "schema.graphql"), "utf8");
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
		readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
	};
	mistaken = await compileFixture(here, "mistaken");
	const product = {
		id: "p1",
		category_id: "c1",
		name: "Lamp",
		extra: { any: ["json"] },
		settings: { theme: "dark" },
		shade: "warm",
		token: "t0k3n",
	};
	const handler =
		(operationId: string, answer: () => object) =>
		(_caller: unknown, input: Readonly<Record<string, unknown>>) => {
			received.push({ operationId, input });
			return answer();
		};
	schema = generated.createSchema(
		() => ({
			Products_read: handler("Products_read", () => ({ status: 200, body: product })),
			Products_create: handler("Products_create", () => ({ status: 201, body: product })),
			Categories_read: handler("Categories_read", () => ({
				status: 200,
				body: { id: "c1", name: "Lighting" },
			})),
		}),
		{ authorize: () => "allow", context: () => ({ subject: "declarations" }) },
	);
}, 300_000);

describe("@json", () => {
	it("raises no projected-as-json for the projection it accepts", () => {
		expect(codes).toEqual([]);
		expect(sdl).toMatch(/^\s+extra: JSON$/m);
	});

	/** A named type is accepted wherever it is reached, as a property's type is. */
	it("accepts a named model, union or scalar it names, each still JSON", () => {
		for (const field of ["settings", "shade", "token"]) {
			expect(sdl, field).toMatch(new RegExp(`^\\s+${field}: JSON!$`, "m"));
		}
		expect(sdl).not.toMatch(/^(type|union|scalar) (Settings|Shade|Opaque)\b/m);
	});

	/** The README's remedy for a warning nobody reads, made usable: every diagnostic an error. */
	it("lets the surface build under warn-as-error, where a dropped link still fails it", async () => {
		const build = async (name: string) => {
			const outputDir = join(here, ".out", `warn-as-error-${name}`);
			const program = await compile(NodeHost, join(here, `${name}.tsp`), {
				outputDir,
				warningAsError: true,
				emit: ["typespec-http-graphql"],
				// `extra` holds `null` beside a union, which 3.0 cannot say.
				options: {
					"@typespec/openapi3": { "openapi-versions": ["3.1.0"] },
					"typespec-http-graphql": { "emitter-output-dir": outputDir },
				},
			});
			return program.diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code}`);
		};
		expect(await build("main")).toEqual([]);
		expect(await build("dropped")).toEqual(["error typespec-http-graphql/unknown-link-property"]);
	});

	it("is warned, at the declaration, on a type projected as a type of its own", () => {
		expect(
			mistaken.messages
				.filter((diagnostic) => diagnostic.code.endsWith("not-projected-as-json"))
				.map((diagnostic) => diagnostic.message),
		).toEqual([
			"'@json' accepts 'Catalog.Category' as the 'JSON' scalar, but it is projected as 'Category', a GraphQL type of its own, so the declaration does nothing. Remove it from graphql.tsp.",
		]);
		expect(mistaken.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"typespec-http-graphql/projected-as-json",
		);
	});
});

describe("a warning two services meet", () => {
	/**
	 * **Reported once, at its one declaration.** Each service is planned on its own, and the compiler
	 * keeps every diagnostic it is given, so a type two services project was warned once per service.
	 */
	it("is reported once, however many services project the type", async () => {
		const compiled = await compileFixture(here, "twice");
		const count = (code: string) =>
			compiled.diagnostics.filter(
				(diagnostic) => diagnostic.code === `typespec-http-graphql/${code}`,
			).length;
		expect(count("not-projected-as-json")).toBe(1);
		expect(count("projected-as-json")).toBe(1);
	});
});

describe("@inputHeader", () => {
	it("makes the optional header a field of that mutation's input, and leaves every other omitted", () => {
		expect(sdl).toMatch(
			/input CreateProductInput \{\n\s+idempotencyKey: String\n\s+name: String!\n\}/,
		);
		expect(sdl).toMatch(/product\(id: String!\): Product/);
	});

	it("sends each mutation in a document its own key, under the header's wire name", async () => {
		received.length = 0;
		const result = await graphql({
			schema,
			source: `mutation {
				a: createProduct(input: { idempotencyKey: "k-1", name: "Lamp" }) { __typename }
				b: createProduct(input: { idempotencyKey: "k-2", name: "Desk" }) { __typename }
			}`,
			contextValue: {},
		});
		expect(result.errors).toBeUndefined();
		expect(received.map(({ input }) => input)).toEqual([
			{ "Idempotency-Key": "k-1", name: "Lamp" },
			{ "Idempotency-Key": "k-2", name: "Desk" },
		]);
	});

	/** An argument of every query field and link calling the operation, as a mutation's is a field. */
	it("makes the optional header an argument of the query field and the link that call its operation", async () => {
		expect(sdl).toMatch(/^\s+category\(id: String!, acceptLanguage: String\): Category /m);
		expect(sdl).toMatch(/^\s+category\(acceptLanguage: String\): Category /m);
		received.length = 0;
		const result = await graphql({
			schema,
			source: `{
				category(id: "c1", acceptLanguage: "fr") { id }
				product(id: "p1") { category(acceptLanguage: "de") { id } }
			}`,
			contextValue: {},
		});
		expect(result.errors).toBeUndefined();
		expect(
			received
				.filter(({ operationId }) => operationId === "Categories_read")
				.map(({ input }) => input),
		).toEqual([
			{ id: "c1", "Accept-Language": "fr" },
			{ id: "c1", "Accept-Language": "de" },
		]);
	});

	it("is warned where it names no optional header of its operation, and changes nothing", () => {
		expect(
			mistaken.messages
				.filter((diagnostic) => diagnostic.code.endsWith("input-header-ignored"))
				.map((diagnostic) => diagnostic.message)
				.toSorted(),
		).toEqual([
			"'@inputHeader' names 'accept' of 'Audits_read', which has one literal value, which the resolver supplies, so it changes nothing. Name an optional header of the operation, as TypeSpec declares it.",
			"'@inputHeader' names 'id' of 'Products_read', which is a path parameter, not a header, so it changes nothing. Name an optional header of the operation, as TypeSpec declares it.",
			"'@inputHeader' names 'nope' of 'Products_read', which is not a parameter of it, so it changes nothing. Name an optional header of the operation, as TypeSpec declares it.",
			"'@inputHeader' names 'store' of 'Audits_read', which is a required header, which is input already, so it changes nothing. Name an optional header of the operation, as TypeSpec declares it.",
		]);
	});
});

describe("a field's own description", () => {
	it("replaces the operation's on a root field and a link, which keep their REST wording elsewhere", () => {
		const described = (description: string, field: string) =>
			`  """\n  ${description}\n  """\n  ${field}`;
		expect(sdl).toContain(described("One product, or null when there is none.", "product("));
		expect(sdl).toContain(described("Create a product.", "createProduct("));
		expect(sdl).toContain(
			described("The product's category.", "category(acceptLanguage: String): Category"),
		);
		expect(sdl).toContain(
			described("Fetch one category. Answers 404 when there is none.", "category("),
		);
		expect(sdl).not.toContain("?fields=a");
		expect(schema.getQueryType()?.getFields()["product"]?.description).toBe(
			"One product, or null when there is none.",
		);
	});
});
