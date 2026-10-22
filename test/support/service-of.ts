import type { Program, Type } from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import type { EmittedRoute, EmittedService, RouteSchemaNames } from "typespec-http-zod";
import { emittedServicesOf } from "./compile-fixture.js";

/**
 * One fixture's single service, as the planning modules receive it: `emittedServicesOf`, which runs
 * the published `emitHttpZod` exactly as `$onEmit` does, with two refusals in front.
 *
 * **The library's operation ids, never a reconstruction of them.** Ids are deduplicated per
 * emission and an explicit `@operationId` is taken as given; every lookup below goes through the
 * `EmittedService` the library returned.
 *
 * **A fixture that does not compile is refused**, and so is one declaring other than one service:
 * a planning arm graded against a half-checked program, or against whichever service came first,
 * would be grading something nobody ships.
 */
export interface CompiledService {
	readonly program: Program;
	readonly emitted: EmittedService;
}

/** One operation as every planning module receives it. */
export interface CompiledOperation {
	readonly route: EmittedRoute;
	readonly names: RouteSchemaNames;
	readonly operation: HttpOperation;
}

/** `openApiVersions`, for a fixture compiled at a version other than its own row's. */
export async function serviceOf(
	dir: string,
	name: string,
	openApiVersions?: readonly string[],
): Promise<CompiledService> {
	const { program, services } = await emittedServicesOf(
		dir,
		name,
		openApiVersions === undefined
			? `${name}-service`
			: `${name}-service-${openApiVersions.join("-")}`,
		[],
		openApiVersions,
	);
	const [emitted] = services;
	if (services.length !== 1 || emitted === undefined) {
		throw new Error(
			`${name}.tsp declares ${String(services.length)} services; a fixture here declares one`,
		);
	}
	return { program, emitted };
}

export function operationOf(service: CompiledService, operationId: string): CompiledOperation {
	const route = service.emitted.routes.find((candidate) => candidate.operationId === operationId);
	const names = service.emitted.schemaNames.get(operationId);
	const operation = service.emitted.operations.get(operationId);
	if (route === undefined || names === undefined || operation === undefined) {
		const known = [...service.emitted.operations.keys()].join(", ");
		throw new Error(`no operation ${operationId}; the fixture declares ${known}`);
	}
	return { route, names, operation };
}

/** A declared type by its fully qualified name, as the fixture spells it (`Shapes.Widget`). */
export function typeOf(service: CompiledService, reference: string): Type {
	const [type] = service.program.resolveTypeReference(reference);
	if (type === undefined) throw new Error(`no type ${reference} in the fixture`);
	return type;
}
