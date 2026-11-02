import { buildOperationNodeForField } from "@graphql-tools/utils";
import {
	buildSchema,
	type FieldNode,
	type OperationDefinitionNode,
	parse,
	print,
	type SelectionSetNode,
	validate,
	visit,
} from "graphql";
import { describe, expect, it } from "vitest";
import {
	type ArgumentPlan,
	type CallPlan,
	type ConnectionPlan,
	listOf,
	named,
	type OutputFieldPlan,
	type Projection,
	type TypeDef,
	type TypeRef,
} from "../../src/model.js";
import { writtenRequestOf } from "../../src/requests.js";

/**
 * **The document `graphqlRequestsOf` writes for a root field, from a plan built by hand**, so each
 * rule is graded alone, and from `src/`, where the mutation run can see it. Every expected document
 * is written out from the rule it grades, not read back from the code: Apollo Federation's decision
 * (the first field under a name keeps it, a later one is compared with it and needs the same field
 * and a response shape that merges), graphql-tools' spelling for the alias (`<name><Type>`, `!` as
 * `NonNull`, `[` as `List`, `]` dropped), and `__alias_<n>` after a name already taken. Each
 * document is also validated, against a schema written out by hand from the same plan.
 */

const S = (name: string): TypeRef => named(name, true);
const N = (name: string): TypeRef => named(name, false);
const L = (of: TypeRef): TypeRef => listOf(of, true);

function plain(name: string, type: TypeRef, extra: Partial<OutputFieldPlan> = {}): OutputFieldPlan {
	return {
		name,
		wire: name,
		type,
		description: undefined,
		deprecationReason: undefined,
		arguments: [],
		call: undefined,
		directives: [],
		...extra,
	};
}

function argument(name: string, type: TypeRef, extra: Partial<ArgumentPlan> = {}): ArgumentPlan {
	return {
		name,
		wire: name,
		type,
		description: undefined,
		deprecationReason: undefined,
		dropNull: false,
		nullIfAbsent: false,
		defaultValue: undefined,
		merge: false,
		...extra,
	};
}

function callOf(
	projection: Readonly<Record<string, Projection>>,
	connection?: ConnectionPlan,
): CallPlan {
	return {
		kind: "query",
		operationId: "Books_read",
		authentication: "none",
		security: [],
		inputSchema: "Books_readGraphQLInput",
		responses: "Books_readResponses",
		bound: [],
		supplied: {},
		projection,
		connection,
	};
}

function object(name: string, fields: readonly OutputFieldPlan[]): TypeDef {
	return { kind: "object", name, description: undefined, fields };
}

function union(name: string, members: readonly string[], discriminator?: string): TypeDef {
	return {
		kind: "union",
		name,
		description: undefined,
		members,
		resolveBy:
			discriminator === undefined
				? { kind: "member" }
				: { kind: "discriminator", property: discriminator, mapping: {} },
	};
}

function enumeration(name: string): TypeDef {
	return {
		kind: "enum",
		name,
		description: undefined,
		values: [
			{ name: "DRAFT", wire: "draft", description: undefined, deprecationReason: undefined },
		],
	};
}

function scalar(name: string): TypeDef {
	return { kind: "scalar", name, description: undefined, specifiedBy: undefined, json: "integer" };
}

/** A query field `read` of `type`, every 2xx member a success. */
function rootOf(
	type: TypeRef,
	projection: Readonly<Record<string, Projection>> = { "200": { as: "value" } },
	extra: Partial<OutputFieldPlan> = {},
): OutputFieldPlan {
	return plain("read", type, { call: callOf(projection), ...extra });
}

/** The lines of a document's result selection, without its operation and field lines. */
const body = (document: string): string[] => document.split("\n").slice(2, -2);

/** The call a hand-built root field makes, which every root field has. */
function callFor(root: OutputFieldPlan): CallPlan {
	if (root.call === undefined) throw new Error(`${root.name} has no call`);
	return root.call;
}

