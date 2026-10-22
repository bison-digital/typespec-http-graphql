/**
 * **The claim this package rests on, written the way an application writes it.**
 *
 * ONE handler object, passed to BOTH generated surfaces: the published `typespec-hono`'s
 * `registerRoutes` and this package's `createSchema`. If the two emitters ever derive a different
 * signature for one operation, this file stops compiling. Nothing else can see that, because the two
 * are separate packages deriving the same thing by the same rules.
 *
 * Excluded from `pnpm typecheck` by `tsconfig.json` (`**\/*.fixture.ts`): it imports from a
 * gitignored output directory. `agreement.test.ts` compiles it against freshly emitted output, which
 * cannot go stale.
 *
 * **Every line below is load-bearing.** See the docblocks.
 */
import { Hono } from "hono";
import {
	createSchema,
	type DeclaredOperationId,
	type GraphQLOperations,
} from "./.out/agreement/graphql.gen.js";
import type { GraphQLDeps } from "./.out/agreement/graphql-runtime.gen.js";
import { registerRoutes, type Operations } from "./.out/agreement/hono/app.gen.js";
import type { AppEnv, RouteDeps } from "./.out/agreement/hono/runtime.gen.js";

/** What both surfaces' `deps.context` establish, and therefore what every handler receives. */
interface Caller {
	readonly subject: string;
}

/** The GraphQL context value a server hands every resolver. */
interface GraphQLContext {
	readonly caller: string;
}

declare const routeDeps: RouteDeps<AppEnv, Caller>;
declare const graphqlDeps: GraphQLDeps<GraphQLContext, Caller>;

const author = { id: "t1", name: "Ada Lane" };
const book = { id: "c1", authorId: "t1", title: "Harbour Lights", status: "published" } as const;
const problem = (status: number, title: string) => ({ type: "about:blank", title, status });

/**
 * **`satisfies`, not an annotation.** An annotation widens the value to the annotation, `T` then
 * infers to it, `Exclude<keyof T, ...>` collapses to `never`, and the surplus-key guard in BOTH
 * `registerRoutes` and `createSchema` evaporates. `satisfies` checks the object and leaves its type
 * as written, so each `status` stays the literal that selects its response and both guards still see
 * every key.
 *
 * Every input shape is read and every kind of response returned: a `304` with its header and no
 * body, a bodyless `204`, two success statuses, a failure for each declared problem, an optional
 * body read by its presence, a named array body, a cookie, and the `accept` each negotiated
 * operation is handed.
 *
 * `Books_excerptAsText` answers text, which no GraphQL field carries, so `graphql.tsp`
 * declares no field for it. It is still in this ONE object: `createSchema` accepts a handler for an
 * operation the document declares and the GraphQL surface does not expose.
 */
const operations = {
	Authors_read: (_ctx: Caller, input) =>
		input.authorId === author.id
			? { status: 200, body: author }
			: { status: 404, body: problem(404, "Not Found") },
	Books_list: (_ctx: Caller, input) => ({
		status: 200,
		body: { items: [book], nextCursor: input.cursor === undefined ? "c2" : null },
	}),
	Books_read: (_ctx: Caller, input) =>
		input["If-None-Match"] === '"c1"'
			? { status: 304, headers: { etag: '"c1"' } }
			: input.bookId === book.id
				? { status: 200, body: book }
				: { status: 404, body: problem(404, "Not Found") },
	Books_create: (ctx: Caller, input) =>
		input.originalLanguage === "duplicate"
			? { status: 409, body: problem(409, "Conflict") }
			: {
					status: 201,
					body: { ...book, title: input.title ?? ctx.subject },
					headers: { location: `/v1/books/${book.id}` },
				},
	Books_update: (_ctx: Caller, input) => ({
		status: 200,
		body: { ...book, id: input.bookId, title: input.title ?? null },
	}),
	Books_remove: (_ctx: Caller, input) =>
		input.bookId === book.id ? { status: 204 } : { status: 404, body: problem(404, "Not Found") },
	Books_note: (_ctx: Caller, input) => ({
		status: 200,
		body: { ...book, title: input.body?.text ?? null },
	}),
	Books_tag: (_ctx: Caller, input) => ({
		status: 200,
		body: { ...book, title: input.tags.join(", ") },
	}),
	Books_preferences: (_ctx: Caller, input) => ({
		status: 200,
		body: { locale: input.locale ?? "en-GB" },
	}),
	Books_excerptAsText: (_ctx: Caller, input) => ({
		status: 200,
		body: `${input.bookId} in ${input.accept}`,
	}),
	Books_excerptAsJson: (_ctx: Caller, input) => ({
		status: 200,
		body: { bookId: input.bookId, text: input.accept },
	}),
} satisfies Operations<Caller>;

