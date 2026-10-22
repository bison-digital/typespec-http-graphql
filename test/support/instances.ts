import { z, type ZodType } from "zod";

/**
 * **Values to probe a Zod schema with: a minimal instance, and single-fact mutations of it.**
 *
 * Read from `z.toJSONSchema(schema, { io: "input" })`, the schema's own published shape, so the
 * values are the schema's and not the emitter's. The generator only PROPOSES: every caller keeps the
 * probes `schema.safeParse` accepts as legal and treats the rest as refusals, so a sample the
 * generator gets wrong costs coverage, never a false verdict.
 *
 * The pattern is typespec-http-zod's `probes.ts` (minimal instance, then one fact changed per probe),
 * written here rather than imported: emitters and their tests stay independent.
 */

type JsonSchema = Readonly<Record<string, unknown>>;

/** One probe: what changed, as a path and a kind, and the value. */
export interface Probe {
	readonly path: readonly string[];
	readonly kind:
		| "base"
		| "omit"
		| "null"
		| "enum"
		| "bound"
		| "empty"
		| "one"
		| "branch"
		| "wrong-type";
	readonly value: unknown;
}

/** A sample for each string format the corpus and the fixtures use, RFC-shaped. */
const FORMAT_SAMPLES: Readonly<Record<string, readonly string[]>> = {
	"date-time": ["2026-10-14T09:30:00Z", "2026-10-14T09:30:00.000Z", "2026-10-14T09:30:00+01:00"],
	date: ["2026-10-14"],
	time: ["09:30:00", "09:30:00Z"],
	duration: ["PT1S", "P1D"],
	uuid: ["0b8a3f4e-6c1d-4e2f-9a7b-5c3d2e1f0a9b"],
	email: ["person@example.com"],
	uri: ["https://example.com/a"],
	url: ["https://example.com/a"],
	"uri-reference": ["https://example.com/a"],
	byte: ["AAEC"],
	base64: ["AAEC"],
	base64url: ["AAEC"],
	ipv4: ["192.0.2.1"],
	ipv6: ["2001:db8::1"],
};

/** Strings to try where no format says, the first one matching every stated constraint wins. */
const PLAIN_STRINGS = [
	"sample",
	"a",
	"0",
	"abc",
	"AAEC",
	"2026-10-14T09:30:00Z",
	"PT1S",
	"x".repeat(32),
];

/** Values of every JSON type, for a position whose schema says nothing (`{}`). */
const ANY_VALUES: readonly unknown[] = ["sample", 1, true, null, {}, []];

class Generator {
	readonly #root: JsonSchema;

	constructor(root: JsonSchema) {
		this.#root = root;
	}

	resolve(schema: JsonSchema): JsonSchema {
		const ref = schema["$ref"];
		if (typeof ref !== "string") return schema;
		const parts = ref.replace(/^#\//, "").split("/");
		let target: unknown = this.#root;
		for (const part of parts) {
			target = (target as Readonly<Record<string, unknown>> | undefined)?.[part];
		}
		if (typeof target !== "object" || target === null) return {};
		return this.resolve(target as JsonSchema);
	}

	#string(schema: JsonSchema): string {
		const format = typeof schema["format"] === "string" ? schema["format"] : undefined;
		const candidates = [
			...(format === undefined ? [] : (FORMAT_SAMPLES[format] ?? [])),
			...PLAIN_STRINGS,
		];
		const pattern =
			typeof schema["pattern"] === "string" ? new RegExp(schema["pattern"], "u") : undefined;
		const min = typeof schema["minLength"] === "number" ? schema["minLength"] : 0;
		const max = typeof schema["maxLength"] === "number" ? schema["maxLength"] : Infinity;
		for (const candidate of candidates) {
			if (candidate.length < min || candidate.length > max) continue;
			if (pattern !== undefined && !pattern.test(candidate)) continue;
			return candidate;
		}
		return "a".repeat(Math.max(min, 1));
	}

