import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, type GraphQLSchema } from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile-fixture.js";

/**
 * **What building the schema costs at start-up, at a large operation count, on both runtimes.**
 *
 * `graphql.gen.ts` constructs every type when `createSchema` runs, and a server runs it once, in
 * global scope. On Workers that work counts against the platform's start-up limit, one second of
 * CPU for the whole global scope (developers.cloudflare.com/workers/platform/limits/#worker-startup-time),
 * which a schema built from a large spec could reach. So the cost is measured, budgeted, and
 * recorded in `docs/measurements.md` with the commands that produced it.
 *
 * The spec is generated: 30 resources of 5 operations each, every one declared, and a link from each
 * resource to the next. Node times `createSchema` directly. workerd is profiled by
 * `wrangler check startup`, which bundles the Worker as `wrangler deploy` would and records a CPU
 * profile of its global scope; timing inside a Worker is no use, since its clock does not advance
 * during synchronous work.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const startupRoot = join(here, ".out", "startup");

const RESOURCES = 30;
const OPERATIONS = RESOURCES * 5;
/** Generous on Node, where the build is a few milliseconds; it guards against a change of order. */
const NODE_BUDGET_MS = 150;
/** Well under the platform's one second, since a local profile runs on a different CPU from the edge. */
const WORKERD_BUDGET_MS = 400;

function restSpec(count: number): string {
	const lines = [
		`import "@typespec/http";`,
		"",
		"using Http;",
		"",
		`@service(#{ title: "Startup" })`,
		"namespace Startup;",
		"",
		"@error model NotFound { @statusCode statusCode: 404; message: string; }",
		"",
		"model Page<Item> {",
		"  @pageItems items: Item[];",
		`  @continuationToken @encodedName("application/json", "nextCursor") next_cursor: string | null;`,
		"}",
		"",
		"model PageRequest {",
		"  @query @pageSize @minValue(1) @maxValue(200) limit?: int32 = 50;",
		"  @query @continuationToken cursor?: string;",
		"}",
	];
	for (let i = 1; i <= count; i += 1) {
		lines.push(
			"",
			`enum Resource${i}Status { active, archived }`,
			`model Resource${i} {`,
			"  id: string;",
			"  name: string;",
			`  status: Resource${i}Status;`,
			"  tags: string[];",
			"  metadata: Record<unknown>;",
			`  @encodedName("application/json", "createdAt") created_at: utcDateTime;`,
			`  @encodedName("application/json", "nextId") next_id: string | null;`,
			"}",
			`model CreateResource${i}Request { name: string; tags?: string[]; }`,
			`model UpdateResource${i}Request { name?: string; tags?: string[] | null; }`,
			`@route("/resource-${i}") interface Resources${i} {`,
			`  @route("/{id}") @get read(@path id: string): Resource${i} | NotFound;`,
			`  @list @get list(...PageRequest): Page<Resource${i}>;`,
			`  @post create(@body body: CreateResource${i}Request): Resource${i};`,
			`  @route("/{id}") @patch(#{ implicitOptionality: false }) update(@path id: string, @body body: UpdateResource${i}Request): Resource${i} | NotFound;`,
			`  @route("/{id}") @delete remove(@path id: string): NoContentResponse | NotFound;`,
			"}",
		);
	}
	return `${lines.join("\n")}\n`;
}

function graphqlSpec(count: number): string {
	const lines = [
		`import "typespec-http-graphql";`,
		`import "./rest.tsp";`,
		"",
		"using HttpGraphQL;",
		"using Startup;",
		"",
	];
	for (let i = 1; i <= count; i += 1) {
		lines.push(
			`@@queryField(Resources${i}.read, "resource${i}");`,
			`@@queryField(Resources${i}.list, "resources${i}");`,
			`@@mutationField(Resources${i}.create, "createResource${i}");`,
			`@@mutationField(Resources${i}.update, "updateResource${i}");`,
			`@@mutationField(Resources${i}.remove, "deleteResource${i}");`,
		);
		if (i < count) {
			lines.push(`@@link(Resource${i}, "next", Resources${i + 1}.read, #{ id: "next_id" });`);
		}
	}
	return `${lines.join("\n")}\n`;
}

