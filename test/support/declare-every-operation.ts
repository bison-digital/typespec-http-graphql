import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, NodeHost, type Operation } from "@typespec/compiler";
import { getAllHttpServices } from "@typespec/http";
import { resolveOperationId } from "@typespec/openapi";
import { applyFieldNamePipeline } from "../names/upstream-naming.js";

/**
 * **A `graphql.tsp` for a spec that has none: every operation of every service, declared.**
 *
 * This emitter emits only what `graphql.tsp` declares, and the `@typespec/http-specs` corpus has no
 * `graphql.tsp`, so compiled as it stands the corpus would emit nothing and grade nothing. Declaring
 * every operation is the WORST case the emitter can be handed: every request shape, response shape,
 * encoding and name the corpus has reaches it at once.
 *
 * **Why a test may synthesise declarations when the emitter must never infer them.** design.md
 * rejects projecting a surface from HTTP verbs because the result is a poor GraphQL API for a
 * client. That is a judgement about what to SERVE. Here nothing is served: the rule below is how a
 * test reaches every operation, and the rule is nowhere in the emitter. Safe methods become query
 * fields and the rest mutation fields only so that `query-not-safe` stays out of the way; a field is
 * named from the operation id, deduplicated with a counter, only so that `graphql-name-collision`
 * stays out of the way. Every other check runs as it would for a person's file.
 *
 * **Named by upstream's pipeline, the vendored oracle, never by this package's `names.ts`.** A
 * root field is named verbatim from `graphql.tsp`, so these names are the expected side of every
 * suite that grades which fields a scenario serves; computing them with the code under test would
 * make that grading circular.
 *
 * **References are spelled to resolve whatever the scenario declares.** Every segment is backticked,
 * because the corpus names operations `as`, `and` and `yield`; `global.` comes first, because the
 * versioning scenarios declare a namespace `Versioning` beside `TypeSpec.Versioning`. Both measured:
 * 66 scenarios, 803 operations, every reference recorded.
 */

/** IANA's safe methods that reach a GraphQL field at all. `HEAD` is dropped as `head-operation`. */
const SAFE = new Set(["get", "head"]);

export interface DeclaredSurface {
	/** The generated `graphql.tsp`: the entry point to compile. */
	readonly entry: string;
	/** Root declarations written, one per operation of every service. */
	readonly declared: number;
	/** Each declared field name, to the operation id it was named from. */
	readonly fields: ReadonlyMap<string, string>;
}

function referenceOf(operation: Operation): string {
	const segments = [operation.name];
	if (operation.interface !== undefined) segments.unshift(operation.interface.name);
	for (
		let namespace = operation.interface?.namespace ?? operation.namespace;
		namespace !== undefined && namespace.name !== "";
		namespace = namespace.namespace
	) {
		segments.unshift(namespace.name);
	}
	for (const segment of segments) {
		if (segment.includes("`")) throw new Error(`cannot reference ${segments.join(".")}`);
	}
	return ["global", ...segments.map((segment) => `\`${segment}\``)].join(".");
}

/** Write `<dir>/graphql.tsp` declaring every operation `main` serves, and say what it declared. */
export async function declareEveryOperation(main: string, dir: string): Promise<DeclaredSurface> {
	const program = await compile(NodeHost, main, { noEmit: true });
	const [services] = getAllHttpServices(program);
	const taken = new Set<string>();
	const fields = new Map<string, string>();
	const lines: string[] = [];
	for (const service of services) {
		for (const operation of service.operations) {
			const operationId = resolveOperationId(program, operation.operation);
			const base = applyFieldNamePipeline(operationId);
			let name = base;
			for (let count = 2; taken.has(name); count += 1) name = `${base}${count}`;
			taken.add(name);
			fields.set(name, operationId);
			const kind = SAFE.has(operation.verb) ? "queryField" : "mutationField";
			lines.push(`@@${kind}(${referenceOf(operation.operation)}, ${JSON.stringify(name)});`);
		}
	}
	mkdirSync(dir, { recursive: true });
	const entry = join(dir, "graphql.tsp");
	writeFileSync(
		entry,
		[
			"// Written by test/support/declare-every-operation.ts: every operation, declared.",
			`import "typespec-http-graphql";`,
			`import ${JSON.stringify(main)};`,
			"",
			"using HttpGraphQL;",
			"",
			...lines,
			"",
		].join("\n"),
	);
	return { entry, declared: lines.length, fields };
}
