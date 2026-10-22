import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serverAudits } from "graphql-http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { compileFixture } from "../support/compile-fixture.js";
import { readmeBlock } from "../support/readme.js";

/**
 * **The README's mount, served over a real socket on both runtimes it names.** The README's
 * `graphql.ts` is written out as the README shows it and served as it is: its limits, its context
 * factory and its `deps`.
 *
 * `test/acceptance/` drives Yoga in process with a `Request` it built. That proves the schema
 * answers; it cannot prove four things this does:
 * - **emitted output survives BUNDLING.** wrangler's esbuild resolves the `./x.js` specifiers the
 *   emitter writes for neighbouring `.ts` files, and nothing else here asks a bundler to read them.
 * - **emitted output runs on workerd**, with no `nodejs_compat`. `test/architecture/` checks the
 *   import rule by READING imports; this checks it by running them.
 * - **GraphQL over HTTP as a server speaks it**: `POST` and `GET /graphql?query=`, the response
 *   media type, and `405` for a mutation over `GET`.
 * - **one app, one handler object, both surfaces**: the REST routes and `/graphql` on one Hono app.
 * - **the GraphQL over HTTP specification, as its reference implementation audits it**: every MUST
 *   audit of `graphql-http`'s `serverAudits`, on both runtimes.
 *
 * `app.fixture.ts` is ONE file served twice: on Node through `@hono/node-server`, and bundled by
 * wrangler onto workerd.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

const NOVEL = "0b7e1c44-5a2d-4f6e-8c3b-000000000001";
const DOCUMENT = `{ book(bookId: "${NOVEL}") { id title status author { name } } }`;
const ANSWER = {
	data: {
		book: {
			id: NOVEL,
			title: "Harbour Lights",
			status: "IN_REVIEW",
			author: { name: "Ada Lane" },
		},
	},
};
const GRAPHQL_RESPONSE = "application/graphql-response+json";

/** Every request carries a bearer token, as the acceptance spec's `@useAuth(BearerAuth)` requires. */
const AUTHORIZED = { authorization: "Bearer alice" };

/**
 * **Every request gives up after 30 s.** A Worker whose script fails to load (`No such module`)
 * leaves workerd accepting the connection and answering nothing, measured past 15 s; without a
 * deadline each workerd arm would wait out the system project's 30-minute test timeout.
 */
const deadline = (): AbortSignal => AbortSignal.timeout(30_000);

interface Fixture {
	readonly app: { readonly fetch: (request: Request) => Response | Promise<Response> };
}

/** The fixture's handlers module, as `.out/socket/handlers.ts`: its count of `verify` calls. */
interface Handlers {
	readonly verifications: { readonly count: number };
}

let handlersModule: Handlers | undefined;

let node: ReturnType<typeof serve> | undefined;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
const origins = { node: "", workerd: "" };

