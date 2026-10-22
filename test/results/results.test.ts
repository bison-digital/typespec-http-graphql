import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	listOf,
	named,
	type OutputFieldPlan,
	type TypeDef,
	type TypeRef,
} from "../../src/model.js";
import { NameBook } from "../../src/names.js";
import {
	batchResultOf,
	mutationResultOf,
	queryResultOf,
	statusCodesTable,
} from "../../src/results.js";
import { TypeProjector } from "../../src/types.js";
import { type CompiledService, operationOf, serviceOf, typeOf } from "../support/service-of.js";

const here = fileURLToPath(new URL(".", import.meta.url));

let service: CompiledService;
beforeAll(async () => {
	service = await serviceOf(here, "results");
});

function fresh(): TypeProjector {
	return new TypeProjector(service.program, new NameBook(), service.emitted.typeSchemaNames);
}

function query(operationId: string, fieldName: string, projector = fresh()) {
	const { route, operation } = operationOf(service, operationId);
	return queryResultOf(service.program, route, operation, projector, fieldName, undefined);
}

function mutation(operationId: string, fieldName: string, projector = fresh()) {
	const { route, operation } = operationOf(service, operationId);
	return mutationResultOf(service.program, route, operation, projector, fieldName);
}

function defOf(projector: TypeProjector, name: string): TypeDef {
	const def = projector.defs().find((candidate) => candidate.name === name);
	if (def === undefined) throw new Error(`no def ${name}`);
	return def;
}

