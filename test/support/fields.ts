import { resolveEncodedName } from "@typespec/compiler";
import type { LinkField, RootField } from "../../src/surface.js";
import { type CompiledService, operationOf, typeOf } from "./service-of.js";

/**
 * The records `surfaceOf` yields for a root field and a link, built from the same program, for the
 * suites that grade one planning module without the declaration checks in front of it.
 *
 * **Built from the library's own operation and the compiler's own names**: the route, schema names
 * and HttpOperation are `emitHttpZod`'s, a binding's `wire` is the parameter's key in the merged
 * input and its `parentWire` is `resolveEncodedName`, exactly as `LinkBinding` documents them.
 */
export function rootField(
	service: CompiledService,
	operationId: string,
	kind: "query" | "mutation",
	name: string,
): RootField {
	const { route, names, operation } = operationOf(service, operationId);
	return {
		kind,
		name,
		route,
		names,
		operation,
		description: undefined,
		inputHeaders: new Set(),
		node: operation.operation,
	};
}

export function linkField(
	service: CompiledService,
	parentReference: string,
	name: string,
	operationId: string,
	parameters: Readonly<Record<string, string>>,
): LinkField {
	const parent = typeOf(service, parentReference);
	if (parent.kind !== "Model") throw new Error(`${parentReference} is not a model`);
	const { route, names, operation } = operationOf(service, operationId);
	const bindings = Object.entries(parameters).map(([parameter, propertyName]) => {
		const target = operation.parameters.parameters.find(
			(candidate) => candidate.param.name === parameter,
		);
		const property = parent.properties.get(propertyName);
		if (target === undefined || property === undefined) {
			throw new Error(`no parameter ${parameter} or property ${propertyName}`);
		}
		return {
			parameter,
			wire: target.name,
			property,
			parentWire: resolveEncodedName(service.program, property, "application/json"),
			list: false,
		};
	});
	return {
		parent,
		name,
		route,
		names,
		operation,
		bindings,
		maxItems: undefined,
		description: undefined,
		inputHeaders: new Set(),
		node: operation.operation,
	};
}
