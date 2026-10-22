import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { compileFixture } from "../support/compile-fixture.js";

/**
 * **Batched links over a real socket, on both runtimes the README names.** A batch waits for its
 * wave on a macrotask: `setImmediate` on Node, and `setTimeout` on workerd, which has no
 * `setImmediate` without `nodejs_compat`. Each runtime is held to the same calls: a page of books
 * reads its authors in one call, and their publishers in one more.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

/** Every request gives up after 30 s, as in `socket.test.ts`. */
const deadline = (): AbortSignal => AbortSignal.timeout(30_000);

let node: ReturnType<typeof serve> | undefined;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
const origins = { node: "", workerd: "" };

beforeAll(async () => {
	await compileFixture(join(packageRoot, "test", "links"), "batch", {
		outDir: join(here, ".out", "batch"),
	});
	const fixture = (await import(join(here, "batch.fixture.ts"))) as {
		readonly app: { readonly fetch: (request: Request) => Response | Promise<Response> };
	};
	origins.node = await new Promise<string>((resolve) => {
		node = serve({ fetch: fixture.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
			resolve(`http://127.0.0.1:${info.port}`),
		);
	});
	worker = await unstable_startWorker({ config: join(here, "wrangler.batch.jsonc") });
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
	it("waits for a wave on the timer the runtime has", async () => {
		const timers = await (await fetch(`${origins[arm]}/timers`, { signal: deadline() })).json();
		expect(timers).toEqual({ setImmediate: arm === "node" ? "function" : "undefined" });
	});

	it("reads a page's authors in one batch call, and their publishers in one more", async () => {
		const origin = origins[arm];
		await fetch(`${origin}/calls`, { method: "POST", signal: deadline() });
		const response = await fetch(`${origin}/graphql`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				query: "{ books { id author { name publisher { name } } editors { name } } }",
			}),
			signal: deadline(),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				books: [
					{
						id: "b1",
						author: { name: "First Author", publisher: { name: "House p1" } },
						editors: [{ name: "Second Author" }, { name: "Third Author" }],
					},
					{
						id: "b2",
						author: { name: "Second Author", publisher: { name: "House p2" } },
						editors: null,
					},
					{
						id: "b3",
						author: { name: "First Author", publisher: { name: "House p1" } },
						editors: null,
					},
				],
			},
		});
		const calls = await (await fetch(`${origin}/calls`, { signal: deadline() })).json();
		expect(calls).toEqual([
			{ operationId: "Authors_batchGet", ids: ["a1", "a2", "a3"] },
			{ operationId: "Publishers_batchGet", ids: ["p1", "p2"] },
		]);
	});
});