	#number(schema: JsonSchema, integer: boolean): number {
		const minimum = schema["minimum"];
		const exclusive = schema["exclusiveMinimum"];
		const maximum = schema["maximum"];
		let value =
			typeof minimum === "number" ? minimum : typeof exclusive === "number" ? exclusive + 1 : 1;
		if (typeof maximum === "number" && value > maximum) value = maximum;
		const multiple = schema["multipleOf"];
		if (typeof multiple === "number" && multiple > 0)
			value = Math.ceil(value / multiple) * multiple;
		return integer ? Math.ceil(value) : value;
	}

	/** A value the schema states is valid, or the best guess at one. */
	minimal(input: JsonSchema, depth = 0): unknown {
		const schema = this.resolve(input);
		if ("const" in schema) return schema["const"];
		if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) return schema["enum"][0];
		for (const key of ["anyOf", "oneOf"] as const) {
			const branches = schema[key];
			if (Array.isArray(branches) && branches.length > 0) {
				const branch =
					(branches as JsonSchema[]).find(
						(candidate) => this.resolve(candidate)["type"] !== "null",
					) ?? (branches[0] as JsonSchema);
				return this.minimal(branch, depth);
			}
		}
		const allOf = schema["allOf"];
		if (Array.isArray(allOf) && allOf.length > 0) {
			const merged: Record<string, unknown> = {};
			for (const part of allOf as JsonSchema[]) {
				const value = this.minimal(part, depth);
				if (typeof value === "object" && value !== null) Object.assign(merged, value);
			}
			return merged;
		}
		const type = Array.isArray(schema["type"])
			? (schema["type"] as unknown[]).find((candidate) => candidate !== "null")
			: schema["type"];
		switch (type) {
			case "string":
				return this.#string(schema);
			case "integer":
				return this.#number(schema, true);
			case "number":
				return this.#number(schema, false);
			case "boolean":
				return true;
			case "null":
				return null;
			case "array": {
				const items = (schema["items"] ?? {}) as JsonSchema;
				const count = typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
				return Array.from({ length: count }, () => this.minimal(items, depth + 1));
			}
			case "object": {
				const result: Record<string, unknown> = {};
				const properties = (schema["properties"] ?? {}) as Readonly<Record<string, JsonSchema>>;
				const required = new Set((schema["required"] ?? []) as string[]);
				for (const [key, property] of Object.entries(properties)) {
					if (required.has(key) && depth < 8) result[key] = this.minimal(property, depth + 1);
				}
				return result;
			}
			default:
				return "sample";
		}
	}

	/** The alternatives worth trying at one position: every JSON type for `{}`, else the minimal. */
	alternatives(input: JsonSchema): unknown[] {
		const schema = this.resolve(input);
		const empty =
			Object.keys(schema).filter((key) => key !== "description" && key !== "$schema").length === 0;
		return empty ? [...ANY_VALUES] : [this.minimal(schema)];
	}

	/** Single-fact mutations of `base` below `schema`, to `depth` levels of nesting. */
	mutations(input: JsonSchema, base: unknown, path: readonly string[], depth: number): Probe[] {
		const schema = this.resolve(input);
		const probes: Probe[] = [];
		const push = (kind: Probe["kind"], value: unknown): void => {
			probes.push({ path, kind, value });
		};
		push("null", null);
		if (Array.isArray(schema["enum"])) for (const value of schema["enum"]) push("enum", value);
		for (const key of ["anyOf", "oneOf"] as const) {
			const branches = schema[key];
			if (Array.isArray(branches)) {
				for (const branch of branches as JsonSchema[]) push("branch", this.minimal(branch));
			}
		}
		const type = Array.isArray(schema["type"])
			? (schema["type"] as unknown[]).find((candidate) => candidate !== "null")
			: schema["type"];
		if (type === "integer" || type === "number") {
			for (const bound of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
				const value = schema[bound];
				if (typeof value === "number") {
					push("bound", value);
					push(
						"bound",
						type === "integer"
							? value + (bound.startsWith("max") || bound === "exclusiveMaximum" ? 1 : -1)
							: value * 2,
					);
				}
			}
			push("wrong-type", "1");
		}
		if (type === "string") {
			push("wrong-type", 1);
			if (typeof schema["maxLength"] === "number")
				push("bound", "a".repeat(schema["maxLength"] + 1));
		}
		if (type === "boolean") push("wrong-type", "true");
		if (type === "array") {
			const items = (schema["items"] ?? {}) as JsonSchema;
			push("empty", []);
			for (const item of this.alternatives(items)) push("one", [item]);
			push("one", [null]);
			push("wrong-type", "a");
		}
		if (
			type === "object" &&
			depth > 0 &&
			typeof base === "object" &&
			base !== null &&
			!Array.isArray(base)
		) {
			const record = base as Readonly<Record<string, unknown>>;
			const properties = (schema["properties"] ?? {}) as Readonly<Record<string, JsonSchema>>;
			for (const [key, property] of Object.entries(properties)) {
				if (key in record) {
					const { [key]: _omitted, ...rest } = record;
					probes.push({ path: [...path, key], kind: "omit", value: rest });
				}
				for (const value of this.alternatives(property)) {
					probes.push({ path: [...path, key], kind: "branch", value: { ...record, [key]: value } });
				}
				const current = key in record ? record[key] : this.minimal(property);
				for (const nested of this.mutations(property, current, [...path, key], depth - 1)) {
					probes.push({ ...nested, value: { ...record, [key]: nested.value } });
				}
			}
			push("wrong-type", "a");
		}
		return probes;
	}
}

/** The JSON Schema Zod publishes for a schema's INPUT, with nothing it cannot state refused. */
export function jsonSchemaOf(schema: ZodType): JsonSchema {
	return z.toJSONSchema(schema, {
		io: "input",
		unrepresentable: "any",
		cycles: "ref",
	}) as JsonSchema;
}

/**
 * Probes for `schema`: the base instance first, then single-fact mutations to `depth` levels. Each
 * probe is unchecked; the caller asks `schema.safeParse` which are legal.
 */
export function probesOf(schema: ZodType, depth = 3): Probe[] {
	const json = jsonSchemaOf(schema);
	const generator = new Generator(json);
	const bases = generator.alternatives(json);
	const probes: Probe[] = bases.map((value) => ({ path: [], kind: "base", value }));
	for (const base of bases) {
		probes.push(
			...generator
				.mutations(json, base, [], depth)
				.map((probe) => ({ ...probe, value: probe.value })),
		);
	}
	const seen = new Set<string>();
	return probes.filter((probe) => {
		const key = JSON.stringify(probe.value) ?? "undefined";
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The probes `schema` accepts, as it parses them: what a handler may legally return. */
export function legalValuesOf(
	schema: ZodType,
	depth = 3,
): { readonly probe: Probe; readonly parsed: unknown }[] {
	const legal: { probe: Probe; parsed: unknown }[] = [];
	for (const probe of probesOf(schema, depth)) {
		const parsed = schema.safeParse(probe.value);
		if (parsed.success) legal.push({ probe, parsed: parsed.data });
	}
	return legal;
}