beforeAll(async () => {
	const served = join(here, ".out", "socket");
	await compileFixture(join(packageRoot, "test", "acceptance"), "main", {
		outDir: join(served, "generated"),
		withServer: true,
	});
	// The README's `graphql.ts`, as written, beside what it imports: the emitted output and `./handlers.js`.
	writeFileSync(join(served, "graphql.ts"), readmeBlock("graphql.ts"));
	copyFileSync(join(here, "handlers.fixture.ts"), join(served, "handlers.ts"));
	handlersModule = (await import(join(served, "handlers.ts"))) as Handlers;

	// Imported after the compile, because it imports what the compile writes.
	const fixture = (await import(join(here, "app.fixture.ts"))) as Fixture;
	origins.node = await new Promise<string>((resolve) => {
		node = serve({ fetch: fixture.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
			resolve(`http://127.0.0.1:${info.port}`),
		);
	});

	worker = await unstable_startWorker({ config: join(here, "wrangler.jsonc") });
	await worker.ready;
	origins.workerd = (await worker.url).origin;
}, 600_000);

afterAll(async () => {
	await new Promise<void>((resolve) => {
		if (node === undefined) resolve();
		else node.close(() => resolve());
	});
	await worker?.dispose();
});

describe.each([
	["Node, on @hono/node-server", "node"],
	["workerd, without nodejs_compat", "workerd"],
] as const)("%s, over a real socket", (_runtime, arm) => {
	const origin = (): string => origins[arm];

	it("serves on a port the operating system chose", () => {
		expect(origin()).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
	});

	it("answers POST /graphql", async () => {
		const response = await fetch(`${origin()}/graphql`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: GRAPHQL_RESPONSE, ...AUTHORIZED },
			body: JSON.stringify({ query: DOCUMENT }),
			signal: deadline(),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toMatch(/^application\/graphql-response\+json/);
		expect(await response.json()).toEqual(ANSWER);
	});

	it("answers GET /graphql?query=", async () => {
		const response = await fetch(`${origin()}/graphql?query=${encodeURIComponent(DOCUMENT)}`, {
			headers: { accept: GRAPHQL_RESPONSE, ...AUTHORIZED },
			signal: deadline(),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(ANSWER);
	});

	it("refuses a mutation over GET", async () => {
		const mutation = `mutation { createBook(input: { originalLanguage: "en" }) { __typename } }`;
		const response = await fetch(`${origin()}/graphql?query=${encodeURIComponent(mutation)}`, {
			headers: { accept: GRAPHQL_RESPONSE, ...AUTHORIZED },
			signal: deadline(),
		});
		expect(response.status).toBe(405);
	});

	it("serves REST from the same app and the same handler object", async () => {
		const response = await fetch(`${origin()}/v1/books/${NOVEL}`, { signal: deadline() });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: NOVEL,
			title: "Harbour Lights",
			status: "in_review",
		});
	});

	/** POST one document, with the bearer token unless `anonymous`; the parsed body and status. */
	const post = async (query: string, anonymous = false) => {
		const response = await fetch(`${origin()}/graphql`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: GRAPHQL_RESPONSE,
				...(anonymous ? {} : AUTHORIZED),
			},
			body: JSON.stringify({ query }),
			signal: deadline(),
		});
		const body = (await response.json()) as {
			readonly data?: unknown;
			readonly errors?: readonly { readonly extensions?: Readonly<Record<string, unknown>> }[];
		};
		return {
			status: response.status,
			body,
			codes: (body.errors ?? []).map((e) => e.extensions?.["code"]),
		};
	};

	it("answers an operation that needs a caller UNAUTHENTICATED when the request carries none", async () => {
		const { body, codes } = await post(DOCUMENT, true);
		expect(codes).toEqual(["UNAUTHENTICATED"]);
		expect(body.data).toEqual({ book: null });
	});

	/** 1 for `books`, 1 for `nodes`, and an `author` link for each of 1,000 nodes: 1,002. */
	it("refuses an operation over the cost limit before any handler runs", async () => {
		const { body, codes } = await post(`{ books(first: 1000) { nodes { author { name } } } }`);
		expect(codes).toEqual(["COST_LIMIT_EXCEEDED"]);
		expect(body.errors?.[0]?.extensions).toMatchObject({ cost: 1002, maximumCost: 1000 });
		expect(body.data).toBeUndefined();
	});

	/**
	 * Eleven aliases of a thousand books: Field Cost 2 each, 22 in all, under `costLimit`;
	 * Type Cost the root and 1,001 objects each, 11,012, over the README's `typeCostLimit(10_000)`.
	 */
	it("refuses an operation returning more objects than the type cost limit, though few calls", async () => {
		const aliases = Array.from(
			{ length: 11 },
			(_, n) => `c${String(n)}: books(first: 1000) { nodes { id } }`,
		).join(" ");
		const { body, codes } = await post(`{ ${aliases} }`);
		expect(codes).toEqual(["TYPE_COST_LIMIT_EXCEEDED"]);
		expect(body.errors?.[0]?.extensions).toMatchObject({ cost: 11_012, maximumCost: 10_000 });
		expect(body.data).toBeUndefined();
	});

	it("keeps the headers middleware set before /graphql, as REST does", async () => {
		const graphql = await fetch(`${origin()}/graphql`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: GRAPHQL_RESPONSE,
				"x-request-id": "r-1",
				...AUTHORIZED,
			},
			body: JSON.stringify({ query: DOCUMENT }),
			signal: deadline(),
		});
		const rest = await fetch(`${origin()}/v1/books/${NOVEL}`, {
			headers: { "x-request-id": "r-2" },
			signal: deadline(),
		});
		expect([graphql.headers.get("x-request-id"), rest.headers.get("x-request-id")]).toEqual([
			"r-1",
			"r-2",
		]);
		expect(graphql.headers.get("content-type")).toMatch(/^application\/graphql-response\+json/);
		expect(await graphql.json()).toEqual(ANSWER);
	});

	it("refuses a document with more aliases than the limit", async () => {
		const aliases = Array.from({ length: 31 }, (_, n) => `a${String(n)}: __typename`).join(" ");
		const { codes } = await post(`{ ${aliases} }`);
		expect(codes).toEqual(["ALIAS_LIMIT_EXCEEDED"]);
	});

	it("refuses a document of more tokens than the limit, before parsing it whole", async () => {
		const { status, body } = await post(`{ ${"__typename ".repeat(2001)}}`);
		expect(status).toBe(400);
		expect(JSON.stringify(body.errors)).toContain("more than 2000 tokens");
	});

	/** Each audit names its level: an `id`, and a `name` beginning MUST, SHOULD or MAY. */
	it("passes every MUST audit of graphql-http, the GraphQL over HTTP reference implementation", async () => {
		const audits = serverAudits({ url: `${origin()}/graphql` });
		const must = audits.filter((audit) => audit.name.startsWith("MUST"));
		// graphql-http 1.23.1 defines thirteen; an upgrade may add more, never fewer.
		expect(must.length).toBeGreaterThanOrEqual(13);
		const failed: string[] = [];
		for (const audit of must) {
			const result = await audit.fn();
			if (result.status !== "ok") failed.push(`${audit.id} ${audit.name}: ${result.reason}`);
		}
		expect(failed).toEqual([]);
	});
});

