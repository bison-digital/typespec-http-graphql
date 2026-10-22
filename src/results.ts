import type { Program, Type } from "@typespec/compiler";
import { getReturnsDoc, isNeverType, isVoidType } from "@typespec/compiler";
import type { HttpOperation, HttpStatusCodesEntry } from "@typespec/http";
import { type EmittedRoute, STATUS_CODES, type StatusKey } from "typespec-http-zod";
import { asNullable, named, type OutputFieldPlan, type Projection, type TypeRef } from "./model.js";
import { reasonCodeOf, reasonTypeNameOf, typeNameOf } from "./names.js";
import type { TypeProjector } from "./types.js";

/**
 * Declared response arms to GraphQL values: `design.md` § Results, table for table.
 *
 * **Expected outcomes are typed data; what a client cannot act on is a top-level error.** A query's
 * 404 is `null`; a mutation's declared 4xx is a member of its `<Name>Result` union; 401, 403, 429
 * and 5xx are top-level codes on both. The projection is keyed by the arm's `StatusKey`, so the
 * resolver decides from the arm `armFor` found, never from the shape of the body.
 *
 * **A 3xx arm gets no entry**, and neither does a 1xx. The runtime treats an arm with no projection
 * as it treats an undeclared status: a plain `Error`, which the server masks as
 * `INTERNAL_SERVER_ERROR`. A GraphQL field cannot follow a redirect, and `design.md` projects none.
 *
 * **Ranges and `default` are decided by status.** A `default`, `4XX` or `5XX` arm stands for many
 * statuses, so the status the handler answered decides, by the same tables (`byStatus`). On a
 * mutation, a `default` or `4XX` arm whose body is a model is a member for the member-class statuses,
 * as every declared 4xx other than 401, 403 and 429 is; a `2XX` range is a success member.
 */

export interface FieldResult {
	readonly type: TypeRef; // the field's GraphQL type; always nullable for roots and links
	readonly projection: Readonly<Record<string, Projection>>;
}

/** One declared response: its status key, and the TypeSpec type of its body when it has one. */
interface Arm {
	readonly key: string;
	readonly status: StatusKey;
	readonly body: Type | undefined;
}

/** One member of a result: the object type it is, and how its arm projects onto it. */
interface Member {
	readonly type: string;
	readonly projection: Projection;
}

/** The codes `design.md` fixes; every other exact 4xx and 5xx is its reason phrase, CONSTANT_CASE. */
const FIXED_CODES: Readonly<Record<number, string>> = {
	400: "BAD_USER_INPUT",
	401: "UNAUTHENTICATED",
	403: "FORBIDDEN",
	409: "CONFLICT",
	422: "BAD_USER_INPUT",
	429: "RATE_LIMITED",
};

/** What a mutation answers at top level rather than as a member: authentication and rate limiting. */
const TOP_LEVEL_ON_MUTATIONS: ReadonlySet<StatusKey> = new Set<StatusKey>([401, 403, 429]);

/**
 * The status keys a response is published under: `typespec-http-zod`'s rule, and `@typespec/openapi3`'s,
 * for `HttpStatusCodesEntry`, so each body pairs with the arm the library emitted for it. A range is
 * every class it overlaps; `*` is `default`.
 */
function statusKeysOf(codes: HttpStatusCodesEntry): StatusKey[] {
	if (codes === "*") return ["default"];
	if (typeof codes === "number") return [codes];
	const { start, end } = codes;
	const keys: StatusKey[] = ([1, 2, 3, 4, 5] as const)
		.filter((group) => start <= group * 100 + 99 && end >= group * 100)
		.map((group) => `${group}XX` as const);
	if (start < 100 || end > 599) keys.push("default");
	return keys;
}

/**
 * Every arm the library declares, in its precedence order, each with its body's TypeSpec type.
 *
 * **The arms are the library's** (`EmittedRoute.responses`, one for each entry of the arms const
 * `schemas.gen.ts` declares), because they are the arms `armFor` chooses between at run time. The
 * body's TYPE is read from the HttpOperation as the library reads it: the first body declared for a
 * status, passing over one declared `void`, which the document publishes as no content, and one
 * declared `never`, which the library refuses (`never-body`) and declares no schema for. An emit
 * carries on past that error, so a `never` body read as a body would throw below.
 */
