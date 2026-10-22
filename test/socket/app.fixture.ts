/**
 * **The README's mount, as one app, so the documentation is graded by running.**
 *
 * `yoga` is the README's own `graphql.ts`, written out verbatim by `socket.test.ts` beside the output
 * emitted for it and `handlers.fixture.ts`: the limits, the context factory and `deps` served are the
 * ones the README shows. This app mounts it as the README's Node and Workers examples do, and serves
 * the REST routes `typespec-hono` generates beside it, from ONE handler object. The socket suite
 * serves this file twice: on Node through `@hono/node-server`, and bundled by wrangler onto workerd
 * with no `nodejs_compat`.
 *
 * Excluded from `pnpm typecheck` by `tsconfig.json` (`**\/*.fixture.ts`): it imports from a
 * gitignored output directory. `socket.test.ts` compiles it against freshly emitted output.
 */
import { Hono } from "hono";
import { yoga } from "./.out/socket/graphql.js";
import { type Caller, handlers } from "./.out/socket/handlers.js";
import { registerRoutes } from "./.out/socket/generated/hono/app.gen.js";
import type { AppEnv, RouteDeps } from "./.out/socket/generated/hono/runtime.gen.js";

const restDeps: RouteDeps<AppEnv, Caller> = {
	authorize: () => async (_c, next) => {
		await next();
	},
	context: () => ({ subject: "socket" }),
	noContext: (c) => c.json({ title: "Unauthorized" }, 401),
	notAcceptable: (c) => c.body(null, 406),
	invalid: () => undefined,
};

export const app = new Hono<AppEnv>();
// A consumer's request-id middleware, setting its header before any route runs.
app.use(async (c, next) => {
	c.header("x-request-id", c.req.header("x-request-id") ?? "socket");
	await next();
});
registerRoutes(app, () => handlers, restDeps);
app.on(["GET", "POST"], "/graphql", async (c) => {
	const response = await yoga.fetch(c.req.raw, { c });
	// Through Hono's context, so headers earlier middleware set with `c.header()` are kept.
	return c.newResponse(response.body, response);
});

export default app;
