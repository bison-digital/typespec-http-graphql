import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDeprecationDetails, getDoc, type ModelProperty, type Value } from "@typespec/compiler";
import {
	getNamedType,
	type GraphQLInputType,
	type IntrospectionField,
	type IntrospectionInputObjectType,
	type IntrospectionInputValue,
	type IntrospectionObjectType,
	introspectionFromSchema,
	isInputObjectType,
	isNonNullType,
} from "graphql";
import { applyEnumMemberPipeline } from "../names/upstream-naming.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResponseArm } from "typespec-http-zod/runtime";
import { corpusScenarios, libraryRefusalsOf, packageRoot } from "../support/corpus.js";
import { declareEveryOperation } from "../support/declare-every-operation.js";
import { openApiVersionsOf } from "../support/openapi-versions.js";
import { legalValuesOf, probesOf } from "../support/instances.js";
import { ratchet } from "../support/ratchet.js";
import { publishDocument } from "../replay/published.js";
import { Untranslatable } from "../support/wire-walk.js";
import { executeThroughYoga, type GraphQLResult } from "../support/yoga.js";
import {
	argumentsFor,
	bodyOf,
	dispositionOf,
	type Fixture,
	fieldOf,
	groupsOf,
	handedFor,
	loadFixture,
	pagingOf,
	type RootField,
	typeAt,
	asExpected,
	zodVerdict,
	documentFor,
	expectedFor,
	isMember,
	isOpenInput,
	isSuccess,
	statusFor,
} from "../support/surface-harness.js";

/**
 * **Verdict parity: every value the library's Zod calls legal crosses GraphQL intact, and GraphQL
 * accepts exactly the input the library accepts.**
 *
 * The analogue of typespec-http-zod's `behaviour.test.ts`, where one value goes through Ajv and the
 * emitted Zod and both must give the same verdict. Here the two judges are GraphQL (the emitted
 * schema, through Yoga) and the library's own Zod schemas, which the REST route validates with:
 *
 * - **Responses.** For every root field and every success or member arm it declares, bodies the
 *   arm's schema ACCEPTS (a minimal instance, each key nulled and omitted, each enum member, each
 *   bound, to depth three) are returned by the handler. The field must answer each one with no
 *   error, and with the value `WireWalk` says design.md gives it.
 * - **Inputs.** Probes from both sides: single-fact mutations of a valid wire input, and every
 *   nullable argument or input field omitted or nulled. The handler is called exactly when the
 *   library accepts what GraphQL hands it, with exactly what the library parses; GraphQL refuses only
 *   what the library refuses; and where GraphQL lets through what the library then refuses, the
 *   only reasons allowed are ones a GraphQL type cannot state: a format, a range, a multiple, or a
 *   value at a position design.md projects as `JSON`.
 *
 * Probes come from the schemas' own JSON Schema (`test/support/instances.ts`); expected values from
 * `test/support/wire-walk.ts`, which reads no emitted code. Counts are held to `baseline.json`.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const outRoot = join(packageRoot, "test", ".out-verdicts");

/** Zod issue codes a GraphQL type cannot state, so GraphQL rightly lets them through to Zod. */
const BEYOND_GRAPHQL = new Set(["invalid_format", "too_big", "too_small", "not_multiple_of"]);

const DEPTH_FIXTURES: readonly { readonly name: string; readonly entry: string }[] = [
	{ name: "edges", entry: join(here, "edges", "main.tsp") },
	{ name: "idiom", entry: join(packageRoot, "test", "idiom", "main.tsp") },
	{ name: "acceptance", entry: join(packageRoot, "test", "acceptance", "main.tsp") },
];

const fixtures: Fixture[] = [];
/** Fixtures that did not load, with why: in the report, for whoever reads a red run. */
const unloaded: string[] = [];
const skipped: Record<string, number> = {};
const skip = (reason: string): void => {
	skipped[reason] = (skipped[reason] ?? 0) + 1;
};

