import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	graphql,
	GraphQLEnumType,
	GraphQLInputObjectType,
	GraphQLInterfaceType,
	GraphQLObjectType,
	GraphQLScalarType,
	type GraphQLSchema,
	GraphQLString,
	GraphQLUnionType,
	printSchema,
	validateSchema,
} from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import type { OutputFieldPlan, SchemaPlan } from "../../src/model.js";
import { named } from "../../src/model.js";
import { typecheckEmitted } from "../support/typecheck-emitted.js";
import { PLAN } from "./plan-fixture.js";
import { writePlanModule } from "./write-plan-module.js";
import { byCodeUnit } from "../support/by-code-unit.js";

/**
 * **`graphql.gen.ts` rendered from a hand-built plan: it compiles, it builds, and it resolves.**
 *
 * The plan carries every TypeDef kind and every rendering rule (see `plan-fixture.ts`). The output
 * is compiled by `tsc` under the settings a consumer builds with, beside a consumer's own file, then
 * imported and executed, as typespec-http-mcp's acceptance suite imports its emitted module.
 */

interface Generated {
	readonly createSchema: (
		handlersFor: (context: object) => object,
		deps: {
			readonly authorize: () => "allow";
			readonly context: (context: object) => string;
		},
		extend?: (types: Readonly<Record<string, unknown>>) => unknown,
	) => GraphQLSchema;
}

const deps = { authorize: () => "allow" as const, context: () => "caller" };

let calls: { operationId: string; input: unknown }[] = [];

const book = (id: string) => ({
	id,
	title: `title ${id}`,
	legacy_title: "old",
	status: "archived",
	created_at: "2026-10-13T00:00:00Z",
	author_id: "t1",
	metadata: { nested: { snake_case: true } },
	last_event: { kind: "review", reviewer: "r1" },
});

function handlersFor(): object {
	const record =
		(operationId: string, answer: (input: Record<string, unknown>) => unknown) =>
		(_ctx: unknown, input: Record<string, unknown>) => {
			calls.push({ operationId, input });
			return answer(input);
		};
	return {
		Books_read: record("Books_read", (input) => ({
			status: 200,
			body: book(String(input["id"])),
		})),
		Books_list: record("Books_list", () => ({
			status: 200,
			body: { items: [book("c1"), book("c2")], next_token: "n1" },
		})),
		Books_create: record("Books_create", () => ({
			status: 201,
			body: book("c9"),
		})),
		Books_rename: record("Books_rename", (input) => ({
			status: 200,
			body: {
				...book(String(input["id"])),
				title: (input["body"] as { title: string }).title,
			},
		})),
		Books_summary: record("Books_summary", (input) => ({
			status: 200,
			body: { text: String(input["accept"]) },
		})),
		Authors_read: record("Authors_read", (input) => ({
			status: 200,
			body: { id: input["authorId"], name: "Author one" },
		})),
	};
}

async function importModule(outDir: string): Promise<Generated> {
	return (await import(join(outDir, "graphql.gen.ts"))) as Generated;
}

const tsc = fileURLToPath(new URL("../../node_modules/.bin/tsc", import.meta.url));

