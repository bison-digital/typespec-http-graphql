/**
 * The public API.
 *
 * Re-exports `typespec-http-zod` wholesale, as `typespec-hono` and `typespec-http-mcp` do, so a
 * consumer building on this emitter has one specifier to import from.
 */
export * from "typespec-http-zod";
export { $onEmit } from "./emitter.js";
export { $lib, EmitterOptionsSchema, type EmitterOptions } from "./lib.js";
export { $decorators } from "./tsp-index.js";
export {
	type GraphQLRequest,
	type GraphQLServiceRequests,
	graphqlRequestsOf,
	type RequestValues,
} from "./requests.js";