/** The SDL a hand-built plan stands for, so a document can be validated against it. */
function sdlOf(types: readonly TypeDef[], root: OutputFieldPlan): string {
	const text = (ref: TypeRef): string =>
		`${ref.kind === "list" ? `[${text(ref.of)}]` : ref.name}${ref.nonNull ? "!" : ""}`;
	const defaulted = (arg: ArgumentPlan): string =>
		arg.defaultValue?.kind === "STRING" ? ` = ${JSON.stringify(arg.defaultValue.value)}` : "";
	const args = (field: OutputFieldPlan): string =>
		field.arguments.length === 0
			? ""
			: `(${field.arguments.map((arg) => `${arg.name}: ${text(arg.type)}${defaulted(arg)}`).join(", ")})`;
	const fields = (list: readonly OutputFieldPlan[]) =>
		list.map((field) => `  ${field.name}${args(field)}: ${text(field.type)}`).join("\n");
	return [
		"scalar Long",
		...types.map((type) => {
			switch (type.kind) {
				case "object":
					return `type ${type.name} {\n${fields(type.fields)}\n}`;
				case "interface":
					return `interface ${type.name} {\n${fields(type.fields)}\n}`;
				case "union":
					return `union ${type.name} = ${type.members.join(" | ")}`;
				case "enum":
					return `enum ${type.name} { ${type.values.map((value) => value.name).join(" ")} }`;
				case "scalar":
					return type.name === "Long" ? "" : `scalar ${type.name}`;
				default:
					return "";
			}
		}),
		`type Query {\n${fields([root])}\n}`,
	].join("\n\n");
}

/** The document for `root` over `types`, validated against the schema they make. */
function written(types: readonly TypeDef[], root: OutputFieldPlan) {
	const request = writtenRequestOf(
		new Map(types.map((type) => [type.name, type])),
		"query",
		root,
		callFor(root),
	);
	const errors = validate(buildSchema(sdlOf(types, root)), parse(request.document));
	expect(errors.map((error) => error.message)).toEqual([]);
	return request;
}

/** Two or more members, each an object of the given fields, under one union `Result`. */
function membersOf(
	members: Readonly<Record<string, readonly OutputFieldPlan[]>>,
	extra: readonly TypeDef[] = [],
): readonly TypeDef[] {
	return [
		union("Result", Object.keys(members)),
		...Object.entries(members).map(([name, fields]) => object(name, fields)),
		...extra,
	];
}

const unionRoot = (members: readonly string[]) =>
	rootOf(
		N("Result"),
		Object.fromEntries(
			members.map((member, index) => [String(200 + index), { as: "member", type: member }]),
		),
	);

