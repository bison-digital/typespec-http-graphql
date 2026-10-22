import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "./support/compile-fixture.js";
import { workingTreeFiles } from "./support/working-tree.js";

/**
 * **That the package ships what it needs and nothing else, and declares what it and its output
 * import.**
 *
 * A dependency that resolves here because a sibling installed it, or an emitted import naming a
 * package the consumer was never told to add, both work until the first person installs this from
 * the registry. And a tarball is judged by what `pnpm pack` puts in it, not by what `files` appears
 * to say: pnpm 11 can pack `dist/test/**` under a `files` list that appears to leave it out.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	files: string[];
	license?: string;
};

/** `@scope/name/sub` -> `@scope/name`; `pkg/sub` -> `pkg`. Relative paths and builtins are not packages. */
function packageOf(specifier: string): string | undefined {
	if (specifier.startsWith(".") || specifier.startsWith("node:")) return undefined;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function importsIn(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
		const name = packageOf(match[1] ?? "");
		if (name !== undefined) found.add(name);
	}
	return [...found];
}

/** What `pnpm pack` would put in the tarball, by path. */
function packed(): string[] {
	const output = execFileSync("pnpm", ["pack", "--dry-run", "--json"], {
		cwd: packageRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return (JSON.parse(output) as { files: { path: string }[] }).files
		.map((file) => file.path)
		.toSorted();
}

const declared = new Set([
	...Object.keys(manifest.dependencies ?? {}),
	...Object.keys(manifest.peerDependencies ?? {}),
]);

const emittedDir = join(packageRoot, "test", ".out-packaging");
let emitted: string[] = [];

beforeAll(async () => {
	await compileFixture(join(packageRoot, "test", "acceptance"), "main", { outDir: emittedDir });
	emitted = readdirSync(emittedDir)
		.filter((name) => name.endsWith(".gen.ts"))
		.map((name) => join(emittedDir, name));
}, 300_000);

describe("the tarball holds the emitter, its TypeSpec library and the runtime source, and nothing else", () => {
	it("ships every file a consumer needs", () => {
		const files = packed();
		for (const required of [
			"dist/src/index.js",
			"dist/src/index.d.ts",
			"dist/src/tsp-index.js",
			"dist/src/runtime.js",
			"lib/main.tsp",
			"lib/decorators.tsp",
			"src/runtime.ts",
			"README.md",
			"LICENSE",
			"package.json",
		]) {
			expect(files, required).toContain(required);
		}
		// Every module of src/, built and declared.
		expect(files.filter((path) => path.startsWith("dist/src/")).length).toBeGreaterThanOrEqual(30);
	});

	it("ships nothing but those", () => {
		const allowed = (path: string): boolean =>
			["package.json", "README.md", "LICENSE", "CHANGELOG.md"].includes(path) ||
			path.startsWith("dist/src/") ||
			/^lib\/[^/]+\.tsp$/.test(path) ||
			path === "src/runtime.ts";
		expect(packed().filter((path) => !allowed(path))).toEqual([]);
	});

	/** **The plant, kept.** A build that leaves test output in `dist/` must still not ship it. */
	it("ships no test material, even when a build leaves some in dist/", () => {
		const planted = join(packageRoot, "dist", "test", "planted.test.js");
		mkdirSync(join(packageRoot, "dist", "test"), { recursive: true });
		writeFileSync(planted, "export {};\n");
		try {
			expect(packed().filter((path) => path.startsWith("dist/test/"))).toEqual([]);
		} finally {
			rmSync(join(packageRoot, "dist", "test"), { recursive: true, force: true });
		}
	});
});

describe("the package declares what it and its output import", () => {
	const sources = workingTreeFiles(packageRoot, "src").filter((name) => name.endsWith(".ts"));

	it("has source to inspect at all", () => {
		expect(sources.length).toBeGreaterThanOrEqual(15);
	});

	it("declares every package src/ imports", () => {
		const undeclared = sources
			.flatMap((name) => importsIn(readFileSync(join(packageRoot, name), "utf8")))
			.filter((name) => !declared.has(name));
		expect([...new Set(undeclared)]).toEqual([]);
	});

	it("declares every package the emitted output imports, and the output imports no build tool", () => {
		expect(emitted.length).toBeGreaterThanOrEqual(3);
		const imported = [...new Set(emitted.flatMap((file) => importsIn(readFileSync(file, "utf8"))))];
		expect(imported.filter((name) => !declared.has(name))).toEqual([]);
		expect(imported.toSorted()).toEqual(["graphql", "zod"]);
	});

	/**
	 * **graphql is a PEER, never a dependency.** Two copies of graphql-js in one graph refuse each
	 * other's schemas ("from another module or realm"), which this package's own suite met; the
	 * consumer's server and this package's output must share the consumer's one copy.
	 */
	it("declares graphql and zod as peers and not as dependencies", () => {
		for (const name of ["graphql", "zod"]) {
			expect(Object.keys(manifest.peerDependencies ?? {})).toContain(name);
			expect(Object.keys(manifest.dependencies ?? {})).not.toContain(name);
		}
	});

	it("depends on the library by a real semver range, never by path", () => {
		for (const map of [manifest.dependencies ?? {}, manifest.peerDependencies ?? {}]) {
			for (const [name, range] of Object.entries(map)) {
				expect(`${name}: ${range}`).not.toMatch(/\b(?:file|link|portal):/);
			}
		}
		expect(manifest.dependencies?.["typespec-http-zod"]).toMatch(/^\^\d+\.\d+\.\d+$/);
	});

	/** Nothing it emits imports it, which is what lets a consumer install it for the build alone. */
	it("tells a user to install it as a devDependency, and that is true of what it emits", () => {
		expect(readFileSync(join(packageRoot, "README.md"), "utf8")).toContain("devDependency");
		const self = emitted
			.flatMap((file) => importsIn(readFileSync(file, "utf8")))
			.filter((name) => name === "typespec-http-graphql" || name === "typespec-http-zod");
		expect(self).toEqual([]);
	});
});

describe("the manifest is exported", () => {
	/**
	 * A tool that finds a package's root or version through its `package.json`, such as a check that
	 * two emitters resolve one copy of the library, resolves it by name. Asked of Node itself, through
	 * the package's own self-reference, so the `exports` map is the one a consumer's Node reads.
	 */
	it("resolves typespec-http-graphql/package.json by name, as Node reads the exports map", () => {
		const resolved = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				'console.log(import.meta.resolve("typespec-http-graphql/package.json"))',
			],
			{ cwd: packageRoot, encoding: "utf8" },
		).trim();
		const found = JSON.parse(readFileSync(fileURLToPath(resolved), "utf8")) as { version: string };
		expect(found.version).toBe(
			(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string })
				.version,
		);
	});
});

describe("the package carries its licence", () => {
	it("declares MIT and ships the licence text", () => {
		expect(manifest.license).toBe("MIT");
		expect(existsSync(join(packageRoot, "LICENSE"))).toBe(true);
	});
});