describe("the rendered module compiles under the settings a consumer builds with", () => {
	for (const sealed of [false, true]) {
		it(`typechecks beside a consumer's handler object, with seal-object-schemas ${sealed}`, () => {
			const outDir = writePlanModule(`render-compile-${sealed}`, { sealed });
			const { output, failed } = typecheckEmitted(outDir);
			expect(output).toBe("");
			expect(failed).toBe(false);
		});
	}

	it("typechecks under erasableSyntaxOnly and verbatimModuleSyntax too", () => {
		const outDir = writePlanModule("render-erasable", { sealed: false });
		expect(typecheckEmitted(outDir).failed).toBe(false);
		const output = execFileSync(
			tsc,
			[
				"-p",
				join(outDir, "tsconfig.emitted.json"),
				"--ignoreConfig",
				"--erasableSyntaxOnly",
				"--verbatimModuleSyntax",
			],
			{ encoding: "utf8" },
		);
		expect(output).toBe("");
	});

	it("exports exactly createSchema, the five named types and one result type per operation", () => {
		const outDir = writePlanModule("render-exports", { sealed: false });
		const text = readFileSync(join(outDir, "graphql.gen.ts"), "utf8");
		const exported = [...text.matchAll(/^export (?:interface|type|function|const) (\w+)/gm)].map(
			(m) => m[1],
		);
		expect(exported.toSorted(byCodeUnit)).toEqual(
			[
				"createSchema",
				"DeclaredOperationId",
				"GraphQLExhaustive",
				"GraphQLExtension",
				"GraphQLOperations",
				"GraphQLTypes",
				"Books_createResult",
				"Books_listResult",
				"Books_readResult",
				"Books_renameResult",
				"Books_summaryResult",
				"Authors_readResult",
			].toSorted(),
		);
	});

	it("still compiles when the plan calls no operation", () => {
		const empty: SchemaPlan = {
			types: [],
			query: [
				{
					name: "_empty",
					wire: "_empty",
					type: named("Boolean", false),
					description: undefined,
					deprecationReason: undefined,
					arguments: [],
					call: undefined,
					directives: [],
				},
			],
			mutation: [],
			operations: [],
			statusCodes: {},
			usesCost: false,
		};
		const outDir = writePlanModule("render-empty", { sealed: false, plan: empty, declared: [] });
		const { output, failed } = typecheckEmitted(outDir);
		expect(output).toBe("");
		expect(failed).toBe(false);
		expect(readFileSync(join(outDir, "graphql.gen.ts"), "utf8")).toContain("_handlersFor");
	});
});

