import {
	type EmittedResponse,
	jsDocComment,
	mediaTypeTypeOf,
	objectKey,
	type ResultMember,
	resultMembersOf,
	statusCodesOf,
} from "typespec-http-zod";
import type { SchemaPlan } from "./model.js";

/**
 * **The handler signatures: the agreement half of `graphql.gen.ts`.**
 *
 * Every function here is the same rendering typespec-http-mcp's `tools.ts` does for its `Tools`
 * interface, copied rule for rule (`intersectedValidators`, `shapedValidators`, `inputTypeOf`,
 * `selectedAcceptOf`, `statusTypeOf`, `resultTypeOf`, `resultTypeName`, the two helpers and
 * `EMPTY_INPUT`), because ONE handler object is passed to `typespec-hono`'s `registerRoutes`, to
 * typespec-http-mcp's `registerTools` and to `createSchema`. `test/agreement/` grades each input and
 * result type against the published `typespec-hono`'s `Operations` with `Identical<>`.
 *
 * Pure: it reads the library's types and nothing else, so it never reaches the compiler.
 */

/** One operation a handler must exist for. */
export type PlannedOperation = SchemaPlan["operations"][number];

/** The same helper typespec-http-mcp's tools.ts emits, under the same name, for the same reason. */
const FIELDS_HELPER = `/**
 * A validator's fields, or nothing at all when it declares none.
 *
 * **Zod 4 infers \`Record<string, never>\` for \`z.object({})\`.** That is a fair reading on its own -
 * no string key may exist - and lethal in an intersection: \`{ id: string } & Record<string, never>\`
 * makes \`id\` into \`string & never\`, so the input type is uninhabitable and the call site below
 * cannot compile. An empty model contributes nothing to an operation's input, so it becomes \`{}\`,
 * the identity of \`&\` over the object types an input is made of - not \`unknown\`, which an input
 * made of nothing else would then BE, and which the contract types' \`{}\` does not accept.
 */
type Fields<T> = string extends keyof T ? ([T[string]] extends [never] ? {} : T) : T;

`;

/** The same helper typespec-http-mcp's tools.ts emits: what a handler must SUPPLY. */
const PRODUCED_HELPER = `/**
 * What a handler must SUPPLY, as opposed to what it receives.
 *
 * An index signature and \`readonly\` are true of an inferred type without being obligations on a
 * producer, so both are dropped here - only where the shape has declared keys beside it, because an
 * index signature also arrives as a property's own declared type, where stripping it would destroy
 * the property.
 *
 * It is applied to the schema's INPUT, \`z.input\`, because that is what a result is checked against:
 * a property with a default may be left out, and an optional property is \`?: T\`, because
 * \`.exactOptional()\` refuses an explicit \`undefined\`. Both are what the contract types state.
 */
type ProducedKeyOf<T> = keyof {
	[K in keyof T as string extends K
		? never
		: number extends K
			? never
			: symbol extends K
				? never
				: K]: 0;
};

type Produced<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer Element)[]
		? readonly Produced<Element>[]
		: T extends object
			? [ProducedKeyOf<T>] extends [never]
				? { readonly [K in keyof T]: Produced<T[K]> }
				: {
						readonly [K in keyof T as string extends K
							? never
							: number extends K
								? never
								: symbol extends K
									? never
									: K]: Produced<T[K]>;
					}
			: T;
`;

const EMPTY_INPUT = "Record<string, never>";

/** One member of a result: the library's member, with the identifier its schema is declared under. */
interface Member extends ResultMember<EmittedResponse> {
	readonly schemaName: string | undefined;
}

/** typespec-http-mcp's `membersOf` (bodies.ts): the library's rules, read rather than restated. */
function membersOf(operation: PlannedOperation): Member[] {
	return resultMembersOf(
		operation.route.responses,
		(response) => response.schema !== undefined,
	).map((member) => ({ ...member, schemaName: operation.names.arms[member.index]?.schema }));
}

/**
 * The validators that INTERSECT into the handler's input: path, query, header, cookie, then body. A
 * named body is named rather than intersected, so its index signature is not imposed on its siblings.
 */
function intersectedValidators(operation: PlannedOperation): readonly string[] {
	const { names, route } = operation;
	const groups = [names.path, names.query, names.header, names.cookie, names.body];
	return groups.filter(
		(name): name is string =>
			name !== undefined && (route.bodyProperty === undefined || name !== names.body),
	);
}

/** The same groups, with an exploded query read from `queryFields`, whose `.shape` a spread needs. */
function shapedValidators(operation: PlannedOperation): readonly string[] {
	const { names } = operation;
	return intersectedValidators(operation).map((name) =>
		name === names.query && names.queryFields !== undefined ? names.queryFields : name,
	);
}