beforeAll(async () => {
	const sources: {
		name: string;
		entry: string;
		published: string;
		expectedErrors: readonly string[];
	}[] = DEPTH_FIXTURES.map((fixture) => ({
		...fixture,
		published: fixture.entry,
		expectedErrors: [],
	}));
	for (const { name, main } of corpusScenarios()) {
		const spec = join(outRoot, "corpus", name, "spec");
		await declareEveryOperation(main, spec);
		sources.push({
			name: `corpus:${name}`,
			entry: join(spec, "graphql.tsp"),
			published: main,
			expectedErrors: libraryRefusalsOf(name),
		});
	}
	for (const { name, entry, published, expectedErrors } of sources) {
		// The document a base's value is decided by, published in a compile of its own.
		const documentDir = join(outRoot, name.replace(":", "__"), "document");
		await publishDocument(published, documentDir);
		const loaded = await loadFixture(
			name,
			entry,
			join(outRoot, name.replace(":", "__"), "emitted"),
			{ expectedErrors, openApiVersions: openApiVersionsOf(name), documentDir },
		);
		if ("skip" in loaded) {
			skip(`fixture:${loaded.skip}`);
			unloaded.push(`${name}: ${loaded.skip} ${loaded.detail}`);
			continue;
		}
		fixtures.push(loaded.fixture);
	}
}, 1_800_000);

/**
 * **Every run writes what it found to `.out-verdicts/report.json`**: each violation in full, each
 * fixture that did not load, and the tallies. An assertion message truncates a long list; the
 * report does not.
 */
afterAll(() => {
	mkdirSync(outRoot, { recursive: true });
	writeFileSync(
		join(outRoot, "report.json"),
		`${JSON.stringify({ unloaded, skipped, responses, inputs, facts, factViolations, responseViolations, inputViolations, fixtures: fixtures.map((fixture) => ({ name: fixture.name, roots: fixture.roots.map((root) => root.name), missing: fixture.missing })) }, null, "\t")}\n`,
	);
});

const fixtureNamed = (name: string): Fixture => {
	const found = fixtures.find((fixture) => fixture.name === name);
	if (found === undefined) throw new Error(`fixture ${name} did not load`);
	return found;
};

// -------------------------------------------------------------------------------------------------
// Shared mechanics.
// -------------------------------------------------------------------------------------------------

async function execute(
	fixture: Fixture,
	root: RootField,
	args: Readonly<Record<string, unknown>>,
): Promise<GraphQLResult> {
	fixture.recorder.reset();
	return executeThroughYoga(fixture.schema, documentFor(fixture, root, args), {});
}

/** A valid wire input for the operation: the first probe of each group the library accepts. */
function baseWireOf(fixture: Fixture, root: RootField): Record<string, unknown> | undefined {
	const wire: Record<string, unknown> = {};
	for (const group of groupsOf(fixture, root)) {
		const [legal] = legalValuesOf(group.schema, 1);
		if (legal === undefined) return undefined;
		// As the library parses it: a query or header value arrives as text and reaches the handler
		// typed, and the GraphQL client sends the typed value.
		const value = legal.parsed;
		if (group.key !== undefined) wire[group.key] = value;
		else if (typeof value === "object" && value !== null) Object.assign(wire, value);
	}
	return wire;
}

// -------------------------------------------------------------------------------------------------
// Responses.
// -------------------------------------------------------------------------------------------------

interface Tally {
	fields: number;
	arms: number;
	bodies: number;
	probes: number;
	called: number;
	refusedByGraphQL: number;
	refusedByZod: number;
}

const responses = { fields: 0, arms: 0, bodies: 0 };
const responseViolations: string[] = [];
const inputs: Omit<Tally, "fields" | "arms" | "bodies"> & { fields: number } = {
	fields: 0,
	probes: 0,
	called: 0,
	refusedByGraphQL: 0,
	refusedByZod: 0,
};
const inputViolations: string[] = [];

