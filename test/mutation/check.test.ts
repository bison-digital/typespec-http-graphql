import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ratchet } from "../support/ratchet.js";

/**
 * **Every mutant of the modules `stryker.config.mjs` mutates is killed, or survives for a reason
 * someone wrote down.** `pnpm test:mutation` runs Stryker, then this check over the report it wrote.
 *
 * - **The report is of these sources.** Each mutated file's text in the report is the file on disk,
 *   so a check never grades an older run.
 * - **A verdict the runner decided is refused.** A survivor that ran no test, or fewer than cover it,
 *   was never opposed by the tests: the vitest runner reported exactly that while its name filter
 *   matched nothing (stryker-js #6210) and while a test file that failed to load counted as passing
 *   (#6150). A kill whose reason is a file-system error is the sandbox racing itself, not a test. A
 *   timeout counts only when the mutant's hit limit stopped a loop: any other is the clock deciding,
 *   and a static mutant no test notices runs every suite, fixture compiles included, until it does.
 * - **Every survivor and every uncovered mutant is in `equivalents.json`**, keyed by file, mutator,
 *   the source text it replaced, its replacement and the text of the line it starts on (never the
 *   line's number), with the reason no test can tell it from the original. The line tells apart
 *   two sites of one mutant, so a reason written for one cannot pass for the other. An entry no
 *   mutant matches is stale, and fails too.
 * - **The counts are held by the ratchet** (`baseline.json`): detected mutants only rise, survivors
 *   only fall, and a loosening carries its reason.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = join(here, "..", "..");
const REPORT = join(here, ".out", "mutation.json");

interface Position {
	readonly line: number;
	readonly column: number;
}

interface Mutant {
	readonly id: string;
	readonly mutatorName: string;
	readonly replacement: string;
	readonly status: string;
	readonly static?: boolean;
	readonly location: { readonly start: Position; readonly end: Position };
	readonly coveredBy?: readonly string[];
	readonly testsCompleted?: number;
	readonly statusReason?: string;
}

interface Report {
	readonly files: Readonly<
		Record<string, { readonly source: string; readonly mutants: readonly Mutant[] }>
	>;
}

interface Equivalent {
	readonly file: string;
	readonly mutator: string;
	readonly original: string;
	readonly replacement: string;
	/** The source line the mutant starts on, trimmed. */
	readonly line: string;
	readonly reason: string;
}

/** The statuses Stryker counts as detected: a test failed, the run hung, or the code would not load. */
const DETECTED = new Set(["Killed", "Timeout", "RuntimeError"]);
/** The statuses that need a written reason. */
const UNOPPOSED = new Set(["Survived", "NoCoverage"]);

/** The source text a mutant replaced: 1-based lines and columns, end exclusive. */
function originalOf(source: string, { start, end }: Mutant["location"]): string {
	const lines = source.split("\n");
	if (start.line === end.line) {
		return (lines[start.line - 1] ?? "").slice(start.column - 1, end.column - 1);
	}
	return [
		(lines[start.line - 1] ?? "").slice(start.column - 1),
		...lines.slice(start.line, end.line - 1),
		(lines[end.line - 1] ?? "").slice(0, end.column - 1),
	].join("\n");
}

/** The trimmed text of the line a mutant starts on. */
const lineOf = (source: string, { start }: Mutant["location"]): string =>
	(source.split("\n")[start.line - 1] ?? "").trim();

const keyOf = (entry: Omit<Equivalent, "reason">): string =>
	JSON.stringify([entry.file, entry.mutator, entry.original, entry.replacement, entry.line]);

const where = (file: string, mutant: Mutant): string =>
	`${file}:${String(mutant.location.start.line)}:${String(mutant.location.start.column)} ${mutant.mutatorName} -> ${mutant.replacement}`;

function loadReport(): Report {
	if (!existsSync(REPORT)) {
		throw new Error(`no ${REPORT}: run \`pnpm test:mutation\`, which runs Stryker first`);
	}
	return JSON.parse(readFileSync(REPORT, "utf8")) as Report;
}

const report = existsSync(REPORT) ? loadReport() : undefined;
const files = Object.entries(report?.files ?? {});
/** The modules the config mutates, read from it rather than restated. */
const { default: strykerConfig } = (await import(
	pathToFileURL(join(packageRoot, "stryker.config.mjs")).href
)) as { readonly default: { readonly mutate: readonly string[] } };
const mutated = strykerConfig.mutate;

