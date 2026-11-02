import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GraphQLSchema, isInterfaceType } from "graphql";
import { describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";

/**
 * **The runtime schema repeats an interface field's list bound** in its `extensions`, as it does an
 * object field's, so a validation rule reading the schema finds what `schema.graphql` states. Over
 * `../plan/interface-lists.tsp`, emitted; `../plan/interface-lists.test.ts` holds the plan.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

describe("an interface's list field in graphql.gen.ts", () => {
	it("repeats the bound its implementers share, and none where they differ", async () => {
		const compiled = await compileFixture(join(here, "..", "plan"), "interface-lists", {
			outDir: join(here, ".out", "interface-lists"),
		});
		const module = (await import(join(compiled.outDir, "graphql.gen.ts"))) as {
			readonly createSchema: (handlers: unknown, deps: unknown) => GraphQLSchema;
		};
		const schema = module.createSchema(() => ({}), {
			authorize: () => "allow",
			context: () => ({}),
		});
		const extensionOf = (type: string, field: string): unknown => {
			const found = schema.getType(type);
			if (!isInterfaceType(found)) throw new Error(`no interface ${type}`);
			return found.getFields()[field]?.extensions["listSize"];
		};
		expect(extensionOf("PublicationInterface", "marks")).toEqual({ assumedSize: 4 });
		expect(extensionOf("PublicationInterface", "notes")).toBeUndefined();
		expect(extensionOf("NoticeInterface", "stamps")).toBeUndefined();
		expect(extensionOf("PrizeInterface", "judges")).toEqual({ assumedSize: 5 });
	}, 300_000);
});