describe("the README's graphql.ts, on Node", () => {
	it("verifies the caller once per request, however many fields the request resolves", async () => {
		const before = handlersModule?.verifications.count ?? 0;
		const response = await fetch(`${origins.node}/graphql`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: GRAPHQL_RESPONSE, ...AUTHORIZED },
			body: JSON.stringify({
				query: `{ a: book(bookId: "${NOVEL}") { author { name } }
					b: book(bookId: "${NOVEL}") { id } books { nodes { id } } }`,
			}),
			signal: deadline(),
		});
		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).not.toHaveProperty("errors");
		expect((handlersModule?.verifications.count ?? 0) - before).toBe(1);
	});
});

describe("the app both runtimes serve is the one the README describes", () => {
	/** The `/graphql` route, from `app.on(` to the statement's end. */
	const mountOf = (source: string): string | undefined =>
		/^app\.on\(\["GET", "POST"\], "\/graphql"[\s\S]*?^\}\);$/m.exec(source)?.[0];

	it("mounts /graphql as the README's Node and Workers examples do", () => {
		const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
		const fixture = readFileSync(join(here, "app.fixture.ts"), "utf8");
		const mounts = [...readme.matchAll(/^```ts\n([\s\S]*?)^```$/gm)]
			.map((block) => mountOf(block[1] ?? ""))
			.filter((mount) => mount !== undefined);
		expect(mounts).toHaveLength(2);
		expect(new Set([...mounts, mountOf(fixture)])).toEqual(new Set([mounts[0]]));
	});

	it("typechecks against freshly emitted output", () => {
		let output = "";
		try {
			execFileSync(
				join(packageRoot, "node_modules", ".bin", "tsc"),
				["-p", join(here, "tsconfig.socket.json"), "--ignoreConfig"],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch (error) {
			const asExec = error as { stdout?: string; stderr?: string };
			output = `${asExec.stdout ?? ""}${asExec.stderr ?? ""}`;
		}
		expect(output.trim(), output).toBe("");
	}, 300_000);
});