function armsOf(route: EmittedRoute, operation: HttpOperation): Arm[] {
	const bodies = new Map<string, Type>();
	for (const response of operation.responses) {
		const body = response.responses
			.map((content) => content.body?.type)
			.find((type) => type !== undefined && !isVoidType(type) && !isNeverType(type));
		if (body === undefined) continue;
		for (const key of statusKeysOf(response.statusCodes)) {
			if (!bodies.has(String(key))) bodies.set(String(key), body);
		}
	}
	return route.responses.map((response) => {
		const key = String(response.status);
		const body = bodies.get(key);
		// The library declares a schema exactly where this finds a body (its `resolveResponses`), but
		// for a multipart body, which surface.ts refuses before planning (`non-json-response`).
		if ((body === undefined) !== (response.schema === undefined)) {
			throw new Error(
				`${route.operationId}: the library and the operation disagree on a ${key} body`,
			);
		}
		return { key, status: response.status, body };
	});
}

/**
 * The class of a status key: an exact code's first digit, which `@typespec/http` holds to 100 to 599
 * (`status-code-invalid`), or a range's. `default` is of no class, `NaN`.
 */
function classOf(status: StatusKey): number {
	return Number(String(status)[0]);
}

/** `extensions.code` for an arm answered at top level. */
function errorCodeOf(status: number): string {
	return FIXED_CODES[status] ?? reasonCodeOf(status);
}

/**
 * **The arms every result answers at top level**: 5xx, `default`, and the 4xx `topLevel` admits.
 *
 * An exact status has its code. A `default`, `4XX` or `5XX` arm stands for many statuses, so it is
 * `byStatus` and the status the handler answered decides: a fixed `CLIENT_ERROR` or
 * `INTERNAL_SERVER_ERROR` would answer a 404 under the common `| Error` default arm as a server error
 * on a read, never `null`, and a 400 there as anything but `BAD_USER_INPUT`.
 */
function errorsOf(
	arms: readonly Arm[],
	topLevel: (status: StatusKey) => boolean,
	projection: Record<string, Projection>,
	read: boolean,
): void {
	for (const arm of arms) {
		const { status } = arm;
		if (typeof status !== "number") {
			if (status === "default" || status === "4XX" || status === "5XX") {
				projection[arm.key] = { as: "byStatus", nullOn404: read };
			}
		} else if (classOf(status) === 5 || (classOf(status) === 4 && topLevel(status))) {
			projection[arm.key] = { as: "error", code: errorCodeOf(status) };
		}
	}
}

/**
 * Every 4xx and 5xx a server can answer with (`typespec-http-zod`'s `STATUS_CODES`, each of which
 * has a reason phrase), to the code design.md gives it: the fixed codes, else the reason phrase in
 * CONSTANT_CASE. What a `byStatus` projection reads the status it met in.
 */
export function statusCodesTable(): Record<string, string> {
	return Object.fromEntries(
		[...STATUS_CODES[4], ...STATUS_CODES[5]].map((status) => [String(status), errorCodeOf(status)]),
	);
}

/** A ref as text, to tell two success bodies apart: `[Widget!]!`. */
function refKey(ref: TypeRef): string {
	const nullable = ref.kind === "named" ? ref.name : `[${refKey(ref.of)}]`;
	return ref.nonNull ? `${nullable}!` : nullable;
}

function wrapperField(
	name: "value" | "success",
	type: TypeRef,
	description: string,
): OutputFieldPlan {
	return {
		name,
		wire: name,
		type,
		description,
		deprecationReason: undefined,
		arguments: [],
		call: undefined,
		directives: [],
	};
}

/** The body's TypeRef, naming an anonymous body after the field and the arm. */
function bodyRefOf(
	body: Type,
	arm: Arm,
	projector: TypeProjector,
	name: string,
	fieldName: string,
): TypeRef {
	return projector.output(body, {
		name: `${name}${reasonTypeNameOf(arm.status)}Body`,
		owner: `${fieldName} ${arm.key} body`,
	});
}

