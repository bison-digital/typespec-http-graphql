import {
	buildSchema,
	type GraphQLSchema,
	isObjectType,
	Kind,
	lexicographicSortSchema,
	parse,
	printSchema,
	valueFromASTUntyped,
} from "graphql";
import type { SchemaPlan } from "../../src/model.js";

/**
 * **`schema.graphql` must be the schema `createSchema` builds.** Two renderings of one plan, by two
 * renderers, compared through graphql-js:
 *
 * - `printSchema(lexicographicSortSchema(buildSchema(sdl)))` against the same of the runtime schema,
 *   which covers every type, field, argument, default, description, deprecation, `@specifiedBy` and
 *   directive DEFINITION, but not applied directives, which `printSchema` drops;
 * - so every `@cost`/`@listSize` applied in the SDL AST is compared with the same field's
 *   `extensions` in the runtime schema, both ways;
 * - and, given the plan, every directive the plan applies must parse back from the SDL.
 */
export interface Agreement {
	/** The SDL's schema, printed and sorted. */
	readonly sdl: string;
	/** The runtime schema, printed and sorted. */
	readonly runtime: string;
	readonly disagreements: readonly string[];
	/** How many cost directives the SDL applies, so a caller can assert the check was not vacuous. */
	readonly applied: number;
}

const COST_DIRECTIVES = ["cost", "listSize"] as const;

/** JSON with sorted keys, so a null-prototype map and a plain object of one value compare equal. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item: unknown) => canonical(item)).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Readonly<Record<string, unknown>>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

/** `Type.field@directive` -> the directive's arguments, for every directive the SDL applies. */
function appliedIn(sdl: string): Map<string, Record<string, unknown>> {
	const applied = new Map<string, Record<string, unknown>>();
	for (const definition of parse(sdl).definitions) {
		if (definition.kind !== Kind.OBJECT_TYPE_DEFINITION) continue;
		for (const field of definition.fields ?? []) {
			for (const directive of field.directives ?? []) {
				const args: Record<string, unknown> = {};
				for (const argument of directive.arguments ?? []) {
					args[argument.name.value] = valueFromASTUntyped(argument.value);
				}
				applied.set(`${definition.name.value}.${field.name.value}@${directive.name.value}`, args);
			}
		}
	}
	return applied;
}

export function sdlAgreement(sdl: string, runtime: GraphQLSchema, plan?: SchemaPlan): Agreement {
	const disagreements: string[] = [];
	const applied = appliedIn(sdl);
	const costApplied = [...applied.keys()].filter((key) =>
		COST_DIRECTIVES.some((name) => key.endsWith(`@${name}`)),
	);

	// Every cost directive a runtime field carries in its extensions is applied in the SDL, equally...
	for (const type of Object.values(runtime.getTypeMap())) {
		if (!isObjectType(type) || type.name.startsWith("__")) continue;
		for (const field of Object.values(type.getFields())) {
			for (const name of COST_DIRECTIVES) {
				const key = `${type.name}.${field.name}@${name}`;
				const inRuntime = field.extensions[name];
				const inSdl = applied.get(key);
				if (inRuntime === undefined && inSdl === undefined) continue;
				if (canonical(inRuntime) !== canonical(inSdl)) {
					disagreements.push(
						`${key}: runtime extensions ${canonical(inRuntime)}, SDL ${canonical(inSdl)}`,
					);
				}
			}
		}
	}
	// ...and every one the SDL applies sits on a field the runtime schema has.
	for (const key of costApplied) {
		const [typeName = "", rest = ""] = key.split(".");
		const fieldName = rest.split("@")[0] ?? "";
		const type = runtime.getType(typeName);
		if (!isObjectType(type) || type.getFields()[fieldName] === undefined) {
			disagreements.push(`${key}: applied in the SDL, on a field the runtime schema lacks`);
		}
	}

	// Every directive the plan applies parses back from the SDL.
	if (plan !== undefined) {
		const owners: (readonly [string, SchemaPlan["query"]])[] = [
			["Query", plan.query],
			["Mutation", plan.mutation],
			...plan.types.flatMap((def) =>
				def.kind === "object" ? [[def.name, def.fields] as const] : [],
			),
		];
		for (const [typeName, fields] of owners) {
			for (const field of fields) {
				for (const directive of field.directives) {
					const key = `${typeName}.${field.name}@${directive.name}`;
					const parsed = applied.get(key);
					if (canonical(parsed) !== canonical(directive.arguments)) {
						disagreements.push(
							`${key}: planned ${canonical(directive.arguments)}, SDL ${canonical(parsed)}`,
						);
					}
				}
			}
		}
	}

	return {
		sdl: printSchema(lexicographicSortSchema(buildSchema(sdl))),
		runtime: printSchema(lexicographicSortSchema(runtime)),
		disagreements,
		applied: costApplied.length,
	};
}
