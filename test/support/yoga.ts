import type { GraphQLSchema } from "graphql";
import { createYoga } from "graphql-yoga";

/**
 * **Execute one GraphQL document the way a client's request is executed: through GraphQL Yoga, as
 * an HTTP request, with a server context of the caller's choosing.**
 *
 * Not `graphql()` called directly. Yoga is the server the README mounts, and it owns three things a
 * direct call would skip: building one context object per request (which the call memo is keyed
 * on), validating the document against the schema, and masking an error that is not a
 * `GraphQLError`. An arm that skipped them would grade a server nobody runs.
 *
 * In process, with no socket: `test/socket/` is the arm that adds one.
 */

/** A GraphQL request as a client sends one. */
export interface GraphQLDocument {
	readonly query: string;
	readonly variables?: Readonly<Record<string, unknown>>;
}

/** One entry of a response's `errors`, as it crosses the wire. */
export interface GraphQLErrorBody {
	readonly message: string;
	readonly path?: readonly (string | number)[];
	readonly extensions?: Readonly<Record<string, unknown>>;
}

/** A response, with the HTTP status it came with. */
export interface GraphQLResult {
	readonly status: number;
	readonly data?: Readonly<Record<string, unknown>> | null;
	readonly errors?: readonly GraphQLErrorBody[];
}

type Serve = (
	request: Request,
	serverContext: Readonly<Record<string, unknown>>,
) => Response | Promise<Response>;

/** One Yoga per schema, as a server has one: Yoga caches parsing and validation per instance. */
const servers = new WeakMap<GraphQLSchema, Serve>();

function serverFor(schema: GraphQLSchema): Serve {
	const existing = servers.get(schema);
	if (existing !== undefined) return existing;
	const yoga = createYoga<Record<string, unknown>>({ schema, logging: false });
	const serve: Serve = (request, serverContext) => yoga.fetch(request, serverContext);
	servers.set(schema, serve);
	return serve;
}

export async function executeThroughYoga(
	schema: GraphQLSchema,
	document: GraphQLDocument,
	serverContext: Readonly<Record<string, unknown>>,
): Promise<GraphQLResult> {
	const request = new Request("http://yoga.test/graphql", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(document),
	});
	const response = await serverFor(schema)(request, serverContext);
	const body = (await response.json()) as Omit<GraphQLResult, "status">;
	return { status: response.status, ...body };
}
