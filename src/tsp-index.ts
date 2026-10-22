import type { DecoratorImplementations } from "@typespec/compiler";
import { $inputHeader, $json, $link, $mutationField, $queryField } from "./decorators.js";

/**
 * What TypeSpec's compiler loads for this library: its diagnostics, options and state, and the
 * implementations of the decorators `lib/decorators.tsp` declares.
 *
 * **This package has decorators where its siblings have none, and the rule that kept them out still
 * holds.** `typespec-http-zod` refuses decorators because each would let a spec state something the
 * OpenAPI document cannot publish, a second contract. These state the GraphQL contract itself, which
 * exists nowhere else in the spec, and nothing but this emitter reads them.
 */
export { $lib } from "./lib.js";

export const $decorators = {
	HttpGraphQL: {
		queryField: $queryField,
		mutationField: $mutationField,
		link: $link,
		inputHeader: $inputHeader,
		json: $json,
	},
} satisfies DecoratorImplementations;
