import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { GraphQLSchema } from "graphql";
import { type Context, Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";
import { executeThroughYoga, type GraphQLResult } from "../support/yoga.js";

/**
 * **A `@discriminator` base, value by value: what REST serves, what GraphQL answers, and what the
 * document says each value is.**
 *
 * The expected side is the document `@typespec/openapi3` publishes, graded with Ajv, never either
 * server. A value the base's schema refuses is refused by both. One it accepts is served by both,
 * and is, by OAS 3.1.1 § 4.8.25, the subtype its discriminator's `mapping` names if and only if it
 * validates against that subtype's schema, and otherwise the base: `discriminator` changes no
 * validation outcome. A nested base is decided again by its own mapping.
 *
 * The first two tables are an extensible `Dog` whose `Golden` adds a property, and a fixed `Snake`.
 * A `Puppy` only narrows a property its base declares, `Shark` is a base under `Fish`, and `Animal`
 * declares its discriminator under another wire key.
 *
 * **A value naming a subtype it is not a valid instance of is the base**, on both surfaces: the
 * resolver asks the subtype's own validator, imported by the name the library publishes for it
 * (`typeSchemaNames`). These rows were held, answered as the subtype, until typespec-http-zod 0.33.0
 * published the names.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

interface Row {
	readonly field: "dog" | "snake" | "pet" | "fish" | "shark" | "animal";
	readonly name: string;
	readonly value: Readonly<Record<string, unknown>>;
	/** What GraphQL answers for an accepted value: written by hand, its `__typename` by the document. */
	readonly answer?: Readonly<Record<string, unknown>>;
}

const ROWS: readonly Row[] = [
	{
		field: "dog",
		name: "a valid Golden",
		value: { kind: "golden", weight: 8, coat: "red" },
		answer: { __typename: "Golden", kind: "golden", weight: 8, coat: "red" },
	},
	{
		field: "dog",
		name: "a kind no subtype names",
		value: { kind: "wrongKind", weight: 8 },
		answer: { __typename: "Dog", kind: "wrongKind", weight: 8 },
	},
	{
		field: "dog",
		name: "a Golden's kind with no coat",
		value: { kind: "golden", weight: 8 },
		answer: { __typename: "Dog", kind: "golden", weight: 8 },
	},
	{ field: "dog", name: "no weight", value: { kind: "golden" } },
	{
		field: "snake",
		name: "a valid Cobra",
		value: { kind: "cobra", length: 8, hood: true },
		answer: { __typename: "Cobra", kind: "COBRA", length: 8, hood: true },
	},
	{
		field: "snake",
		name: "a Cobra's kind with no hood",
		value: { kind: "cobra", length: 8 },
		answer: { __typename: "Snake", kind: "COBRA", length: 8 },
	},
	{
		field: "snake",
		name: "a kind the enum does not hold",
		value: { kind: "wrongKind", length: 8 },
	},
	{
		field: "pet",
		name: "a valid Puppy",
		value: { kind: "puppy", age: 1 },
		answer: { __typename: "Puppy", kind: "puppy", age: 1 },
	},
	{
		field: "pet",
		name: "a Puppy's kind past the age a Puppy allows",
		value: { kind: "puppy", age: 5 },
		answer: { __typename: "Pet", kind: "puppy", age: 5 },
	},
	{
		field: "pet",
		name: "a kind no subtype names",
		value: { kind: "cat", age: 5 },
		answer: { __typename: "Pet", kind: "cat", age: 5 },
	},
	{
		field: "fish",
		name: "a valid Salmon",
		value: { kind: "salmon", age: 1, river: "Tay" },
		answer: { __typename: "Salmon", kind: "salmon", age: 1, river: "Tay" },
	},
	{
		field: "fish",
		name: "a valid SawShark, through the nested base",
		value: { kind: "shark", sharktype: "saw", age: 1, teeth: 3 },
		answer: { __typename: "SawShark", kind: "shark", age: 1, sharktype: "saw", teeth: 3 },
	},
	{
		field: "fish",
		name: "a Shark whose sharktype no subtype names",
		value: { kind: "shark", sharktype: "goblin", age: 1 },
		answer: { __typename: "Shark", kind: "shark", age: 1, sharktype: "goblin" },
	},
	{
		field: "fish",
		name: "a kind no subtype names",
		value: { kind: "trout", age: 1 },
		answer: { __typename: "Fish", kind: "trout", age: 1 },
	},
	{
		field: "shark",
		name: "a valid SawShark",
		value: { kind: "shark", sharktype: "saw", age: 1, teeth: 3 },
		answer: { __typename: "SawShark", kind: "shark", age: 1, sharktype: "saw", teeth: 3 },
	},
	{
		field: "shark",
		name: "a sharktype no subtype names",
		value: { kind: "shark", sharktype: "nurse", age: 2 },
		answer: { __typename: "Shark", kind: "shark", age: 2, sharktype: "nurse" },
	},
	{
		field: "animal",
		name: "a valid Bird, dispatched by the kind the discriminator names, not the base's type",
		value: { type: "finch", legs: 2, kind: "bird", wings: 2 },
		answer: { __typename: "Bird", type: "finch", legs: 2, kind: "bird", wings: 2 },
	},
	{
		field: "animal",
		name: "a kind no subtype names",
		value: { type: "bird", legs: 4, kind: "cat" },
		answer: { __typename: "Animal", type: "bird", legs: 4, kind: "cat" },
	},
	{ field: "animal", name: "no type", value: { legs: 2, kind: "bird", wings: 2 } },
];

