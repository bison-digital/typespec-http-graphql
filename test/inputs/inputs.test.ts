import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { dispositionOf, mutationInputsOf, queryInputsOf } from "../../src/inputs.js";
import {
	type ArgumentPlan,
	type ConnectionPlan,
	listOf,
	named,
	type TypeDef,
} from "../../src/model.js";
import { NameBook } from "../../src/names.js";
import { TypeProjector } from "../../src/types.js";
import { linkField, rootField } from "../support/fields.js";
import { type CompiledService, operationOf, serviceOf } from "../support/service-of.js";

const here = fileURLToPath(new URL(".", import.meta.url));

let service: CompiledService;
beforeAll(async () => {
	service = await serviceOf(here, "inputs");
});

/** `book` is the NameBook a `graphql-name-collision` warning names each owner from. */
function projector(book = new NameBook()): TypeProjector {
	return new TypeProjector(service.program, book, service.emitted.typeSchemaNames);
}

function inputDef(projector: TypeProjector, name: string): Extract<TypeDef, { kind: "input" }> {
	const def = projector.defs().find((candidate) => candidate.name === name);
	if (def?.kind !== "input") throw new Error(`no input ${name}`);
	return def;
}

/** What `connections.ts` derives for `Widgets_list`, which `test/connections/` grades. */
const PAGING: ConnectionPlan = {
	items: "items",
	next: "nextCursor",
	first: "limit",
	after: "cursor",
	item: named("Widget", true),
	maximum: undefined,
	assumedSize: undefined,
};

/** What `connections.ts` derives for `Widgets_find`, whose paging parameters follow a filter. */
const FIND_PAGING: ConnectionPlan = { ...PAGING, first: "size", after: "from" };

/**
 * **design.md § Arguments and input: an open body makes the input `JSON`.** The operation takes one
 * `input: JSON!`, merged as the handler's whole input, in place of every argument it would have had.
 */
const OPEN_INPUT: ArgumentPlan = {
	name: "input",
	wire: "input",
	type: named("JSON", true),
	description:
		"The operation's whole input, as the HTTP request carries it: its body is open, so no GraphQL input type can state it.",
	deprecationReason: undefined,
	dropNull: false,
	nullIfAbsent: false,
	defaultValue: undefined,
	merge: true,
};

describe("parameter disposition", () => {
	/**
	 * design.md: a single-literal header is supplied, every optional header and cookie left out, and
	 * a required header that is not a single literal kept, as is every path and query parameter, a
	 * single-literal one included: only a header is HTTP mechanics.
	 */
	it.each([
		["Widgets_read", "widgetId", "argument"],
		["Widgets_read", "If-None-Match", "omitted"],
		["Widgets_read", "X-Request-Id", "omitted"],
		["Widgets_read", "X-Api-Version", "argument"],
		["Widgets_read", "session", "omitted"],
		["Widgets_update", "Content-Type", "supplied"],
		["Widgets_update", "If-Match", "argument"],
		["Reports_asJson", "accept", "supplied"],
		["Reports_asJson", "version", "argument"],
	] as const)("decide %s's %s: %s", (operationId, wire, disposition) => {
		const parameter = operationOf(service, operationId).operation.parameters.parameters.find(
			(candidate) => candidate.name === wire,
		);
		if (parameter === undefined) throw new Error(`${operationId} has no parameter ${wire}`);
		expect(dispositionOf(parameter, new Set())).toBe(disposition);
	});

	/**
	 * **An optional header `@inputHeader` names is input**, and nothing else it might name changes:
	 * a one-literal header is still supplied, a required one still an argument, a cookie still omitted.
	 */
	it.each([
		["Widgets_read", "X-Request-Id", "argument"],
		["Widgets_read", "If-None-Match", "omitted"],
		["Widgets_read", "session", "omitted"],
		["Widgets_update", "Content-Type", "supplied"],
		["Widgets_update", "If-Match", "argument"],
	] as const)(
		"decide %s's %s, with X-Request-Id and every other taken as input: %s",
		(operationId, wire, disposition) => {
			const parameters = operationOf(service, operationId).operation.parameters.parameters;
			const parameter = parameters.find((candidate) => candidate.name === wire);
			if (parameter === undefined) throw new Error(`${operationId} has no parameter ${wire}`);
			const taken = new Set(
				parameters
					.filter((candidate) => candidate.name !== "If-None-Match")
					.map((candidate) => candidate.param.name),
			);
			expect(dispositionOf(parameter, taken)).toBe(disposition);
		},
	);
});