/**
 * The member an arm is.
 *
 * **A body that is a model projecting to an object type is that type**, so two arms with one model
 * are one member. **Anything else is wrapped**, because a union member must be an object type: a list,
 * scalar, enum or union body in `<Name><Reason> { value }`, and a bodyless arm in
 * `<Name><Reason> { success: Boolean! }`.
 */
function memberOf(arm: Arm, projector: TypeProjector, name: string, fieldName: string): Member {
	const wrapper = `${name}${reasonTypeNameOf(arm.status)}`;
	const description = `The ${arm.key} response of ${fieldName}.`;
	if (arm.body === undefined) {
		/**
		 * **No HTTP status in an object type.** A member with no body still needs a field, as every
		 * GraphQL object does; `success` says what the member's name already implies, in the client's
		 * terms rather than HTTP's: true for a success response, false for a refusal.
		 */
		const succeeded = classOf(arm.status) === 2;
		projector.define({
			kind: "object",
			name: wrapper,
			description,
			fields: [
				wrapperField(
					"success",
					named("Boolean", true),
					succeeded
						? "Always true: the operation succeeded, and answered no body."
						: "Always false: the operation refused, and answered no body.",
				),
			],
		});
		return { type: wrapper, projection: { as: "wrap", type: wrapper, hasBody: false } };
	}
	const member = modelMemberOf(arm, projector, name, fieldName);
	if (member !== undefined) return member;
	const ref = bodyRefOf(arm.body, arm, projector, name, fieldName);
	projector.define({
		kind: "object",
		name: wrapper,
		description,
		fields: [wrapperField("value", ref, "The response body.")],
	});
	return { type: wrapper, projection: { as: "wrap", type: wrapper, hasBody: true } };
}

/**
 * The member an arm's body is as its own object type, a model that projects to one; `undefined` for
 * any other body, having defined no wrapper for it.
 */
function modelMemberOf(
	arm: Arm,
	projector: TypeProjector,
	name: string,
	fieldName: string,
): Member | undefined {
	if (arm.body?.kind !== "Model") return undefined;
	const ref = bodyRefOf(arm.body, arm, projector, name, fieldName);
	return ref.kind === "named" && ref.nonNull && projector.outputNameOf(arm.body) === ref.name
		? { type: ref.name, projection: { as: "member", type: ref.name } }
		: undefined;
}

/**
 * The field's type from its members: the union `<Name>Result`, whose `resolveType` is the member the
 * projection tagged.
 *
 * **A mutation is a union even with one member.** Otherwise its type would be that member's, and the
 * first error response a REST mutation gains would change it to a union: a breaking change to every
 * client of a field whose REST contract did not break. `<Name>Result` from the start makes the next
 * member an addition. A query comes here only with two success bodies or more; one body is its value.
 */
function resultOf(
	program: Program,
	operation: HttpOperation,
	projector: TypeProjector,
	name: string,
	members: readonly (readonly [Arm, Member])[],
	projection: Record<string, Projection>,
): TypeRef {
	const distinct = [...new Set(members.map(([, member]) => member.type))];
	for (const [arm, member] of members) projection[arm.key] = member.projection;
	const union = `${name}Result`;
	projector.define({
		kind: "union",
		name: union,
		description: getReturnsDoc(program, operation.operation),
		members: distinct,
		resolveBy: { kind: "member" },
	});
	return named(union, false);
}

