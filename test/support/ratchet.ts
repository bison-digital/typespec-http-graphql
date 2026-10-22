import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * **A baseline an oracle's counts are held to, which moves in one direction unless someone says why.**
 *
 * A snapshot file is the wrong shape for an oracle's record: vitest writes it when it is missing and
 * rewrites it under `-u`, so a run that measured less than the last one can become the new truth by
 * accident. A ratchet keeps two kinds of number:
 *
 * - **floors**: what an oracle COMPARED (scenarios, fields, entries). A measurement below its floor
 *   is a regression.
 * - **ceilings**: what an oracle SKIPPED or DROPPED, by reason. A measurement above its ceiling is a
 *   regression.
 *
 * Either one moving the good way is reported too, as stale, so the file always states what the
 * last run measured and a later fall cannot hide inside a loose floor. A key that appears or goes
 * is reported the same way.
 *
 * **Writing it.** `UPDATE_ORACLE_BASELINE=1` writes the measurement when every change tightens it
 * (floors up, ceilings down, new keys). A change that loosens it (a floor down, a ceiling up, a key
 * gone) is written only with `BASELINE_REASON=<why>`, which is appended to `loosened` beside each
 * change, so every loosening carries its reason in the file a reviewer reads. A missing baseline is a
 * failure, never an invitation: the first one is written with `UPDATE_ORACLE_BASELINE=1` as well.
 */

export interface Measured {
	readonly floors: Readonly<Record<string, number>>;
	readonly ceilings: Readonly<Record<string, number>>;
}

export interface Baseline extends Measured {
	/** What the oracle compares and against what: read by whoever opens the file. */
	readonly note: string;
	readonly loosened: readonly { readonly reason: string; readonly change: string }[];
}

export interface RatchetResult {
	/** Every way the measurement differs from the baseline. Empty is the only passing result. */
	readonly problems: readonly string[];
	/** Set when `UPDATE_ORACLE_BASELINE=1` wrote the file. */
	readonly wrote: boolean;
}

interface Change {
	readonly text: string;
	readonly loosens: boolean;
}

function changesOf(baseline: Measured, measured: Measured): Change[] {
	const changes: Change[] = [];
	for (const kind of ["floors", "ceilings"] as const) {
		const before = baseline[kind];
		const after = measured[kind];
		const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
		for (const key of keys) {
			const was = before[key];
			const now = after[key];
			if (was === now) continue;
			/**
			 * A key that appears or goes is a count that moved from or to nothing. A new FLOOR compares
			 * something more, and a gone one compares something no longer; a new CEILING is a skip or a
			 * warning that did not exist (a rise from zero) and a gone one fell to zero.
			 */
			if (was === undefined) {
				changes.push({
					text: `${kind} ${key}: new, measured ${String(now)}`,
					loosens: kind === "ceilings",
				});
			} else if (now === undefined) {
				changes.push({
					text: `${kind} ${key}: gone, was ${String(was)}`,
					loosens: kind === "floors",
				});
			} else {
				const rose = now > was;
				const loosens = kind === "floors" ? !rose : rose;
				const verdict = loosens ? "regressed" : "stale, tighten it";
				changes.push({
					text: `${kind} ${key}: ${verdict}, baseline ${String(was)}, measured ${String(now)}`,
					loosens,
				});
			}
		}
	}
	return changes;
}

const sorted = (record: Readonly<Record<string, number>>): Record<string, number> =>
	Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Hold `measured` to the baseline at `file`.
 *
 * `env` defaults to `process.env`; the tests of this module pass their own so they never write a
 * real baseline.
 */
export function ratchet(
	file: string,
	note: string,
	measured: Measured,
	env: Readonly<Record<string, string | undefined>> = process.env,
): RatchetResult {
	const update = env["UPDATE_ORACLE_BASELINE"] === "1";
	const reason = env["BASELINE_REASON"];
	const write = (loosened: Baseline["loosened"]): void => {
		const baseline: Baseline = {
			note,
			floors: sorted(measured.floors),
			ceilings: sorted(measured.ceilings),
			loosened,
		};
		writeFileSync(file, `${JSON.stringify(baseline, null, "\t")}\n`);
	};

	if (!existsSync(file)) {
		if (!update) {
			return {
				problems: [`no baseline at ${file}: write the first with UPDATE_ORACLE_BASELINE=1`],
				wrote: false,
			};
		}
		write([]);
		return { problems: [], wrote: true };
	}

	const baseline = JSON.parse(readFileSync(file, "utf8")) as Baseline;
	const changes = changesOf(baseline, measured);
	if (changes.length === 0) return { problems: [], wrote: false };
	if (!update) return { problems: changes.map((change) => change.text), wrote: false };

	const loosening = changes.filter((change) => change.loosens);
	if (loosening.length > 0 && (reason === undefined || reason.trim() === "")) {
		return {
			problems: [
				"UPDATE_ORACLE_BASELINE=1 refuses to loosen a baseline without BASELINE_REASON:",
				...loosening.map((change) => change.text),
			],
			wrote: false,
		};
	}
	write([
		...baseline.loosened,
		...loosening.map((change) => ({ reason: reason ?? "", change: change.text })),
	]);
	return { problems: [], wrote: true };
}
