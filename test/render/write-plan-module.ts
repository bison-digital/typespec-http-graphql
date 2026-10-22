import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderOperations } from "../../src/handlers.js";
import type { SchemaPlan } from "../../src/model.js";
import { renderSchemaModule } from "../../src/render.js";
import { CONSUMER, DECLARED, PLAN, SCHEMAS_STUB } from "./plan-fixture.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const RUNTIME_SOURCE = fileURLToPath(new URL("../../src/runtime.ts", import.meta.url));

/**
 * Writes `graphql.gen.ts` rendered from a plan into a directory of its own, beside the hand-written
 * `schemas.gen.ts` stub and the runtime copied as the emitter copies it, plus (for the fixture plan)
 * a consumer's file: the arrangement a consumer has.
 *
 * **Each caller passes its own `outName`**: vitest runs test files in parallel, and two files
 * writing one directory would grade each other's output. The directory is emptied first, so an
 * assertion cannot be answered by a previous run.
 */
export function writePlanModule(
	outName: string,
	options: {
		readonly sealed: boolean;
		readonly plan?: SchemaPlan;
		readonly declared?: readonly string[];
	},
): string {
	const plan = options.plan ?? PLAN;
	const outDir = join(here, ".out", outName);
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "schemas.gen.ts"), SCHEMAS_STUB);
	writeFileSync(join(outDir, "graphql-runtime.gen.ts"), readFileSync(RUNTIME_SOURCE, "utf8"));
	writeFileSync(
		join(outDir, "graphql.gen.ts"),
		`${renderSchemaModule(plan, { sealed: options.sealed, hint: undefined })}\n${renderOperations(
			plan.operations,
			options.declared ?? DECLARED,
		)}`,
	);
	if (options.plan === undefined) writeFileSync(join(outDir, "consumer.ts"), CONSUMER);
	return outDir;
}
