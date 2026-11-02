import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readmeBlock } from "../support/readme.js";

/**
 * **The README's Node mount for Yoga's execution cancellation, run as the README writes it**, but
 * for two lines: its `./graphql.js` is a Yoga with `useExecutionCancellation()` and a mutation of two
 * fields, which GraphQL resolves in turn: `slow`, which takes a second and a half, then `later`,
 * which counts its calls. It listens on a free port. A client goes away after 200 ms.
 *
 * Measured against the README's plain Node mount, run the same way, which `@hono/node-server`'s
 * string abort reason makes log an error. So the arm that the cancellation mount logs nothing is one
 * that has been seen to fail. **Silence alone would also be a mount that never aborts**, whose `slow`
 * runs to its end unheard; so the same arm holds that `later` is never called, which only an
 * execution cancelled while `slow` ran can keep.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const served = join(here, ".out", "cancellation");

const YOGA = `import { createSchema, createYoga, useExecutionCancellation } from "graphql-yoga";

export const yoga = createYoga({
	schema: createSchema({
		typeDefs: "type Query { ping: String } type Mutation { slow: String later: String }",
		resolvers: {
			Mutation: {
				slow: () => new Promise((resolve) => setTimeout(() => resolve("done"), 1500)),
				later: () => {
					globalThis.laterCalls = (globalThis.laterCalls ?? 0) + 1;
					return "later";
				},
			},
		},
	}),
	plugins: [useExecutionCancellation()],
});
`;

/** How often a mount's Yoga has called `later`, which runs only once `slow` has answered. */
const laterCalls = (): number => (globalThis as { laterCalls?: number }).laterCalls ?? 0;

/** The README's Node example: the block of its `### Node` section, which names no file. */
function nodeMountOfReadme(): string {
	const readme = readFileSync(join(here, "..", "..", "README.md"), "utf8");
	const block = /^### Node\n\n```ts\n([\s\S]*?)^```$/m.exec(readme)?.[1];
	if (block === undefined) throw new Error("the README shows no Node mount");
	return block;
}

/** A mount, its listen line made one that answers on a free port and is exported. */
function runnable(source: string): string {
	const listen = "serve({ fetch: app.fetch, port: 3000 });";
	if (!source.includes(listen)) throw new Error("the mount listens otherwise than the README did");
	return source.replace(
		listen,
		'export const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });',
	);
}

/** The cancellation mount with one more route, refusing with the 418 an `HTTPException` carries. */
function withTeapot(source: string): string {
	const middleware = "app.use(requestId());";
	if (!source.includes(middleware))
		throw new Error("the mount sets no request id as the README did");
	return source.replace(
		middleware,
		`${middleware}\napp.get("/teapot", () => {\n\tthrow new HTTPException(418, { message: "a teapot" });\n});`,
	);
}

interface Mount {
	readonly server: Server;
}

/** Everything a request's handling wrote to the console and to the process's streams. */
async function whatALeavingClientLogs(file: string): Promise<string[]> {
	const { server } = (await import(join(served, file))) as Mount;
	await new Promise<void>((resolve) => {
		if (server.listening) resolve();
		else server.once("listening", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	const written: string[] = [];
	const record =
		(name: string) =>
		(...args: unknown[]): boolean => {
			written.push(
				`${name}: ${args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" ")}`,
			);
			return true;
		};
	const saved = {
		error: console.error,
		log: console.log,
		stdout: process.stdout.write.bind(process.stdout),
		stderr: process.stderr.write.bind(process.stderr),
	};
	console.error = record("console.error");
	console.log = record("console.log");
	process.stdout.write = record("stdout") as typeof process.stdout.write;
	process.stderr.write = record("stderr") as typeof process.stderr.write;
	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		await fetch(`http://127.0.0.1:${port}/graphql`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "mutation { slow later }" }),
			signal: controller.signal,
		}).catch(() => undefined);
		// Long enough for the field to have run to the end, had it not been cancelled.
		await new Promise((resolve) => setTimeout(resolve, 1800));
	} finally {
		console.error = saved.error;
		console.log = saved.log;
		process.stdout.write = saved.stdout;
		process.stderr.write = saved.stderr;
		await new Promise((resolve) => server.close(resolve));
	}
	return written;
}

beforeAll(() => {
	rmSync(served, { recursive: true, force: true });
	mkdirSync(served, { recursive: true });
	writeFileSync(join(served, "graphql.ts"), YOGA);
	writeFileSync(
		join(served, "node-cancellation.ts"),
		withTeapot(runnable(readmeBlock("node-cancellation.ts"))),
	);
	writeFileSync(join(served, "node.ts"), runnable(nodeMountOfReadme()));
});

describe("a client that goes away under Yoga's execution cancellation, on Node", () => {
	it("is an error logged through the README's plain Node mount", async () => {
		const written = await whatALeavingClientLogs("node.ts");
		expect(written.join("\n")).toMatch(/Client connection prematurely closed|AbortError/);
	}, 30_000);

	it("logs nothing through the README's cancellation mount, and calls nothing after the client left", async () => {
		const before = laterCalls();
		const written = await whatALeavingClientLogs("node-cancellation.ts");
		expect(
			written.filter((line) => /ERR|AbortError|prematurely|Internal Server Error/.test(line)),
		).toEqual([]);
		expect(laterCalls() - before).toBe(0);
	}, 30_000);
});

/**
 * **The cancellation mount's `app.onError` answers every other error as Hono's own handler does**,
 * an `HTTPException` through `c.newResponse`, so the headers middleware set stay on it: a route of
 * the same app, written in beside its middleware, refusing with a 418 keeps the `X-Request-Id` its
 * `requestId()` set.
 */
describe("an HTTPException through the README's cancellation mount", () => {
	it("keeps the request id the middleware set", async () => {
		// The module is the one the arm above served and closed: listen again, on a free port.
		const { server } = (await import(join(served, "node-cancellation.ts"))) as Mount;
		if (!server.listening) {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		}
		try {
			const { port } = server.address() as AddressInfo;
			const response = await fetch(`http://127.0.0.1:${port}/teapot`, {
				headers: { "x-request-id": "teapot-1" },
			});
			expect(response.status).toBe(418);
			expect(response.headers.get("x-request-id")).toBe("teapot-1");
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	}, 30_000);
});