/** The negotiated `accept` literal the resolver supplies itself, as `key: "literal"`. */
function selectedAcceptOf(operation: PlannedOperation): string | undefined {
	const selected = operation.names.selectedAccept;
	return selected === undefined
		? undefined
		: `${objectKey(selected.name)}: ${JSON.stringify(selected.value)}`;
}

/** The handler's input type: the same intersection the sibling server emitter writes. */
function inputTypeOf(operation: PlannedOperation): string {
	const parts = intersectedValidators(operation).map((name) => `Fields<z.infer<typeof ${name}>>`);
	if (operation.route.bodyProperty !== undefined && operation.names.body !== undefined) {
		const optionalMark = operation.route.optionalBody ? "?" : "";
		parts.push(
			`{ ${objectKey(operation.route.bodyProperty)}${optionalMark}: z.infer<typeof ${operation.names.body}> }`,
		);
	}
	const selected = selectedAcceptOf(operation);
	if (selected !== undefined) parts.push(`{ ${selected} }`);
	return parts.length === 0 ? EMPTY_INPUT : parts.join(" & ");
}

/** The name of the merged request schema `graphql.gen.ts` declares for an operation. */
export function inputSchemaName(operationId: string): string {
	return `${operationId}GraphQLInput`;
}

/**
 * The merged request schema a resolver validates its assembled input with: every group merged into
 * one object, as typespec-http-mcp's `inputSchemaOf` merges a tool's arguments, open or sealed per
 * `seal-object-schemas`.
 *
 * **One addition: the negotiated `accept` is declared as its literal.** typespec-http-mcp adds it
 * after validation; here the resolver supplies it before validating, as it does a single-literal
 * header, so a sealed schema must declare it or refuse every call.
 */
export function inputSchemaOf(operation: PlannedOperation, sealed: boolean): string {
	const constructor = sealed ? "z.strictObject" : "z.looseObject";
	const spreads = shapedValidators(operation).flatMap((name) => [
		`...${name}.shape`,
		/**
		 * A path parameter the library decodes from segment text (`decodedPathParameters`) is
		 * validated by the schema the decoding feeds, `.out` of its `z.preprocess` pipe, as the
		 * library says a caller holding the value must: the resolver hands the value, not text.
		 */
		...(name === operation.names.path
			? operation.route.decodedPathParameters.map(
					(key) => `${objectKey(key)}: ${name}.shape[${JSON.stringify(key)}].out`,
				)
			: []),
	]);
	if (operation.route.bodyProperty !== undefined && operation.names.body !== undefined) {
		const optional = operation.route.optionalBody ? ".exactOptional()" : "";
		spreads.push(`${objectKey(operation.route.bodyProperty)}: ${operation.names.body}${optional}`);
	}
	const selected = operation.names.selectedAccept;
	if (selected !== undefined) {
		spreads.push(`${objectKey(selected.name)}: z.literal(${JSON.stringify(selected.value)})`);
	}
	if (spreads.length === 0) return "z.strictObject({})";
	return `${constructor}({ ${spreads.join(", ")} })`;
}

/** The status a result member is typed with: the codes its response answers with, written out. */
function statusTypeOf(response: EmittedResponse, operation: PlannedOperation): string {
	const codes = statusCodesOf(
		response,
		operation.route.responses,
		(candidate) => candidate.schema !== undefined,
	);
	return codes.length === 0 ? "never" : codes.join(" | ");
}

/** The published operation id with its first letter raised: the name the siblings give its result. */
export function resultTypeName(operationId: string): string {
	return `${operationId.charAt(0).toUpperCase()}${operationId.slice(1)}Result`;
}

/** The union a handler returns: `{ status, body, headers }` for every response the document declares. */
function resultTypeOf(operation: PlannedOperation): string {
	const members = membersOf(operation).map((member) => {
		const { response } = member;
		const fields = [`readonly status: ${statusTypeOf(response, operation)}`];
		if (member.choosesMediaType && member.mediaType !== undefined) {
			fields.push(`readonly contentType: ${mediaTypeTypeOf(member.mediaType)}`);
		}
		switch (member.serving) {
			case "none":
				fields.push("readonly body?: undefined");
				break;
			case "stream":
			case "binary":
				/**
				 * The surface refuses an operation answering bytes (`non-json-response`), so the plan
				 * never carries one. Rendering `ByteStream` here would need a declaration the runtime
				 * does not make, so reaching this is a defect upstream of the renderer.
				 */
				throw new Error(
					`typespec-http-graphql internal invariant: ${operation.route.operationId} answers ` +
						`${String(response.status)} with ${member.serving} content, which the surface refuses`,
				);
			case "unvalidated":
				fields.push("readonly body: string");
				break;
			default:
				fields.push(`readonly body: Produced<z.input<typeof ${member.schemaName}>>`);
		}
		if (response.headers.length > 0) {
			const every = response.headers.every((header) => header.optional);
			const rendered = response.headers
				.map((header) =>
					header.optional
						? `readonly ${objectKey(header.name)}?: ${header.type} | undefined`
						: `readonly ${objectKey(header.name)}: ${header.type}`,
				)
				.join("; ");
			fields.push(`readonly headers${every ? "?" : ""}: { ${rendered} }`);
		}
		return `{ ${fields.join("; ")} }`;
	});
	const body =
		members.length <= 1
			? ` ${members[0] ?? "never"}`
			: members.map((member) => `\n\t| ${member}`).join("");
	return `export type ${resultTypeName(operation.route.operationId)} =${body};`;
}

