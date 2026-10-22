import { rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, type EmitContext, NodeHost, type Program } from "@typespec/compiler";
import { emitHttpZod, type EmittedService } from "typespec-http-zod";
import { openApiVersionsOf } from "./openapi-versions.js";

const testRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Compile one `.tsp` fixture with this emitter, and hand back where it landed.
 *
 * **Shared rather than copied into each suite.** Copies of a harness drift: they come to quote one
 * rule differently, or to grade whatever a previous run left on disk.
 *
 * **One emitter, every file.** This package runs the whole of `typespec-http-zod` and adds its own
 * output beside it, so a fixture lists `typespec-http-graphql` alone and gets the validators too.
 * That is the arrangement a consumer has, and compiling it any other way would test something
 * nobody ships.
 *
 * **The other emitters a consumer runs beside it are opt-in**, each into a sibling subdirectory:
 * `@typespec/openapi3` into `openapi/` and the published `typespec-hono` into `hono/`. The
 * removability oracle compiles one REST fixture with and without the GraphQL surface and compares
 * those two directories byte for byte, and the acceptance and agreement arms serve through them.
 */
export interface CompiledFixture {
	readonly outDir: string;
	/** Where `@typespec/openapi3` wrote, when `withDocument` was set. */
	readonly documentDir: string;
	/** Where the published `typespec-hono` wrote, when `withServer` was set. */
	readonly serverDir: string;
	readonly diagnostics: readonly { readonly code: string; readonly severity: string }[];
	/**
	 * The same diagnostics with the message the compiler formatted, for an arm that has to know which
	 * declaration one was raised against. Kept apart so the arms comparing `{ code, severity }`
	 * exactly are not rewritten around a field they do not grade.
	 */
	readonly messages: readonly { readonly code: string; readonly message: string }[];
	/** The compiled program, for an arm that reads what the decorators recorded. */
	readonly program: Program;
}

export interface FixtureOptions {
	/**
	 * The output directory's name, when it must differ from the spec's.
	 *
	 * **Two suites compiling one fixture to one directory with DIFFERENT options overwrite each
	 * other, and vitest runs test files in parallel.** A suite that races itself is not evidence, and
	 * the failure looks exactly like a flaky emitter.
	 */
	readonly outName?: string;
	/** The full output directory, when a suite owns one of its own rather than sharing `dir/.out/`. */
	readonly outDir?: string;
	/** Also run `@typespec/openapi3`, into `<outDir>/openapi`. */
	readonly withDocument?: boolean;
	/** Also run the published `typespec-hono`, which runs the library itself, into `<outDir>/hono`. */
	readonly withServer?: boolean;
	/**
	 * Leave this emitter out of `emit:`, for the arm that grades what the OTHER emitters write when
	 * a consumer has deleted this emitter's line from `tspconfig.yaml`.
	 */
	readonly withoutGraphQL?: boolean;
	/** Anything else this emitter accepts, for an option a single suite exercises. */
	readonly extraOptions?: Readonly<Record<string, unknown>>;
	/**
	 * The error codes this compile must raise, for an arm grading a spec the compiler or an emitter
	 * refuses. Every other error refuses the fixture, and so does an expected one that is not raised.
	 */
	readonly expectedErrors?: readonly string[];
	/**
	 * The `openapi-versions` openapi3 publishes, which the library validates by. A fixture under
	 * `test/` takes its row in `openapi-versions.ts`, and any other compile openapi3's default.
	 */
	readonly openApiVersions?: readonly string[] | undefined;
}

/** The versions a compile of `<dir>/<name>.tsp` sets: those given, or the fixture's own row. */
function versionsOf(dir: string, name: string, given?: readonly string[]): Record<string, unknown> {
	const versions = given ?? openApiVersionsOf(relative(testRoot, join(dir, name)));
	return versions === undefined ? {} : { "openapi-versions": versions };
}

/**
 * **A fixture that does not compile is refused, never graded**, unless the arm names the errors it
 * expects. No emitter's output follows an error, so an artefact graded after one is one no user
 * gets.
 *
 * **Read after every emitter ran, never before.** The library raises its own errors while it emits
 * (`never-body`, `unsatisfiable-encoding` and the rest), so a check made after `compile(noEmit)`
 * sees none of them: `test/surface/rest.tsp` declared a `never` body that `typespec-http-zod`
 * 0.31.0 refuses, and every surface suite stayed green over it.
 */
export function refuseErrors(
	program: Program,
	name: string,
	expected: readonly string[] = [],
): void {
	const errors = program.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	const unexpected = errors.filter((error) => !expected.includes(error.code));
	const missing = expected.filter((code) => !errors.some((error) => error.code === code));
	if (unexpected.length > 0 || missing.length > 0) {
		throw new Error(
			[
				`${name}.tsp does not compile as expected:`,
				...unexpected.map((error) => `${error.code}: ${String(error.message)}`),
				...missing.map((code) => `expected ${code}, not raised`),
			].join("\n"),
		);
	}
}

