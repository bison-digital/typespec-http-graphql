import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { type Baseline, ratchet } from "./ratchet.js";

/**
 * The ratchet every oracle's baseline goes through, graded on its own: each way a measurement can
 * move, and each way the file can be written, against a scratch file.
 */

const dir = fileURLToPath(new URL("../.out-ratchet/", import.meta.url));
const file = join(dir, "baseline.json");
const READ_ONLY = {};
const UPDATE = { UPDATE_ORACLE_BASELINE: "1" };

const base = { floors: { compared: 10, scenarios: 3 }, ceilings: { "skip:head": 2 } };

beforeEach(() => {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const baseline: Baseline = { note: "test", ...base, loosened: [] };
	writeFileSync(file, JSON.stringify(baseline));
});

const read = (): Baseline => JSON.parse(readFileSync(file, "utf8")) as Baseline;

describe("ratchet", () => {
	it("passes a measurement equal to its baseline", () => {
		expect(ratchet(file, "test", base, READ_ONLY)).toEqual({ problems: [], wrote: false });
	});

	it("refuses to write a ceiling that is new, a rise from zero, without BASELINE_REASON", () => {
		const { problems, wrote } = ratchet(
			file,
			"test",
			{ floors: base.floors, ceilings: { "skip:head": 2, "skip:new": 1 } },
			UPDATE,
		);
		expect(wrote).toBe(false);
		expect(problems).toContain("ceilings skip:new: new, measured 1");
	});

	it("writes a ceiling that went, a fall to zero, as a tightening", () => {
		const { wrote } = ratchet(file, "test", { floors: base.floors, ceilings: {} }, UPDATE);
		expect(wrote).toBe(true);
	});

	it("refuses a floor that fell, a ceiling that rose, and a key that went", () => {
		const { problems } = ratchet(
			file,
			"test",
			{ floors: { compared: 9 }, ceilings: { "skip:head": 3 } },
			READ_ONLY,
		);
		expect(problems).toEqual([
			"floors compared: regressed, baseline 10, measured 9",
			"floors scenarios: gone, was 3",
			"ceilings skip:head: regressed, baseline 2, measured 3",
		]);
	});

	it("reports a floor that rose, a ceiling that fell, and a new key as stale, so the file stays true", () => {
		const { problems } = ratchet(
			file,
			"test",
			{ floors: { compared: 11, scenarios: 3, fields: 4 }, ceilings: { "skip:head": 1 } },
			READ_ONLY,
		);
		expect(problems).toEqual([
			"floors compared: stale, tighten it, baseline 10, measured 11",
			"floors fields: new, measured 4",
			"ceilings skip:head: stale, tighten it, baseline 2, measured 1",
		]);
	});

	it("writes a tightening under UPDATE_ORACLE_BASELINE=1", () => {
		const tighter = { floors: { compared: 12, scenarios: 3 }, ceilings: { "skip:head": 0 } };
		expect(ratchet(file, "test", tighter, UPDATE)).toEqual({ problems: [], wrote: true });
		expect(read()).toMatchObject({ ...tighter, loosened: [] });
		expect(ratchet(file, "test", tighter, READ_ONLY).problems).toEqual([]);
	});

	it("refuses to write a loosening without BASELINE_REASON, and leaves the file alone", () => {
		const before = readFileSync(file, "utf8");
		const looser = { floors: { compared: 8, scenarios: 3 }, ceilings: { "skip:head": 2 } };
		const { problems, wrote } = ratchet(file, "test", looser, UPDATE);
		expect(wrote).toBe(false);
		expect(problems).toContain("floors compared: regressed, baseline 10, measured 8");
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("writes a loosening with BASELINE_REASON, recording the reason beside the change", () => {
		const looser = { floors: { compared: 8, scenarios: 3 }, ceilings: { "skip:head": 2 } };
		const { wrote } = ratchet(file, "test", looser, {
			...UPDATE,
			BASELINE_REASON: "corpus shrank",
		});
		expect(wrote).toBe(true);
		expect(read().loosened).toEqual([
			{ reason: "corpus shrank", change: "floors compared: regressed, baseline 10, measured 8" },
		]);
	});

	it("fails without a baseline, and writes the first only under UPDATE_ORACLE_BASELINE=1", () => {
		rmSync(file);
		expect(ratchet(file, "test", base, READ_ONLY).problems[0]).toMatch(/^no baseline at /);
		expect(ratchet(file, "test", base, UPDATE).wrote).toBe(true);
		expect(ratchet(file, "test", base, READ_ONLY).problems).toEqual([]);
	});
});