describe("query arguments", () => {
	/**
	 * A cookie is transport state, as a header is, and follows the header rule: optional, it is left
	 * to the /graphql request's own, so the optional `session` is no argument.
	 */
	it("take one argument per path and required header parameter, named from its wire name, and leave out an optional cookie", () => {
		const field = rootField(service, "Widgets_read", "query", "widget");
		const { arguments: args, supplied } = queryInputsOf(
			service.program,
			field,
			projector(),
			undefined,
		);
		expect(args.map((arg) => [arg.name, arg.wire, arg.type, arg.dropNull, arg.merge])).toEqual([
			["widgetId", "widgetId", named("String", true), false, false],
			["xApiVersion", "X-Api-Version", named("String", true), false, false],
		]);
		expect(supplied).toEqual({});
	});

	/**
	 * **Any optional header, a precondition or not, is neither asked for nor supplied**: a
	 * precondition would take the conditional path, and a tracing or client header is the caller's
	 * transport, not an argument of the field.
	 */
	it("leave out an optional header entirely, a precondition or any other", () => {
		const field = rootField(service, "Widgets_read", "query", "widget");
		const { arguments: args, supplied } = queryInputsOf(
			service.program,
			field,
			projector(),
			undefined,
		);
		const wires = args.map((arg) => arg.wire);
		expect(wires).not.toContain("If-None-Match");
		expect(wires).not.toContain("X-Request-Id");
		expect(Object.keys(supplied)).not.toContain("If-None-Match");
		expect(Object.keys(supplied)).not.toContain("X-Request-Id");
		// Non-vacuity: the required header of the same operation is still an argument.
		expect(wires).toContain("X-Api-Version");
	});

	it("name a query parameter from its wire name, which it writes back", () => {
		const field = rootField(service, "Widgets_list", "query", "widgets");
		const { arguments: args } = queryInputsOf(service.program, field, projector(), undefined);
		expect(args.find((arg) => arg.wire === "page-size")).toEqual({
			name: "pageSize",
			wire: "page-size",
			type: named("Int", false),
			description: undefined,
			deprecationReason: undefined,
			dropNull: true,
			nullIfAbsent: false,
			defaultValue: undefined,
			merge: false,
		});
	});

	/**
	 * The name is owned by the field and the parameter, which is who a `graphql-name-collision`
	 * warning names when another type converts to the same name.
	 */
	it("name an anonymous enum argument from the field and the parameter", () => {
		const book = new NameBook();
		const types = projector(book);
		const field = rootField(service, "Widgets_list", "query", "widgets");
		const { arguments: args } = queryInputsOf(service.program, field, types, undefined);
		expect(args.find((arg) => arg.wire === "state")?.type).toEqual(named("WidgetsState", false));
		expect(types.defs().find((def) => def.name === "WidgetsState")?.kind).toBe("enum");
		expect(book.owners("WidgetsState")).toEqual(["query widgets(state)"]);
	});

	/**
	 * design.md § Connections: `first` is the `@pageSize` parameter, its doc, null rule and default
	 * the parameter's (`first: Int = 50`, as `test/idiom/expected.graphql` has it); `after` is a cursor
	 * this connection issued, documented as one.
	 */
	it("replace a connection's paging parameters with first and after, writing their keys", () => {
		const field = rootField(service, "Widgets_list", "query", "widgets");
		const { arguments: args } = queryInputsOf(service.program, field, projector(), PAGING);
		expect(args.map((arg) => [arg.name, arg.wire, arg.type, arg.dropNull])).toEqual([
			["first", "limit", named("Int", false), true],
			["after", "cursor", named("String", false), true],
			["pageSize", "page-size", named("Int", false), true],
			["state", "state", named("WidgetsState", false), true],
		]);
		expect(args.slice(0, 2)).toEqual([
			{
				name: "first",
				wire: "limit",
				type: named("Int", false),
				description: "How many to return.",
				deprecationReason: undefined,
				dropNull: true,
				nullIfAbsent: false,
				defaultValue: { kind: "INT", value: "50" },
				merge: false,
			},
			{
				name: "after",
				wire: "cursor",
				type: named("String", false),
				description:
					"An opaque cursor from this connection, an edge's or `pageInfo.endCursor`: the items after it.",
				deprecationReason: undefined,
				dropNull: true,
				nullIfAbsent: false,
				defaultValue: undefined,
				merge: false,
			},
		]);
	});

	/**
	 * **`after` states no default, even where the token parameter has one**: design.md § Connections
	 * takes only a cursor this connection issued as `after`, so a backend token stated as its default
	 * would be refused. Each paging argument reads the parameter it replaces, wherever it is declared.
	 */
	it("read first and after from the parameters they replace, and give after no default", () => {
		const field = rootField(service, "Widgets_find", "query", "findWidgets");
		const { arguments: args } = queryInputsOf(service.program, field, projector(), FIND_PAGING);
		expect(
			args.map((arg) => [arg.name, arg.wire, arg.description, arg.defaultValue, arg.dropNull]),
		).toEqual([
			["first", "size", "How many widgets to return.", { kind: "INT", value: "20" }, true],
			[
				"after",
				"from",
				"An opaque cursor from this connection, an edge's or `pageInfo.endCursor`: the items after it.",
				undefined,
				true,
			],
			["q", "q", undefined, undefined, true],
		]);
	});

	/**
	 * design.md: an explicit `null` for an optional parameter that is not `| null` is dropped, and a
	 * required `| null` one, which GraphQL can only state as nullable, is written as `null` when the
	 * caller leaves it out.
	 */
	it("state each parameter's null rules: drop a null where optional, write one where required and | null", () => {
		const stamps = queryInputsOf(
			service.program,
			rootField(service, "Stamps_read", "query", "stamps"),
			projector(),
			undefined,
		).arguments;
		const widgets = queryInputsOf(
			service.program,
			rootField(service, "Widgets_list", "query", "widgets"),
			projector(),
			undefined,
		).arguments;
		expect(
			[...stamps, ...widgets]
				.filter((arg) => ["X-Since", "X-Maybe", "page-size"].includes(arg.wire))
				.map((arg) => [arg.wire, arg.dropNull, arg.nullIfAbsent]),
		).toEqual([
			["X-Since", false, false],
			["X-Maybe", false, true],
			["page-size", true, false],
		]);
	});

	/** A link's anonymous types are named after its parent and its own name, and owned by the link. */
	it("leave a link's bound parameters out of its arguments, and name its anonymous types after the link", () => {
		const book = new NameBook();
		const types = projector(book);
		const field = linkField(service, "Inputs.Widget", "owner", "Owners_read", {
			ownerId: "ownerId",
		});
		const { arguments: args } = queryInputsOf(service.program, field, types, undefined);
		expect(args.map((arg) => [arg.name, arg.wire, arg.type])).toEqual([
			["verbose", "verbose", named("Boolean", false)],
			["view", "view", named("WidgetOwnerView", false)],
		]);
		expect(book.owners("WidgetOwnerView")).toEqual(["link Widget.owner(view)"]);
	});

	/** Only a header is HTTP mechanics: a single-literal query parameter is still asked for. */
	it("supply the negotiated accept rather than ask for it, and ask for a single-literal query parameter", () => {
		const field = rootField(service, "Reports_asJson", "query", "report");
		const { arguments: args, supplied } = queryInputsOf(
			service.program,
			field,
			projector(),
			undefined,
		);
		expect(args.map((arg) => [arg.name, arg.wire])).toEqual([["version", "version"]]);
		expect(supplied).toEqual({ accept: "application/json" });
	});

	it("take a POST search's spread body as arguments of its own, after its parameters", () => {
		const field = rootField(service, "Widgets_search", "query", "searchWidgets");
		const { arguments: args } = queryInputsOf(service.program, field, projector(), undefined);
		expect(args.map((arg) => [arg.name, arg.wire, arg.type, arg.merge])).toEqual([
			["limit", "limit", named("Int", false), false],
			["text", "text", named("String", true), false],
			["tags", "tags", listOf(named("String", true), false), false],
		]);
	});

	it("take one JSON input, in place of every argument, where the spread body is open", () => {
		const field = rootField(service, "Labelled_search", "query", "searchLabels");
		expect(queryInputsOf(service.program, field, projector(), undefined)).toEqual({
			arguments: [OPEN_INPUT],
			supplied: {},
		});
	});
});

