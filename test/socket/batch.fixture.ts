/**
 * **Batched links, served**: the schema emitted for `test/links/batch.tsp`, mounted in Yoga as the
 * README mounts it, with handlers that record each batch call they answer. `GET /calls` reads the
 * record and `POST /calls` clears it, so a test can read, over the socket, what one document called.
 *
 * Served twice by `batch.test.ts`: on Node, where a wave is awaited by `setImmediate`, and bundled
 * onto workerd with no `nodejs_compat`, where it is awaited by `setTimeout`.
 *
 * Excluded from `pnpm typecheck` by `tsconfig.json` (`**\/*.fixture.ts`): it imports from a
 * gitignored output directory.
 */
import { createYoga } from "graphql-yoga";
import { Hono } from "hono";
import { createSchema } from "./.out/batch/graphql.gen.js";

const AUTHORS: Readonly<Record<string, { id: string; name: string; publisher_id: string }>> = {
	a1: { id: "a1", name: "First Author", publisher_id: "p1" },
	a2: { id: "a2", name: "Second Author", publisher_id: "p2" },
	a3: { id: "a3", name: "Third Author", publisher_id: "p1" },
};
const BOOKS = [
	{ id: "b1", title: "One", author_id: "a1", editor_ids: ["a2", "a3"] },
	{ id: "b2", title: "Two", author_id: "a2" },
	{ id: "b3", title: "Three", author_id: "a1" },
];

let calls: { readonly operationId: string; readonly ids: readonly string[] }[] = [];

const batch = <T>(
	operationId: string,
	ids: readonly string[],
	known: (id: string) => T | undefined,
): T[] => {
	calls.push({ operationId, ids });
	return ids.flatMap((id) => known(id) ?? []);
};

const handlers = {
	Books_list: () => ({ status: 200 as const, body: BOOKS }),
	Books_read: (_caller: unknown, { id }: { readonly id: string }) => {
		const book = BOOKS.find((candidate) => candidate.id === id);
		return book === undefined
			? { status: 404 as const, body: { message: "none" } }
			: { status: 200 as const, body: book };
	},
	Books_batchGet: (_caller: unknown, { ids }: { readonly ids: readonly string[] }) => ({
		status: 200 as const,
		body: { books: batch("Books_batchGet", ids, (id) => BOOKS.find((book) => book.id === id)) },
	}),
	Authors_batchGet: (_caller: unknown, { ids }: { readonly ids: readonly string[] }) => ({
		status: 200 as const,
		body: { authors: batch("Authors_batchGet", ids, (id) => AUTHORS[id]) },
	}),
	Publishers_batchGet: (_caller: unknown, { ids }: { readonly ids: readonly string[] }) => ({
		status: 200 as const,
		body: batch("Publishers_batchGet", ids, (id) => ({ id, name: `House ${id}` })),
	}),
	Reviews_list: () => ({ status: 200 as const, body: [] }),
};

const schema = createSchema(() => handlers, {
	authorize: () => "allow",
	context: () => ({ subject: "batch" }),
});
const yoga = createYoga({ schema, logging: false });

export const app = new Hono();
app.get("/calls", (c) => c.json(calls));
// Which timer the runtime's wave waits on is decided by what the runtime has.
app.get("/timers", (c) =>
	c.json({ setImmediate: typeof (globalThis as { setImmediate?: unknown }).setImmediate }),
);
app.post("/calls", (c) => {
	calls = [];
	return c.body(null, 204);
});
app.on(["GET", "POST"], "/graphql", async (c) => {
	const response = await yoga.fetch(c.req.raw, { c });
	return c.newResponse(response.body, response);
});

export default app;
