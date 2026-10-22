/**
 * **The start-up a deployed Worker pays once per isolate, for the generated 150-operation schema.**
 *
 * The schema and the server are built in global scope, as the README builds them, so
 * `wrangler check startup` profiles exactly that work. No request ever reaches this Worker.
 *
 * Excluded from `pnpm typecheck` by `tsconfig.json`: it imports what `startup.test.ts` generates.
 */
import { createYoga } from "graphql-yoga";
import { createSchema } from "./.out/startup/emitted/graphql.gen.js";

const schema = createSchema(
	() => {
		throw new Error("the start-up probe serves no request");
	},
	{ authorize: () => "allow", context: () => ({}) },
);
const yoga = createYoga({ schema });

export default {
	fetch: (request: Request): Response | Promise<Response> => yoga.fetch(request, {}),
};