interface CpuProfile {
	readonly nodes: readonly {
		readonly id: number;
		readonly callFrame: { readonly functionName: string };
	}[];
	readonly samples: readonly number[];
	readonly timeDeltas: readonly number[];
}

/** Milliseconds the profile spent on anything but `(idle)`: the "Active" figure wrangler prints. */
function activeMs(profile: CpuProfile): number {
	const idle = new Set(
		profile.nodes.filter((node) => node.callFrame.functionName === "(idle)").map((node) => node.id),
	);
	let micros = 0;
	profile.samples.forEach((sample, index) => {
		if (!idle.has(sample)) micros += profile.timeDeltas[index] ?? 0;
	});
	return Math.round(micros / 100) / 10;
}

/**
 * Profile one Worker's global scope on local workerd.
 *
 * **`--config` twice, once through `--args`.** `check startup` builds the bundle with an inner
 * `wrangler deploy --dry-run` that it does not hand its own `--config`; that deploy finds no
 * configuration in the package root, runs framework detection, finds `hono` and refuses (`The
 * detected framework ("Hono") cannot be automatically configured.`). `--args` is split on spaces, so
 * the path is given relative to the package root, the command's working directory.
 *
 * **The least of three profiles.** One local profile is noisy: the baseline Worker measured from 11 to
 * 141 ms over ten runs, overlapping the schema's 45 to 120, so a single pair could put the baseline
 * above the schema and fail the non-vacuity arm on noise alone. The least is the run least disturbed.
 */
function startupOf(config: string, name: string): { activeMs: number; bundleKiB: number | null } {
	const forwarded = `--args=--config ${relative(packageRoot, config)}`;
	let least: { activeMs: number; bundleKiB: number | null } | undefined;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const outfile = join(startupRoot, `${name}-${attempt}.cpuprofile`);
		const run = spawnSync(
			join(packageRoot, "node_modules", ".bin", "wrangler"),
			["check", "startup", "--config", config, forwarded, "--outfile", outfile],
			{
				cwd: packageRoot,
				encoding: "utf8",
				env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
			},
		);
		if (run.status !== 0) {
			throw new Error(`wrangler check startup failed for ${name}:\n${run.stdout}${run.stderr}`);
		}
		const bundle = /Bundle: ([\d.]+) KiB/.exec(`${run.stdout}${run.stderr}`)?.[1];
		const profiled = {
			activeMs: activeMs(JSON.parse(readFileSync(outfile, "utf8")) as CpuProfile),
			bundleKiB: bundle === undefined ? null : Number(bundle),
		};
		if (least === undefined || profiled.activeMs < least.activeMs) least = profiled;
	}
	if (least === undefined) throw new Error(`no profile of ${name}`);
	return least;
}

interface Measurements {
	readonly operations: number;
	readonly links: number;
	readonly node: { readonly firstMs: number; readonly medianMs: number; readonly runs: number };
	readonly workerd: {
		readonly baselineMs: number;
		readonly schemaMs: number;
		readonly baselineBundleKiB: number | null;
		readonly schemaBundleKiB: number | null;
	};
}

let diagnostics: readonly { readonly code: string; readonly severity: string }[] = [];
let sdl = "";
let measured: Measurements;

