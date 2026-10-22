import type { Program } from "@typespec/compiler";

/**
 * **Copied from typespec-http-mcp's `src/coexistence.ts`, its logic unchanged.** This package
 * runs `typespec-http-zod` too, so it contests `schemas.gen.ts` exactly as the MCP emitter does;
 * `src/emitter.ts` passes this package's own `PACKAGE_NAME` as `self`.
 */
/**
 * **Two emitters writing one file is a silent last-writer-wins, and the winner is decided by the
 * order of `emit:` in `tspconfig.yaml`.**
 *
 * `emitFile` has no duplicate-path detection -- measured in `@typespec/compiler@1.15.0`,
 * `dist/src/core/emitter-utils.js:19-27`, which does `mkdirp`, records the path and writes. Two
 * emitters that both run `typespec-http-zod` therefore both write `schemas.gen.ts`.
 *
 * End to end on the published packages, with divergent `seal-object-schemas`:
 *
 * | `emit:` order | surviving `schemas.gen.ts` |
 * | --- | --- |
 * | server first, then library | every object a `z.object` -- unsealed |
 * | library first, then server | the sealed objects `z.strictObject` -- sealed |
 *
 * Exit 0 both times, no diagnostic either time, and the two files differ. In the first row the
 * server was generated believing schemas were sealed while the surviving file is not, so it
 * validates more permissively than the emitter that wrote it believed.
 *
 * **The collision is opt-in, which is why this is a warning and not a refusal.** With nothing
 * configured, `emitterOutputDir` defaults to `[outputDir, packageName]`
 * (`dist/src/core/program.js:367-369`), so each emitter writes into a directory of its own and
 * nothing collides. Only a consumer who deliberately points both at one directory can reach this --
 * and that is a good arrangement when the options match, because it is what makes one set of
 * validators serve both surfaces.
 */

/**
 * The options that decide what `typespec-http-zod` writes.
 *
 * **Only these.** An emitter that shares a directory but does not accept them is not running the
 * same library and is not contesting the same file -- `@typespec/openapi3` alongside a server
 * emitter is the ordinary case, and warning about it would be noise.
 */
const SHARED_LIBRARY_OPTIONS = [
	"contracts-output-dir",
	"contracts-package",
	"seal-object-schemas",
	"compile-schemas",
	"key-vocabularies",
	"regenerate-hint",
] as const;

export interface Collision {
	readonly emitter: string;
	/** The library options the two emitters resolve differently. */
	readonly differing: readonly string[];
}

/** Reproduces the compiler's own default, so a comparison means the same thing unconfigured. */
function outputDirOf(program: Program, emitter: string): string | undefined {
	const options = program.compilerOptions.options?.[emitter] as Record<string, unknown> | undefined;
	const configured = options?.["emitter-output-dir"];
	if (typeof configured === "string") return configured;
	const base = program.compilerOptions.outputDir;
	return base === undefined ? undefined : `${base}/${emitter}`;
}

/**
 * Whether an emitter runs `typespec-http-zod`, read from the option schema its library PUBLISHES.
 *
 * **Not from whether it was given one of these options.** That was the rule, and it held only while
 * both emitters were configured with a `runtime-module`: an emitter running the library on its
 * defaults sets none of them, and a sibling beside it with `compile-schemas: false` then rewrote
 * `schemas.gen.ts` with nothing said. An emitter that accepts every one of these options is running
 * the library that reads them, whatever it was configured with.
 */
function runsLibrary(program: Program, emitter: string): boolean {
	const loaded = program.emitters.find((ref) => ref.metadata.name === emitter);
	const declared = (
		loaded?.library.definition?.emitter?.options as { properties?: object } | undefined
	)?.properties;
	return declared !== undefined && SHARED_LIBRARY_OPTIONS.every((key) => key in declared);
}

/**
 * Another emitter writing where this one writes, with library options that disagree.
 *
 * Returns nothing when the options MATCH: that arrangement produces byte-identical content and is
 * the one worth encouraging.
 */
export function collisionsFor(program: Program, self: string, selfOutputDir: string): Collision[] {
	const collisions: Collision[] = [];
	const mine = program.compilerOptions.options?.[self] as Record<string, unknown> | undefined;

	for (const emitter of program.compilerOptions.emit ?? []) {
		if (emitter === self) continue;
		if (outputDirOf(program, emitter) !== selfOutputDir) continue;
		if (!runsLibrary(program, emitter)) continue;

		const theirs = program.compilerOptions.options?.[emitter] as
			| Record<string, unknown>
			| undefined;
		const differing = SHARED_LIBRARY_OPTIONS.filter((key) => {
			const a = mine?.[key];
			const b = theirs?.[key];
			return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
		});
		if (differing.length > 0) collisions.push({ emitter, differing });
	}
	return collisions;
}