describe("responses: every legal body crosses GraphQL intact", () => {
	it("answers every body each success and member arm's schema accepts, as design.md says", async () => {
		for (const fixture of fixtures) {
			for (const root of fixture.roots) {
				let base: Record<string, unknown> | undefined;
				let args: Readonly<Record<string, unknown>>;
				try {
					base = baseWireOf(fixture, root);
					if (base === undefined) {
						skip("response:no-legal-input");
						continue;
					}
					args = argumentsFor(fixture, root, base).args;
				} catch (error) {
					if (!(error instanceof Untranslatable)) throw error;
					skip("response:untranslatable-input");
					continue;
				}
				const arms = fixture.library[root.names.responses] as readonly ResponseArm[];
				responses.fields += 1;
				for (const arm of arms) {
					const status = statusFor(arm, arms);
					if (status === undefined) {
						skip("response:default-arm");
						continue;
					}
					const projected = isSuccess(status) || (root.kind === "mutation" && isMember(status));
					if (!projected) {
						skip("response:error-arm");
						continue;
					}
					responses.arms += 1;
					const bodies =
						arm.schema === undefined
							? [{ probe: { value: undefined }, parsed: undefined }]
							: legalValuesOf(arm.schema);
					if (bodies.length === 0) {
						skip("response:no-legal-body");
						continue;
					}
					for (const { probe, parsed } of bodies) {
						let expected: unknown;
						try {
							expected = expectedFor(fixture, root, status, parsed, arms);
						} catch (error) {
							if (!(error instanceof Untranslatable)) throw error;
							skip("response:untranslatable-body");
							continue;
						}
						responses.bodies += 1;
						fixture.recorder.answer = () => ({ status, body: probe.value, headers: {} });
						const result = await execute(fixture, root, args);
						const where = `${fixture.name} ${root.name} ${String(arm.status)} ${JSON.stringify(probe.value)}`;
						if (result.errors !== undefined) {
							responseViolations.push(
								`${where}: ${result.errors.map((error) => error.message).join("; ")}`,
							);
							continue;
						}
						const actual = asExpected(result.data?.[root.name], expected);
						if (
							JSON.stringify(actual) !== JSON.stringify(expected) &&
							!deepEqual(actual, expected)
						) {
							responseViolations.push(
								`${where}: answered ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
							);
						}
					}
				}
			}
		}
		expect(responseViolations).toEqual([]);
	}, 1_800_000);
});

// -------------------------------------------------------------------------------------------------
// Inputs.
// -------------------------------------------------------------------------------------------------

/** Nullable arguments and input fields, as paths, each omitted and nulled. */
function graphqlProbes(
	fixture: Fixture,
	root: RootField,
	args: Readonly<Record<string, unknown>>,
): { readonly args: Record<string, unknown>; readonly kind: string }[] {
	const field = fieldOf(fixture, root);
	const probes: { args: Record<string, unknown>; kind: string }[] = [];
	const visit = (
		type: GraphQLInputType,
		value: Readonly<Record<string, unknown>>,
		rebuild: (next: Record<string, unknown>) => Record<string, unknown>,
		depth: number,
	): void => {
		const named = getNamedType(type);
		if (!isInputObjectType(named) || depth > 2) return;
		for (const inner of Object.values(named.getFields())) {
			const { [inner.name]: _dropped, ...without } = value;
			if (!isNonNullType(inner.type)) {
				probes.push({ args: rebuild(without), kind: `omit ${inner.name}` });
				probes.push({
					args: rebuild({ ...value, [inner.name]: null }),
					kind: `null ${inner.name}`,
				});
			}
			const nested = value[inner.name];
			if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
				visit(
					inner.type,
					nested as Record<string, unknown>,
					(next) => rebuild({ ...value, [inner.name]: next }),
					depth + 1,
				);
			}
		}
	};
	for (const arg of field.args) {
		if (!isNonNullType(arg.type)) {
			const { [arg.name]: _dropped, ...without } = args;
			probes.push({ args: without, kind: `omit ${arg.name}` });
			probes.push({ args: { ...args, [arg.name]: null }, kind: `null ${arg.name}` });
		}
		const value = args[arg.name];
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			visit(
				arg.type,
				value as Record<string, unknown>,
				(next) => ({ ...args, [arg.name]: next }),
				0,
			);
		}
	}
	return probes;
}

/** Wire probes: each group's single-fact mutations, placed over the base input. */
function wireProbes(
	fixture: Fixture,
	root: RootField,
	base: Readonly<Record<string, unknown>>,
): { readonly wire: Record<string, unknown>; readonly kind: string }[] {
	const probes: { wire: Record<string, unknown>; kind: string }[] = [];
	for (const group of groupsOf(fixture, root)) {
		for (const raw of probesOf(group.schema, 2)) {
			// A probe the library accepts, as it parses it; a refused one, as it was proposed.
			const parsed = group.schema.safeParse(raw.value);
			const probe = parsed.success ? { ...raw, value: parsed.data } : raw;
			if (group.key !== undefined) {
				probes.push({
					wire: { ...base, [group.key]: probe.value },
					kind: `${group.name} ${probe.kind} ${probe.path.join(".")}`,
				});
				continue;
			}
			if (typeof probe.value !== "object" || probe.value === null || Array.isArray(probe.value))
				continue;
			const rest = Object.fromEntries(Object.entries(base).filter(([key]) => !group.keys.has(key)));
			probes.push({
				wire: { ...rest, ...probe.value },
				kind: `${group.name} ${probe.kind} ${probe.path.join(".")}`,
			});
		}
	}
	return probes;
}

/** True when a Zod issue is one GraphQL cannot state: by its code, or because it sits in JSON. */
function beyondGraphQL(
	fixture: Fixture,
	root: RootField,
	issue: { readonly code: string; readonly path: readonly PropertyKey[] },
): boolean {
	if (BEYOND_GRAPHQL.has(issue.code)) return true;
	// An open input is one `JSON` value: every issue in it sits in a JSON position.
	if (isOpenInput(root)) return true;
	return typeAt(fixture, root, issue.path).some((type) =>
		fixture.walk.isJson(type, { input: true, visibility: root.visibility }),
	);
}

describe("inputs: GraphQL accepts exactly what the library accepts", () => {
	it("calls the handler exactly when the library accepts what GraphQL hands it, with what the library parses", async () => {
		for (const fixture of fixtures) {
			for (const root of fixture.roots) {
				let base: Record<string, unknown> | undefined;
				let baseArgs: Readonly<Record<string, unknown>>;
				try {
					base = baseWireOf(fixture, root);
					if (base === undefined) {
						skip("input:no-legal-input");
						continue;
					}
					baseArgs = argumentsFor(fixture, root, base).args;
				} catch (error) {
					if (!(error instanceof Untranslatable)) throw error;
					skip("input:untranslatable-input");
					continue;
				}
				inputs.fields += 1;
				const groups = groupsOf(fixture, root);
				const arms = fixture.library[root.names.responses] as readonly ResponseArm[];
				const success = arms.find((arm) => typeof arm.status === "number" && isSuccess(arm.status));
				const answer =
					success === undefined
						? undefined
						: (success.schema === undefined ? [] : legalValuesOf(success.schema, 1))[0];
				fixture.recorder.answer = () => ({
					status: success?.status ?? 200,
					body: answer?.probe.value,
					headers: {},
				});

				const candidates: { args: Readonly<Record<string, unknown>>; kind: string }[] = [
					{ args: baseArgs, kind: "base" },
					...graphqlProbes(fixture, root, baseArgs),
				];
				for (const { wire, kind } of wireProbes(fixture, root, base)) {
					try {
						candidates.push({ args: argumentsFor(fixture, root, wire).args, kind: `wire ${kind}` });
					} catch (error) {
						if (!(error instanceof Untranslatable)) throw error;
						skip("input:untranslatable-probe");
					}
				}
				const seen = new Set<string>();
				for (const { args, kind } of candidates) {
					const key = JSON.stringify(args);
					if (seen.has(key)) continue;
					seen.add(key);
					let handed: Record<string, unknown>;
					try {
						handed = handedFor(fixture, root, args);
					} catch (error) {
						if (!(error instanceof Untranslatable)) throw error;
						skip("input:untranslatable-probe");
						continue;
					}
					const verdict = zodVerdict(root, groups, handed);
					inputs.probes += 1;
					const result = await execute(fixture, root, args);
					const calls = fixture.recorder.calls.filter(
						(call) => call.operationId === root.operationId,
					);
					const where = `${fixture.name} ${root.name} [${kind}] ${JSON.stringify(args)}`;
					const issues =
						result.errors?.flatMap((error) =>
							Array.isArray(error.extensions?.["issues"]) ? [error] : [],
						) ?? [];
					if (calls.length > 0) {
						inputs.called += 1;
						if (!verdict.accepted) {
							inputViolations.push(
								`${where}: the handler was called, but the library refuses ${JSON.stringify(handed)}: ${JSON.stringify(verdict.issues)}`,
							);
						} else if (!deepEqual(calls[0]?.input, verdict.parsed)) {
							inputViolations.push(
								`${where}: the handler received ${JSON.stringify(calls[0]?.input)}, the library parses ${JSON.stringify(verdict.parsed)}`,
							);
						}
					} else if (issues.length > 0) {
						inputs.refusedByZod += 1;
						if (verdict.accepted) {
							inputViolations.push(
								`${where}: refused as BAD_USER_INPUT, but the library accepts ${JSON.stringify(handed)}`,
							);
						} else {
							const stateable = verdict.issues.filter(
								(issue) => !beyondGraphQL(fixture, root, issue),
							);
							if (stateable.length > 0) {
								inputViolations.push(
									`${where}: GraphQL accepted what the library refuses for a reason a GraphQL type states: ${JSON.stringify(stateable)}`,
								);
							}
						}
					} else {
						inputs.refusedByGraphQL += 1;
						if (verdict.accepted) {
							inputViolations.push(
								`${where}: GraphQL refused input the library accepts (${JSON.stringify(handed)}): ${result.errors?.map((error) => error.message).join("; ") ?? "no error"}`,
							);
						}
					}
				}
			}
		}
		expect(inputViolations).toEqual([]);
	}, 1_800_000);
});

// -------------------------------------------------------------------------------------------------
// Facts: what the spec says about an input reaches introspection.
// -------------------------------------------------------------------------------------------------

/**
 * A TypeSpec default as the GraphQL literal introspection prints it, or `undefined` where design.md
 * gives no GraphQL spelling for one (an object or array default).
 */
function literalOf(value: Value): string | undefined {
	switch (value.valueKind) {
		case "StringValue":
			return JSON.stringify(value.value);
		case "BooleanValue":
			return String(value.value);
		case "NumericValue":
			return value.value.toString();
		case "EnumValue":
			return applyEnumMemberPipeline(value.value.name);
		case "NullValue":
			return "null";
		default:
			return undefined;
	}
}

const factViolations: string[] = [];
const facts = { inputs: 0, docs: 0, deprecations: 0, defaults: 0 };

/** One input's facts against its introspected input value: doc, deprecation, default. */
function checkFacts(
	fixture: Fixture,
	where: string,
	property: ModelProperty,
	value: IntrospectionInputValue | undefined,
): void {
	if (value === undefined) {
		factViolations.push(`${where}: introspection has no such input`);
		return;
	}
	facts.inputs += 1;
	const doc = getDoc(fixture.program, property);
	if (doc !== undefined) {
		facts.docs += 1;
		if (
			value.description === null ||
			value.description === undefined ||
			!value.description.startsWith(doc)
		) {
			factViolations.push(
				`${where}: description ${JSON.stringify(value.description)} does not carry the doc ${JSON.stringify(doc)}`,
			);
		}
	}
	const reason = getDeprecationDetails(fixture.program, property)?.message;
	if (reason !== undefined) {
		facts.deprecations += 1;
		const required = value.type.kind === "NON_NULL" && value.defaultValue === null;
		// design.md: GraphQL refuses @deprecated on a required input, so there the reason ends the
		// description as `Deprecated: <reason>`; everywhere else it is the input's own deprecation.
		if (required) {
			if (!(value.description ?? "").endsWith(`Deprecated: ${reason}`)) {
				factViolations.push(
					`${where}: required, and its description does not end "Deprecated: ${reason}"`,
				);
			}
		} else if (value.isDeprecated !== true || value.deprecationReason !== reason) {
			factViolations.push(
				`${where}: #deprecated "${reason}" in the spec, introspection says isDeprecated ${String(value.isDeprecated)}, reason ${JSON.stringify(value.deprecationReason)}`,
			);
		}
	}
	const declared = property.defaultValue;
	if (declared !== undefined) {
		/**
		 * design.md: a default is stated, an enum's by its value's name, upstream's enum-member
		 * pipeline applied to the member or, for a union of literals, to the literal.
		 */
		const enumTyped =
			value.type.kind === "ENUM" ||
			(value.type.kind === "NON_NULL" && value.type.ofType.kind === "ENUM");
		const literal =
			enumTyped && declared.valueKind === "StringValue"
				? applyEnumMemberPipeline(declared.value)
				: literalOf(declared);
		if (literal !== undefined) {
			facts.defaults += 1;
			if (value.defaultValue !== literal) {
				factViolations.push(
					`${where}: default ${literal} in the spec, introspection says ${JSON.stringify(value.defaultValue)}`,
				);
			}
		}
	}
}

describe("facts: every doc, deprecation and default an input declares reaches introspection", () => {
	it("introspects each argument and input field with the spec's doc, #deprecated and default", () => {
		for (const fixture of fixtures) {
			const introspection = introspectionFromSchema(fixture.schema, {
				inputValueDeprecation: true,
			});
			const typeNamed = (name: string) =>
				introspection.__schema.types.find((type) => type.name === name);
			for (const root of fixture.roots) {
				// An open input states no input of its own to carry a doc, deprecation or default.
				if (isOpenInput(root)) {
					skip("facts:open-input");
					continue;
				}
				const rootType = typeNamed(root.kind === "query" ? "Query" : "Mutation") as
					| IntrospectionObjectType
					| undefined;
				const field = rootType?.fields.find(
					(candidate: IntrospectionField) => candidate.name === root.name,
				);
				if (field === undefined) continue;
				let inputs: readonly IntrospectionInputValue[] = field.args;
				if (root.kind === "mutation") {
					const input = field.args.find((arg) => arg.name === "input");
					if (input === undefined) continue;
					let ref = input.type;
					while (ref.kind === "NON_NULL" || ref.kind === "LIST") ref = ref.ofType;
					inputs =
						(typeNamed(ref.name) as IntrospectionInputObjectType | undefined)?.inputFields ?? [];
				}
				const paging =
					root.kind === "query" ? pagingOf(fixture.program, root.operation) : undefined;
				for (const parameter of root.operation.parameters.parameters) {
					if (dispositionOf(parameter) !== "argument" || paging?.after === parameter.name) continue;
					const name =
						paging?.first === parameter.name ? "first" : fixture.walk.fieldName(parameter.name);
					checkFacts(
						fixture,
						`${fixture.name} ${root.name}(${name})`,
						parameter.param,
						inputs.find((input) => input.name === name),
					);
				}
				const body = bodyOf(root);
				if (body !== undefined && body.key === undefined && body.type.kind === "Model") {
					for (const property of fixture.walk.payloadOf(body.type, root.visibility)) {
						const name = fixture.walk.fieldName(fixture.walk.wireName(property));
						checkFacts(
							fixture,
							`${fixture.name} ${root.name}(${name})`,
							property,
							inputs.find((input) => input.name === name),
						);
					}
				}
			}
		}
		expect(factViolations).toEqual([]);
	});
});

// -------------------------------------------------------------------------------------------------
// The record.
// -------------------------------------------------------------------------------------------------

describe("the verdicts are evidence", () => {
	it("loaded every depth fixture, each with its declarations served", () => {
		for (const { name } of DEPTH_FIXTURES) {
			const fixture = fixtureNamed(name);
			expect(fixture.roots.length, name).toBeGreaterThan(0);
			expect(fixture.missing, name).toEqual([]);
		}
	});

	it("holds what it compared and what it skipped to the baseline", () => {
		const { problems } = ratchet(
			join(here, "baseline.json"),
			"Verdict parity between GraphQL and the library's Zod: root fields, arms and legal bodies compared " +
				"for responses; root fields and probes for inputs; inputs whose doc, deprecation and default were " +
				"checked (floors); and every skip by reason (ceilings). How each probe was answered is in " +
				".out-verdicts/report.json. Held by test/support/ratchet.ts.",
			{
				floors: {
					"fixtures:loaded": fixtures.length,
					"responses:fields": responses.fields,
					"responses:arms": responses.arms,
					"responses:bodies": responses.bodies,
					"inputs:fields": inputs.fields,
					"inputs:probes": inputs.probes,
					"facts:inputs": facts.inputs,
					"facts:docs": facts.docs,
					"facts:deprecations": facts.deprecations,
					"facts:defaults": facts.defaults,
				},
				ceilings: skipped,
			},
		);
		expect(problems).toEqual([]);
	});
});

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const left = a as Readonly<Record<string, unknown>>;
	const right = b as Readonly<Record<string, unknown>>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (!deepEqual(left[key], right[key])) return false;
	}
	return true;
}