beforeAll(async () => {
	rmSync(startupRoot, { recursive: true, force: true });
	const spec = join(startupRoot, "spec");
	mkdirSync(spec, { recursive: true });
	writeFileSync(join(spec, "rest.tsp"), restSpec(RESOURCES));
	writeFileSync(join(spec, "graphql.tsp"), graphqlSpec(RESOURCES));
	writeFileSync(join(spec, "main.tsp"), `import "./rest.tsp";\nimport "./graphql.tsp";\n`);
	const emittedDir = join(startupRoot, "emitted");
	const compiled = await compileFixture(spec, "main", { outDir: emittedDir });
	diagnostics = compiled.diagnostics;
	sdl = readFileSync(join(emittedDir, "schema.graphql"), "utf8");

	const generated = (await import(join(emittedDir, "graphql.gen.ts"))) as unknown as {
		readonly createSchema: (
			handlersFor: () => object,
			deps: { readonly authorize: () => "allow"; readonly context: () => object },
		) => GraphQLSchema;
	};
	const deps = { authorize: () => "allow" as const, context: () => ({}) };
	const samples: number[] = [];
	for (let run = 0; run < 25; run += 1) {
		const started = performance.now();
		generated.createSchema(() => ({}), deps);
		samples.push(performance.now() - started);
	}
	const sorted = samples.toSorted((a, b) => a - b);
	const round = (ms: number): number => Math.round(ms * 10) / 10;

	const baseline = startupOf(join(here, "wrangler.baseline.jsonc"), "baseline");
	const schema = startupOf(join(here, "wrangler.startup.jsonc"), "schema");
	measured = {
		operations: OPERATIONS,
		links: RESOURCES - 1,
		node: {
			firstMs: round(samples[0] ?? 0),
			medianMs: round(sorted[12] ?? 0),
			runs: samples.length,
		},
		workerd: {
			baselineMs: baseline.activeMs,
			schemaMs: schema.activeMs,
			baselineBundleKiB: baseline.bundleKiB,
			schemaBundleKiB: schema.bundleKiB,
		},
	};
	writeFileSync(
		join(startupRoot, "measurements.json"),
		`${JSON.stringify(measured, null, "\t")}\n`,
	);
}, 900_000);

describe(`start-up cost of a ${OPERATIONS}-operation schema`, () => {
	it("compiles the generated spec with every operation and link declared, and no diagnostic", () => {
		expect(diagnostics).toEqual([]);
		const schema = buildSchema(sdl);
		expect(Object.keys(schema.getQueryType()?.getFields() ?? {})).toHaveLength(RESOURCES * 2);
		expect(Object.keys(schema.getMutationType()?.getFields() ?? {})).toHaveLength(RESOURCES * 3);
		const linked = Object.values(schema.getTypeMap()).filter(
			(type) =>
				/^Resource\d+$/.test(type.name) && "getFields" in type && "next" in type.getFields(),
		);
		expect(linked).toHaveLength(RESOURCES - 1);
	});

	it("builds the schema on Node within its budget", () => {
		expect(measured.node.medianMs).toBeLessThanOrEqual(NODE_BUDGET_MS);
	});

	/**
	 * **Non-vacuity: the profile has the schema in it.** The same Worker with a one-field schema is
	 * profiled beside it; a figure no larger than that baseline would mean the build was not measured.
	 */
	it("starts the Worker on workerd within its budget, and the schema is what costs", () => {
		expect(measured.workerd.schemaMs).toBeLessThanOrEqual(WORKERD_BUDGET_MS);
		expect(measured.workerd.schemaMs).toBeGreaterThan(measured.workerd.baselineMs);
	});

	it("records the figures in docs/measurements.md, with the commands that produced them", () => {
		const doc = readFileSync(join(packageRoot, "docs", "measurements.md"), "utf8");
		expect(doc).toContain("wrangler check startup");
		expect(doc).toContain(`${OPERATIONS} operations`);
		expect(doc).not.toMatch(/\|\s*—\s*\|/);
		expect(doc).not.toContain("Measured on: —");
		// Cells may be padded: a formatter aligns Markdown tables. The closing `|` is a lookahead, so it
		// is left to open the next cell of the row.
		expect(
			[...doc.matchAll(/\|\s*\d+(?:\.\d+)? (?:ms|KiB)\s*(?=\|)/g)].length,
		).toBeGreaterThanOrEqual(6);
	});
});