describe("the rendered module builds the planned schema", () => {
	let schema: GraphQLSchema;

	beforeAll(async () => {
		const generated = await importModule(writePlanModule("render-run", { sealed: true }));
		schema = generated.createSchema(handlersFor, deps);
	});

	it("is a valid schema", () => {
		expect(validateSchema(schema)).toEqual([]);
	});

	it("defines every planned type, as the class its kind names", () => {
		const CLASS = {
			object: GraphQLObjectType,
			interface: GraphQLInterfaceType,
			input: GraphQLInputObjectType,
			enum: GraphQLEnumType,
			union: GraphQLUnionType,
			scalar: GraphQLScalarType,
		} as const;
		for (const def of PLAN.types) {
			expect({ name: def.name, ok: schema.getType(def.name) instanceof CLASS[def.kind] }).toEqual({
				name: def.name,
				ok: true,
			});
		}
		expect(PLAN.types).toHaveLength(20);
		const printed = printSchema(schema);
		expect(printed).toContain(
			'"""What every identified thing shares."""\ninterface IdentifiedInterface {',
		);
		expect(printed).toContain("type Book implements IdentifiedInterface {");
		expect(printed).toContain("type Author implements IdentifiedInterface {");
		expect(printed).toContain("type Query {");
		expect(printed).toContain("type Mutation {");
		expect(printed).toContain("directive @cost(weight: String!)");
		expect(printed).toContain("directive @listSize(");
		expect(printed).toContain('legacyTitle: String @deprecated(reason: "Use title.")');
		expect(printed).toContain('ARCHIVED @deprecated(reason: "Use CLOSED.")');
		expect(printed).toContain(
			'scalar UTCDateTime @specifiedBy(url: "https://scalars.graphql.org/chillicream/date-time.html")',
		);
		expect(printed).toContain('"""Any JSON value."""\nscalar JSON');
		expect(printed).toContain(
			'"""A UTC date and time, as an RFC 3339 string."""\nscalar UTCDateTime @specifiedBy(',
		);
	});

	/**
	 * The wire rules are code (`CallRuntime.args`, `INPUT_RULES`), so a schema rebuilt from its SDL or
	 * transformed loses nothing a resolver reads. No argument or input field states one in `extensions`.
	 */
	it("states no wire rule in any argument's or input field's extensions", () => {
		const stated: string[] = [];
		for (const type of Object.values(schema.getTypeMap())) {
			if (type.name.startsWith("__")) continue;
			if (type instanceof GraphQLObjectType) {
				for (const field of Object.values(type.getFields())) {
					for (const argument of field.args) {
						if (Object.keys(argument.extensions).length > 0)
							stated.push(`${type.name}.${field.name}(${argument.name})`);
					}
				}
			}
			if (type instanceof GraphQLInputObjectType) {
				for (const field of Object.values(type.getFields())) {
					if (Object.keys(field.extensions).length > 0) stated.push(`${type.name}.${field.name}`);
				}
			}
		}
		expect(stated).toEqual([]);
	});

	it("repeats the cost directives in each field's extensions", () => {
		const books = schema.getQueryType()?.getFields()["books"];
		expect(books?.extensions).toEqual({
			cost: { weight: "1" },
			listSize: {
				slicingArguments: ["first"],
				sizedFields: ["edges", "nodes"],
				requireOneSlicingArgument: false,
			},
			operationId: "Books_list",
		});
	});

	/**
	 * **A tracer tells a handler call from a property read by `extensions.operationId`**: every field
	 * has a resolver, so graphql-js's `isDefaultResolver` is false on all of them. The field that calls
	 * an operation names it, and no other field carries the key.
	 */
	it("names the operation in the extensions of every field that calls one, and of no other", () => {
		const planned = new Map<string, string | undefined>();
		const record = (type: string, fields: readonly OutputFieldPlan[]) => {
			for (const field of fields) planned.set(`${type}.${field.name}`, field.call?.operationId);
		};
		record("Query", PLAN.query);
		record("Mutation", PLAN.mutation);
		for (const def of PLAN.types) {
			if (def.kind === "object" || def.kind === "interface") record(def.name, def.fields);
		}
		const found = new Map<string, unknown>();
		for (const [key] of planned) {
			const [type = "", name = ""] = key.split(".");
			const owner = schema.getType(type);
			if (!(owner instanceof GraphQLObjectType || owner instanceof GraphQLInterfaceType)) continue;
			found.set(key, owner.getFields()[name]?.extensions["operationId"]);
		}
		expect(found).toEqual(planned);
		expect([...planned.values()].filter((id) => id !== undefined).length).toBeGreaterThan(2);
	});

	it("resolves a root field, wire-renamed fields, a link, a JSON scalar and a discriminated union", async () => {
		calls = [];
		const result = await graphql({
			schema,
			source: `{ book(id: "c1", xApiVersion: "v1") {
				id createdAt legacyTitle status metadata
				author { name }
				lastEvent { __typename ... on ReviewEvent { reviewer } }
			} }`,
			contextValue: {},
		});
		expect(result).toEqual({
			data: {
				book: {
					id: "c1",
					createdAt: "2026-10-13T00:00:00Z",
					legacyTitle: "old",
					status: "ARCHIVED",
					metadata: { nested: { snake_case: true } },
					author: { name: "Author one" },
					lastEvent: { __typename: "ReviewEvent", reviewer: "r1" },
				},
			},
		});
		expect(calls).toEqual([
			{ operationId: "Books_read", input: { id: "c1", "x-api-version": "v1" } },
			{ operationId: "Authors_read", input: { authorId: "t1" } },
		]);
	});

	/**
	 * graphql-js's default resolver reads `source[name]` through the prototype chain and CALLS a
	 * function it finds there, so with it a body lacking `constructor` answered `Object` called on the
	 * arguments: "String cannot represent value: {}". Every rendered field reads its own property.
	 */
	it("answers null, with no error, for a field whose wire key Object.prototype owns and the value lacks", async () => {
		const result = await graphql({
			schema,
			source: `{ book(id: "c1", xApiVersion: "v1") { id constructor } }`,
			contextValue: {},
		});
		expect(result).toEqual({ data: { book: { id: "c1", constructor: null } } });
	});

	it("resolves a connection, with first, a returned cursor and an enum argument at their wire keys", async () => {
		const opening = await graphql({
			schema,
			source: `{ books(first: 2, status: OPEN) { pageInfo { endCursor } } }`,
			contextValue: {},
		});
		const endCursor = (opening.data as { books: { pageInfo: { endCursor: string } } }).books
			.pageInfo.endCursor;
		calls = [];
		const result = await graphql({
			schema,
			source: `{ books(first: 2, after: "${endCursor}", status: OPEN) { nodes { id } } }`,
			contextValue: {},
		});
		expect(result).toEqual({
			data: { books: { nodes: [{ id: "c1" }, { id: "c2" }] } },
		});
		// The opening page's next token, which the handler answered as `n1`, is what `after` resumes at.
		expect(calls).toEqual([
			{
				operationId: "Books_list",
				input: { "page-size": 2, "page-token": "n1", status: "open" },
			},
		]);
	});

	it("merges a mutation's input, renames, drops an explicit null, and answers a member", async () => {
		calls = [];
		const result = await graphql({
			schema,
			source: `mutation { createBook(input: {
				xApiVersion: "v2", title: "t", authorId: null, note: null, labels: [{ displayName: "a" }]
			}) { __typename ... on Book { id } } }`,
			contextValue: {},
		});
		expect(result).toEqual({
			data: { createBook: { __typename: "Book", id: "c9" } },
		});
		expect(calls).toEqual([
			{
				operationId: "Books_create",
				input: { "x-api-version": "v2", title: "t", note: null, labels: [{ display_name: "a" }] },
			},
		]);
	});

	it("keeps a named body under its key, and supplies the negotiated accept", async () => {
		calls = [];
		const renamed = await graphql({
			schema,
			source: `mutation { renameBook(input: { id: "c3", body: { title: "new" } }) { title } }`,
			contextValue: {},
		});
		expect(renamed).toEqual({ data: { renameBook: { title: "new" } } });
		const summary = await graphql({
			schema,
			source: `{ bookSummary(id: "c3") { text } }`,
			contextValue: {},
		});
		expect(summary).toEqual({ data: { bookSummary: { text: "application/json" } } });
		expect(calls).toEqual([
			{ operationId: "Books_rename", input: { id: "c3", body: { title: "new" } } },
			{ operationId: "Books_summary", input: { id: "c3", accept: "application/json" } },
		]);
	});
});

