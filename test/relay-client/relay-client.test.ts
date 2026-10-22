import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApolloClient, gql, HttpLink, InMemoryCache, type TypedDocumentNode } from "@apollo/client";
import { relayStylePagination } from "@apollo/client/utilities";
import { serve, type ServerType } from "@hono/node-server";
import type { GraphQLSchema } from "graphql";
import { createYoga } from "graphql-yoga";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";

/**
 * **A real Relay client walks every connection, over a real socket.**
 *
 * The schema's connections are graded here by Apollo Client's own `relayStylePagination`, the field
 * policy a client application uses, against the emitted schema served by Yoga on `@hono/node-server`.
 * Apollo is written by neither this package nor the spec it implements; it pages as the Relay
 * connection specification (relay.dev/graphql/connections.htm) tells a client to: it stores the
 * edges a page answers, under their cursors, and asks for the next page `after` the last cursor.
 *
 * The backend pages forward by an opaque token, as design.md's backends do. Each arm is a promise
 * the specification makes:
 *
 * - §4.1, §5.1: walking `after: endCursor` until `hasNextPage` is false yields every item, once,
 *   in order, in as many requests as pages;
 * - §3.1: every edge has a cursor, and `after` it yields exactly the items after that edge;
 * - §4.4: a negative `first` is an error, and edges beyond `first` are cut, and lost to no one;
 * - the same, through a link: a connection nested below an object.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

interface Book {
	readonly id: string;
	readonly title: string;
}

const BOOKS: readonly Book[] = Array.from({ length: 10 }, (_, index) => ({
	id: `b${String(index)}`,
	title: `Book ${String(index)}`,
}));

/** How many items beyond the page size the backend answers with: 0 is honest, 2 over-delivers. */
let extra = 0;
let requests = 0;

/** The backend: an offset in a token, a page of `size`, and the next token while items remain. */
function page(input: { readonly size?: number; readonly token?: string }) {
	const offset = input.token === undefined ? 0 : Number(input.token);
	const size = input.size ?? 3;
	const end = offset + size;
	return {
		status: 200 as const,
		body: {
			items: BOOKS.slice(offset, end + extra),
			...(end < BOOKS.length ? { next: String(end) } : {}),
		},
	};
}

const handlers = {
	Books_list: (_caller: unknown, input: { readonly size?: number; readonly token?: string }) => {
		requests += 1;
		return page(input);
	},
	Shelves_read: (_caller: unknown, input: { readonly shelfId: string }) => ({
		status: 200 as const,
		body: { id: input.shelfId, name: "Fiction" },
	}),
	Shelves_books: (
		_caller: unknown,
		input: { readonly shelfId: string; readonly size?: number; readonly token?: string },
	) => {
		requests += 1;
		return page(input);
	},
};

let server: ServerType;
let uri = "";

beforeAll(async () => {
	const compiled = await compileFixture(here, "shelf", {
		outDir: join(here, "..", ".out-relay-client"),
	});
	const generated = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
		readonly createSchema: (handlersFor: () => object, deps: object) => GraphQLSchema;
	};
	const schema = generated.createSchema(() => handlers, {
		authorize: () => "allow",
		context: () => ({ subject: "reader" }),
	});
	const yoga = createYoga({ schema, logging: false });
	const app = new Hono();
	app.on(["GET", "POST"], "/graphql", (c) => yoga.fetch(c.req.raw, {}));
	uri = await new Promise<string>((resolve) => {
		server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) =>
			resolve(`http://127.0.0.1:${String(info.port)}/graphql`),
		);
	});
}, 300_000);

afterAll(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
});

function client(): ApolloClient {
	return new ApolloClient({
		link: new HttpLink({ uri, fetch }),
		cache: new InMemoryCache({
			typePolicies: {
				Query: { fields: { books: relayStylePagination() } },
				Shelf: { fields: { books: relayStylePagination() } },
			},
		}),
	});
}

interface Connection {
	readonly edges: readonly { readonly cursor: string; readonly node: Book }[];
	readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
}

/** The variables every connection query here takes. */
interface Paging {
	readonly first?: number;
	readonly after?: string | null;
}

const BOOKS_QUERY: TypedDocumentNode<{ readonly books: Connection | null }, Paging> = gql`
	query Books($first: Int, $after: String) {
		books(first: $first, after: $after) {
			edges {
				cursor
				node {
					id
					title
				}
			}
			pageInfo {
				hasNextPage
				endCursor
			}
		}
	}
`;

