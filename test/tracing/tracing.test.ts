import { tracingChannel } from "node:diagnostics_channel";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphQLSchema } from "graphql";
import { createYoga, type Plugin } from "graphql-yoga";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";
import { readmeBlock } from "../support/readme.js";

/**
 * **What a tracer sees of the generated schema, through graphql 17's tracing channels** (the README's
 * "Tracing").
 *
 * graphql-js publishes each resolver call on `graphql:resolve`, with `isDefaultResolver` for a field
 * that has no resolver of its own. Every generated field has one, reading its own property rather
 * than through the prototype chain, so the flag is false everywhere; `extensions.operationId` is how a
 * subscriber tells the fields that call a handler from those that read a property.
 *
 * GraphQL Yoga executes with `@graphql-tools/executor`, which publishes nothing, so the channels fire
 * only where graphql-js executes: Yoga with `useEngine` from `@envelop/core`.
 *
 * **Run as the README writes it**: its `graphql.ts` and `tracing.ts`, verbatim, beside the output
 * emitted for them and the socket suite's `./handlers.js`. The plugin and `operationOf` graded here
 * are the README's own, and so is the mount the first arm goes through.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

const NOVEL = "0b7e1c44-5a2d-4f6e-8c3b-000000000001";
const DOCUMENT = `{ book(bookId: "${NOVEL}") { id title author { id name } } }`;

interface Resolved {
	readonly parentType: string;
	readonly fieldName: string;
	readonly isDefaultResolver: boolean;
}

const resolved: Resolved[] = [];
const fired = new Set<string>();
const subscribers = ["parse", "validate", "execute", "resolve"].map((name) => {
	const channel = tracingChannel(`graphql:${name}`);
	const subscriber = {
		start: (message: unknown) => {
			fired.add(name);
			if (name === "resolve") resolved.push(message as Resolved);
		},
		end: () => undefined,
		asyncStart: () => undefined,
		asyncEnd: () => undefined,
		error: () => undefined,
	};
	channel.subscribe(subscriber);
	return () => channel.unsubscribe(subscriber);
});
afterAll(() => {
	for (const unsubscribe of subscribers) unsubscribe();
});

/** The README's `graphql.ts`: the schema and the Yoga it mounts. */
interface ReadmeServer {
	readonly schema: GraphQLSchema;
	readonly yoga: {
		readonly fetch: (url: string, init: RequestInit, context: object) => Promise<Response>;
	};
}

/** The README's `tracing.ts`. */
interface ReadmeTracing {
	readonly graphqlJsExecution: Plugin;
	readonly operationOf: (parentType: string, fieldName: string) => string | undefined;
}

let server: ReadmeServer;
let tracing: ReadmeTracing;

beforeAll(async () => {
	const served = join(here, ".out", "readme");
	await compileFixture(join(packageRoot, "test", "acceptance"), "main", {
		outDir: join(served, "generated"),
	});
	writeFileSync(join(served, "graphql.ts"), readmeBlock("graphql.ts"));
	writeFileSync(join(served, "tracing.ts"), readmeBlock("tracing.ts"));
	copyFileSync(
		join(packageRoot, "test", "socket", "handlers.fixture.ts"),
		join(served, "handlers.ts"),
	);
	server = (await import(join(served, "graphql.ts"))) as ReadmeServer;
	tracing = (await import(join(served, "tracing.ts"))) as ReadmeTracing;
}, 300_000);

/** The Hono context the README's mount hands Yoga: here, only the request header it reads. */
const honoContext = {
	c: {
		req: { header: (name: string) => (name === "authorization" ? "Bearer tracer" : undefined) },
	},
};

/**
 * One document through the README's mount, or through Yoga with the README's `graphqlJsExecution`
 * in its plugins: what it answered, every channel that fired, and every field `graphql:resolve`
 * reported.
 */
async function traced(execution: "yoga" | "graphql-js") {
	resolved.length = 0;
	fired.clear();
	const yoga =
		execution === "yoga"
			? server.yoga
			: createYoga({
					schema: server.schema,
					context: () => ({ caller: { subject: "tracer" } }),
					plugins: [tracing.graphqlJsExecution],
				});
	const response = await yoga.fetch(
		"http://tracer/graphql",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: DOCUMENT }),
		},
		honoContext,
	);
	return { body: (await response.json()) as unknown, resolved: [...resolved], fired: [...fired] };
}

const ANSWER = {
	data: {
		book: {
			id: NOVEL,
			title: "Harbour Lights",
			author: { id: "6c0f8e52-3b7a-4c1e-9d2a-000000000001", name: "Ada Lane" },
		},
	},
};

describe("graphql 17's tracing channels", () => {
	it("stay silent on execution through Yoga as the README mounts it", async () => {
		const { body, resolved: fields, fired: channels } = await traced("yoga");
		expect(body).toEqual(ANSWER);
		expect(channels.toSorted()).toEqual(["parse", "validate"]);
		expect(fields).toEqual([]);
	});

	it("report every field, and name the operation of the two that call a handler, with useEngine", async () => {
		const { body, resolved: fields, fired: channels } = await traced("graphql-js");
		expect(body).toEqual(ANSWER);
		expect(channels.toSorted()).toEqual(["execute", "parse", "resolve", "validate"]);
		expect(fields.map((field) => `${field.parentType}.${field.fieldName}`)).toEqual([
			"Query.book",
			"Book.id",
			"Book.title",
			"Book.author",
			"Author.id",
			"Author.name",
		]);
		// Every field has a resolver of its own, so the flag cannot tell the handler calls apart.
		expect(fields.filter((field) => field.isDefaultResolver)).toEqual([]);
		expect(
			fields
				.map((field) => [
					`${field.parentType}.${field.fieldName}`,
					tracing.operationOf(field.parentType, field.fieldName),
				])
				.filter(([, operationId]) => operationId !== undefined),
		).toEqual([
			["Query.book", "Books_read"],
			["Book.author", "Authors_read"],
		]);
	});
});