/** The HTTP surface. */
const app = new Hono<AppEnv>();
registerRoutes(app, () => operations, routeDeps);

/** The GraphQL surface, from the SAME object. */
const schema = createSchema(() => operations, graphqlDeps);

/**
 * **The type-level half, which the value-level half above cannot see.**
 *
 * One object satisfying both proves it is assignable to each. It does NOT prove the two interfaces
 * are the same: a GraphQL input WIDER than the server's would still accept this object while
 * admitting values the HTTP surface refuses. `Identical<>` is invariant, so it catches that, for the
 * caller context, the input and every member of the result union.
 *
 * `Identical<A, B> & true` merely produces an odd type. **Only a constraint violation is an error**,
 * which is what `MustHold<T extends true>` is for.
 */
type Identical<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type MustHold<T extends true> = T;

/**
 * **Every operation is exposed but the one GraphQL cannot carry**, and that one is absent from
 * `GraphQLOperations` rather than present with another signature.
 */
type NotExposed = "Books_excerptAsText";
type _Keys = MustHold<
	Identical<keyof GraphQLOperations<Caller>, Exclude<keyof Operations<Caller>, NotExposed>>
>;
type _NotExposed = MustHold<Identical<Extract<keyof GraphQLOperations<Caller>, NotExposed>, never>>;
/** The document's operations, every one: what `createSchema` accepts a handler for. */
type _Declared = MustHold<Identical<DeclaredOperationId, keyof Operations<Caller>>>;
type _AuthorsRead = MustHold<
	Identical<GraphQLOperations<Caller>["Authors_read"], Operations<Caller>["Authors_read"]>
>;
type _List = MustHold<
	Identical<GraphQLOperations<Caller>["Books_list"], Operations<Caller>["Books_list"]>
>;
type _Read = MustHold<
	Identical<GraphQLOperations<Caller>["Books_read"], Operations<Caller>["Books_read"]>
>;
type _Create = MustHold<
	Identical<GraphQLOperations<Caller>["Books_create"], Operations<Caller>["Books_create"]>
>;
type _Update = MustHold<
	Identical<GraphQLOperations<Caller>["Books_update"], Operations<Caller>["Books_update"]>
>;
type _Remove = MustHold<
	Identical<GraphQLOperations<Caller>["Books_remove"], Operations<Caller>["Books_remove"]>
>;
type _Note = MustHold<
	Identical<GraphQLOperations<Caller>["Books_note"], Operations<Caller>["Books_note"]>
>;
type _Tag = MustHold<
	Identical<GraphQLOperations<Caller>["Books_tag"], Operations<Caller>["Books_tag"]>
>;
type _Preferences = MustHold<
	Identical<GraphQLOperations<Caller>["Books_preferences"], Operations<Caller>["Books_preferences"]>
>;
type _ExcerptAsJson = MustHold<
	Identical<
		GraphQLOperations<Caller>["Books_excerptAsJson"],
		Operations<Caller>["Books_excerptAsJson"]
	>
>;

export type {
	_Create,
	_Declared,
	_Keys,
	_List,
	_Note,
	_NotExposed,
	_Preferences,
	_Read,
	_Remove,
	_Tag,
	_AuthorsRead,
	_ExcerptAsJson,
	_Update,
};
export { app, schema };