/** The result of a query field or a link: its value, `null` on 404, top-level codes for the rest. */
export function queryResultOf(
	program: Program,
	route: EmittedRoute,
	operation: HttpOperation,
	projector: TypeProjector,
	fieldName: string,
	connection: TypeRef | undefined,
): FieldResult {
	const name = typeNameOf(fieldName);
	const arms = armsOf(route, operation);
	const projection: Record<string, Projection> = {};
	for (const arm of arms) if (arm.status === 404) projection[arm.key] = { as: "null" };
	errorsOf(arms, (status) => status !== 404, projection, true);
	const successes = arms.filter((arm) => classOf(arm.status) === 2);

	if (connection !== undefined) {
		for (const arm of successes) {
			projection[arm.key] = arm.body === undefined ? { as: "null" } : { as: "connection" };
		}
		return { type: asNullable(connection), projection };
	}
	/**
	 * **One body is the value, and no body is `true`.** Where every success answers the same body, or
	 * none answers any (a query with no success included), the field is that body or `Boolean`; any
	 * other mix of successes is a union of members.
	 */
	const refs = successes.map((arm) =>
		arm.body === undefined ? undefined : bodyRefOf(arm.body, arm, projector, name, fieldName),
	);
	const [first] = refs;
	if (new Set(refs.map((ref) => (ref === undefined ? undefined : refKey(ref)))).size <= 1) {
		for (const arm of successes) {
			projection[arm.key] = first === undefined ? { as: "true" } : { as: "value" };
		}
		return { type: first === undefined ? named("Boolean", false) : asNullable(first), projection };
	}
	const members = successes.map((arm) => [arm, memberOf(arm, projector, name, fieldName)] as const);
	return {
		type: resultOf(program, operation, projector, name, members, projection),
		projection,
	};
}

/**
 * **The result of a batched link: one item of the batch's answer**, `null` where the answer holds
 * none for the value, as a 404 is on a link of its own. The success body is projected whole, and the
 * resolver hands each waiting field its item, so the field's type is the item's and no envelope type
 * is named. A 404 is `null`, which the resolver reads as a chunk to retry one value at a time.
 */
export function batchResultOf(
	route: EmittedRoute,
	operation: HttpOperation,
	projector: TypeProjector,
	fieldName: string,
	item: Type,
): FieldResult {
	const arms = armsOf(route, operation);
	const projection: Record<string, Projection> = {};
	for (const arm of arms) if (arm.status === 404) projection[arm.key] = { as: "null" };
	errorsOf(arms, (status) => status !== 404, projection, true);
	for (const arm of arms) if (classOf(arm.status) === 2) projection[arm.key] = { as: "value" };
	const type = projector.output(item, {
		name: `${typeNameOf(fieldName)}Item`,
		owner: `${fieldName} batch item`,
	});
	return { type: asNullable(type), projection };
}

/** The result of a mutation: `<Name>Result` of its successes and declared 4xx, except 401, 403, 429. */
export function mutationResultOf(
	program: Program,
	route: EmittedRoute,
	operation: HttpOperation,
	projector: TypeProjector,
	fieldName: string,
): FieldResult {
	const name = typeNameOf(fieldName);
	const arms = armsOf(route, operation);
	const projection: Record<string, Projection> = {};
	errorsOf(arms, (status) => TOP_LEVEL_ON_MUTATIONS.has(status), projection, false);
	// Every 2xx, a `2XX` range included, and every declared 4xx but 401, 403 and 429.
	const members = arms
		.filter((arm) =>
			typeof arm.status === "number"
				? classOf(arm.status) === 2 ||
					(classOf(arm.status) === 4 && !TOP_LEVEL_ON_MUTATIONS.has(arm.status))
				: arm.status === "2XX",
		)
		.map((arm) => [arm, memberOf(arm, projector, name, fieldName)] as const);
	/**
	 * A `default` or `4XX` arm whose body is a model is a member too, for the member-class statuses
	 * the handler answers under it; every other status it meets is top-level (`byStatus`). Any other
	 * body defines nothing, as no member stands for it.
	 */
	const ranged = arms.flatMap((arm) => {
		if (arm.status !== "default" && arm.status !== "4XX") return [];
		const member = modelMemberOf(arm, projector, name, fieldName);
		return member === undefined ? [] : [[arm, member] as const];
	});
	const all = [...members, ...ranged];
	if (all.length === 0) return { type: named("Boolean", false), projection };
	const type = resultOf(program, operation, projector, name, all, projection);
	for (const [arm, member] of ranged) {
		projection[arm.key] = { as: "byStatus", nullOn404: false, member: member.type };
	}
	return { type, projection };
}