/**
 * **A date-time header with no `@encode` is RFC 7231**, as TypeSpec sends a header by default. The
 * expected types are read off the document `@typespec/openapi3` publishes for `inputs.tsp`: `http-date`
 * for a standard `utcDateTime` or `offsetDateTime` header with no `@encode`, its own or inside a
 * `@bodyRoot`, or `| null`; `date-time` for an explicit `rfc3339`, a declared scalar (a `$ref`), a header list's
 * items and a query parameter.
 */
describe("date-time headers", () => {
	it("take a standard date-time header with no @encode as RFC 7231, and leave every other date-time as it is published", () => {
		const field = rootField(service, "Stamps_read", "query", "stamps");
		const { arguments: args } = queryInputsOf(service.program, field, projector(), undefined);
		expect(args.map((arg) => [arg.wire, arg.type])).toEqual([
			["X-Since", named("UTCDateTimeHuman", true)],
			["X-Offset", named("OffsetDateTimeHuman", true)],
			["X-Iso", named("UTCDateTime", true)],
			["X-Human", named("UTCDateTimeHuman", true)],
			["X-Stamp", named("UTCDateTime", true)],
			["X-Stamps", listOf(named("UTCDateTime", true), true)],
			["X-Maybe", named("UTCDateTimeHuman", false)],
			["at", named("UTCDateTime", true)],
		]);
	});

	it("take a date-time header inside a @bodyRoot model as RFC 7231", () => {
		const types = projector();
		mutationInputsOf(
			service.program,
			rootField(service, "Stamps_touch", "mutation", "touchStamps"),
			types,
		);
		expect(
			inputDef(types, "TouchStampsInput").fields.map((field) => [field.wire, field.type]),
		).toEqual([
			["If-Unmodified-Since", named("UTCDateTimeHuman", true)],
			["name", named("String", true)],
		]);
	});
});

