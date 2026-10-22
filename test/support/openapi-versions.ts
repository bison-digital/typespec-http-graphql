/**
 * **The fixtures and corpus scenarios compiled with `@typespec/openapi3` publishing OpenAPI 3.1**,
 * each with the shape its 3.0 document cannot say. Every other compile takes openapi3's default,
 * `3.0.0`, which is what a consumer's `tspconfig.yaml` gets without the option, and so what the
 * library validates by.
 *
 * Kept in one table because a fixture is compiled by more than its own suite:
 * `test/idiom/specifications.test.ts` compiles every fixture under `test/`, and the corpus suites
 * each compile every scenario. A shape refused at 3.0 (`unpublishable-null`) fails each of them
 * unless they agree on its version here.
 */
export const PUBLISHED_AT_31: Readonly<Record<string, string>> = {
	"connections/connections": "a nullable model, `Book | null`",
	"declarations/main": "`extra`, any JSON value: a union holding `null`",
	"declarations/mistaken": "`extra`, any JSON value: a union holding `null`",
	"declarations/dropped": "`extra`, any JSON value: a union holding `null`",
	"inputs/inputs": "a nullable model, `Owner | null`",
	"results/results": "a nullable model, `Widget | null`",
	"types/types":
		'a nullable model, `Gadget | null`; a bare `null`; `"light" | "dark" | null`; a union of `null` alone',
	"verdicts/edges/main": "a nullable model, `Entry | null`",
	"corpus:type__array": "its `nullable-model`, `InnerModel | null`",
};

/**
 * The `openapi-versions` a compile of `key` sets: a fixture's path under `test/` without `.tsp`
 * (`inputs/inputs`), or `corpus:<scenario>`. `undefined` is openapi3's default.
 */
export function openApiVersionsOf(key: string): readonly string[] | undefined {
	return Object.hasOwn(PUBLISHED_AT_31, key) ? ["3.1.0"] : undefined;
}
