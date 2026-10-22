import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "./support/compile-fixture.js";

/**
 * **Nothing deprecated: no deprecated package in the tree, and no deprecated API in this package's
 * source, its tests, or the code it emits.**
 *
 * Two gates, each graded for its ability to fail:
 *
 * - **Packages.** pnpm records a package's registry deprecation in the lockfile as it resolves it
 *   (`deprecated: <message>` under the package's entry; measured with `lodash.get@4.4.2`). The
 *   lockfile is the whole tree, production and development, so one read covers what a manifest
 *   check would miss: a deprecated package arriving transitively.
 * - **APIs.** `typescript/no-deprecated`, the type-aware rule `oxlint-tsgolint` runs, reports every
 *   reference to a declaration its library marks `@deprecated`, which is how graphql-js 17 marks
 *   `serialize`, `parseValue`, `parseLiteral`, `defaultValue` and `findBreakingChanges`. It runs over
 *   `src/` and `test/`, and over emitted output, which no tsconfig of this package reaches.
 *
 * The lint script runs the same rule as an error, so `pnpm lint` refuses a deprecated reference
 * before this suite is ever reached; this suite is what proves the rule still sees one.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const oxlint = join(packageRoot, "node_modules", ".bin", "oxlint");
const outRoot = join(packageRoot, "test", ".out-no-deprecated");

/** Every package key a pnpm lockfile lists under `packages:`, with its `deprecated:` message if any. */
function packagesIn(lockfile: string): Map<string, string | undefined> {
	const found = new Map<string, string | undefined>();
	let section = "";
	let current: string | undefined;
	for (const line of lockfile.split("\n")) {
		const top = /^(\S[^:]*):\s*$/.exec(line);
		if (top !== null) {
			section = top[1] ?? "";
			current = undefined;
			continue;
		}
		if (section !== "packages") continue;
		const key = /^ {2}(\S.*):\s*$/.exec(line);
		if (key !== null) {
			current = (key[1] ?? "").replace(/^'|'$/g, "");
			found.set(current, undefined);
			continue;
		}
		const deprecated = /^ {4}deprecated:\s*(.*)$/.exec(line);
		if (deprecated !== null && current !== undefined) found.set(current, deprecated[1] ?? "");
	}
	return found;
}

const deprecatedIn = (packages: ReadonlyMap<string, string | undefined>): string[] =>
	[...packages].filter(([, message]) => message !== undefined).map(([key]) => key);

/** One finding of oxlint's JSON report. */
interface Finding {
	readonly code: string;
	readonly message: string;
	readonly filename: string;
}

/**
 * `typescript/no-deprecated` alone, as an error, over `paths`: the findings of oxlint's JSON report.
 *
 * **Emitted files are named one by one.** oxlint's walker skips hidden directories, and every emitted
 * directory here is one (`.out-*`): handed the directory, it answers "No files found to lint" and
 * exits 1 having checked nothing (measured). A file named on the command line is always linted.
 *
 * **The report, not the text.** oxlint's text output varies with the environment it detects: a
 * clean run prints a "Found 0 warnings and 0 errors" summary in one and nothing in another, so a
 * gate that expected no output passed locally and failed in GitHub Actions (measured). The
 * JSON report lists the same findings wherever it runs.
 */
function gate(paths: readonly string[], cwd: string): { findings: Finding[]; failed: boolean } {
	let report: string;
	let failed = false;
	try {
		report = execFileSync(
			oxlint,
			["--type-aware", "-A", "all", "-D", "typescript/no-deprecated", "--format", "json", ...paths],
			{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
		);
	} catch (error) {
		const asExec = error as { stdout?: string; stderr?: string };
		report = asExec.stdout ?? "";
		failed = true;
		if (!report.trimStart().startsWith("{")) {
			throw new Error(`oxlint wrote no report: ${report}${asExec.stderr ?? ""}`);
		}
	}
	const { diagnostics } = JSON.parse(report) as { diagnostics: Finding[] };
	return {
		findings: diagnostics.map(({ code, message, filename }) => ({ code, message, filename })),
		failed,
	};
}

/** A directory the type-aware rule can check on its own: its `.ts` files and a `tsconfig.json`. */
function lintable(dir: string): void {
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "es2023",
				module: "nodenext",
				moduleResolution: "nodenext",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
				types: [],
			},
			include: ["./*.ts"],
		}),
	);
}