/**
 * Every `schemas.gen.ts` name `graphql.gen.ts` references: the input types' validators, the merged
 * input schemas' shaped validators and named bodies, every result body's schema, and each operation's
 * `responses` arms. Sorted, so the import line is stable.
 */
export function schemaImportsOf(operations: readonly PlannedOperation[]): readonly string[] {
	const imported = new Set<string>();
	for (const operation of operations) {
		for (const name of [...intersectedValidators(operation), ...shapedValidators(operation)]) {
			imported.add(name);
		}
		if (operation.names.body !== undefined) imported.add(operation.names.body);
		for (const member of membersOf(operation)) {
			if (
				(member.serving === "json" || member.serving === "text") &&
				member.schemaName !== undefined
			) {
				imported.add(member.schemaName);
			}
		}
		imported.add(operation.names.responses);
	}
	return [...imported].toSorted();
}

/**
 * `GraphQLOperations<C>`, the per-operation result types, `DeclaredOperationId` and
 * `GraphQLExhaustive<T>`: the part of `graphql.gen.ts` that follows `renderSchemaModule`'s text,
 * whose imports cover what this text names.
 *
 * `declaredOperationIds` is every operation the DOCUMENT declares, not only the ones the surface
 * calls: one handler object serves every surface, so a handler for an operation GraphQL does not
 * call is expected rather than surplus.
 */
export function renderOperations(
	operations: readonly PlannedOperation[],
	declaredOperationIds: readonly string[],
): string {
	const usesFields = operations.some((operation) => intersectedValidators(operation).length > 0);
	const usesProduced = operations.some((operation) =>
		membersOf(operation).some((member) => member.serving === "json" || member.serving === "text"),
	);
	const helpers = `${usesFields ? FIELDS_HELPER : ""}${usesProduced ? PRODUCED_HELPER : ""}`;
	const resultTypes = operations.map(resultTypeOf).join("\n\n");
	/** An unused type parameter is an error under `noUnusedParameters` unless it starts with `_`. */
	const u = operations.length === 0 ? "_" : "";
	/**
	 * **A PROPERTY signature, not a method signature**, as typespec-http-mcp writes it: a method's
	 * parameters compare bivariantly, so a handler wanting a richer `ctx` would compile.
	 */
	const methods = operations
		.map((operation) => {
			const doc = jsDocComment(operation.route.summary, "\t");
			return `${doc}\treadonly ${objectKey(operation.route.operationId)}: (ctx: C, input: ${inputTypeOf(operation)}) => Awaitable<${resultTypeName(operation.route.operationId)}>;`;
		})
		.join("\n");
	const declared =
		declaredOperationIds.length === 0
			? "never"
			: declaredOperationIds.map((id) => JSON.stringify(id)).join(" | ");

	return `${helpers}${resultTypes === "" ? "" : `${resultTypes}\n\n`}/**
 * One handler per operation the GraphQL surface calls, as a root field or through a link, each
 * typed from the schemas it validates against and returning \`{ status, body, headers }\` for any
 * response the document declares.
 *
 * **These are the signatures a generated HTTP server and tool surface declare for the same
 * operations**, so ONE handler object serves all three. \`C\` is the caller context
 * \`deps.context\` establishes.
 */
export interface GraphQLOperations<${u}C = unknown> {
${methods}
}

/**
 * Every operation the SERVICE declares, whether or not the GraphQL surface calls it. A handler for
 * one it does not call is expected, since one handler object serves every surface.
 */
export type DeclaredOperationId = ${declared};

/**
 * Refuses a handler set carrying an operation the spec no longer declares, as \`ToolsExhaustive\`
 * does. **Write the handler factory UNANNOTATED**: annotating widens it and this guard evaporates.
 */
export type GraphQLExhaustive<T> = T & Record<Exclude<keyof T, DeclaredOperationId>, never>;
`;
}
