/**
 * **The same Worker with a one-field schema written by hand**: what graphql-js and Yoga cost at
 * start-up before a generated schema adds anything. `startup.test.ts` profiles both, so the
 * difference is the schema's.
 */
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql";
import { createYoga } from "graphql-yoga";

const schema = new GraphQLSchema({
	query: new GraphQLObjectType({
		name: "Query",
		fields: { ok: { type: GraphQLString, resolve: () => "ok" } },
	}),
});
const yoga = createYoga({ schema });

export default {
	fetch: (request: Request): Response | Promise<Response> => yoga.fetch(request, {}),
};