describe("no deprecated package", () => {
	const lockfile = readFileSync(join(packageRoot, "pnpm-lock.yaml"), "utf8");
	const packages = packagesIn(lockfile);

	it("reads the whole tree from the lockfile", () => {
		expect(packages.size).toBeGreaterThan(300);
		expect(packages.has("graphql@17.0.2")).toBe(true);
		expect(
			packages.has("zod@4.6.2") || [...packages.keys()].some((key) => key.startsWith("zod@")),
		).toBe(true);
	});

	it("finds none deprecated", () => {
		expect(deprecatedIn(packages)).toEqual([]);
	});

	it("can fail: a lockfile carrying a deprecated package, in pnpm's own format, is refused", () => {
		// The entry pnpm 11 wrote for `lodash.get@4.4.2`, copied from a lockfile it resolved.
		const planted = lockfile.replace(
			/^packages:\n\n/m,
			[
				"packages:",
				"",
				"  lodash.get@4.4.2:",
				"    resolution: {integrity: sha512-z+Uw/vLuy6gQe8cfaFWD7p0wVv8fJl3mbzXh33RS+0oW2wvUqiRXiQ69gLWSLpgB5/6sU+r6BlQR0MBILadqTQ==}",
				"    deprecated: This package is deprecated. Use the optional chaining (?.) operator instead.",
				"",
				"",
			].join("\n"),
		);
		expect(planted).not.toBe(lockfile);
		expect(deprecatedIn(packagesIn(planted))).toEqual(["lodash.get@4.4.2"]);
	});
});

describe("no deprecated API", () => {
	let emitted = "";

	beforeAll(async () => {
		rmSync(outRoot, { recursive: true, force: true });
		const compiled = await compileFixture(join(packageRoot, "test", "acceptance"), "main", {
			outDir: join(outRoot, "emitted"),
		});
		emitted = compiled.outDir;
		lintable(emitted);
	}, 300_000);

	it("finds none in src/ and test/", () => {
		const result = gate(["src/", "test/"], packageRoot);
		expect(result.findings).toEqual([]);
		expect(result.failed).toBe(false);
	});

	it("finds none in the emitted files and the runtime copy", () => {
		const files = readdirSync(emitted).filter((name) => name.endsWith(".ts"));
		expect(files).toEqual(
			expect.arrayContaining(["graphql.gen.ts", "graphql-runtime.gen.ts", "schemas.gen.ts"]),
		);
		const result = gate(files, emitted);
		expect(result.findings).toEqual([]);
		expect(result.failed).toBe(false);
	});

	it("can fail: graphql 17's deprecated scalar API, beside emitted output, is refused", () => {
		const planted = join(outRoot, "planted");
		mkdirSync(planted, { recursive: true });
		lintable(planted);
		writeFileSync(
			join(planted, "scalar.ts"),
			[
				'import { GraphQLScalarType } from "graphql";',
				"",
				"export const Legacy = new GraphQLScalarType({",
				'\tname: "Legacy",',
				"\tserialize: (value) => value,",
				"});",
				"",
			].join("\n"),
		);
		const result = gate(["scalar.ts"], planted);
		expect(result.failed).toBe(true);
		expect(result.findings).toEqual([
			{
				code: "typescript(no-deprecated)",
				message: expect.stringContaining("`serialize` is deprecated"),
				filename: "scalar.ts",
			},
		]);
	});
});