/**
 * **Every page, as a Relay client walks them**: the first page into the cache, then `fetchMore` after
 * the end cursor the cache holds, until it says there is no next page. `relayStylePagination` merges
 * each page's edges under their cursors; the merged connection is read back from the cache.
 */
async function walkConnection<T>(
	query: TypedDocumentNode<T, Paging>,
	variables: Readonly<Record<string, unknown>>,
	connectionOf: (data: T) => Connection,
): Promise<{ edges: Connection["edges"]; pages: number }> {
	const apollo = client();
	const watched = apollo.watchQuery({ query, variables });
	const subscription = watched.subscribe(() => {});
	try {
		await apollo.query({ query, variables });
		let pages = 1;
		const read = () => {
			const data = apollo.readQuery({ query, variables });
			if (data === null) throw new Error("the cache holds no page");
			return connectionOf(data as T);
		};
		for (let guard = 0; read().pageInfo.hasNextPage && guard < 50; guard += 1) {
			await watched.fetchMore({ variables: { ...variables, after: read().pageInfo.endCursor } });
			pages += 1;
		}
		return { edges: read().edges, pages };
	} finally {
		subscription.unsubscribe();
	}
}

const walk = (first: number) =>
	walkConnection(BOOKS_QUERY, { first }, (data) => {
		if (data.books === null) throw new Error("books answered null");
		return data.books;
	});

/** One page after `after`, outside any cache: what a client that kept the cursor is answered. */
async function after(cursor: string | null, first: number) {
	return client().query({
		query: BOOKS_QUERY,
		variables: { first, after: cursor },
		fetchPolicy: "no-cache",
	});
}

const ids = (edges: Connection["edges"]): string[] => edges.map((edge) => edge.node.id);

describe("a Relay client walking a connection", () => {
	it("gets every item once, in order, in as many requests as pages (§4.1, §5.1)", async () => {
		extra = 0;
		requests = 0;
		const { edges, pages } = await walk(3);
		expect(ids(edges)).toEqual(BOOKS.map((book) => book.id));
		expect(pages).toBe(4);
		expect(requests).toBe(4);
	});

	it("resumes after every edge with exactly the items after it (§3.1)", async () => {
		extra = 0;
		const { edges } = await walk(3);
		let resumed = 0;
		for (const [index, edge] of edges.entries()) {
			expect(typeof edge.cursor, `edge ${String(index)}`).toBe("string");
			const result = await after(edge.cursor, 3);
			expect(result.error, `after edge ${String(index)}`).toBeUndefined();
			expect(ids(result.data?.books?.edges ?? []), `after edge ${String(index)}`).toEqual(
				BOOKS.slice(index + 1, index + 4).map((book) => book.id),
			);
			resumed += 1;
		}
		expect(resumed).toBe(BOOKS.length);
	});

	it("refuses a negative first as an error (§4.4)", async () => {
		const result = await client().query({
			query: BOOKS_QUERY,
			variables: { first: -1 },
			fetchPolicy: "no-cache",
			errorPolicy: "all",
		});
		expect(result.error).toBeDefined();
		expect(result.data?.books ?? null).toBeNull();
	});

	it("cuts a backend's over-long page to first, and loses nothing on the way (§4.4)", async () => {
		extra = 2;
		try {
			const first = await after(null, 3);
			expect(ids(first.data?.books?.edges ?? [])).toEqual(["b0", "b1", "b2"]);
			expect(first.data?.books?.pageInfo.hasNextPage).toBe(true);
			const { edges } = await walk(3);
			expect(ids(edges)).toEqual(BOOKS.map((book) => book.id));
		} finally {
			extra = 0;
		}
	});
});

describe("a Relay client walking a connection below a link", () => {
	const SHELF_QUERY: TypedDocumentNode<{ readonly shelf: { readonly books: Connection } }, Paging> =
		gql`
			query Shelf($first: Int, $after: String) {
				shelf(shelfId: "s1") {
					id
					books(first: $first, after: $after) {
						edges {
							cursor
							node {
								id
							}
						}
						pageInfo {
							hasNextPage
							endCursor
						}
					}
				}
			}
		`;

	it("gets every item once, in order", async () => {
		extra = 0;
		const { edges, pages } = await walkConnection(
			SHELF_QUERY,
			{ first: 4 },
			(data) => data.shelf.books,
		);
		expect(ids(edges)).toEqual(BOOKS.map((book) => book.id));
		expect(pages).toBe(3);
	});
});