describe("a document's result selection", () => {
	it("keeps the name two members share with one response shape", () => {
		const types = membersOf({
			Book: [plain("title", S("String")), plain("labels", L(S("String")))],
			Shelved: [plain("title", S("String")), plain("labels", L(S("String")))],
		});
		expect(body(written(types, unionRoot(["Book", "Shelved"])).document)).toEqual([
			"    __typename",
			"    ... on Book {",
			"      title",
			"      labels",
			"    }",
			"    ... on Shelved {",
			"      title",
			"      labels",
			"    }",
		]);
	});

	it("aliases a later member's field of another leaf type, never the first's", () => {
		const types = membersOf(
			{ Book: [plain("status", S("BookStatus"))], Problem: [plain("status", S("Int"))] },
			[enumeration("BookStatus")],
		);
		expect(body(written(types, unionRoot(["Book", "Problem"])).document)).toEqual([
			"    __typename",
			"    ... on Book {",
			"      status",
			"    }",
			"    ... on Problem {",
			"      statusIntNonNull: status",
			"    }",
		]);
	});

	it("aliases nullability alone, whichever member is nullable", () => {
		const nullableFirst = membersOf({
			Book: [plain("title", N("String"))],
			Problem: [plain("title", S("String"))],
		});
		expect(body(written(nullableFirst, unionRoot(["Book", "Problem"])).document)).toContain(
			"      titleStringNonNull: title",
		);
		const nonNullFirst = membersOf({
			Book: [plain("title", S("String"))],
			Problem: [plain("title", N("String"))],
		});
		expect(body(written(nonNullFirst, unionRoot(["Book", "Problem"])).document)).toContain(
			"      titleString: title",
		);
	});

	it("aliases a list beside one value, and a list whose items differ in nullability", () => {
		const single = membersOf({
			Book: [plain("labels", L(S("String")))],
			Shelved: [plain("labels", S("String"))],
		});
		expect(body(written(single, unionRoot(["Book", "Shelved"])).document)).toContain(
			"      labelsStringNonNull: labels",
		);
		const items = membersOf({
			Book: [plain("labels", L(S("String")))],
			Shelved: [plain("labels", L(N("String")))],
		});
		expect(body(written(items, unionRoot(["Book", "Shelved"])).document)).toContain(
			"      labelsListStringNonNull: labels",
		);
		const nested = membersOf({
			Book: [plain("grid", L(S("Int")))],
			Shelved: [plain("grid", L(L(S("Int"))))],
		});
		expect(body(written(nested, unionRoot(["Book", "Shelved"])).document)).toContain(
			"      gridListListIntNonNullNonNullNonNull: grid",
		);
	});

	it("compares every later member with the first, so members of one shape share one alias", () => {
		const types = membersOf({
			Book: [plain("edition", S("Int"))],
			Shelved: [plain("edition", S("String"))],
			Reserved: [plain("edition", S("String"))],
			Lent: [plain("edition", S("Boolean"))],
		});
		expect(
			body(written(types, unionRoot(["Book", "Shelved", "Reserved", "Lent"])).document),
		).toEqual([
			"    __typename",
			"    ... on Book {",
			"      edition",
			"    }",
			"    ... on Shelved {",
			"      editionStringNonNull: edition",
			"    }",
			"    ... on Reserved {",
			"      editionStringNonNull: edition",
			"    }",
			"    ... on Lent {",
			"      editionBooleanNonNull: edition",
			"    }",
		]);
	});

	it("takes no name a field of the set is selected by, counting on from __alias_0", () => {
		const types = membersOf(
			{
				Book: [plain("status", S("BookStatus"))],
				Problem: [plain("status", S("Int"))],
				Rejected: [
					plain("statusIntNonNull", S("String")),
					plain("statusIntNonNull__alias_0", S("Boolean")),
				],
			},
			[enumeration("BookStatus")],
		);
		expect(body(written(types, unionRoot(["Book", "Problem", "Rejected"])).document)).toEqual([
			"    __typename",
			"    ... on Book {",
			"      status",
			"    }",
			"    ... on Problem {",
			"      statusIntNonNull__alias_1: status",
			"    }",
			"    ... on Rejected {",
			"      statusIntNonNull",
			"      statusIntNonNull__alias_0",
			"    }",
		]);
	});

	it("merges two objects answering under one name, and aliases a leaf below them", () => {
		const types: readonly TypeDef[] = [
			union("Edition", ["EditionPrint", "EditionDigital"], "kind"),
			object("EditionPrint", [plain("kind", S("String")), plain("value", S("Printed"))]),
			object("EditionDigital", [plain("kind", S("String")), plain("value", S("Digital"))]),
			object("Printed", [plain("pages", S("Int"))]),
			object("Digital", [plain("pages", S("Long"))]),
			scalar("Long"),
		];
		expect(body(written(types, rootOf(N("Edition"))).document)).toEqual([
			"    __typename",
			"    ... on EditionPrint {",
			"      kind",
			"      value {",
			"        __typename",
			"        pages",
			"      }",
			"    }",
			"    ... on EditionDigital {",
			"      kind",
			"      value {",
			"        __typename",
			"        pagesLongNonNull: pages",
			"      }",
			"    }",
		]);
	});

	it("aliases an object beside a leaf, and a non-null object beside a nullable one", () => {
		const leafFirst = membersOf(
			{ Shelf: [plain("value", S("Int"))], ShelfAccepted: [plain("value", S("Printed"))] },
			[object("Printed", [plain("pages", S("Int"))])],
		);
		expect(body(written(leafFirst, unionRoot(["Shelf", "ShelfAccepted"])).document)).toContain(
			"      valuePrintedNonNull: value {",
		);
		const nullable = membersOf(
			{
				ShelfMoved: [plain("value", S("Printed"))],
				ShelfAccepted: [plain("value", N("Digital"))],
			},
			[
				object("Printed", [plain("pages", S("Int"))]),
				object("Digital", [plain("bytes", S("Int"))]),
			],
		);
		expect(body(written(nullable, unionRoot(["ShelfMoved", "ShelfAccepted"])).document)).toContain(
			"      valueDigital: value {",
		);
	});

	/**
	 * Two variants of a union no envelope wraps, each a payload object beside the discriminator, whose
	 * aliases are spelled alike: `ab` of `CDNonNull` and `abC` of `DNonNull`. The objects merge, so only
	 * the rule that one name is one field keeps the second off the first's alias.
	 */
	it("never answers two different fields under one alias, even where their shapes merge", () => {
		const types: readonly TypeDef[] = [
			union("Copy", ["Hardback", "Audio", "Paperback", "Ebook"], "kind"),
			object("Hardback", [plain("kind", S("String")), plain("ab", S("Int"))]),
			object("Audio", [plain("kind", S("String")), plain("abC", S("Int"))]),
			object("Paperback", [plain("kind", S("String")), plain("ab", S("CD"))]),
			object("Ebook", [plain("kind", S("String")), plain("abC", S("D"))]),
			object("CD", [plain("pages", S("Int"))]),
			object("D", [plain("bytes", S("Int"))]),
		];
		const lines = body(written(types, rootOf(N("Copy"))).document);
		expect(lines).toContain("      abCDNonNull: ab {");
		expect(lines).toContain("      abCDNonNull__alias_0: abC {");
	});

	it("selects neither a link nor a field taking a required argument, as a leaf or a payload", () => {
		const link = callOf({ "200": { as: "value" } });
		const types: readonly TypeDef[] = [
			union("Copy", ["Paperback", "Wrapped", "Ebook"], "kind"),
			object("Paperback", [
				plain("kind", S("String")),
				plain("format", N("Format"), { call: link }),
			]),
			object("Wrapped", [plain("value", N("Format"), { arguments: [argument("size", S("Int"))] })]),
			object("Ebook", [
				plain("kind", S("String")),
				plain("bytes", S("Int"), { arguments: [argument("unit", S("String"))] }),
				plain("pages", S("Int"), {
					arguments: [
						argument("unit", S("String"), { defaultValue: { kind: "STRING", value: "a" } }),
					],
				}),
				plain("words", S("Int"), { arguments: [argument("unit", N("String"))] }),
				plain("rating", S("Int"), { call: link }),
				plain("reviews", S("Int"), {
					keyed: {
						property: "kind",
						arms: [{ values: ["ebook"], call: link, arguments: [], member: undefined }],
					},
				}),
			]),
			object("Format", [plain("binding", S("String"))]),
		];
		expect(body(written(types, rootOf(N("Copy"))).document)).toEqual([
			"    __typename",
			"    ... on Paperback {",
			"      kind",
			"    }",
			"    ... on Wrapped {",
			"      __typename",
			"    }",
			"    ... on Ebook {",
			"      kind",
			"      pages",
			"      words",
			"    }",
		]);
	});

	it("writes a connection through its nodes and its page's cursor", () => {
		const connection: ConnectionPlan = {
			items: "items",
			next: "next",
			first: "limit",
			after: "cursor",
			item: named("Book", true),
			maximum: undefined,
			assumedSize: undefined,
		};
		const types: readonly TypeDef[] = [
			object("BookConnection", [plain("nodes", L(S("Book"))), plain("pageInfo", S("PageInfo"))]),
			object("PageInfo", [plain("hasNextPage", S("Boolean")), plain("endCursor", N("String"))]),
			object("Book", [plain("id", S("String"))]),
		];
		const root = plain("read", N("BookConnection"), {
			call: callOf({ "200": { as: "connection" } }, connection),
		});
		const request = written(types, root);
		expect(body(request.document)).toEqual([
			"    __typename",
			"    nodes {",
			"      __typename",
			"      id",
			"    }",
			"    pageInfo {",
			"      hasNextPage",
			"      endCursor",
			"    }",
		]);
		expect([...request.resultPathsOf(["items", "0", "id"])]).toEqual([]);
		expect([...request.resultPathsOf([])]).toEqual([]);
		const withoutNodes = [
			object("BookConnection", [plain("pageInfo", S("PageInfo"))]),
			...types.slice(1),
		];
		expect(() =>
			writtenRequestOf(
				new Map(withoutNodes.map((type) => [type.name, type])),
				"query",
				root,
				callFor(root),
			),
		).toThrow("BookConnection has no nodes field");
	});

	it("selects no object field but a payload: one field named value, or the envelope beside the discriminator", () => {
		const types: readonly TypeDef[] = [
			union("Copy", ["Moved", "Priced", "Bound", "Labelled", "Boxed"], "kind"),
			// One field, an object not named `value`: no payload.
			object("Moved", [plain("price", S("Price"))]),
			// Two fields, the first named `value`, the second no discriminator: no payload.
			object("Priced", [plain("value", S("Price")), plain("note", S("String"))]),
			// The discriminator and two objects: no payload.
			object("Bound", [
				plain("kind", S("String")),
				plain("cover", S("Price")),
				plain("spine", S("Price")),
			]),
			// Two fields whose first is not the discriminator: no payload.
			object("Labelled", [plain("label", S("String")), plain("price", S("Price"))]),
			// The discriminator and one object: that object is the payload.
			object("Boxed", [plain("kind", S("String")), plain("box", S("Price"))]),
			object("Price", [plain("amount", S("Int"))]),
		];
		expect(body(written(types, rootOf(N("Copy"))).document)).toEqual([
			"    __typename",
			"    ... on Moved {",
			"      __typename",
			"    }",
			"    ... on Priced {",
			"      note",
			"    }",
			"    ... on Bound {",
			"      kind",
			"    }",
			"    ... on Labelled {",
			"      label",
			"    }",
			"    ... on Boxed {",
			"      kind",
			"      box {",
			"        __typename",
			"        amount",
			"      }",
			"    }",
		]);
		const unresolved = [union("Copy", ["Boxed"]), ...types.slice(-2)];
		expect(body(written(unresolved, rootOf(N("Copy"))).document)).toEqual([
			"    __typename",
			"    ... on Boxed {",
			"      kind",
			"    }",
		]);
	});

	it("merges an object beside an interface and beside a union, both composite", () => {
		const types: readonly TypeDef[] = [
			union("Edition", ["EditionPrint", "EditionDigital", "EditionBoxed"], "kind"),
			object("EditionPrint", [plain("kind", S("String")), plain("value", S("Printed"))]),
			object("EditionDigital", [plain("kind", S("String")), plain("value", S("Medium"))]),
			object("EditionBoxed", [plain("kind", S("String")), plain("value", S("Set"))]),
			object("Printed", [plain("pages", S("Int"))]),
			{
				kind: "interface",
				name: "Medium",
				description: undefined,
				fields: [plain("pages", S("Int"))],
			},
			union("Set", ["Printed"]),
		];
		expect(body(written(types, rootOf(N("Edition"))).document)).toEqual([
			"    __typename",
			"    ... on EditionPrint {",
			"      kind",
			"      value {",
			"        __typename",
			"        pages",
			"      }",
			"    }",
			"    ... on EditionDigital {",
			"      kind",
			"      value {",
			"        __typename",
			"        pages",
			"      }",
			"    }",
			"    ... on EditionBoxed {",
			"      kind",
			"      value {",
			"        __typename",
			"        ... on Printed {",
			"          pages",
			"        }",
			"      }",
			"    }",
		]);
	});

	it("names an operation with no argument without parentheses", () => {
		const types = [object("Book", [plain("id", S("String"))])];
		expect(
			written(types, rootOf(N("Book")))
				.document.split("\n")
				.slice(0, 2),
		).toEqual(["query Read {", "  read {"]);
	});

	it("declares and passes each of several arguments, separated", () => {
		const types = [object("Book", [plain("id", S("String"))]), enumeration("Format")];
		const root = rootOf(
			N("Book"),
			{ "200": { as: "value" } },
			{ arguments: [argument("id", S("String")), argument("format", N("Format"))] },
		);
		expect(written(types, root).document.split("\n").slice(0, 2)).toEqual([
			"query Read($id: String!, $format: Format) {",
			"  read(id: $id, format: $format) {",
		]);
	});

	it("refuses a selection of a type the plan does not define", () => {
		const types = [union("Result", ["Book"])];
		const root = unionRoot(["Book"]);
		expect(() =>
			writtenRequestOf(
				new Map(types.map((type) => [type.name, type])),
				"query",
				root,
				callFor(root),
			),
		).toThrow("the plan defines no type Book");
	});

	/**
	 * **A recursive type is cut where `@graphql-tools/utils`' `buildOperationNodeForField` cuts one**,
	 * at its default `circularReferenceDepth` of 1: a field whose type is an object the selection is
	 * already inside a field of is left out, and so is a union's member that is one; a union never
	 * counts. So `Negate`'s `operand` is selected once, without `Negate` among its members, and
	 * `Twice`'s `again` once, without its own `again`.
	 */
	const filter: readonly TypeDef[] = [
		union("Filter", ["Eq", "Negate", "Twice"], "kind"),
		object("Eq", [plain("kind", S("String")), plain("value", S("String"))]),
		object("Negate", [plain("kind", S("String")), plain("operand", S("Filter"))]),
		object("Twice", [plain("kind", S("String")), plain("again", S("Twice"))]),
	];
	/** A member reached again inside itself, through another union: left out there. */
	const reentered: readonly TypeDef[] = [
		union("Holding", ["Shelved", "Boxed"], "kind"),
		object("Shelved", [plain("kind", S("String")), plain("value", S("Stored"))]),
		object("Boxed", [plain("kind", S("String")), plain("label", S("String"))]),
		union("Stored", ["Shelved", "Loaned"], "kind"),
		object("Loaned", [plain("kind", S("String")), plain("due", S("String"))]),
	];
	/** A variant holding a list of the union it is a variant of. */
	const nestedRules: readonly TypeDef[] = [
		union("Rule", ["TitleIs", "AllOf"], "kind"),
		object("TitleIs", [plain("kind", S("String")), plain("title", S("String"))]),
		object("AllOf", [plain("kind", S("String")), plain("rules", L(S("Rule")))]),
	];

	it("cuts a recursive union where graphql-tools cuts one", () => {
		expect(body(written(filter, rootOf(N("Filter"))).document)).toEqual([
			"    __typename",
			"    ... on Eq {",
			"      kind",
			"      value",
			"    }",
			"    ... on Negate {",
			"      kind",
			"      operand {",
			"        __typename",
			"        ... on Eq {",
			"          kind",
			"          value",
			"        }",
			"        ... on Twice {",
			"          kind",
			"          again {",
			"            __typename",
			"            kind",
			"          }",
			"        }",
			"      }",
			"    }",
			"    ... on Twice {",
			"      kind",
			"      again {",
			"        __typename",
			"        kind",
			"      }",
			"    }",
		]);
		const wrapper = [object("Node", [plain("value", N("Node"))])];
		expect(body(written(wrapper, rootOf(N("Node"))).document)).toEqual([
			"    __typename",
			"    value {",
			"      __typename",
			"    }",
		]);
	});

	it("leaves out a union's member the selection is already inside a field of", () => {
		expect(body(written(reentered, rootOf(N("Holding"))).document)).toEqual([
			"    __typename",
			"    ... on Shelved {",
			"      kind",
			"      value {",
			"        __typename",
			"        ... on Loaned {",
			"          kind",
			"          due",
			"        }",
			"      }",
			"    }",
			"    ... on Boxed {",
			"      kind",
			"      label",
			"    }",
		]);
	});

	/**
	 * **The same cut as `buildOperationNodeForField`'s own document**, run on the schema each plan
	 * stands for: the root field's selection, `__typename` aside, which that function does not write.
	 */
	it.each([
		["a union whose variants hold it", filter, "Filter"],
		["a member reached again inside itself", reentered, "Holding"],
		["a variant holding a list of its union", nestedRules, "Rule"],
	])("selects as graphql-tools does for %s", (_case, types, root) => {
		const field = rootOf(N(root));
		const schema = buildSchema(sdlOf(types, field));
		const theirs = buildOperationNodeForField({ schema, kind: "query" as never, field: "read" });
		const ours = parse(written(types, field).document).definitions[0];
		const selectionOf = (operation: unknown): string => {
			const { selectionSet } = operation as OperationDefinitionNode;
			const [read] = selectionSet.selections;
			return print(
				visit((read as FieldNode).selectionSet as SelectionSetNode, {
					Field: (node) => (node.name.value === "__typename" ? null : undefined),
				}),
			);
		};
		expect(selectionOf(ours)).toBe(selectionOf(theirs));
	});

	it("selects a payload of another type, below one of the same type, once", () => {
		const nested: readonly TypeDef[] = [
			object("Outer", [plain("value", S("Middle"))]),
			object("Middle", [plain("value", S("Inner"))]),
			object("Inner", [plain("id", S("String")), plain("outer", N("Outer"))]),
		];
		expect(body(written(nested, rootOf(N("Outer"))).document)).toEqual([
			"    __typename",
			"    value {",
			"      __typename",
			"      value {",
			"        __typename",
			"        id",
			"      }",
			"    }",
		]);
	});

	it("writes a field of a leaf type with no selection, and finds nothing in it", () => {
		const root = rootOf(
			S("Int"),
			{ "200": { as: "value" } },
			{
				arguments: [argument("id", S("String"))],
			},
		);
		const request = writtenRequestOf(new Map(), "query", root, callFor(root));
		expect(request.document).toBe(
			["query Read($id: String!) {", "  read(id: $id)", "}"].join("\n"),
		);
		expect([...request.resultPathsOf([])]).toEqual([]);
	});
});

