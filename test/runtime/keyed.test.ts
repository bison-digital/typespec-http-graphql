import {
	type ExecutionResult,
	graphql,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
	type GraphQLResolveInfo,
	GraphQLSchema,
	GraphQLString,
	GraphQLUnionType,
} from "graphql";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type CallRuntime,
	type GraphQLDeps,
	keyedResolver,
	memberTypeOf,
	resolverFor,
} from "../../src/runtime.js";

/**
 * **A link chosen by a kind, through graphql-js's own executor, against a hand-built schema.** The
 * schema is what `graphql.gen.ts` writes for a keyed link, by hand, so every rule here is the
 * runtime's: which arm a value chooses, what is called, and which member each answer is.
 */

const bookSchema = z.object({ id: z.string(), title: z.string() });
const authorSchema = z.object({ id: z.string(), name: z.string() });
const problemSchema = z.object({ message: z.string() });
const idInput = z.looseObject({ id: z.string() });

function call(overrides: Partial<CallRuntime> & Pick<CallRuntime, "operationId">): CallRuntime {
	return {
		kind: "link",
		authentication: "none",
		security: [],
		input: idInput,
		arms: [],
		bound: [],
		supplied: {},
		projection: {},
		connection: undefined,
		args: {},
		...overrides,
	};
}

let calls: string[];
let answers: Record<string, (id: string) => unknown>;

function handlersFor(): object {
	const handler =
		(operationId: string) =>
		(_ctx: unknown, input: { readonly id: string }): unknown => {
			calls.push(`${operationId} ${input.id}`);
			const answer = answers[operationId];
			if (answer === undefined) throw new Error(`unexpected call to ${operationId}`);
			return answer(input.id);
		};
	return {
		Books_read: handler("Books_read"),
		Authors_read: handler("Authors_read"),
		Shelves_read: handler("Shelves_read"),
	};
}

const deps: GraphQLDeps<object, string> = { authorize: () => "allow", context: () => "caller" };

const Book = new GraphQLObjectType({
	name: "Book",
	fields: { id: { type: new GraphQLNonNull(GraphQLString) }, title: { type: GraphQLString } },
});
const Author = new GraphQLObjectType({
	name: "Author",
	fields: { id: { type: new GraphQLNonNull(GraphQLString) }, name: { type: GraphQLString } },
});
/** A member a shelf's own result union already tagged, by its arm: `memberTypeOf` reads that tag. */
const Shelf = new GraphQLObjectType({
	name: "Shelf",
	fields: { id: { type: new GraphQLNonNull(GraphQLString) } },
});
const Subject = new GraphQLUnionType({
	name: "ReviewSubject",
	types: [Book, Author, Shelf],
	resolveType: memberTypeOf,
});

const bookArm = (bound: CallRuntime["bound"]) =>
	resolverFor(
		call({
			operationId: "Books_read",
			arms: [
				{ status: 200, schema: bookSchema },
				{ status: 404, schema: problemSchema },
			],
			bound,
			projection: { "200": { as: "value" }, "404": { as: "null" } },
		}),
		handlersFor,
		deps,
		{},
	);
const authorArm = (bound: CallRuntime["bound"]) =>
	resolverFor(
		call({
			operationId: "Authors_read",
			arms: [{ status: 200, schema: authorSchema }],
			bound,
			projection: { "200": { as: "value" } },
		}),
		handlersFor,
		deps,
		{},
	);
/** An arm whose own projection tags its member, as a `…Result` union's arms do. */
const shelfArm = resolverFor(
	call({
		operationId: "Shelves_read",
		arms: [{ status: 200, schema: z.object({ id: z.string() }) }],
		bound: [{ wire: "id", parent: "subject_id" }],
		projection: { "200": { as: "member", type: "Shelf" } },
	}),
	handlersFor,
	deps,
	{},
);

const single = [{ wire: "id", parent: "subject_id" }] as const;
const listed = [{ wire: "id", parent: "subject_ids", list: true }] as const;

const Review = new GraphQLObjectType({
	name: "Review",
	fields: {
		id: { type: new GraphQLNonNull(GraphQLString) },
		subject: {
			type: Subject,
			resolve: keyedResolver("subject_type", [
				{ values: ["book"], member: "Book", resolve: bookArm(single) },
				{ values: ["author", "writer"], member: "Author", resolve: authorArm(single) },
				{ values: ["shelf"], resolve: shelfArm },
			]),
		},
		subjects: {
			type: new GraphQLList(Subject),
			resolve: keyedResolver("subject_type", [
				{ values: ["book"], member: "Book", resolve: bookArm(listed) },
				{ values: ["author"], member: "Author", resolve: authorArm(listed) },
			]),
		},
	},
});

let reviews: readonly Readonly<Record<string, unknown>>[];