describe("mutation input", () => {
	it("take one input argument, merged into the handler's input, of type <Name>Input!", () => {
		const types = projector();
		const field = rootField(service, "Widgets_create", "mutation", "createWidget");
		const { arguments: args } = mutationInputsOf(service.program, field, types);
		expect(args).toEqual([
			{
				name: "input",
				wire: "input",
				type: named("CreateWidgetInput", true),
				description: undefined,
				deprecationReason: undefined,
				dropNull: false,
				nullIfAbsent: false,
				defaultValue: undefined,
				merge: true,
			},
		]);
	});

	it("spread a body the library spreads: one field per property sent, by JSON name", () => {
		const types = projector();
		mutationInputsOf(
			service.program,
			rootField(service, "Widgets_create", "mutation", "createWidget"),
			types,
		);
		expect(
			inputDef(types, "CreateWidgetInput").fields.map((field) => [
				field.name,
				field.wire,
				field.dropNull,
			]),
		).toEqual([
			// Read-only, and sent: the body is `Widget`'s canonical schema, as the library validates it.
			["id", "id", false],
			["name", "name", false],
			["ownerId", "owner_id", false],
			["note", "note", true],
			["colour", "colour", false],
		]);
	});

	/**
	 * The library names an optional body, a union and a body sharing a key with a parameter. Its
	 * null rules are a parameter's: an optional body drops an explicit `null`, and a required
	 * `| null` one is written as `null` when the caller leaves it out. Its doc is its property's,
	 * so an implicit body, which has no property, has none.
	 */
	it.each([
		{
			body: "an optional body, nullable",
			operationId: "Owners_create",
			field: "createOwner",
			input: "CreateOwnerInput",
			parameter: { wire: "region", type: named("String", true), dropNull: false },
			type: named("OwnerInput", false),
			description: undefined,
			nulls: { dropNull: true, nullIfAbsent: false },
		},
		{
			body: "a required body, non-null and documented",
			operationId: "Widgets_rename",
			field: "renameWidget",
			input: "RenameWidgetInput",
			parameter: { wire: "name", type: named("String", true), dropNull: false },
			type: named("RenameWidgetBodyInput", true),
			description: "The widget's new name.",
			nulls: { dropNull: false, nullIfAbsent: false },
		},
		{
			body: "a required | null body, nullable",
			operationId: "Owners_replace",
			field: "replaceOwner",
			input: "ReplaceOwnerInput",
			parameter: { wire: "region", type: named("String", true), dropNull: false },
			type: named("OwnerInput", false),
			description: undefined,
			nulls: { dropNull: false, nullIfAbsent: true },
		},
		{
			body: "an implicit body, with no doc",
			operationId: "Widgets_annotate",
			field: "annotateWidget",
			input: "AnnotateWidgetInput",
			parameter: { wire: "note", type: named("String", false), dropNull: true },
			type: named("AnnotateWidgetBodyInput", true),
			description: undefined,
			nulls: { dropNull: false, nullIfAbsent: false },
		},
	])(
		"keep $body as one field under its key, beside its parameters",
		({ operationId, field, input, parameter, type, description, nulls }) => {
			const types = projector();
			mutationInputsOf(service.program, rootField(service, operationId, "mutation", field), types);
			expect(inputDef(types, input).fields).toEqual([
				{
					name: parameter.wire,
					wire: parameter.wire,
					type: parameter.type,
					description: undefined,
					deprecationReason: undefined,
					dropNull: parameter.dropNull,
					nullIfAbsent: false,
					defaultValue: undefined,
				},
				{
					name: "body",
					wire: "body",
					type,
					description,
					deprecationReason: undefined,
					...nulls,
					defaultValue: undefined,
				},
			]);
		},
	);

	it("name a named body's anonymous type after the field and the body", () => {
		const book = new NameBook();
		mutationInputsOf(
			service.program,
			rootField(service, "Widgets_rename", "mutation", "renameWidget"),
			projector(book),
		);
		expect(book.owners("RenameWidgetBodyInput")).toEqual(["mutation renameWidget body as input"]);
	});

	it("take one JSON input, in place of an input type, where the spread body is open", () => {
		const types = projector();
		const inputs = mutationInputsOf(
			service.program,
			rootField(service, "Labelled_label", "mutation", "label"),
			types,
		);
		expect(inputs).toEqual({ arguments: [OPEN_INPUT], supplied: {} });
		expect(types.defs().map((def) => def.name)).not.toContain("LabelInput");
	});

	it("supply a single-literal content-type and keep a required precondition header", () => {
		const types = projector();
		const { supplied } = mutationInputsOf(
			service.program,
			rootField(service, "Widgets_update", "mutation", "updateWidget"),
			types,
		);
		expect(supplied).toEqual({ "Content-Type": "application/merge-patch+json" });
		const wires = inputDef(types, "UpdateWidgetInput").fields.map((field) => field.wire);
		expect(wires).toContain("If-Match");
		expect(wires).not.toContain("Content-Type");
		expect(wires).toEqual(["widgetId", "If-Match", "id", "name", "owner_id", "note", "colour"]);
	});

	it("take no argument at all when the operation has no input", () => {
		const types = projector();
		const inputs = mutationInputsOf(
			service.program,
			rootField(service, "Widgets_ping", "mutation", "ping"),
			types,
		);
		expect(inputs).toEqual({ arguments: [], supplied: {} });
		expect(types.defs().map((def) => def.name)).not.toContain("PingInput");
	});
});

/**
 * **What the planner takes on trust, refused when it is broken.** surface.ts refuses parts before
 * planning (`non-json-request`), and connections.ts names a paging parameter only by the key of one
 * the operation has; handed either anyway, the planner throws rather than plan an input the handler
 * cannot receive.
 */
describe("the planner's invariants", () => {
	it("refuse an unnamed body that is no model", () => {
		const field = rootField(service, "Widgets_upload", "mutation", "upload");
		expect(() => mutationInputsOf(service.program, field, projector())).toThrow(
			new Error("upload: an unnamed body that is no model"),
		);
	});

	it("refuse a connection naming a paging parameter the operation does not have", () => {
		const field = rootField(service, "Widgets_list", "query", "widgets");
		expect(() =>
			queryInputsOf(service.program, field, projector(), { ...PAGING, first: "size" }),
		).toThrow(new Error("widgets: no paging parameter size"));
	});
});
