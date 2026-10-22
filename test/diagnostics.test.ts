import { describe, expect, it } from "vitest";
import { $lib, GraphQLKeys, PACKAGE_NAME } from "../src/lib.js";

/**
 * **The diagnostics this emitter can raise, and that every one is a warning.**
 *
 * An `error` sets `program.hasError()`, and `@typespec/openapi3` then writes no document at all, so
 * one error here would cost a consumer their OpenAPI document over a GraphQL field. The codes and
 * the parameters each message takes are the contract later stages report against; a code that
 * drifted from this table would be a `reportDiagnostic` call that no longer type-checks, or worse, a
 * message that prints `undefined`.
 */

const TABLE: Readonly<Record<string, readonly string[]>> = {
	"no-fields-declared": ["service"],
	"invalid-graphql-name": ["name", "declaration"],
	"graphql-name-collision": ["first", "second", "name"],
	"declared-twice": ["operationId"],
	"unknown-link-parameter": ["link", "parameter", "operationId"],
	"unknown-link-property": ["link", "property", "model"],
	"link-property-unreadable": ["link", "property", "model"],
	"link-type-mismatch": ["link", "parameter", "property"],
	"link-list-not-bindable": ["link", "property", "reason"],
	"link-list-unbounded": ["link", "property"],
	"link-not-safe": ["link", "operationId", "verb"],
	"link-when-mismatch": ["link", "reason"],
	"link-arms-conflict": ["link", "reason"],
	"link-arm-not-object": ["link", "operationId", "answers"],
	"link-batch-invalid": ["link", "operationId", "reason"],
	"input-header-ignored": ["parameter", "operationId", "reason"],
	"query-not-safe": ["name", "operationId", "verb"],
	"head-operation": ["operationId"],
	"non-json-request": ["operationId", "types"],
	"non-object-body": ["operationId", "types"],
	"non-json-response": ["operationId", "status", "types"],
	"shared-input-key": ["operationId", "name", "locations"],
	"link-target-unreachable": ["link", "model"],
	"not-a-connection": ["operationId", "missing"],
	"transport-argument": ["field", "location", "name"],
	"projected-as-json": ["what", "reason"],
	"not-projected-as-json": ["target", "name"],
	"anonymous-type-shared": ["holders", "name"],
	"shared-output-dir": ["emitter", "differing"],
};

type Definition = {
	readonly severity: string;
	readonly messages: { readonly default: { readonly keys: readonly string[] } };
};
const definitions = $lib.diagnostics as unknown as Readonly<Record<string, Definition>>;

describe("the diagnostics", () => {
	it("are exactly the table's codes", () => {
		expect(Object.keys(definitions).toSorted()).toEqual(Object.keys(TABLE).toSorted());
	});

	it("are every one a warning", () => {
		for (const [code, definition] of Object.entries(definitions)) {
			expect(definition.severity, code).toBe("warning");
		}
	});

	it("each take exactly the table's format parameters", () => {
		for (const [code, keys] of Object.entries(TABLE)) {
			expect(definitions[code]?.messages.default.keys.toSorted(), code).toEqual(keys.toSorted());
		}
	});
});

describe("the library", () => {
	it("is named as tspconfig.yaml names it", () => {
		expect($lib.name).toBe(PACKAGE_NAME);
		expect(PACKAGE_NAME).toBe("typespec-http-graphql");
	});

	/**
	 * **The state keys are the compiler's `Symbol.for` of the library name**, so the decorators the
	 * compiler loads from `dist/` and an accessor imported from `src/` read one map.
	 */
	it("declares the state the decorators record into, under shared symbols", () => {
		expect(GraphQLKeys.roots).toBe(Symbol.for("typespec-http-graphql/roots"));
		expect(GraphQLKeys.links).toBe(Symbol.for("typespec-http-graphql/links"));
		expect(GraphQLKeys.inputHeaders).toBe(Symbol.for("typespec-http-graphql/inputHeaders"));
		expect(GraphQLKeys.json).toBe(Symbol.for("typespec-http-graphql/json"));
	});
});