describe("where a success answer holds a value of the REST body", () => {
	const types = membersOf({
		Book: [plain("id", S("String")), plain("pageCount", S("Int"), { wire: "page_count" })],
		Problem: [plain("id", S("Int"))],
		Shelved: [plain("id", S("Int"))],
		BookListed: [plain("value", L(S("Book")))],
		BookDeleted: [plain("success", S("Boolean"))],
	});
	const root = rootOf(N("Result"), {
		"200": { as: "member", type: "Book" },
		"202": { as: "wrap", type: "BookListed", hasBody: true },
		"204": { as: "wrap", type: "BookDeleted", hasBody: false },
		"2XX": { as: "member", type: "Shelved" },
		"400": { as: "member", type: "Problem" },
	});

	it("names each success member's path below data, its alias included, by the wire name", () => {
		const request = written(types, root);
		expect(request.successTypenames).toEqual(["Book", "BookListed", "BookDeleted", "Shelved"]);
		expect([...request.resultPathsOf(["id"])]).toEqual([
			["Book", ["read", "id"]],
			["Shelved", ["read", "idIntNonNull"]],
		]);
		expect([...request.resultPathsOf(["page_count"])]).toEqual([["Book", ["read", "pageCount"]]]);
		expect([...request.resultPathsOf(["pageCount"])]).toEqual([]);
	});

	it("finds a wrapper's body under its value, a list's item by its index, and nothing past a leaf", () => {
		const request = written(types, root);
		expect([...request.resultPathsOf([])]).toEqual([
			["Book", ["read"]],
			["BookListed", ["read", "value"]],
			["Shelved", ["read"]],
		]);
		expect(request.resultPathsOf(["2", "page_count"]).get("BookListed")).toEqual([
			"read",
			"value",
			"2",
			"pageCount",
		]);
		expect(request.resultPathsOf(["12", "page_count"]).get("BookListed")).toEqual([
			"read",
			"value",
			"12",
			"pageCount",
		]);
		expect(request.resultPathsOf(["2", "pages"]).get("BookListed")).toBeUndefined();
		expect(request.resultPathsOf(["first", "page_count"]).get("BookListed")).toBeUndefined();
		expect(request.resultPathsOf(["01", "page_count"]).get("BookListed")).toBeUndefined();
		expect(request.resultPathsOf(["id", "length"]).get("Book")).toBeUndefined();
	});

	it("names every member of a union a 2xx arm answers whole, and no member of another projection", () => {
		const edition: readonly TypeDef[] = [
			union("Edition", ["EditionPrint", "EditionDigital"], "kind"),
			object("EditionPrint", [plain("kind", S("String"))]),
			object("EditionDigital", [plain("kind", S("String"))]),
		];
		expect(written(edition, rootOf(N("Edition"))).successTypenames).toEqual([
			"EditionPrint",
			"EditionDigital",
		]);
		const flagged = rootOf(N("Edition"), {
			"200": { as: "true" },
			"201": { as: "member", type: "EditionPrint" },
			"404": { as: "null" },
		});
		expect(written(edition, flagged).successTypenames).toEqual(["EditionPrint"]);
	});

	it("names a field of one object type by that type", () => {
		const one = [object("Book", [plain("id", S("String"))])];
		const request = written(one, rootOf(N("Book")));
		expect(request.successTypenames).toBeUndefined();
		expect([...request.resultPathsOf(["id"])]).toEqual([["Book", ["read", "id"]]]);
	});

	it("finds an item of a list root field by its index, and nothing in the list by a key", () => {
		const books = [object("Book", [plain("id", S("String"))])];
		const request = written(books, rootOf(L(S("Book"))));
		expect([...request.resultPathsOf(["0", "id"])]).toEqual([["Book", ["read", "0", "id"]]]);
		expect([...request.resultPathsOf(["7", "id"])]).toEqual([["Book", ["read", "7", "id"]]]);
		expect([...request.resultPathsOf(["id"])]).toEqual([]);
		expect([...request.resultPathsOf(["01", "id"])]).toEqual([]);
		expect([...request.resultPathsOf([])]).toEqual([["Book", ["read"]]]);
	});

	it("finds an item of a list of a union by its index, under each member's own name", () => {
		const copies = [
			union("Copy", ["Paperback", "Ebook"], "kind"),
			object("Paperback", [plain("kind", S("String")), plain("title", S("String"))]),
			object("Ebook", [plain("kind", S("String")), plain("title", N("String"))]),
		];
		const request = written(copies, rootOf(L(S("Copy"))));
		expect([...request.resultPathsOf(["3", "title"])]).toEqual([
			["Paperback", ["read", "3", "title"]],
			["Ebook", ["read", "3", "titleString"]],
		]);
		expect([...request.resultPathsOf(["title"])]).toEqual([]);
	});

	describe("below a union the answer nests", () => {
		// A 201 wrapping a discriminated union whose members each carry their payload under `value`.
		const nested: readonly TypeDef[] = [
			union("Result", ["Created", "Problem"]),
			object("Created", [plain("value", S("Edition"))]),
			object("Problem", [plain("title", S("String"))]),
			union("Edition", ["EditionPrint", "EditionDigital", "EditionAudio"], "kind"),
			object("EditionPrint", [plain("kind", S("String")), plain("value", S("Printed"))]),
			object("EditionDigital", [plain("kind", S("String")), plain("value", S("Digital"))]),
			object("EditionAudio", [plain("kind", S("String")), plain("value", S("Audio"))]),
			object("Printed", [
				plain("id", S("String")),
				plain("pages", S("Int")),
				plain("title", S("String")),
			]),
			object("Digital", [
				plain("id", S("String")),
				plain("pages", S("Long")),
				plain("title", S("String")),
			]),
			object("Audio", [plain("id", S("String")), plain("minutes", S("Int"))]),
		];
		const created = rootOf(N("Result"), {
			"201": { as: "wrap", type: "Created", hasBody: true },
			"400": { as: "member", type: "Problem" },
		});

		it("finds the value every member holds under one name", () => {
			const request = written(nested, created);
			expect([...request.resultPathsOf(["value", "id"])]).toEqual([
				["Created", ["read", "value", "value", "id"]],
			]);
			expect([...request.resultPathsOf(["kind"])]).toEqual([
				["Created", ["read", "value", "kind"]],
			]);
		});

		it("finds nothing where the members answer it under two names, or one member has none", () => {
			const request = written(nested, created);
			// Printed's `pages` keeps its name, Digital's `Long!` one is aliased, Audio has none.
			expect(request.document).toMatch(/^ +pagesLongNonNull: pages$/m);
			expect([...request.resultPathsOf(["value", "pages"])]).toEqual([]);
			expect([...request.resultPathsOf(["value", "minutes"])]).toEqual([]);
			// Two of three members hold it under one name; the third has none.
			expect([...request.resultPathsOf(["value", "title"])]).toEqual([]);
			// Whichever member is first: one lacking it, or one holding it beside one lacking it.
			const audioFirst = nested.map((type) =>
				type.name === "Edition" ? union("Edition", ["EditionAudio", "EditionPrint"], "kind") : type,
			);
			expect([...written(audioFirst, created).resultPathsOf(["value", "minutes"])]).toEqual([]);
			const printFirst = nested.map((type) =>
				type.name === "Edition" ? union("Edition", ["EditionPrint", "EditionAudio"], "kind") : type,
			);
			expect([...written(printFirst, created).resultPathsOf(["value", "minutes"])]).toEqual([]);
			const twoNames = written(
				nested
					.filter((type) => type.name !== "EditionAudio" && type.name !== "Audio")
					.map((type) =>
						type.name === "Edition"
							? union("Edition", ["EditionPrint", "EditionDigital"], "kind")
							: type,
					),
				created,
			);
			expect([...twoNames.resultPathsOf(["value", "id"])]).toEqual([
				["Created", ["read", "value", "value", "id"]],
			]);
			expect([...twoNames.resultPathsOf(["value", "pages"])]).toEqual([]);
		});
	});
});
