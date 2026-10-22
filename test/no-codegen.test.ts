import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * **No code-generation library anywhere this package's dependency tree reaches.**
 *
 * design.md: no Alloy, no emitter framework, no mutator framework, no graphql-codegen, and no
 * TypeSpec library that loads one, which is why `@typespec/graphql` is here too: it loads Alloy even
 * for its decorators. The emitter writes its output as source text, and a dependency on one of these
 * would be the first step away from that, so the tree itself is checked, not the manifest alone: a
 * library can arrive transitively.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN: readonly RegExp[] = [
	/^@alloy-js\//,
	/^@typespec\/emitter-framework$/,
	/^@typespec\/mutator-framework$/,
	/^@typespec\/graphql$/,
	/^@graphql-codegen\//,
];

/** A node of `pnpm list --json`. */
interface Listed {
	readonly dependencies?: Readonly<Record<string, Listed>>;
	readonly devDependencies?: Readonly<Record<string, Listed>>;
	readonly optionalDependencies?: Readonly<Record<string, Listed>>;
}

function namesIn(nodes: readonly Listed[], found: Set<string> = new Set()): Set<string> {
	for (const node of nodes) {
		for (const group of [node.dependencies, node.devDependencies, node.optionalDependencies]) {
			for (const [name, child] of Object.entries(group ?? {})) {
				found.add(name);
				namesIn([child], found);
			}
		}
	}
	return found;
}

const forbiddenIn = (names: Iterable<string>): string[] =>
	[...names].filter((name) => FORBIDDEN.some((pattern) => pattern.test(name))).toSorted();

function listed(...flags: readonly string[]): Listed[] {
	return JSON.parse(
		execFileSync("pnpm", ["list", ...flags, "--depth", "Infinity", "--json"], {
			cwd: packageRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 256 * 1024 * 1024,
		}),
	) as Listed[];
}

let production = new Set<string>();
let everything = new Set<string>();

beforeAll(() => {
	production = namesIn(listed("--prod"));
	everything = namesIn(listed());
}, 120_000);

describe("the dependency tree carries no code-generation library", () => {
	it("lists the tree a consumer installs, and it is not empty", () => {
		expect(production).toContain("typespec-http-zod");
		expect(production).toContain("change-case");
	});

	it("finds none in the production tree", () => {
		expect(forbiddenIn(production)).toEqual([]);
	});

	it("finds none in the whole tree, development included", () => {
		expect(forbiddenIn(everything)).toEqual([]);
		// Non-vacuity: the development tree is the larger one, and it was read.
		expect(everything.size).toBeGreaterThan(production.size);
		expect(everything).toContain("graphql-yoga");
		expect(everything).toContain("typespec-hono");
	});

	it("names none in the manifest, in any section", () => {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
			string,
			Readonly<Record<string, string>> | undefined
		>;
		const named = [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"optionalDependencies",
		].flatMap((section) => Object.keys(manifest[section] ?? {}));
		expect(forbiddenIn(named)).toEqual([]);
	});

	/** **The control, without which the arms above prove nothing.** */
	it("sees one wherever it sits: in a copy of the real tree, and nested deep", () => {
		expect(forbiddenIn([...production, "@alloy-js/core"])).toEqual(["@alloy-js/core"]);
		const planted: Listed[] = [
			{
				dependencies: { "typespec-http-zod": { dependencies: { "@alloy-js/core": {} } } },
				devDependencies: {
					"@typespec/emitter-framework": {},
					wrangler: { optionalDependencies: { "@typespec/mutator-framework": {} } },
				},
			},
			{ dependencies: { "@typespec/graphql": {}, "@graphql-codegen/cli": {} } },
		];
		expect(forbiddenIn(namesIn(planted))).toEqual([
			"@alloy-js/core",
			"@graphql-codegen/cli",
			"@typespec/emitter-framework",
			"@typespec/graphql",
			"@typespec/mutator-framework",
		]);
	});
});
