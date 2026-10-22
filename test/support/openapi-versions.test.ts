import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, NodeHost } from "@typespec/compiler";
import { describe, expect, it } from "vitest";
import { compileFixture, refuseErrors, servicesOfProgram } from "./compile-fixture.js";
import { corpusScenarios } from "./corpus.js";
import { PUBLISHED_AT_31 } from "./openapi-versions.js";

/**
 * **Every row of `PUBLISHED_AT_31` is needed: compiled at openapi3's default, the fixture is
 * refused**, as `unpublishable-null` names the shape its row states. A row left behind once its
 * shape went would compile that fixture at 3.1 for no reason, and the default every consumer gets
 * would go ungraded there.
 */

const testRoot = fileURLToPath(new URL("..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const REFUSED = "typespec-http-zod/unpublishable-null";

describe("each fixture published at OpenAPI 3.1", () => {
	it.each(Object.keys(PUBLISHED_AT_31).filter((key) => !key.startsWith("corpus:")))(
		"%s is refused at 3.0",
		async (key) => {
			const name = key.slice(key.lastIndexOf("/") + 1);
			await expect(
				compileFixture(join(testRoot, key, ".."), name, {
					outDir: join(here, ".out", "at-30", key.replaceAll("/", "__")),
					openApiVersions: ["3.0.0"],
					expectedErrors: [REFUSED],
				}),
			).resolves.toBeDefined();
		},
	);

	it.each(Object.keys(PUBLISHED_AT_31).filter((key) => key.startsWith("corpus:")))(
		"%s is refused at 3.0",
		async (key) => {
			const scenario = corpusScenarios().find(({ name }) => `corpus:${name}` === key);
			if (scenario === undefined) throw new Error(`the corpus declares no ${key}`);
			const program = await compile(NodeHost, scenario.main, { noEmit: true });
			const outDir = join(here, ".out", "at-30", key.replace(":", "__"));
			await servicesOfProgram(program, outDir);
			rmSync(outDir, { recursive: true, force: true });
			expect(() => {
				refuseErrors(program, key, [REFUSED]);
			}).not.toThrow();
		},
	);
});