/** Each field's selection: the base's interface, then what each member adds. */
const SELECTIONS: Readonly<Record<Row["field"], string>> = {
	dog: "__typename ... on DogInterface { kind weight } ... on Golden { coat }",
	snake: "__typename ... on SnakeInterface { kind length } ... on Cobra { hood }",
	pet: "__typename ... on PetInterface { kind age }",
	fish: "__typename ... on FishInterface { kind age } ... on Salmon { river } ... on SharkInterface { sharktype } ... on SawShark { teeth }",
	shark: "__typename ... on SharkInterface { kind age sharktype } ... on SawShark { teeth }",
	animal: "__typename ... on AnimalInterface { type legs kind } ... on Bird { wings }",
};

const RESPONSE_OF: Readonly<Record<Row["field"], string>> = {
	dog: "/dog",
	snake: "/snake",
	pet: "/pet",
	fish: "/fish",
	shark: "/shark",
	animal: "/animal",
};

interface Schema {
	readonly $ref?: string;
	readonly discriminator?: {
		readonly propertyName: string;
		readonly mapping?: Readonly<Record<string, string>>;
	};
}

interface Document {
	readonly paths: Readonly<
		Record<
			string,
			{
				readonly get: {
					readonly responses: Readonly<
						Record<
							string,
							{ readonly content: Readonly<Record<string, { readonly schema: Schema }>> }
						>
					>;
				};
			}
		>
	>;
	readonly components: { readonly schemas: Readonly<Record<string, Schema>> };
}

let document: Document;
const ajv = new Ajv2020({ strict: false, validateFormats: false, validateSchema: false });

/** Whether the document's schema at `ref`, its components beside it, accepts `value`. */
function accepts(ref: string, value: unknown): boolean {
	return ajv.validate({ $ref: ref, components: document.components }, value);
}

/**
 * The component a value of the schema at `ref` is, by OAS 3.1.1 § 4.8.25: the subtype the
 * discriminator's mapping names where the value validates against it, decided again there for a
 * nested base, and otherwise the base itself.
 */
function documentTypeOf(ref: string, value: Readonly<Record<string, unknown>>): string {
	const name = ref.slice("#/components/schemas/".length);
	const schema = document.components.schemas[name];
	const discriminator = schema?.discriminator;
	if (discriminator === undefined) return name;
	const tag = value[discriminator.propertyName];
	const target = typeof tag === "string" ? discriminator.mapping?.[tag] : undefined;
	return target !== undefined && accepts(target, value) ? documentTypeOf(target, value) : name;
}

function responseRefOf(row: Row): string {
	const schema =
		document.paths[RESPONSE_OF[row.field]]?.get.responses["200"]?.content["application/json"]
			?.schema;
	if (schema?.$ref === undefined) throw new Error(`the document publishes no 200 for ${row.field}`);
	return schema.$ref;
}

const answers = new Map<string, Readonly<Record<string, unknown>>>();
const handlerFor =
	() =>
	(_c: unknown, input: { readonly which: string }): { status: number; body: unknown } => ({
		status: 200,
		body: answers.get(input.which),
	});
const handlers = {
	dog: handlerFor(),
	snake: handlerFor(),
	pet: handlerFor(),
	fish: handlerFor(),
	shark: handlerFor(),
	animal: handlerFor(),
};

const rest = new Hono();
let schema: GraphQLSchema;

beforeAll(async () => {
	const compiled = await compileFixture(here, "discriminators", {
		withServer: true,
		withDocument: true,
	});
	document = JSON.parse(
		readFileSync(join(compiled.documentDir, "openapi.json"), "utf8"),
	) as Document;
	const routes = (await import(join(compiled.serverDir, "app.gen.ts"))) as {
		readonly registerRoutes: (app: Hono, handlersFor: () => object, deps: object) => void;
	};
	routes.registerRoutes(rest, () => handlers, {
		authorize: () => async (_c: Context, next: () => Promise<void>) => {
			await next();
		},
		context: () => ({ subject: "kennel" }),
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
		context: () => ({ subject: "kennel" }),
	});
	ROWS.forEach((row, index) => answers.set(String(index), row.value));
}, 300_000);

async function served(row: Row): Promise<{ status: number; body: unknown }> {
	const response = await rest.request(
		`${RESPONSE_OF[row.field]}?which=${String(ROWS.indexOf(row))}`,
	);
	const text = await response.text();
	return { status: response.status, body: response.status === 200 ? JSON.parse(text) : undefined };
}

async function answered(row: Row): Promise<GraphQLResult> {
	return executeThroughYoga(
		schema,
		{
			query: `{ ${row.field}(which: "${String(ROWS.indexOf(row))}") { ${SELECTIONS[row.field]} } }`,
		},
		{},
	);
}

describe("a value the base's schema refuses", () => {
	it.each(ROWS.filter((row) => row.answer === undefined))(
		"$field: $name is refused by the document, REST and GraphQL",
		async (row) => {
			expect(accepts(responseRefOf(row), row.value)).toBe(false);
			expect((await served(row)).status).toBe(500);
			const result = await answered(row);
			expect(result.data).toEqual({ [row.field]: null });
			expect(result.errors).toHaveLength(1);
		},
	);
});

describe("a value the base's schema accepts", () => {
	it.each(ROWS.filter((row) => row.answer !== undefined))(
		"$field: $name is served by REST and answered by GraphQL as the type the document says",
		async (row) => {
			expect(accepts(responseRefOf(row), row.value)).toBe(true);
			expect(row.answer?.["__typename"]).toBe(documentTypeOf(responseRefOf(row), row.value));
			expect(await served(row)).toEqual({ status: 200, body: row.value });
			expect(await answered(row)).toEqual({ status: 200, data: { [row.field]: row.answer } });
		},
	);
});