describe("the escape hatch", () => {
	let generated: Generated;
	beforeAll(async () => {
		generated = await importModule(writePlanModule("render-extend", { sealed: false }));
	});

	it("adds hand-written fields to Query and to a generated type, typed by the generated types", async () => {
		const schema = generated.createSchema(handlersFor, deps, (types) => ({
			query: {
				authorOfTheDay: {
					type: types["Author"] as GraphQLObjectType,
					resolve: () => ({ id: "t9", name: "Ninth" }),
				},
			},
			fields: {
				Author: {
					slug: {
						type: GraphQLString,
						resolve: (author: { readonly name: string }) => author.name.toLowerCase(),
					},
				},
			},
		}));
		expect(validateSchema(schema)).toEqual([]);
		const result = await graphql({
			schema,
			source: `{ authorOfTheDay { id slug } book(id: "c1", xApiVersion: "v1") { author { slug } } }`,
			contextValue: {},
		});
		expect(result).toEqual({
			data: {
				authorOfTheDay: { id: "t9", slug: "ninth" },
				book: { author: { slug: "author one" } },
			},
		});
	});

	it("throws when the schema is built if an extension field collides with a generated one, naming both", () => {
		expect(() =>
			generated.createSchema(handlersFor, deps, () => ({
				fields: { Author: { name: { type: GraphQLString } } },
			})),
		).toThrow(
			"The extension's field Author.name collides with the generated field Author.name; rename the extension's field",
		);
	});
});