describe("the mutation report", () => {
	it("exists, and is of every module the config mutates, as each reads on disk now", () => {
		const loaded = loadReport();
		expect(Object.keys(loaded.files).toSorted()).toEqual([...mutated].toSorted());
		for (const [file, { source }] of Object.entries(loaded.files)) {
			expect(source, `${file} changed since the run`).toBe(
				readFileSync(join(packageRoot, file), "utf8"),
			);
		}
	});

	it("has no survivor the runner decided: each ran every test that covers it", () => {
		const undecided = files.flatMap(([file, { mutants }]) =>
			mutants
				.filter((mutant) => mutant.status === "Survived")
				.filter(
					(mutant) =>
						(mutant.testsCompleted ?? 0) === 0 ||
						(mutant.static !== true &&
							(mutant.testsCompleted ?? 0) < (mutant.coveredBy?.length ?? 0)),
				)
				.map(
					(mutant) =>
						`${where(file, mutant)}: ran ${String(mutant.testsCompleted ?? 0)} of ${String(mutant.coveredBy?.length ?? 0)}`,
				),
		);
		expect(undecided).toEqual([]);
	});

	it("has no kill the file system decided", () => {
		const raced = files.flatMap(([file, { mutants }]) =>
			mutants
				.filter((mutant) => DETECTED.has(mutant.status))
				.filter((mutant) =>
					/\b(?:ENOENT|EEXIST|ENOTEMPTY|EBUSY|EPERM)\b/.test(mutant.statusReason ?? ""),
				)
				.map((mutant) => `${where(file, mutant)}: ${mutant.statusReason ?? ""}`),
		);
		expect(raced).toEqual([]);
	});

	it("has no timeout the clock decided: each is a loop its hit limit stopped", () => {
		const slow = files.flatMap(([file, { mutants }]) =>
			mutants
				.filter((mutant) => mutant.status === "Timeout")
				.filter((mutant) => !/^Hit limit reached\b/.test(mutant.statusReason ?? ""))
				.map((mutant) => `${where(file, mutant)}: ${mutant.statusReason ?? "no reason"}`),
		);
		expect(slow).toEqual([]);
	});
});

describe("every survivor", () => {
	const listed = JSON.parse(readFileSync(join(here, "equivalents.json"), "utf8")) as {
		readonly equivalents: readonly Equivalent[];
	};

	it("is in equivalents.json with its reason, and every entry there is a survivor", () => {
		const remaining = new Map<string, number>();
		for (const entry of listed.equivalents) {
			expect(entry.reason.trim(), keyOf(entry)).not.toBe("");
			remaining.set(keyOf(entry), (remaining.get(keyOf(entry)) ?? 0) + 1);
		}
		const unexplained: string[] = [];
		for (const [file, { source, mutants }] of files) {
			for (const mutant of mutants.filter(({ status }) => UNOPPOSED.has(status))) {
				const key = keyOf({
					file,
					mutator: mutant.mutatorName,
					original: originalOf(source, mutant.location),
					replacement: mutant.replacement,
					line: lineOf(source, mutant.location),
				});
				const left = remaining.get(key) ?? 0;
				if (left === 0) unexplained.push(`${mutant.status} ${where(file, mutant)}`);
				else remaining.set(key, left - 1);
			}
		}
		const stale = [...remaining].filter(([, left]) => left > 0).map(([key]) => `stale: ${key}`);
		expect([...unexplained, ...stale]).toEqual([]);
	});
});

describe("the counts", () => {
	it("hold to the baseline", () => {
		const floors: Record<string, number> = {};
		const ceilings: Record<string, number> = {};
		for (const [file, { mutants }] of files) {
			const count = (statuses: ReadonlySet<string>): number =>
				mutants.filter(({ status }) => statuses.has(status)).length;
			floors[`detected:${file}`] = count(DETECTED);
			ceilings[`survived:${file}`] = count(new Set(["Survived"]));
			ceilings[`no-coverage:${file}`] = count(new Set(["NoCoverage"]));
			ceilings[`timeout:${file}`] = count(new Set(["Timeout"]));
			ceilings[`runtime-error:${file}`] = count(new Set(["RuntimeError"]));
		}
		const { problems } = ratchet(
			join(here, "baseline.json"),
			"Mutation testing: Stryker over the modules stryker.config.mjs mutates, run by the suites " +
				"vitest.mutation.config.ts names. Floors: mutants detected (killed, timed out, or failing " +
				"to load), per file. Ceilings: per file, survivors and uncovered mutants, each with its " +
				"reason in equivalents.json, and timeouts and load failures. Held by test/support/ratchet.ts.",
			{ floors, ceilings },
		);
		expect(problems).toEqual([]);
	});
});
