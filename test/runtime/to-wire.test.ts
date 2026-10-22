import {
	GraphQLEnumType,
	GraphQLInputObjectType,
	GraphQLList,
	GraphQLNonNull,
	GraphQLString,
} from "graphql";
import { describe, expect, it } from "vitest";
import { type InputRules, SCALARS, toWire as toWireBy } from "../../src/runtime.js";

/**
 * **The wire never changes; only names do.** `RULES` is the `INPUT_RULES` literal `graphql.gen.ts`
 * writes for these input types (`wire` and `dropNull`, each only where its default does not hold),
 * and `toWire` must turn a coerced GraphQL value back into exactly the object the REST route's
 * validators see. The types carry no `extensions`: the rules are code, so a rebuilt schema keeps them.
 */

const RULES: InputRules = {
	LabelInput: { displayName: { wire: "display_name" }, colour: { dropNull: true } },
	CreateWidgetInput: {
		xApiVersion: { wire: "x-api-version" },
		createdAt: { wire: "created_at", dropNull: true },
	},
	RetireWidgetInput: { retiredBy: { wire: "retired_by", nullIfAbsent: true } },
};

const toWire = (value: unknown, type: Parameters<typeof toWireBy>[1]): unknown =>
	toWireBy(value, type, RULES);

const Colour = new GraphQLEnumType({
	name: "Colour",
	values: { DARK_GREY: { value: "dark-grey" }, RED: { value: "red" } },
});

const LabelInput = new GraphQLInputObjectType({
	name: "LabelInput",
	fields: {
		displayName: { type: new GraphQLNonNull(GraphQLString) },
		colour: { type: Colour },
	},
});

/**
 * A mutation's input: a required header beside a spread body's properties, flattened into one
 * object. An optional header is never GraphQL input, so the header here is required.
 */
const CreateWidgetInput = new GraphQLInputObjectType({
	name: "CreateWidgetInput",
	fields: {
		xApiVersion: { type: new GraphQLNonNull(GraphQLString) },
		name: { type: new GraphQLNonNull(GraphQLString) },
		createdAt: { type: SCALARS.UTCDateTime },
		note: { type: GraphQLString },
		labels: { type: new GraphQLList(new GraphQLNonNull(LabelInput)) },
		metadata: { type: SCALARS.JSON },
	},
});

/**
 * A field that is required and `| null` in TypeSpec, which GraphQL can only state as nullable: the
 * caller says the `null` by leaving it out.
 */
const RetireWidgetInput = new GraphQLInputObjectType({
	name: "RetireWidgetInput",
	fields: { retiredBy: { type: GraphQLString } },
});

describe("toWire", () => {
	it("renames every field to its wire key, at every depth", () => {
		expect(
			toWire(
				{
					xApiVersion: "v1",
					name: "w",
					createdAt: "2026-10-13T00:00:00Z",
					labels: [{ displayName: "a", colour: "dark-grey" }],
				},
				new GraphQLNonNull(CreateWidgetInput),
			),
		).toEqual({
			"x-api-version": "v1",
			name: "w",
			created_at: "2026-10-13T00:00:00Z",
			labels: [{ display_name: "a", colour: "dark-grey" }],
		});
	});

	it("drops an explicit null on a dropNull field, as REST sees an absent key", () => {
		const wire = toWire(
			{
				name: "w",
				createdAt: null,
				labels: [{ displayName: "a", colour: null }],
			},
			CreateWidgetInput,
		);
		expect(wire).toEqual({ name: "w", labels: [{ display_name: "a" }] });
		expect(Object.keys(wire as object)).not.toContain("created_at");
	});

	it("keeps an explicit null on a field that is `| null` in TypeSpec", () => {
		expect(toWire({ name: "w", note: null }, CreateWidgetInput)).toEqual({
			name: "w",
			note: null,
		});
	});

	it("leaves an absent field absent, not undefined", () => {
		const wire = toWire({ name: "w" }, CreateWidgetInput) as Record<string, unknown>;
		expect(Object.keys(wire)).toEqual(["name"]);
	});

	it("writes the null a required `| null` field must state, where the caller leaves it out", () => {
		expect(toWire({}, RetireWidgetInput)).toEqual({ retired_by: null });
		expect(toWire({ retiredBy: null }, RetireWidgetInput)).toEqual({ retired_by: null });
		expect(toWire({ retiredBy: "ops" }, RetireWidgetInput)).toEqual({ retired_by: "ops" });
	});

	it("passes enum and scalar values through: they are already wire values", () => {
		expect(toWire("dark-grey", Colour)).toBe("dark-grey");
		const json = { nested: { snake_case: [1, null] } };
		expect(toWire({ name: "w", metadata: json }, CreateWidgetInput)).toEqual({
			name: "w",
			metadata: json,
		});
	});

	it("passes null and undefined through at the top", () => {
		expect(toWire(null, CreateWidgetInput)).toBeNull();
		expect(toWire(undefined, CreateWidgetInput)).toBeUndefined();
	});

	it("converts each element of a list, and a single value in list position", () => {
		const list = new GraphQLList(LabelInput);
		expect(toWire([{ displayName: "a" }, { displayName: "b" }], list)).toEqual([
			{ display_name: "a" },
			{ display_name: "b" },
		]);
		expect(toWire({ displayName: "a" }, list)).toEqual({ display_name: "a" });
	});

	it("leaves a value as it is where the definition no longer carries its type", () => {
		expect(toWireBy({ displayName: "a" }, undefined, RULES)).toEqual({ displayName: "a" });
	});
});
