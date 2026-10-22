import { describe, expect, it } from "vitest";
import { EmitterOptionsSchema as httpZodOptions } from "typespec-http-zod";
import { EmitterOptionsSchema } from "../src/lib.js";

/**
 * That every option `typespec-http-zod` accepts reaches this emitter, and that this emitter adds
 * none of its own.
 *
 * **Graded as a CLASS, never as a list.** This emitter runs the whole library and writes beside its
 * output, so an option the library gains has to arrive here. A hand-written list of expected keys
 * would pass forever while the library grew.
 *
 * **"Adds nothing" is graded as firmly as "forwards everything".** `graphql.tsp` is the one place
 * the GraphQL surface is stated; an option that also selected operations, by tag or otherwise, would
 * be a second statement of it.
 */

type SchemaLike = {
	type: string;
	additionalProperties: boolean;
	properties: Record<string, unknown>;
};

const ours = EmitterOptionsSchema as unknown as SchemaLike;
const theirs = httpZodOptions as unknown as SchemaLike;

const serviceProperties = (schema: SchemaLike): Record<string, unknown> => {
	const services = schema.properties["services"] as {
		additionalProperties: { properties: Record<string, unknown> };
	};
	return services.additionalProperties.properties;
};

describe("the options schema is the library's", () => {
	it("carries every top-level option the library publishes", () => {
		const missing = Object.keys(theirs.properties).filter((key) => !(key in ours.properties));
		expect(missing).toEqual([]);
		// Non-vacuity: an empty library schema would satisfy the line above.
		expect(Object.keys(theirs.properties).length).toBeGreaterThanOrEqual(7);
	});

	it("carries every per-service option the library publishes", () => {
		const theirService = serviceProperties(theirs);
		const missing = Object.keys(theirService).filter((key) => !(key in serviceProperties(ours)));
		expect(missing).toEqual([]);
		expect(Object.keys(theirService).length).toBeGreaterThanOrEqual(1);
	});

	it("adds no option of its own, at either level", () => {
		const extraTop = Object.keys(ours.properties).filter((key) => !(key in theirs.properties));
		expect(extraTop).toEqual([]);
		const theirService = serviceProperties(theirs);
		const extraService = Object.keys(serviceProperties(ours)).filter(
			(key) => !(key in theirService),
		);
		expect(extraService).toEqual([]);
	});

	it("keeps the shape the compiler validates against", () => {
		expect(ours.type).toBe("object");
		expect(ours.additionalProperties).toBe(false);
	});
});