/** A wrapper's one field, as a generated field is planned: no arguments, no resolver, no directives. */
function wrapperField(name: string, type: TypeRef, description: string): OutputFieldPlan {
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

describe("a batched link", () => {
	/**
	 * **The field is one item of the batch's answer, which the resolver takes from its success
	 * body**, so the success arm projects the body as it is, a 404 is `null`, the chunk the resolver
	 * retries one value at a time, and every other arm is what it is on a read. The field's type is the
	 * item's, and no type is named for the envelope.
	 */
	it("is the batch's item type, its success the body, a 404 null and the rest as on a read", () => {
		const { route, operation } = operationOf(service, "Widgets_batch");
		const projector = fresh();
		const { type, projection } = batchResultOf(
			route,
			operation,
			projector,
			"WidgetsAuthor",
			typeOf(service, "Results.Widget"),
		);
		expect(type).toEqual(named("Widget", false));
		expect(projection).toEqual({
			"200": { as: "value" },
			"400": { as: "error", code: "BAD_USER_INPUT" },
			"404": { as: "null" },
			"422": { as: "error", code: "BAD_USER_INPUT" },
			"500": { as: "error", code: "INTERNAL_SERVER_ERROR" },
			"4XX": { as: "byStatus", nullOn404: true },
		});
		expect(projector.defs().map((def) => def.name)).toEqual(["Widget"]);
	});

	/** An anonymous item is named after the field, as an anonymous body is: `<Field>Item`. */
	it("names an anonymous item after the field", () => {
		const { route, operation } = operationOf(service, "Widgets_batchAnonymous");
		const projector = fresh();
		const body = operation.responses[0]?.responses[0]?.body?.type;
		if (body?.kind !== "Model" || body.indexer === undefined) throw new Error("no list body");
		const { type } = batchResultOf(route, operation, projector, "WidgetsLabel", body.indexer.value);
		expect(type).toEqual(named("WidgetsLabelItem", false));
		expect(defOf(projector, "WidgetsLabelItem")).toMatchObject({ kind: "object" });
	});

	/** A name the item claims that another holds is a collision naming the field's batch item. */
	it("claims an anonymous item's name as the field's batch item", () => {
		const { route, operation } = operationOf(service, "Widgets_batchAnonymous");
		const book = new NameBook();
		book.claim("WidgetsLabelItem", "a model of the spec's");
		const projector = new TypeProjector(service.program, book, service.emitted.typeSchemaNames);
		const body = operation.responses[0]?.responses[0]?.body?.type;
		if (body?.kind !== "Model" || body.indexer === undefined) throw new Error("no list body");
		batchResultOf(route, operation, projector, "WidgetsLabel", body.indexer.value);
		expect(book.collisions.map((collision) => collision.second)).toContain(
			"WidgetsLabel batch item",
		);
	});
});

describe("queries and links", () => {
	/**
	 * **The library and the operation agree on which statuses carry a body**, or nothing is planned.
	 * The library declares parts no schema, and surface.ts refuses a multipart response
	 * (`non-json-response`) before planning; handed one anyway, the planner refuses it rather than
	 * plan a body it has no validator for.
	 */
	it("refuse an operation whose body the library declares no schema for", () => {
		expect(() => query("Widgets_parts", "parts")).toThrow(
			new Error("Widgets_parts: the library and the operation disagree on a 200 body"),
		);
	});

	it("project every declared arm by the query table", () => {
		const { type, projection } = query("Widgets_read", "widget");
		expect(type).toEqual(named("Widget", false));
		expect(projection).toEqual({
			"200": { as: "value" },
			"400": { as: "error", code: "BAD_USER_INPUT" },
			"401": { as: "error", code: "UNAUTHENTICATED" },
			"403": { as: "error", code: "FORBIDDEN" },
			"404": { as: "null" },
			"409": { as: "error", code: "CONFLICT" },
			"410": { as: "error", code: "GONE" },
			"422": { as: "error", code: "BAD_USER_INPUT" },
			"429": { as: "error", code: "RATE_LIMITED" },
			"500": { as: "error", code: "INTERNAL_SERVER_ERROR" },
			"503": { as: "error", code: "SERVICE_UNAVAILABLE" },
		});
	});

	/**
	 * A range or `default` stands for many statuses, so the status the handler answered decides,
	 * by design.md's table: a 404 on a read is `null`, every other status its own code. A fixed code
	 * per arm answered a 404 under `| Error` as a server error.
	 */
	it("decide a range's or default's outcome by the status answered, and give a 3xx no entry", () => {
		expect(query("Widgets_ranges", "ranges").projection).toEqual({
			"200": { as: "value" },
			"4XX": { as: "byStatus", nullOn404: true },
			"5XX": { as: "byStatus", nullOn404: true },
			default: { as: "byStatus", nullOn404: true },
		});
	});

	/** A 1xx is no answer a field can give, as a 3xx is not; a `2XX` range is a success like any 2xx. */
	it("give a 1XX range no entry, and take a 2XX range's body as the value", () => {
		expect(query("Widgets_informed", "informed")).toEqual({
			type: named("Widget", false),
			projection: { "2XX": { as: "value" } },
		});
	});

	it("make a bodyless success Boolean, projected as true", () => {
		expect(query("Widgets_exists", "exists")).toEqual({
			type: named("Boolean", false),
			projection: { "204": { as: "true" } },
		});
	});

	it("keep one type where every success carries one body, a list as much as an object", () => {
		expect(query("Widgets_twice", "twice")).toEqual({
			type: named("Widget", false),
			projection: { "200": { as: "value" }, "201": { as: "value" } },
		});
		const projector = fresh();
		expect(query("Widgets_all", "all", projector)).toEqual({
			type: listOf(named("Widget", true), false),
			projection: { "200": { as: "value" } },
		});
		expect(projector.defs().map((def) => def.name)).toEqual(["Widget"]);
	});

	it("make a union of several distinct success bodies, wrapping what is not an object", () => {
		const projector = fresh();
		const { type, projection } = query("Widgets_partly", "partly", projector);
		expect(type).toEqual(named("PartlyResult", false));
		expect(projection).toEqual({
			"200": { as: "member", type: "Widget" },
			"204": { as: "wrap", type: "PartlyNoContent", hasBody: false },
			"206": { as: "wrap", type: "PartlyPartialContent", hasBody: true },
		});
		expect(defOf(projector, "PartlyResult")).toMatchObject({
			kind: "union",
			members: ["Widget", "PartlyNoContent", "PartlyPartialContent"],
			resolveBy: { kind: "member" },
		});
		expect(defOf(projector, "PartlyPartialContent")).toEqual({
			kind: "object",
			name: "PartlyPartialContent",
			description: "The 206 response of partly.",
			fields: [wrapperField("value", listOf(named("Widget", true), true), "The response body.")],
		});
		expect(defOf(projector, "PartlyNoContent")).toEqual({
			kind: "object",
			name: "PartlyNoContent",
			description: "The 204 response of partly.",
			fields: [
				wrapperField(
					"success",
					named("Boolean", true),
					"Always true: the operation succeeded, and answered no body.",
				),
			],
		});
	});

	/**
	 * Two bodies are one value only where they are one GraphQL type: a `Gadget` is no `Widget`, and
	 * a list of `Widget | null` answers null items, which `[Widget!]!` cannot carry.
	 */
	it("make a union of success bodies that differ by type or by nullability", () => {
		expect(query("Widgets_either", "either")).toEqual({
			type: named("EitherResult", false),
			projection: {
				"200": { as: "member", type: "Widget" },
				"201": { as: "member", type: "Gadget" },
			},
		});
		const projector = fresh();
		expect(query("Widgets_lists", "lists", projector)).toEqual({
			type: named("ListsResult", false),
			projection: {
				"200": { as: "wrap", type: "ListsOK", hasBody: true },
				"201": { as: "wrap", type: "ListsCreated", hasBody: true },
			},
		});
		const valueOf = (name: string) => {
			const def = defOf(projector, name);
			return def.kind === "object" && def.fields.map((field) => [field.name, field.type]);
		};
		expect(valueOf("ListsOK")).toEqual([["value", listOf(named("Widget", true), true)]]);
		expect(valueOf("ListsCreated")).toEqual([["value", listOf(named("Widget", false), true)]]);
	});

	/**
	 * A `void` body is no body: `@typespec/openapi3` publishes `Voided | Found`'s 200 as
	 * `$ref: Widget`, and the library's 200 arm parses a `Widget` for both, so the value is one.
	 */
	it("type a status by its body, passing over one declared void", () => {
		expect(query("Widgets_voided", "voided")).toEqual({
			type: named("Widget", false),
			projection: { "200": { as: "value" } },
		});
	});

	/**
	 * design.md § Types: an anonymous type is named from its enclosing type and member, which for a
	 * body is the field and the arm, and its members' names and owners follow from that.
	 */
	it("name an anonymous body after the field and the arm", () => {
		const projector = fresh();
		expect(query("Widgets_summary", "summary", projector).type).toEqual(
			named("SummaryOKBody", false),
		);
		expect(projector.warnings.map((warning) => warning.what)).toEqual(["summary 200 body.either"]);
	});

	/** A bodyless success carries no page, so a connection field answers it as `null`. */
	it("project a connection's success arms as the connection, and a bodyless one as null", () => {
		const connectionResultOf = (operationId: string, fieldName: string) => {
			const { route, operation } = operationOf(service, operationId);
			return queryResultOf(
				service.program,
				route,
				operation,
				fresh(),
				fieldName,
				named("WidgetConnection", false),
			);
		};
		expect(connectionResultOf("Widgets_twice", "twice")).toEqual({
			type: named("WidgetConnection", false),
			projection: { "200": { as: "connection" }, "201": { as: "connection" } },
		});
		expect(connectionResultOf("Widgets_partly", "partly").projection).toEqual({
			"200": { as: "connection" },
			"204": { as: "null" },
			"206": { as: "connection" },
		});
	});
});

describe("mutations", () => {
	it("make <Name>Result of the successes and declared 4xx, with auth, rate limits and 5xx top-level", () => {
		const projector = fresh();
		const { type, projection } = mutation("Widgets_create", "createWidget", projector);
		expect(type).toEqual(named("CreateWidgetResult", false));
		expect(projection).toEqual({
			"201": { as: "member", type: "Widget" },
			"400": { as: "member", type: "Invalid" },
			"401": { as: "error", code: "UNAUTHENTICATED" },
			"404": { as: "member", type: "NotFound" },
			"409": { as: "member", type: "Conflict" },
			"422": { as: "member", type: "Invalid" },
			"429": { as: "error", code: "RATE_LIMITED" },
			"500": { as: "error", code: "INTERNAL_SERVER_ERROR" },
		});
		expect(defOf(projector, "CreateWidgetResult")).toMatchObject({
			members: ["Widget", "Invalid", "NotFound", "Conflict"],
		});
	});

	it("wrap a bodyless success beside an error member", () => {
		const projector = fresh();
		expect(mutation("Widgets_remove", "removeWidget", projector)).toEqual({
			type: named("RemoveWidgetResult", false),
			projection: {
				"204": { as: "wrap", type: "RemoveWidgetNoContent", hasBody: false },
				"404": { as: "member", type: "NotFound" },
			},
		});
	});

	/** design.md: a bodyless member's `success` is true for a success and false for a refusal. */
	it("wrap a bodyless refusal as false, beside a bodyless success as true", () => {
		const projector = fresh();
		expect(mutation("Widgets_purge", "purge", projector)).toEqual({
			type: named("PurgeResult", false),
			projection: {
				"204": { as: "wrap", type: "PurgeNoContent", hasBody: false },
				"410": { as: "wrap", type: "PurgeGone", hasBody: false },
			},
		});
		expect(defOf(projector, "PurgeNoContent")).toEqual({
			kind: "object",
			name: "PurgeNoContent",
			description: "The 204 response of purge.",
			fields: [
				wrapperField(
					"success",
					named("Boolean", true),
					"Always true: the operation succeeded, and answered no body.",
				),
			],
		});
		expect(defOf(projector, "PurgeGone")).toEqual({
			kind: "object",
			name: "PurgeGone",
			description: "The 410 response of purge.",
			fields: [
				wrapperField(
					"success",
					named("Boolean", true),
					"Always false: the operation refused, and answered no body.",
				),
			],
		});
	});

	/**
	 * Two responses for one status are one arm, and its body is the first one declared, as the
	 * document publishes it: the bodyless `Gone` does not leave 410 without `Expired`'s body.
	 */
	it("take a status's body from the response that declares one, beside a bodyless one", () => {
		expect(mutation("Widgets_archive", "archive").projection).toEqual({
			"200": { as: "member", type: "Widget" },
			"410": { as: "member", type: "Expired" },
		});
	});

	/** As on a query: the 200 `@typespec/openapi3` publishes is `Widget`'s, so `Widget` is the member. */
	it("make a status's body the member, beside one declared void", () => {
		expect(mutation("Widgets_devoid", "devoid")).toEqual({
			type: named("DevoidResult", false),
			projection: { "200": { as: "member", type: "Widget" } },
		});
	});

	/**
	 * A mutation is `<Name>Result` even with one member, so the first error response its REST
	 * operation gains adds a member rather than changing the field's type, which would break every
	 * client. `test/evolution/` grades exactly that with two schema-diff judges.
	 */
	it("keep a single member in its <Name>Result union, so a later member is an addition", () => {
		expect(mutation("Widgets_replace", "replaceWidget")).toEqual({
			type: named("ReplaceWidgetResult", false),
			projection: { "200": { as: "member", type: "Widget" } },
		});
		expect(mutation("Widgets_touch", "touchWidget")).toEqual({
			type: named("TouchWidgetResult", false),
			projection: { "204": { as: "wrap", type: "TouchWidgetNoContent", hasBody: false } },
		});
	});

	/** A GraphQL union has at least one member (§3.8), and a 3xx is not projected. */
	it("make a mutation that has no member Boolean, giving its redirect no entry", () => {
		expect(mutation("Widgets_login", "login")).toEqual({
			type: named("Boolean", false),
			projection: {},
		});
	});

	/** `Record<string>` is a model in TypeSpec and the `JSON` scalar in GraphQL, no object type. */
	it("wrap a list or scalar body, and keep a 4XX range as a member for the member-class statuses", () => {
		expect(mutation("Widgets_bulk", "bulkWidgets").projection).toEqual({
			"200": { as: "wrap", type: "BulkWidgetsOK", hasBody: true },
			"409": { as: "member", type: "Conflict" },
		});
		expect(mutation("Widgets_tag", "tag").projection).toEqual({
			"200": { as: "wrap", type: "TagOK", hasBody: true },
			"409": { as: "member", type: "Conflict" },
		});
		expect(mutation("Widgets_ranged", "rangedWidget").projection).toEqual({
			"200": { as: "member", type: "Widget" },
			"4XX": { as: "byStatus", nullOn404: false, member: "Problem" },
		});
	});

	/**
	 * Every range's body is its own classes', and `default`'s its own, whatever order they are
	 * declared in. A 5xx is top-level on a mutation, so a `5XX` model is never a member.
	 */
	it("keep each range's model to the classes it covers, and a default's model to the default", () => {
		const projector = fresh();
		expect(mutation("Widgets_settle", "settle", projector)).toEqual({
			type: named("SettleResult", false),
			projection: {
				"200": { as: "member", type: "Widget" },
				"4XX": { as: "byStatus", nullOn404: false, member: "Problem" },
				"5XX": { as: "byStatus", nullOn404: false },
				default: { as: "byStatus", nullOn404: false, member: "Fallback" },
			},
		});
		expect(defOf(projector, "SettleResult")).toMatchObject({
			members: ["Widget", "Problem", "Fallback"],
		});
		expect(mutation("Widgets_early", "early").projection["default"]).toEqual({
			as: "byStatus",
			nullOn404: false,
			member: "Fallback",
		});
	});

	/**
	 * design.md § Results: a 2xx is a success member, declared as a range or not, so a handler's 201
	 * under `2XX` answers the member; a 1xx, like a 3xx, is no answer a field can give, so a `1XX`
	 * range gets no entry and adds no member.
	 */
	it("take a 2XX range as a success member, and give a 1XX range no entry", () => {
		const projector = fresh();
		expect(mutation("Widgets_accept", "acceptWidget", projector)).toEqual({
			type: named("AcceptWidgetResult", false),
			projection: {
				"2XX": { as: "member", type: "Widget" },
				"409": { as: "member", type: "Conflict" },
			},
		});
		// Members in the arms' precedence, as `armFor` chooses: exact codes, then ranges.
		expect(defOf(projector, "AcceptWidgetResult")).toMatchObject({
			members: ["Conflict", "Widget"],
		});
		const early = fresh();
		expect(mutation("Widgets_early", "early", early).projection["1XX"]).toBeUndefined();
		expect(defOf(early, "EarlyResult")).toMatchObject({ members: ["Widget", "Fallback"] });
	});

	/**
	 * Where two ranges cover one class, the body declared first is the class's, as the document
	 * publishes it: `Failure` covers 4XX and 5XX before `Problem` covers 4XX.
	 */
	it("give a class the body declared first for it", () => {
		expect(mutation("Widgets_overlap", "overlap").projection).toEqual({
			"200": { as: "member", type: "Widget" },
			"4XX": { as: "byStatus", nullOn404: false, member: "Failure" },
			"5XX": { as: "byStatus", nullOn404: false },
		});
	});

	/**
	 * A bodyless range declared first leaves a class it shares to the body declared after it:
	 * `@typespec/openapi3` publishes `lapse`'s `4XX` as `Problem` and its `5XX` with no content.
	 */
	it("give a class the body declared for it after a bodyless range", () => {
		const projector = fresh();
		expect(mutation("Widgets_lapse", "lapse", projector)).toEqual({
			type: named("LapseResult", false),
			projection: {
				"200": { as: "member", type: "Widget" },
				"4XX": { as: "byStatus", nullOn404: false, member: "Problem" },
				"5XX": { as: "byStatus", nullOn404: false },
			},
		});
		expect(defOf(projector, "LapseResult")).toMatchObject({ members: ["Widget", "Problem"] });
	});

	/**
	 * Only a model is the member a range or `default` stands for; a list body, or none, leaves every
	 * status it meets top-level, and the field defines no type for it.
	 */
	it("keep a range or default that carries no model top-level, never a member", () => {
		const strict = fresh();
		expect(mutation("Widgets_strict", "strict", strict)).toEqual({
			type: named("StrictResult", false),
			projection: {
				"200": { as: "member", type: "Widget" },
				"4XX": { as: "byStatus", nullOn404: false },
				default: { as: "byStatus", nullOn404: false },
			},
		});
		expect(defOf(strict, "StrictResult")).toMatchObject({ members: ["Widget"] });
		expect(strict.defs().map((def) => def.name)).toEqual(["StrictResult", "Widget"]);
		const bare = fresh();
		expect(mutation("Widgets_bare", "bare", bare).projection).toEqual({
			"200": { as: "member", type: "Widget" },
			default: { as: "byStatus", nullOn404: false },
		});
		expect(bare.defs().map((def) => def.name)).toEqual(["BareResult", "Widget"]);
	});
});

describe("statusCodesTable", () => {
	/**
	 * Every 4xx and 5xx the IANA HTTP Status Code Registry assigns, by design.md's codes: the six it
	 * fixes, and every other the reason phrase in CONSTANT_CASE. 418 keeps RFC 2324's phrase, which
	 * RFC 9110 § 15.5.19 reserves the code over. An unassigned code has no phrase and no entry.
	 */
	it("codes every assigned 4xx and 5xx", () => {
		expect(statusCodesTable()).toEqual({
			"400": "BAD_USER_INPUT",
			"401": "UNAUTHENTICATED",
			"402": "PAYMENT_REQUIRED",
			"403": "FORBIDDEN",
			"404": "NOT_FOUND",
			"405": "METHOD_NOT_ALLOWED",
			"406": "NOT_ACCEPTABLE",
			"407": "PROXY_AUTHENTICATION_REQUIRED",
			"408": "REQUEST_TIMEOUT",
			"409": "CONFLICT",
			"410": "GONE",
			"411": "LENGTH_REQUIRED",
			"412": "PRECONDITION_FAILED",
			"413": "CONTENT_TOO_LARGE",
			"414": "URI_TOO_LONG",
			"415": "UNSUPPORTED_MEDIA_TYPE",
			"416": "RANGE_NOT_SATISFIABLE",
			"417": "EXPECTATION_FAILED",
			"418": "IM_A_TEAPOT",
			"421": "MISDIRECTED_REQUEST",
			"422": "BAD_USER_INPUT",
			"423": "LOCKED",
			"424": "FAILED_DEPENDENCY",
			"425": "TOO_EARLY",
			"426": "UPGRADE_REQUIRED",
			"428": "PRECONDITION_REQUIRED",
			"429": "RATE_LIMITED",
			"431": "REQUEST_HEADER_FIELDS_TOO_LARGE",
			"451": "UNAVAILABLE_FOR_LEGAL_REASONS",
			"500": "INTERNAL_SERVER_ERROR",
			"501": "NOT_IMPLEMENTED",
			"502": "BAD_GATEWAY",
			"503": "SERVICE_UNAVAILABLE",
			"504": "GATEWAY_TIMEOUT",
			"505": "HTTP_VERSION_NOT_SUPPORTED",
			"506": "VARIANT_ALSO_NEGOTIATES",
			"507": "INSUFFICIENT_STORAGE",
			"508": "LOOP_DETECTED",
			"510": "NOT_EXTENDED",
			"511": "NETWORK_AUTHENTICATION_REQUIRED",
		});
	});
});