const schema = new GraphQLSchema({
	query: new GraphQLObjectType({
		name: "Query",
		fields: { reviews: { type: new GraphQLList(Review), resolve: () => reviews } },
	}),
});

const run = (source: string): Promise<ExecutionResult> =>
	graphql({ schema, source, contextValue: {} });

const SUBJECT =
	"subject { __typename ... on Book { id } ... on Author { id } ... on Shelf { id } }";

beforeEach(() => {
	calls = [];
	answers = {
		Books_read: (id) =>
			id === "b404"
				? { status: 404, body: { message: "none" } }
				: { status: 200, body: { id, title: `title ${id}` } },
		Authors_read: (id) => ({ status: 200, body: { id, name: `name ${id}` } }),
		Shelves_read: (id) => ({ status: 200, body: { id } }),
	};
});

describe("keyedResolver", () => {
	it("calls the arm each value names, and answers that arm's member", async () => {
		reviews = [
			{ id: "r1", subject_type: "book", subject_id: "b1" },
			{ id: "r2", subject_type: "writer", subject_id: "a1" },
			{ id: "r3", subject_type: "author", subject_id: "a2" },
		];
		const result = await run(`{ reviews { id ${SUBJECT} } }`);
		expect(result).toEqual({
			data: {
				reviews: [
					{ id: "r1", subject: { __typename: "Book", id: "b1" } },
					{ id: "r2", subject: { __typename: "Author", id: "a1" } },
					{ id: "r3", subject: { __typename: "Author", id: "a2" } },
				],
			},
		});
		expect(calls).toEqual(["Books_read b1", "Authors_read a1", "Authors_read a2"]);
	});

	it("keeps the member an arm's own projection tagged", async () => {
		reviews = [{ id: "r1", subject_type: "shelf", subject_id: "s1" }];
		const result = await run(`{ reviews { ${SUBJECT} } }`);
		expect(result).toEqual({
			data: { reviews: [{ subject: { __typename: "Shelf", id: "s1" } }] },
		});
	});

	it("is null, calling nothing, for a value no arm names, one that is no string, and none", async () => {
		reviews = [
			{ id: "r1", subject_type: "series", subject_id: "x1" },
			{ id: "r2", subject_type: 1, subject_id: "x2" },
			{ id: "r3", subject_type: null, subject_id: "x3" },
			{ id: "r4", subject_id: "x4" },
			{ id: "r5", subject_type: ["book"], subject_id: "x5" },
		];
		const result = await run(`{ reviews { ${SUBJECT} } }`);
		expect(result).toEqual({
			data: { reviews: [null, null, null, null, null].map((subject) => ({ subject })) },
		});
		expect(calls).toEqual([]);
	});

	it("reads nothing of a parent that is no object, and calls nothing", () => {
		const resolve = keyedResolver("subject_type", [
			{
				values: ["book"],
				member: "Book",
				resolve: () => {
					throw new Error("an arm was called");
				},
			},
		]);
		for (const source of [undefined, null, "book"]) {
			expect(resolve(source, {}, {}, {} as GraphQLResolveInfo)).toBeNull();
		}
	});

	it("reads the kind as the parent's own property, never through its prototype", async () => {
		const inherited = Object.create({ subject_type: "book" }) as Record<string, unknown>;
		inherited["id"] = "r1";
		inherited["subject_id"] = "b1";
		reviews = [inherited];
		const result = await run(`{ reviews { ${SUBJECT} } }`);
		expect(result).toEqual({ data: { reviews: [{ subject: null }] } });
		expect(calls).toEqual([]);
	});

	it("passes the arm's null on, a 404 included", async () => {
		reviews = [
			{ id: "r1", subject_type: "book", subject_id: "b404" },
			{ id: "r2", subject_type: "book", subject_id: null },
		];
		const result = await run(`{ reviews { ${SUBJECT} } }`);
		expect(result).toEqual({ data: { reviews: [{ subject: null }, { subject: null }] } });
		expect(calls).toEqual(["Books_read b404"]);
	});

	it("tags each item of a list arm, and passes its nulls on", async () => {
		reviews = [
			{ id: "r1", subject_type: "book", subject_ids: ["b1", null, "b404"] },
			{ id: "r2", subject_type: "author", subject_ids: ["a1"] },
			{ id: "r3", subject_type: "book" },
		];
		const result = await run(
			`{ reviews { subjects { __typename ... on Book { id } ... on Author { id } } } }`,
		);
		expect(result).toEqual({
			data: {
				reviews: [
					{ subjects: [{ __typename: "Book", id: "b1" }, null, null] },
					{ subjects: [{ __typename: "Author", id: "a1" }] },
					{ subjects: null },
				],
			},
		});
		expect(calls).toEqual(["Books_read b1", "Books_read b404", "Authors_read a1"]);
	});
});