export async function compileFixture(
	dir: string,
	name: string,
	options: FixtureOptions = {},
): Promise<CompiledFixture> {
	const outDir = options.outDir ?? join(dir, ".out", options.outName ?? name);
	const documentDir = join(outDir, "openapi");
	const serverDir = join(outDir, "hono");
	/**
	 * **Emptied first, so an assertion cannot be answered by the previous run.**
	 *
	 * An emitter that stops writing a file leaves the last one on disk, and every oracle reading that
	 * directory keeps passing. Deleting rather than overwriting is also the only way an arm can
	 * assert a file is ABSENT, which a dropped declaration has to be able to prove.
	 */
	rmSync(outDir, { recursive: true, force: true });
	const emit = [
		...(options.withoutGraphQL === true ? [] : ["typespec-http-graphql"]),
		...(options.withDocument === true ? ["@typespec/openapi3"] : []),
		...(options.withServer === true ? ["typespec-hono"] : []),
	];
	const program = await compile(NodeHost, join(dir, `${name}.tsp`), {
		outputDir: outDir,
		emit,
		options: {
			"@typespec/openapi3": {
				"emitter-output-dir": documentDir,
				"file-type": "json",
				...versionsOf(dir, name, options.openApiVersions),
			},
			"typespec-hono": { "emitter-output-dir": serverDir },
			/**
			 * **Nothing set but the output directory, unless a suite asks for an option**, which is the
			 * configuration the README produces.
			 */
			"typespec-http-graphql": { "emitter-output-dir": outDir, ...options.extraOptions },
		},
	});
	refuseErrors(program, name, options.expectedErrors);
	return {
		outDir,
		documentDir,
		serverDir,
		diagnostics: program.diagnostics.map((d) => ({ code: d.code, severity: d.severity })),
		messages: program.diagnostics.map((d) => ({
			code: d.code,
			message: typeof d.message === "string" ? d.message : String(d.message),
		})),
		program,
	};
}

/**
 * **The library's view of a fixture's services, exactly as `$onEmit` receives it**, for an arm that
 * grades one stage of this emitter on its own rather than through the files it writes.
 *
 * `emitHttpZod` is the published entry point and reads only the program, the output directory and
 * the options, so the context is assembled here with no options set: the configuration the README
 * produces. The library still writes `schemas.gen.ts`, into a directory of this caller's own.
 */
export async function emittedServicesOf(
	dir: string,
	name: string,
	outName: string = name,
	expectedErrors: readonly string[] = [],
	openApiVersions?: readonly string[],
): Promise<{ readonly program: Program; readonly services: readonly EmittedService[] }> {
	/**
	 * **One directory per Stryker worker.** A mutation run starts a dozen workers in ONE sandbox, each
	 * running these suites at once. Sharing `<outName>` there, one worker emptied the directory while
	 * another read the schemas it had just written, and the read failed: a suite skipped by that is a
	 * mutant reported survived, and a test failed by it a mutant reported killed, both false. Stryker
	 * names each worker in `STRYKER_MUTATOR_WORKER`; outside a mutation run it is unset.
	 */
	const worker = process.env["STRYKER_MUTATOR_WORKER"];
	const outDir = join(dir, ".out", worker === undefined ? outName : `${outName}-worker-${worker}`);
	rmSync(outDir, { recursive: true, force: true });
	/**
	 * **No options at all where the fixture sets no version**: the README's `tspconfig.yaml`, which
	 * names no `@typespec/openapi3` option, so openapi3's default is read from nothing set.
	 */
	const versions = versionsOf(dir, name, openApiVersions);
	const program = await compile(NodeHost, join(dir, `${name}.tsp`), {
		noEmit: true,
		...(Object.keys(versions).length === 0 ? {} : { options: { "@typespec/openapi3": versions } }),
	});
	const services = await servicesOfProgram(program, outDir);
	// After the library emitted, which raises errors of its own: a decorator misplaced in
	// `test/surface/rest.tsp` once left every surface suite green over a program the compiler refused.
	refuseErrors(program, name, expectedErrors);
	return { program, services };
}

/**
 * The library's view of a program ALREADY compiled, for an arm that compiled the fixture with its
 * emitters and must not compile it a second time: one program, so every `Type` the arm reads is the
 * one the library and this emitter read. The library writes `schemas.gen.ts` again, into `outDir`,
 * which must be a directory of the caller's own.
 */
export async function servicesOfProgram(
	program: Program,
	outDir: string,
): Promise<readonly EmittedService[]> {
	rmSync(outDir, { recursive: true, force: true });
	const context: EmitContext = {
		program,
		emitterOutputDir: outDir,
		options: {},
		perf: {
			startTimer: () => ({ end: () => 0 }),
			time: (_label, callback) => callback(),
			timeAsync: (_label, callback) => callback(),
			report: () => {},
		},
	};
	return emitHttpZod(context);
}
