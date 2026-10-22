/**
 * **`./handlers.js`, the module the README's `graphql.ts` imports: the consumer's, written here.**
 *
 * `socket.test.ts` copies it beside the README's `graphql.ts` and the output emitted for it, as
 * `.out/socket/handlers.ts`, so the README's file is served as written. It is the one handler object
 * both surfaces call, and `verify`, which counts its calls so the Node arm can show the caller is
 * verified once per request however many fields the request resolves.
 *
 * Excluded from `pnpm typecheck` by `tsconfig.json` (`**\/*.fixture.ts`): its imports resolve only from
 * the directory it is copied into. The socket suite compiles that copy.
 */
import type { Context } from "hono";
import type { Operations } from "./generated/hono/app.gen.js";

/** What `verify` establishes, and what every handler receives. */
export interface Caller {
	readonly subject: string;
}

const NOW = "2026-10-01T09:00:00Z";
const AUTHOR = "6c0f8e52-3b7a-4c1e-9d2a-000000000001";
const NOVEL = "0b7e1c44-5a2d-4f6e-8c3b-000000000001";

const author = { id: AUTHOR, name: "Ada Lane", createdAt: NOW };
const book = {
	id: NOVEL,
	authorId: AUTHOR,
	editorId: null,
	title: "Harbour Lights",
	status: "in_review",
	metadata: {},
	createdAt: NOW,
} as const;
const problem = (status: number, title: string) => ({ type: "about:blank", title, status });

/** The handler object both surfaces are given. `satisfies`, so each `status` stays a literal. */
export const handlers = {
	Authors_read: (_caller: Caller, input) =>
		input.authorId === author.id
			? { status: 200, body: author, headers: { etag: '"1"' } }
			: { status: 404, body: problem(404, "Not Found") },
	Books_read: (_caller: Caller, input) =>
		input.bookId === book.id
			? { status: 200, body: book, headers: { etag: '"1"' } }
			: { status: 404, body: problem(404, "Not Found") },
	Books_list: (_caller: Caller, _input) => ({
		status: 200,
		body: { items: [book], nextCursor: null },
	}),
	Books_create: (caller: Caller, input) => ({
		status: 201,
		body: { ...book, title: input.title ?? caller.subject },
		headers: { location: `/v1/books/${book.id}` },
	}),
	BookEditions_list: (_caller: Caller, _input) => ({
		status: 200,
		body: { items: [], nextCursor: null },
	}),
} satisfies Operations<Caller>;

export function handlersFor(_c: Context): typeof handlers {
	return handlers;
}

/** How many times `verify` has run, in this process. */
export const verifications = { count: 0 };

/** A bearer token's subject, as a stand-in for checking its signature; `null` with none. */
export async function verify(authorization: string | undefined): Promise<Caller | null> {
	verifications.count += 1;
	await Promise.resolve();
	const token = authorization?.replace(/^Bearer /, "");
	return token === undefined || token === "" ? null : { subject: token };
}
