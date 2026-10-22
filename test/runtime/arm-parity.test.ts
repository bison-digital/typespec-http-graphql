import {
	armFor as libraryArmFor,
	type ResponseArm as LibraryResponseArm,
} from "typespec-http-zod/runtime";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z, type ZodType } from "zod";
import { armFor, type ResponseArm } from "../../src/runtime.js";

/**
 * **This package declares its own `ResponseArm` and `armFor`, a deliberate second implementation of
 * one rule**, for the reason typespec-http-mcp gives in its own parity suite, which this one copies:
 * the runtime is copied into the consumer's output as `graphql-runtime.gen.ts`, and emitted output
 * must never import the library. What is not forced is letting the two drift, so this grades this
 * package's against the library's own over every arm shape and every status class.
 */

const schema = z.object({ ok: z.boolean() });

/** Every shape a response arm set can take, including the orders that make precedence observable. */
const ARM_SETS: readonly (readonly ResponseArm[])[] = [
	[{ status: 200, schema }],
	[{ status: 200, schema: undefined }],
	[
		{ status: 204, schema: undefined },
		{ status: 200, schema },
	],
	[
		{ status: 404, schema },
		{ status: "4XX", schema },
	],
	// Declared range-first, so an implementation returning the first match gets it wrong.
	[
		{ status: "4XX", schema },
		{ status: 404, schema },
	],
	[
		{ status: "default", schema },
		{ status: 404, schema },
	],
	[
		{ status: 200, schema },
		{ status: "4XX", schema },
		{ status: "default", schema },
	],
	[
		{ status: "5XX", schema },
		{ status: "default", schema },
	],
	[{ status: "default", schema }],
	[],
];

const STATUSES = [200, 201, 204, 301, 400, 401, 404, 409, 418, 422, 429, 500, 502, 599];

/** The library's view of an arm set: `armFor` reads only `status`, so `schema` is dropped. */
function libraryArms(arms: readonly ResponseArm[]): Parameters<typeof libraryArmFor>[0] {
	return arms.map(({ schema: _schema, ...rest }) => ({ ...rest, schema: undefined }));
}

describe("the arm is the library's arm", () => {
	it("declares exactly the library's ResponseArm", () => {
		expectTypeOf<Omit<ResponseArm, "schema">>().toEqualTypeOf<Omit<LibraryResponseArm, "schema">>();
		expectTypeOf<ResponseArm["schema"]>().toEqualTypeOf<ZodType | undefined>();
		expectTypeOf<keyof ResponseArm>().toEqualTypeOf<keyof LibraryResponseArm>();
	});
});

describe("armFor answers exactly as the library's own does", () => {
	it("agrees on every arm set and every status", () => {
		const disagreements: string[] = [];
		let compared = 0;
		for (const arms of ARM_SETS) {
			for (const status of STATUSES) {
				compared += 1;
				const mine = armFor(arms, status);
				const theirs = libraryArmFor(libraryArms(arms), status);
				if (mine?.status !== theirs?.status) {
					disagreements.push(
						`${JSON.stringify(arms.map((a) => a.status))} @ ${status}: ` +
							`${String(mine?.status)} vs ${String(theirs?.status)}`,
					);
				}
			}
		}
		expect(disagreements).toEqual([]);
		expect(compared).toBe(ARM_SETS.length * STATUSES.length);
		expect(compared).toBeGreaterThanOrEqual(140);
	});

	/** The comparison above means something only if these arm sets tell implementations apart. */
	it("the arm sets distinguish exact code from range from catch-all", () => {
		const exactThenRange: readonly ResponseArm[] = [
			{ status: 404, schema },
			{ status: "4XX", schema },
		];
		expect(armFor(exactThenRange, 404)?.status).toBe(404);
		expect(armFor(exactThenRange, 409)?.status).toBe("4XX");
		const rangeFirst: readonly ResponseArm[] = [
			{ status: "4XX", schema },
			{ status: 404, schema },
		];
		expect(armFor(rangeFirst, 404)?.status).toBe(404);
		const fallback: readonly ResponseArm[] = [
			{ status: "default", schema },
			{ status: 404, schema },
		];
		expect(armFor(fallback, 500)?.status).toBe("default");
		expect(armFor([], 200)).toBeUndefined();
	});
});
