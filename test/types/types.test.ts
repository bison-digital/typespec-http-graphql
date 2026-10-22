import { fileURLToPath } from "node:url";
import type { Model, ModelProperty, Program, Type, Value } from "@typespec/compiler";
import { Visibility } from "@typespec/http";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type DefaultLiteral,
	listOf,
	named,
	type OutputFieldPlan,
	type TypeDef,
	type TypeRef,
} from "../../src/model.js";
import { NameBook } from "../../src/names.js";
import { TypeProjector } from "../../src/types.js";
import { emittedServicesOf } from "../support/compile-fixture.js";
import { refusalsOf } from "../support/refused-fixtures.js";
import { type CompiledService, serviceOf, typeOf } from "../support/service-of.js";

const here = fileURLToPath(new URL(".", import.meta.url));

let service: CompiledService;
beforeAll(async () => {
	service = await serviceOf(here, "types");
});

function fresh(): { projector: TypeProjector; book: NameBook } {
	const book = new NameBook();
	return {
		projector: new TypeProjector(service.program, book, service.emitted.typeSchemaNames),
		book,
	};
}

function model(reference: string): Model {
	const type = typeOf(service, reference);
	if (type.kind !== "Model") throw new Error(`${reference} is a ${type.kind}`);
	return type;
}

/** The identifier the library publishes a declared model's validator under: the expected side. */
function validatorOf(reference: string): string {
	const name = service.emitted.typeSchemaNames.get(model(reference));
	if (name === undefined) throw new Error(`the library publishes no validator for ${reference}`);
	return name;
}

function defOf(projector: TypeProjector, name: string): TypeDef {
	const def = projector.defs().find((candidate) => candidate.name === name);
	if (def === undefined) {
		throw new Error(
			`no def ${name}; have ${projector
				.defs()
				.map((d) => d.name)
				.join(", ")}`,
		);
	}
	return def;
}

function fieldsOf(
	projector: TypeProjector,
	name: string,
): readonly { name: string; wire: string; type: TypeRef }[] {
	const def = defOf(projector, name);
	if (def.kind !== "object" && def.kind !== "input" && def.kind !== "interface") {
		throw new Error(`${name} is a ${def.kind}`);
	}
	return def.fields;
}

function fieldOf(projector: TypeProjector, type: string, field: string): Record<string, unknown> {
	const found = fieldsOf(projector, type).find((candidate) => candidate.name === field);
	if (found === undefined) throw new Error(`${type} has no field ${field}`);
	return found;
}

function propertyOf(reference: string, name: string): ModelProperty {
	const found = model(reference).properties.get(name);
	if (found === undefined) throw new Error(`${reference} has no property ${name}`);
	return found;
}

/** The type a property is declared with: how a test reaches an anonymous model or union. */
function typeAt(reference: string, name: string): Type {
	return propertyOf(reference, name).type;
}

function modelAt(reference: string, name: string): Model {
	const type = typeAt(reference, name);
	if (type.kind !== "Model") throw new Error(`${reference}.${name} is a ${type.kind}`);
	return type;
}

/** A member of `Adrift.held`: an anonymous type no declared model's member holds. */
function looseAt(name: string): Type {
	const found = modelAt("Shapes.Adrift", "held").properties.get(name);
	if (found === undefined) throw new Error(`Adrift.held has no member ${name}`);
	return found.type;
}

/** A union's first variant's type: a value of one variant, arriving in a property of the union. */
function variantOf(type: Type): Type {
	if (type.kind !== "Union") throw new Error(`a ${type.kind} has no variants`);
	const [first] = type.variants.values();
	if (first === undefined) throw new Error("a union with no variant");
	return first.type;
}

function interfacesOf(projector: TypeProjector, name: string): readonly string[] | undefined {
	const def = defOf(projector, name);
	if (def.kind !== "object") throw new Error(`${name} is a ${def.kind}`);
	return def.interfaces;
}

/** The fields of an object as GraphQL states them: name and type. */
function shapeOf(projector: TypeProjector, name: string): [string, TypeRef][] {
	return fieldsOf(projector, name).map((field) => [field.name, field.type]);
}

function reasons(projector: TypeProjector): [string, string][] {
	return projector.warnings.map((warning) => [warning.what, warning.reason]);
}

/** The scalars GraphQL builds in, which a schema names without defining. */
const BUILT_IN = new Set(["String", "Int", "Float", "Boolean", "ID"]);

/** Every type a def refers to that is neither built in nor a def: what `buildSchema` calls unknown. */
function undefinedTypesOf(projector: TypeProjector): string[] {
	const defined = new Set(projector.defs().map((def) => def.name));
	const nameOf = (ref: TypeRef): string => (ref.kind === "named" ? ref.name : nameOf(ref.of));
	return projector.defs().flatMap((def) => {
		const referred =
			def.kind === "object" || def.kind === "input" || def.kind === "interface"
				? def.fields.map((field) => nameOf(field.type))
				: def.kind === "union"
					? def.members
					: [];
		return referred.filter((name) => !defined.has(name) && !BUILT_IN.has(name));
	});
}

describe("a property typed as one member", () => {
	it("of an enum is that enum, with no warning", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Kennel"));
		expect(fieldOf(projector, "Kennel", "status").type).toEqual(named("Status", true));
		expect(projector.warnings).toEqual([]);
	});

	it("of a union is that variant's type, with no warning", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Kennel"));
		expect(fieldOf(projector, "Kennel", "mood").type).toEqual(named("String", true));
		expect(projector.warnings).toEqual([]);
	});
});

describe("a model with no field GraphQL can carry", () => {
	/**
	 * GraphQL forbids an object or input type with no field (spec section 3.6.1, "must define one
	 * or more fields"), so a model with no payload property under the position's visibility is the
	 * `JSON` scalar, as design.md projects every shape GraphQL cannot state, with a warning.
	 */
	it("is JSON as output, with a warning, and registers no empty type", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Holder"));
		expect(fieldOf(projector, "Holder", "empty").type).toEqual(named("JSON", true));
		expect(fieldOf(projector, "Holder", "metadata").type).toEqual(named("JSON", true));
		const names = projector.defs().map((def) => def.name);
		expect(names).not.toContain("Empty");
		expect(names).not.toContain("OnlyMetadata");
		const why =
			"it carries no property GraphQL can state, and a GraphQL type needs at least one field";
		expect(reasons(projector)).toEqual([
			["model Shapes.Holder.empty", why],
			["model Shapes.Holder.metadata", why],
		]);
	});

	it("is JSON as input too, and registers no empty input type", () => {
		const { projector } = fresh();
		projector.input(model("Shapes.Holder"), Visibility.Create);
		expect(fieldOf(projector, "HolderInput", "empty").type).toEqual(named("JSON", true));
		const names = projector.defs().map((def) => def.name);
		expect(names).not.toContain("EmptyInput");
		expect(names).not.toContain("OnlyMetadataInput");
	});
});

describe("output objects", () => {
	it("carry the Read-visible payload, base first, with no HTTP metadata", () => {
		const { projector } = fresh();
		expect(projector.output(model("Shapes.Widget"))).toEqual(named("Widget", true));
		expect(fieldsOf(projector, "Widget").map((field) => field.name)).toEqual([
			"id",
			"name",
			"color",
			"createdAt",
			"tags",
			"maybe",
			"nested",
			"labels",
			"anything",
			"status",
			"priority",
			"stage",
			"open",
			"gadget",
			"either",
		]);
	});

	it("name a field from its JSON wire name, and keep the wire name to read it back", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(fieldOf(projector, "Widget", "createdAt")).toMatchObject({
			wire: "created_at",
			type: named("UTCDateTime", true),
		});
	});

	it("carry docs, deprecations, and nullability from optional and `| null`", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(defOf(projector, "Widget").description).toBe("A widget.");
		expect(fieldOf(projector, "Widget", "name")).toMatchObject({
			description: "The display name.",
			type: named("String", true),
		});
		expect(fieldOf(projector, "Widget", "color")).toMatchObject({
			deprecationReason: "use hue",
			type: named("String", false),
		});
		expect(fieldOf(projector, "Widget", "gadget").type).toEqual(named("Gadget", false));
	});

	it("make lists from arrays, by the element's own nullability", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(fieldOf(projector, "Widget", "tags").type).toEqual(listOf(named("String", true), true));
		expect(fieldOf(projector, "Widget", "maybe").type).toEqual(
			listOf(named("String", false), true),
		);
	});

	it("name anonymous models from the enclosing type and member", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(fieldOf(projector, "Widget", "nested").type).toEqual(named("WidgetNested", true));
		expect(fieldOf(projector, "WidgetNested", "deep").type).toEqual(
			named("WidgetNestedDeep", true),
		);
	});

	/**
	 * design.md § Types: an inherited or spread property is the member its declaring model holds, one
	 * type wherever it is reached, so its anonymous type is named after that model, whichever model
	 * holding it is projected first.
	 */
	it.each([
		["Desert", "Tundra"],
		["Tundra", "Desert"],
		["Oasis", "Desert"],
	])(
		"name an inherited or spread anonymous member after its declaring model, %s first",
		(first, second) => {
			expect(typeAt("Shapes.Oasis", "climate")).toBe(typeAt("Shapes.Habitat", "climate"));
			const { projector, book } = fresh();
			projector.output(model(`Shapes.${first}`));
			projector.output(model(`Shapes.${second}`));
			for (const holder of [first, second]) {
				expect(fieldOf(projector, holder, "climate").type).toEqual(named("HabitatClimate", true));
			}
			expect(book.owners("HabitatClimate")).toEqual(["model Shapes.Habitat.climate"]);
			expect(projector.shared).toEqual([]);
			projector.input(model(`Shapes.${first}`), Visibility.Create);
			expect(fieldOf(projector, `${first}Input`, "climate").type).toEqual(
				named("HabitatClimateInput", true),
			);
		},
	);

	/**
	 * design.md § Types: a template instance is no declaration, and its composed name leaves out a
	 * literal argument, so a member an `is` model copies from one is that model's.
	 */
	it("name a member copied from a template instance after the model declaring it with `is`", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Box"));
		projector.output(model("Shapes.Bin"));
		expect(fieldOf(projector, "Box", "contents").type).toEqual(named("BoxContents", true));
		expect(fieldOf(projector, "Bin", "contents").type).toEqual(named("BinContents", true));
		expect(book.collisions).toEqual([]);
		expect(projector.shared).toEqual([]);
	});

	/** As `Box`: a literal beside a named argument, or a union, is left out of the composed name too. */
	it.each([
		["TwinOne", "TwinTwo", "tag"],
		["Mix", "Mox", "contents"],
	])(
		"name what %s and %s copy from instances one composed name covers after each",
		(one, two, member) => {
			const { projector, book } = fresh();
			projector.output(model(`Shapes.${one}`));
			projector.output(model(`Shapes.${two}`));
			const nameOf = (holder: string): string =>
				`${holder}${member[0]?.toUpperCase()}${member.slice(1)}`;
			expect(fieldOf(projector, one, member).type).toEqual(named(nameOf(one), true));
			expect(fieldOf(projector, two, member).type).toEqual(named(nameOf(two), true));
			expect(book.collisions).toEqual([]);
		},
	);

	/**
	 * design.md § Types: where no model names a member, the type enclosing it does. A discriminated
	 * base that is an instance whose name leaves out its argument names its own members, the
	 * discriminator among them, as its object type, `Pen`.
	 */
	it("name a discriminated instance base's own members after the base where nothing else names them", () => {
		const { projector, book } = fresh();
		const base = model("Shapes.Quill").baseModel;
		if (base === undefined) throw new Error("Quill extends nothing");
		expect(projector.output(base)).toEqual(named("PenInterface", true));
		expect(fieldOf(projector, "Pen", "tip").type).toEqual(named("PenTip", true));
		expect(fieldOf(projector, "Quill", "tip").type).toEqual(named("QuillTip", true));
		expect(fieldOf(projector, "Pen", "kind").type).toEqual(named("PenKind", true));
		expect(book.owners("PenKind")).toEqual(['model Shapes.Pen<"ink">.kind']);
	});

	/**
	 * design.md § Types: a template instance whose composed name keeps every argument declares its
	 * members, whether a model reaches them by `extends` or copies them by `is`.
	 */
	it.each([
		["Top", "Bottom", "Rack"],
		["Bottom", "Rack", "Top"],
		["Rack", "Top", "Bottom"],
	])("name a template instance's member after the instance, %s first", (...holders) => {
		const { projector } = fresh();
		for (const holder of holders) projector.output(model(`Shapes.${holder}`));
		for (const holder of holders) {
			expect(fieldOf(projector, holder, "label").type).toEqual(named("ShelfOfStringLabel", true));
		}
		expect(projector.shared).toEqual([]);
	});

	/**
	 * design.md § Types: a visibility transform's copy of a property whose type it reshapes is no
	 * property of the source model, though it names that model: its type is the copying model's.
	 */
	it.each([
		["Dial", "DialCreate"],
		["DialCreate", "Dial"],
	])("name a member a visibility transform reshapes after the copy, %s first", (...holders) => {
		const { projector, book } = fresh();
		for (const holder of holders) projector.output(model(`Shapes.${holder}`));
		expect(fieldOf(projector, "Dial", "face").type).toEqual(named("DialFace", true));
		expect(fieldOf(projector, "DialCreate", "face").type).toEqual(named("DialCreateFace", true));
		expect(fieldOf(projector, "Dial", "rim").type).toEqual(named("DialRim", true));
		expect(fieldOf(projector, "DialCreate", "rim").type).toEqual(named("DialRim", true));
		expect(fieldOf(projector, "Dial", "glass").type).toEqual(named("BezelGlass", true));
		expect(fieldOf(projector, "DialCreate", "glass").type).toEqual(named("DialCreateGlass", true));
		expect(book.collisions).toEqual([]);
		expect(projector.shared).toEqual([]);
	});

	/**
	 * design.md § Types: an alias is no declaration, so a union of literals two members reach
	 * through one is one enum, named after the first of them declared, whichever is projected first,
	 * and warned.
	 */
	it.each([
		["Lamp", "Paint"],
		["Paint", "Lamp"],
	])(
		"project a union of literals two members reach through one alias as one enum, %s first",
		(...holders) => {
			const { projector } = fresh();
			for (const holder of holders) projector.output(model(`Shapes.${holder}`));
			expect(fieldOf(projector, "Lamp", "tone").type).toEqual(named("LampTone", true));
			expect(fieldOf(projector, "Paint", "tone").type).toEqual(named("LampTone", true));
			expect(projector.defs().map((def) => def.name)).not.toContain("PaintTone");
			expect(projector.shared).toEqual([
				{
					name: "LampTone",
					holders: ["Shapes.Lamp.tone", "Shapes.Paint.tone", "Shapes.Tinted.Shade.tone"],
					target: typeAt("Shapes.Lamp", "tone"),
				},
			]);
		},
	);

	/**
	 * **"The first declared" is the first in the spec, not the first the checker filed.** `Easel`,
	 * declared first, names `Paint`, so the compiler files `Paint` in its namespace before `Lamp`,
	 * declared ahead of it: walked in that order, the alias was `PaintTone`.
	 */
	it("names a type two members hold after the first declared, where an earlier model names the later", async () => {
		const held = await serviceOf(here, "held");
		const projector = new TypeProjector(held.program, new NameBook(), held.emitted.typeSchemaNames);
		const heldModel = (name: string): Model => {
			const type = typeOf(held, `Held.${name}`);
			if (type.kind !== "Model") throw new Error(`Held.${name} is a ${type.kind}`);
			return type;
		};
		projector.output(heldModel("Easel"));
		projector.output(heldModel("Lamp"));
		expect(fieldOf(projector, "Lamp", "tone").type).toEqual(named("LampTone", true));
		expect(fieldOf(projector, "Paint", "tone").type).toEqual(named("LampTone", true));
		expect(projector.shared.map(({ name, holders }) => ({ name, holders }))).toEqual([
			{ name: "LampTone", holders: ["Held.Lamp.tone", "Held.Paint.tone"] },
		]);
	});

	/** design.md § Types: a list's items are named after the list's member, shared with it. */
	it.each([
		["Sheet", "Ledger"],
		["Ledger", "Sheet"],
	])(
		"name the items of a list two members reach through one alias after the first, %s first",
		(...holders) => {
			expect(typeAt("Shapes.Ledger", "rows")).toBe(typeAt("Shapes.Sheet", "rows"));
			const { projector } = fresh();
			for (const holder of holders) projector.output(model(`Shapes.${holder}`));
			const rows = listOf(named("SheetRowsItem", true), true);
			expect(fieldOf(projector, "Sheet", "rows").type).toEqual(rows);
			expect(fieldOf(projector, "Ledger", "rows").type).toEqual(rows);
			expect(projector.shared.map(({ name, holders }) => [name, holders])).toEqual([
				["SheetRowsItem", ["Shapes.Sheet.rows", "Shapes.Ledger.rows"]],
			]);
		},
	);

	/**
	 * design.md § Types: a member inherited from an instance whose composed name leaves out its
	 * argument has no model to be named after, so two models extending it share it under the first
	 * declared's name, warned.
	 */
	it.each([
		["Low", "High"],
		["High", "Low"],
	])(
		"name a member two models inherit from one such instance after the first declared, %s first",
		(...holders) => {
			const { projector, book } = fresh();
			for (const holder of holders) projector.output(model(`Shapes.${holder}`));
			expect(fieldOf(projector, "Low", "contents").type).toEqual(named("LowContents", true));
			expect(fieldOf(projector, "High", "contents").type).toEqual(named("LowContents", true));
			expect(book.collisions).toEqual([]);
			projector.input(model(`Shapes.${holders[0]}`), Visibility.Create);
			expect(fieldOf(projector, `${holders[0]}Input`, "contents").type).toEqual(
				named("LowContentsInput", true),
			);
			expect(projector.shared.map(({ name, holders }) => [name, holders])).toEqual([
				["LowContents", ["Shapes.Low.contents", "Shapes.High.contents"]],
			]);
		},
	);

	/**
	 * design.md § Types: only an anonymous type is named by the member holding it, so a declared one
	 * GraphQL cannot state is warned under the member that reached it, not the first declared.
	 */
	it("warn a declared type that is JSON under the member that reached it", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Drain"));
		expect(reasons(projector)).toEqual([
			[
				"model Shapes.Drain.spill",
				"it carries additional properties, which a GraphQL object type cannot",
			],
			["model Shapes.Drain.either", "its variants are neither all literals nor discriminated"],
			["model Shapes.Drain.couple", "a Tuple has no GraphQL type"],
		]);
		expect(projector.shared).toEqual([]);
	});

	/** design.md § Types: a named type reached through a `| null` alias two members hold is itself. */
	it.each([
		["Kiln", "Forge"],
		["Forge", "Kiln"],
	])(
		"name a named type a shared nullable alias reaches by itself, unwarned, %s first",
		(...holders) => {
			const { projector } = fresh();
			for (const holder of holders) projector.output(model(`Shapes.${holder}`));
			for (const holder of holders) {
				expect(fieldOf(projector, holder, "gadget").type).toEqual(named("Gadget", false));
				expect(fieldOf(projector, holder, "mood").type).toEqual(named("Mood", false));
			}
			expect(projector.shared).toEqual([]);
		},
	);

	/**
	 * design.md § Types: a member copied from an instance no declared model's member holds is the
	 * instance's, as one `extends` reaches.
	 */
	it("name a member an anonymous model spreads from an instance after the instance", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Cabinet"));
		expect(fieldOf(projector, "CabinetBox", "label").type).toEqual(
			named("ShelfOfInt32Label", true),
		);
	});

	/** design.md § Types: a type a declared model holds has its member's name wherever it is reached. */
	it("name an anonymous type a field reaches directly after the member that declares it", () => {
		const { projector } = fresh();
		expect(
			projector.output(typeAt("Shapes.Habitat", "climate"), {
				name: "Weather",
				owner: "query weather",
			}),
		).toEqual(named("HabitatClimate", true));
		projector.output(model("Shapes.Desert"));
		expect(fieldOf(projector, "Desert", "climate").type).toEqual(named("HabitatClimate", true));
		expect(projector.shared).toEqual([]);
	});

	/**
	 * design.md § Types: an anonymous member's view suffix is its own reading's, which the input is
	 * one type at, not the holder's, whichever request reached it first.
	 */
	it.each([
		["Create", Visibility.Create, Visibility.Update],
		["Update", Visibility.Update, Visibility.Create],
	])("name an anonymous input by its own reading, %s first", (_, first, second) => {
		const { projector } = fresh();
		projector.input(model("Shapes.Gauge"), first);
		projector.input(model("Shapes.Gauge"), second);
		expect(fieldOf(projector, "GaugeInput", "reading").type).toEqual(
			named("GaugeReadingInput", true),
		);
		expect(fieldOf(projector, "GaugeUpdateInput", "reading").type).toEqual(
			named("GaugeReadingInput", true),
		);
		expect(fieldOf(projector, "GaugeInput", "limits").type).toEqual(
			named("GaugeLimitsInput", true),
		);
		expect(fieldOf(projector, "GaugeUpdateInput", "limits").type).toEqual(
			named("GaugeLimitsUpdateInput", true),
		);
	});

	/**
	 * Upstream's `composeTemplateName`: the template's name, `Of`, and each argument with a name
	 * joined by `And`, a template-instance argument composed the same way. A value, a literal or an
	 * anonymous union has no name, so it adds nothing, and a template with no named argument keeps
	 * its own name.
	 */
	it.each([
		["gadgets", "PageOfGadget"],
		["lists", "PageOfGadgetArray"],
		["pages", "PageOfPageOfGadget"],
		["duo", "DuoOfStringAndGadget"],
		["choices", "PageOfChoiceOfGadgetAndTree"],
		["codes", "PageOfCodeOfString"],
		["tagged", "TaggedOfGadget"],
		["marked", "Marked"],
		["ops", "MarkedOfOpsOfGadget"],
		["fetches", "MarkedOfFetchOfGadget"],
		["unnamed", "Page"],
	])("name the template instance %s as upstream composes it, %s", (property, expected) => {
		const { projector } = fresh();
		projector.output(model("Shapes.Paged"));
		expect(fieldOf(projector, "Paged", property).type).toEqual(named(expected, true));
	});

	it("project a recursive model through its own name", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Tree"));
		expect(fieldOf(projector, "Tree", "children").type).toEqual(listOf(named("Tree", true), true));
	});

	it("answer outputNameOf only for a model that projected to an object", () => {
		const { projector } = fresh();
		expect(projector.outputNameOf(model("Shapes.Widget"))).toBeUndefined();
		projector.output(model("Shapes.Widget"));
		projector.output(model("Shapes.Pet"));
		expect(projector.outputNameOf(model("Shapes.Widget"))).toBe("Widget");
		expect(projector.outputNameOf(model("Shapes.Pet"))).toBeUndefined();
	});

	/**
	 * An anonymous body made only of one model's spread properties IS that model on the wire
	 * (`getEffectivePayloadType`), so it projects to that model's type, and either one answers its
	 * name.
	 */
	it("answer outputNameOf for a body spread from one model by that model's name, either way round", () => {
		const body = modelAt("Shapes.Copies", "gadget");
		const fromModel = fresh().projector;
		fromModel.output(model("Shapes.Gadget"));
		expect(fromModel.outputNameOf(body)).toBe("Gadget");

		const fromBody = fresh().projector;
		expect(fromBody.output(body, { name: "CopiesGadget", owner: "op copy" })).toEqual(
			named("Gadget", true),
		);
		expect(fromBody.outputNameOf(model("Shapes.Gadget"))).toBe("Gadget");
	});

	it("project a recursive model reached through a body spread from it", () => {
		const { projector } = fresh();
		const body = typeAt("Shapes.Copies", "tree");
		expect(projector.output(body, { name: "CopiesTree", owner: "op tree" })).toEqual(
			named("Tree", true),
		);
		expect(fieldOf(projector, "Tree", "children").type).toEqual(listOf(named("Tree", true), true));
	});

	it("carry each field as a plain read: no arguments, no resolver call, no directive", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(fieldOf(projector, "Widget", "name")).toEqual({
			name: "name",
			wire: "name",
			type: named("String", true),
			description: "The display name.",
			deprecationReason: undefined,
			arguments: [],
			call: undefined,
			directives: [],
		});
	});

	it("claim a declared model's name as the model, and an anonymous one's as its member", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(book.owners("Widget")).toEqual(["model Shapes.Widget"]);
		expect(book.owners("WidgetNested")).toEqual(["model Shapes.Widget.nested"]);
	});

	it("name an anonymous list element from its member plus Item, and claim it as the member's element", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Odd"));
		expect(fieldOf(projector, "Odd", "items").type).toEqual(
			listOf(named("OddItemsItem", true), true),
		);
		expect(book.owners("OddItemsItem")).toEqual(["model Shapes.Odd.items[]"]);
	});

	it("project a list at the top of a field with no name to give it, as a list", () => {
		const { projector } = fresh();
		expect(projector.output(typeAt("Shapes.Widget", "tags"))).toEqual(
			listOf(named("String", true), true),
		);
	});

	it("project an anonymous model with nothing to be named after as JSON, warned", () => {
		const { projector } = fresh();
		const nested = looseAt("nested");
		expect(projector.output(nested)).toEqual(named("JSON", true));
		expect(projector.warnings.map((warning) => warning.reason)).toEqual([
			"an anonymous model here has nothing to be named after",
		]);
		expect(projector.warnings[0]?.target).toBe(nested);
	});

	/**
	 * design.md § Types: a payload property `@encode(ArrayEncoding.commaDelimited)` puts `"a,b"` on
	 * the wire, so it is `String`; a parameter so encoded stays a list, which the library splits.
	 */
	it("project a delimited payload array as String, and a delimited parameter as a list", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Odd"));
		expect(fieldOf(projector, "Odd", "csv").type).toEqual(named("String", true));
		const tags = propertyOf("Shapes.Params", "tags");
		expect(projector.input(tags.type, Visibility.Query, undefined, tags)).toEqual(
			listOf(named("String", true), true),
		);
	});

	/**
	 * **A query parameter's array encoding is its style**, as `@typespec/openapi3` publishes it
	 * (`style: commaDelimited`, the schema still an array of `int32`) and the library validates it
	 * (split, then each item as declared): the list stays, its items as declared. Any other `@encode`
	 * on a parameter is the wire type it states, as there: a custom one on a query list, or an array
	 * encoding on a header or a path segment, is one string (`type: string`).
	 */
	it.each<[string, TypeRef]>([
		["ids", listOf(named("Int", true), true)],
		["pipes", listOf(named("Int", true), true)],
		["spaces", listOf(named("Int", true), true)],
		["lines", listOf(named("Int", true), true)],
		["plain", listOf(named("Int", true), true)],
		["codes", named("String", true)],
		["xs", named("String", true)],
		["segs", named("String", true)],
	])("project the parameter %s as its wire form", (name, expected) => {
		const { projector } = fresh();
		const parameter = propertyOf("Shapes.Params", name);
		expect(projector.input(parameter.type, Visibility.Query, undefined, parameter)).toEqual(
			expected,
		);
	});

	/**
	 * **An encoding TypeSpec does not name is its wire type.** typespec-http-zod validates any
	 * `@encode` by the type it states (`encodedTypeOf`), so `@encode("x-custom", string)` on an
	 * `int32` is a string on the wire, a parameter's too, and a payload list so encoded is one string.
	 */
	it("project a custom encoding by the wire type it states, on a payload property and a parameter", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Odd"));
		expect(fieldOf(projector, "Odd", "customCount").type).toEqual(named("String", true));
		expect(fieldOf(projector, "Odd", "customList").type).toEqual(named("String", true));
		const code = propertyOf("Shapes.Params", "code");
		expect(projector.input(code.type, Visibility.Query, undefined, code)).toEqual(
			named("String", true),
		);
	});

	/**
	 * design.md § Types: `...Record<T>`, `extends` or `is Record<T>` beside declared properties make
	 * the wire object open, and a GraphQL type is closed, so the model is `JSON`, warned.
	 */
	it("project a model with additional properties as JSON, warned, by is or by spread", () => {
		const { projector } = fresh();
		expect(projector.output(model("Shapes.OpenIs"))).toEqual(named("JSON", true));
		expect(projector.output(model("Shapes.OpenSpread"))).toEqual(named("JSON", true));
		const why = "it carries additional properties, which a GraphQL object type cannot";
		expect(reasons(projector)).toEqual([
			["Shapes.OpenIs", why],
			["Shapes.OpenSpread", why],
		]);
	});

	/**
	 * Only a `@discriminator` model with derived models is a union: one with none is an object like
	 * any other, as is a model other models extend without a discriminator.
	 */
	it("project a discriminator base with nothing derived, and an undiscriminated base, as objects", () => {
		const { projector } = fresh();
		expect(projector.output(model("Shapes.Lonely"))).toEqual(named("Lonely", true));
		expect(defOf(projector, "Lonely").kind).toBe("object");
		expect(projector.output(model("Shapes.Base"))).toEqual(named("Base", true));
		expect(defOf(projector, "Base").kind).toBe("object");
	});
});

describe("input objects", () => {
	it("carry the request visibility's fields, suffixed where the visibility reshapes the model", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(projector.input(model("Shapes.Widget"), Visibility.Create)).toEqual(
			named("WidgetCreateInput", true),
		);
		expect(book.owners("WidgetCreateInput")).toEqual(["model Shapes.Widget as input at Create"]);
		const input = fieldsOf(projector, "WidgetCreateInput").map((field) => field.name);
		const output = fieldsOf(projector, "Widget").map((field) => field.name);
		expect(input).not.toContain("id");
		expect(input).toContain("secret");
		expect(output).toContain("id");
		expect(output).not.toContain("secret");
	});

	it("take no suffix for a model the visibility does not reshape", () => {
		const { projector, book } = fresh();
		expect(projector.input(model("Shapes.Gadget"), Visibility.Create)).toEqual(
			named("GadgetInput", true),
		);
		expect(book.owners("GadgetInput")).toEqual(["model Shapes.Gadget as input"]);
	});

	/**
	 * design.md § Arguments and input: an explicit null for an optional field that is not `| null` is
	 * dropped, and a field required and `| null` is written as the `null` the caller left out.
	 */
	it("drop an explicit null only where the property is optional and not `| null`", () => {
		const { projector } = fresh();
		projector.input(model("Shapes.Widget"), Visibility.Create);
		projector.input(model("Shapes.Retiring"), Visibility.Create);
		expect(fieldOf(projector, "WidgetCreateInput", "color")).toMatchObject({
			dropNull: true,
			nullIfAbsent: false,
		});
		expect(fieldOf(projector, "WidgetCreateInput", "gadget")).toMatchObject({
			dropNull: false,
			nullIfAbsent: true,
			type: named("GadgetInput", false),
		});
		expect(fieldOf(projector, "WidgetCreateInput", "name")).toMatchObject({
			dropNull: false,
			nullIfAbsent: false,
		});
		expect(fieldOf(projector, "RetiringInput", "note")).toMatchObject({
			dropNull: false,
			nullIfAbsent: false,
			type: named("String", false),
		});
	});

	/**
	 * design.md: `#deprecated` is `@deprecated(reason:)`, except on a required input field, which
	 * GraphQL refuses to deprecate: there the reason ends its description, as `Deprecated: <reason>`.
	 */
	it("deprecate a nullable field, and end a required one's description with the reason", () => {
		const { projector } = fresh();
		projector.input(model("Shapes.Retiring"), Visibility.Create);
		expect(fieldOf(projector, "RetiringInput", "width")).toMatchObject({
			description: "The width.\n\nDeprecated: use size",
			deprecationReason: undefined,
		});
		expect(fieldOf(projector, "RetiringInput", "label")).toMatchObject({
			description: "Deprecated: use code",
			deprecationReason: undefined,
		});
		expect(fieldOf(projector, "RetiringInput", "note")).toMatchObject({
			description: undefined,
			deprecationReason: "gone",
		});
	});

	it("project a recursive input through its own name", () => {
		const { projector } = fresh();
		expect(projector.input(model("Shapes.Tree"), Visibility.Create)).toEqual(
			named("TreeInput", true),
		);
		expect(fieldOf(projector, "TreeInput", "children").type).toEqual(
			listOf(named("TreeInput", true), true),
		);
	});

	/** GraphQL enums are input and output types alike, so one enum serves both positions. */
	it("use the output's enum for an enum or a union of literals", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		projector.input(model("Shapes.Widget"), Visibility.Create);
		expect(fieldOf(projector, "WidgetCreateInput", "status").type).toEqual(named("Status", true));
		expect(fieldOf(projector, "WidgetCreateInput", "stage").type).toEqual(
			named("WidgetStage", true),
		);
		expect(projector.defs().map((def) => def.name)).not.toContain("WidgetCreateStage");
	});

	/** design.md § Types: a union of models with a discriminator is `JSON` as input. */
	it("project a @discriminator base as JSON, without a warning", () => {
		const { projector } = fresh();
		expect(projector.input(model("Shapes.Pet"), Visibility.Create)).toEqual(named("JSON", true));
		expect(projector.warnings).toEqual([]);
	});

	/**
	 * design.md § Arguments and input: a spread body with additional properties puts them at the top
	 * of the handler's input, which no closed input object can carry, warned `projected-as-json`.
	 */
	it("call a spread body with additional properties open, warned, and a closed one or a list not", () => {
		const { projector } = fresh();
		expect(projector.openSpreadBody(model("Shapes.Gadget"), Visibility.Create)).toBe(false);
		expect(projector.openSpreadBody(modelAt("Shapes.Widget", "tags"), Visibility.Create)).toBe(
			false,
		);
		expect(projector.warnings).toEqual([]);
		expect(projector.openSpreadBody(model("Shapes.OpenSpread"), Visibility.Create)).toBe(true);
		expect(reasons(projector)).toEqual([
			["Shapes.OpenSpread", "it carries additional properties, which a GraphQL input type cannot"],
		]);
	});

	it("make every field optional under PATCH, as the validator does", () => {
		const { projector } = fresh();
		expect(projector.input(model("Shapes.Gadget"), Visibility.Update | Visibility.Patch)).toEqual(
			named("GadgetUpdateInput", true),
		);
		expect(fieldsOf(projector, "GadgetUpdateInput")).toMatchObject([
			{ name: "id", type: named("String", false), dropNull: true },
		]);
	});

	it("give inputFieldsOf a model's fields without registering the model", () => {
		const { projector } = fresh();
		const fields = projector.inputFieldsOf(model("Shapes.Gadget"), Visibility.Create, {
			name: "MakeGadget",
			owner: "mutation makeGadget",
		});
		expect(fields.map((field) => field.wire)).toEqual(["id"]);
		expect(projector.defs().map((def) => def.name)).not.toContain("GadgetInput");
	});

	it("give inputFieldsOf a model's fields as input, a nested model as its input type", () => {
		const { projector } = fresh();
		const fields = projector.inputFieldsOf(model("Shapes.Widget"), Visibility.Create, {
			name: "MakeWidget",
			owner: "mutation makeWidget",
		});
		expect(fields.find((field) => field.name === "gadget")?.type).toEqual(
			named("GadgetInput", false),
		);
	});
});

describe("scalars", () => {
	it.each([
		["s", "String"],
		["b", "Boolean"],
		["i8", "Int"],
		["i16", "Int"],
		["i32", "Int"],
		["u8", "Int"],
		["u16", "Int"],
		["f", "Float"],
		["f32", "Float"],
		["f64", "Float"],
		["i64", "Long"],
		["u32", "Long"],
		["si", "Long"],
		["u64", "BigInteger"],
		["int", "BigInteger"],
		["num", "Numeric"],
		["d", "BigDecimal"],
		["d128", "BigDecimal"],
		["utc", "UTCDateTime"],
		["utcHuman", "UTCDateTimeHuman"],
		["utcUnix", "UTCDateTimeUnix"],
		["unix32", "UTCDateTimeUnix"],
		["off", "OffsetDateTime"],
		["offHuman", "OffsetDateTimeHuman"],
		["date", "PlainDate"],
		["time", "PlainTime"],
		["dur", "Duration"],
		["durSeconds", "DurationSeconds"],
		["durMilliseconds", "DurationMilliseconds"],
		["raw", "Bytes"],
		["rawUrl", "BytesUrl"],
		["link", "URL"],
		["slug", "String"],
		["stamp", "UTCDateTimeHuman"],
		["stamped", "UTCDateTimeHuman"],
		["custom", "String"],
		["bigText", "String"],
	])("%s is %s", (property, expected) => {
		const { projector } = fresh();
		projector.output(model("Shapes.Scalars"));
		expect(fieldOf(projector, "Scalars", property).type).toEqual(named(expected, true));
	});

	/**
	 * The plan's scalar rule: a numeric or boolean `@encode(string)` is `String`, since its wire form
	 * is then a JSON string. Every scalar TypeSpec accepts `@encode(string)` on, one per row.
	 */
	it.each([
		"b",
		"i8",
		"i16",
		"i32",
		"u8",
		"u16",
		"f",
		"f32",
		"f64",
		"i64",
		"u32",
		"si",
		"u64",
		"int",
		"num",
		"d",
		"d128",
	])("%s under @encode(string) is String", (property) => {
		const { projector } = fresh();
		projector.output(model("Shapes.StringEncoded"));
		expect(fieldOf(projector, "StringEncoded", property).type).toEqual(named("String", true));
	});

	/**
	 * design.md's scalar table: RFC 3339, ISO 8601 and base64 are each scalar's own encoding, so
	 * naming one changes nothing. An encoding no row names is the wire type it states, as the library
	 * validates it: a scalar's own `@encode` naming `int64` is a `Long`. A row holds only where the wire type it states is of the row's JSON type: openapi3 publishes ISO 8601
	 * as an `int32` as `type: integer` and the library validates `z.int32()`, so it is an `Int`, while
	 * seconds as a `float32` is `type: number`, which `DurationSeconds` is. A scalar that extends no
	 * standard scalar is `JSON` (openapi3 publishes no `type`, the library `z.unknown()`), unless its
	 * `@encode` states a type: `@encode("x-custom", string)` is `type: string`, `z.string()`.
	 */
	it.each([
		["utc", "UTCDateTime"],
		["off", "OffsetDateTime"],
		["dur", "Duration"],
		["raw", "Bytes"],
		["wide", "Long"],
		["isoCount", "Int"],
		["secs", "DurationSeconds"],
		["unbasedIso", "JSON"],
		["unbasedText", "String"],
	])("%s under its encoding is %s", (property, expected) => {
		const { projector } = fresh();
		projector.output(model("Shapes.Encodings"));
		expect(fieldOf(projector, "Encodings", property).type).toEqual(named(expected, true));
	});

	/**
	 * design.md: a date-time header with no `@encode` is RFC 7231, as `@typespec/openapi3` publishes
	 * it (`isDateTimeHeader`: a header whose schema is `format: date-time` becomes `http-date`), but
	 * only where the header's own type is the standard scalar, alone or with `| null`: a declared
	 * scalar (a `$ref`), a list's items, a variant of a wider union (`anyOf`) and an explicit
	 * `@encode` keep RFC 3339.
	 */
	it.each<[string, (header: ModelProperty) => Type, TypeRef]>([
		["since", (header) => header.type, named("UTCDateTimeHuman", true)],
		["until", (header) => header.type, named("OffsetDateTimeHuman", false)],
		["instant", (header) => header.type, named("UTCDateTime", true)],
		["seen", (header) => header.type, listOf(named("UTCDateTime", true), true)],
		["either", (header) => variantOf(header.type), named("UTCDateTime", true)],
		["explicit", (header) => header.type, named("UTCDateTime", true)],
	])("project the header %s's date-time by its own type", (name, typeOfHeader, expected) => {
		const { projector } = fresh();
		const header = propertyOf("Shapes.Headers", name);
		expect(projector.input(typeOfHeader(header), Visibility.Query, undefined, header)).toEqual(
			expected,
		);
	});

	it("project a scalar that extends no standard scalar as JSON, warned", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Odd"));
		expect(fieldOf(projector, "Odd", "opaque").type).toEqual(named("JSON", true));
		expect(reasons(projector)).toContainEqual([
			"Shapes.Opaque",
			"scalar Opaque extends no standard scalar",
		]);
	});

	it("claim each runtime scalar as the runtime's", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Scalars"));
		expect(book.owners("Long")).toEqual(["runtime scalar Long"]);
		expect(book.owners("UTCDateTime")).toEqual(["runtime scalar UTCDateTime"]);
	});

	it("record a runtime scalar whose name another owner holds as a collision, and define none", () => {
		const { projector, book } = fresh();
		book.claim("Long", "a type the caller declared");
		projector.output(model("Shapes.Scalars"));
		expect(book.collisions).toEqual([
			{ name: "Long", first: "a type the caller declared", second: "runtime scalar Long" },
		]);
		expect(projector.defs().map((def) => def.name)).not.toContain("Long");
	});

	it("define each runtime scalar once, with upstream's @specifiedBy and its wire form", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Scalars"));
		expect(
			projector
				.defs()
				.filter((def) => def.kind === "scalar")
				.map((def) => def.name),
		).toEqual([
			"BigDecimal",
			"BigInteger",
			"Bytes",
			"BytesUrl",
			"Duration",
			"DurationMilliseconds",
			"DurationSeconds",
			"Long",
			"Numeric",
			"OffsetDateTime",
			"OffsetDateTimeHuman",
			"PlainDate",
			"PlainTime",
			"URL",
			"UTCDateTime",
			"UTCDateTimeHuman",
			"UTCDateTimeUnix",
		]);
		expect(defOf(projector, "Long")).toMatchObject({
			specifiedBy: "http://scalars.graphql.org/jakobmerrild/long.html",
			json: "integer",
		});
		expect(defOf(projector, "UTCDateTime")).toMatchObject({
			specifiedBy: "https://scalars.graphql.org/chillicream/date-time.html",
			json: "string",
		});
	});
});

/**
 * A literal type is the GraphQL scalar its JSON value is: a string is `String`, a boolean `Boolean`, a number `Float` unless it is an integer, and an integer `Int` only within the
 * signed 32-bit range GraphQL gives `Int` (spec section 3.5.1), past which it is `Long`.
 */
describe("literals and intrinsics", () => {
	it.each([
		["flag", named("Boolean", true)],
		["small", named("Int", true)],
		["fraction", named("Float", true)],
		["intMax", named("Int", true)],
		["pastIntMax", named("Long", true)],
		// GraphQL's Int is a signed 32-bit integer: -2^31 is its least.
		["intMin", named("Int", true)],
		["pastIntMin", named("Long", true)],
		["nothing", named("JSON", false)],
		["pair", named("JSON", true)],
	])("%s is %j", (property, expected) => {
		const { projector } = fresh();
		projector.output(model("Shapes.Odd"));
		expect(fieldOf(projector, "Odd", property).type).toEqual(expected);
	});

	/** design.md: a shape GraphQL cannot state is `JSON`, warned with why; `null` alone is a value. */
	it("warn for a tuple, and not for null", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Odd"));
		expect(reasons(projector)).toEqual([
			["model Shapes.Odd.pair", "a Tuple has no GraphQL type"],
			["Shapes.Opaque", "scalar Opaque extends no standard scalar"],
		]);
	});
});

describe("enums", () => {
	it("project a string enum: CONSTANT_CASE names, the wire value kept", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(defOf(projector, "Status")).toEqual({
			kind: "enum",
			name: "Status",
			description: undefined,
			values: [
				{
					name: "IN_PROGRESS",
					wire: "in-progress",
					description: "Under way.",
					deprecationReason: undefined,
				},
				{ name: "DONE", wire: "done", description: undefined, deprecationReason: undefined },
			],
		});
	});

	it("project a numeric enum with its numbers as wire values", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(defOf(projector, "Priority")).toMatchObject({
			values: [
				{ name: "LOW", wire: 1 },
				{ name: "HIGH", wire: 2 },
			],
		});
	});

	it("project a union of string literals as an enum named from its member, and an open one as String", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(defOf(projector, "WidgetStage")).toMatchObject({
			kind: "enum",
			values: [
				{ name: "IN_PROGRESS", wire: "in-progress" },
				{ name: "DONE", wire: "done" },
			],
		});
		expect(fieldOf(projector, "Widget", "open").type).toEqual(named("String", true));
	});

	/**
	 * The plan's union rule: all string or numeric literals are an enum, values CONSTANT_CASE of the
	 * literal with the literal kept as the wire value. A GraphQL name cannot start with a digit, so
	 * the name of `1` is `_1`.
	 */
	it("project a union of numeric literals as an enum, the numbers kept as wire values", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Unions"));
		expect(fieldOf(projector, "Unions", "level").type).toEqual(named("UnionsLevel", true));
		expect(defOf(projector, "UnionsLevel")).toMatchObject({
			kind: "enum",
			values: [
				{ name: "_1", wire: 1 },
				{ name: "_2", wire: 2 },
			],
		});
	});

	it("project literals with `| null` as a nullable enum of the literals alone", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Unions"));
		expect(fieldOf(projector, "Unions", "shade").type).toEqual(named("UnionsShade", false));
		expect(defOf(projector, "UnionsShade")).toEqual({
			kind: "enum",
			name: "UnionsShade",
			description: undefined,
			values: [
				{ name: "LIGHT", wire: "light", description: undefined, deprecationReason: undefined },
				{ name: "DARK", wire: "dark", description: undefined, deprecationReason: undefined },
			],
		});
	});

	it("name a declared union of literals after itself, and claim each enum as its declaration or member", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Unions"));
		projector.output(model("Shapes.Widget"));
		expect(fieldOf(projector, "Unions", "mood").type).toEqual(named("Mood", true));
		expect(defOf(projector, "Mood")).toMatchObject({
			kind: "enum",
			values: [
				{ name: "CALM", wire: "calm" },
				{ name: "BUSY", wire: "busy" },
			],
		});
		expect(book.owners("Mood")).toEqual(["union Shapes.Mood"]);
		expect(book.owners("WidgetStage")).toEqual(["model Shapes.Widget.stage"]);
		expect(book.owners("Status")).toEqual(["enum Shapes.Status"]);
	});

	it("project an anonymous union of literals with nothing to be named after as JSON, warned", () => {
		const { projector } = fresh();
		const stage = looseAt("stage");
		expect(projector.output(stage)).toEqual(named("JSON", true));
		expect(projector.warnings.map((warning) => warning.reason)).toEqual([
			"an anonymous union of literals here has nothing to be named after",
		]);
		expect(projector.warnings[0]?.target).toBe(stage);
	});

	/** One TypeSpec type is one GraphQL type: the name it was first reached under, wherever reached. */
	it("project one anonymous union of literals reached under two hints as one enum, the first's", () => {
		const { projector } = fresh();
		const stage = looseAt("stage");
		expect(projector.output(stage, { name: "Phase", owner: "query phase" })).toEqual(
			named("Phase", true),
		);
		expect(projector.output(stage, { name: "Step", owner: "query step" })).toEqual(
			named("Phase", true),
		);
		expect(projector.defs().map((def) => def.name)).toEqual(["Phase"]);
	});

	/** As one type: first reached under a reserved name, it is `JSON` under any other. */
	it("keep an anonymous type JSON where it was first reached under a reserved name", () => {
		const { projector } = fresh();
		const stage = looseAt("stage");
		const nested = looseAt("nested");
		expect(projector.output(stage, { name: "Query", owner: "query a" })).toEqual(
			named("JSON", true),
		);
		expect(projector.output(stage, { name: "Phase", owner: "query b" })).toEqual(
			named("JSON", true),
		);
		expect(projector.output(nested, { name: "Mutation", owner: "query c" })).toEqual(
			named("JSON", true),
		);
		expect(projector.output(nested, { name: "Hollow", owner: "query d" })).toEqual(
			named("JSON", true),
		);
		expect(projector.defs().map((def) => def.name)).toEqual(["JSON"]);
	});

	it("record two enums converting to one name as a collision, and keep the first", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Widget"));
		projector.output(typeOf(service, "Shapes.status_"));
		expect(book.collisions).toEqual([
			{ name: "Status", first: "enum Shapes.Status", second: "enum Shapes.status_" },
		]);
		expect(defOf(projector, "Status")).toMatchObject({
			values: [{ wire: "in-progress" }, { wire: "done" }],
		});
	});

	it("record a union of literals named as a taken name as a collision, and keep the first", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Unions"));
		projector.output(looseAt("stage"), {
			name: "Mood",
			owner: "model Shapes.Adrift.held.stage",
		});
		expect(book.collisions).toEqual([
			{ name: "Mood", first: "union Shapes.Mood", second: "model Shapes.Adrift.held.stage" },
		]);
		expect(defOf(projector, "Mood")).toMatchObject({
			values: [{ wire: "calm" }, { wire: "busy" }],
		});
	});

	it("record two values converting to one name as a collision, naming each wire value", () => {
		const { projector, book } = fresh();
		projector.output(typeOf(service, "Shapes.Clash"));
		expect(book.collisions).toEqual([
			{ name: "Clash.IN_PROGRESS", first: "enum Shapes.Clash: a", second: "enum Shapes.Clash: b" },
		]);
	});
});

describe("unions", () => {
	/**
	 * **The schema does not depend on which type is reached first.** A variant that holds its own
	 * union reaches the union while the variant's fields are still being projected; the union must
	 * still see the variant as the object type it is becoming.
	 */
	it.each([
		["Shapes.Cluster", "children", "Shapes.Figure", "Figure", "union", ["Cluster", "Dab"]],
		[
			"Shapes.Flock",
			"members",
			"Shapes.Fauna",
			"FaunaInterface",
			"interface",
			["Fauna", "Flock", "Mole"],
		],
	])(
		"project %s first, and its %s and %s still reach the type of its variants",
		(first, property, abstract, name, kind, members) => {
			const { projector } = fresh();
			projector.output(typeOf(service, first));
			expect(fieldOf(projector, first.slice("Shapes.".length), property).type).toEqual(
				listOf(named(name, true), true),
			);
			expect(projector.output(typeOf(service, abstract))).toEqual(named(name, true));
			expect(defOf(projector, name)).toMatchObject({ kind, members });
			expect(projector.warnings).toEqual([]);
		},
	);

	it("project a discriminated union, resolved by its discriminator", () => {
		const { projector, book } = fresh();
		expect(projector.output(typeOf(service, "Shapes.Shape"))).toEqual(named("Shape", true));
		expect(book.owners("Shape")).toEqual(["union Shapes.Shape"]);
		expect(defOf(projector, "Shape")).toEqual({
			kind: "union",
			name: "Shape",
			description: undefined,
			members: ["Circle", "Square"],
			resolveBy: {
				kind: "discriminator",
				property: "kind",
				mapping: { circle: "Circle", square: "Square" },
			},
		});
	});

	it("give an enveloped discriminated union one envelope object per variant", () => {
		const { projector } = fresh();
		projector.output(typeOf(service, "Shapes.Wrapped"));
		expect(defOf(projector, "Wrapped")).toMatchObject({
			members: ["WrappedCircle", "WrappedSquare"],
			resolveBy: { kind: "discriminator", property: "kind", mapping: { circle: "WrappedCircle" } },
		});
		const plain = { description: undefined, deprecationReason: undefined, call: undefined };
		expect(defOf(projector, "WrappedCircle")).toEqual({
			kind: "object",
			name: "WrappedCircle",
			description: undefined,
			fields: [
				{
					name: "kind",
					wire: "kind",
					type: named("String", true),
					...plain,
					arguments: [],
					directives: [],
				},
				{
					name: "value",
					wire: "value",
					type: named("Circle", true),
					...plain,
					arguments: [],
					directives: [],
				},
			],
		});
	});

	/**
	 * **An anonymous variant is named apart from its envelope.** The envelope is `<Union><Key>`; the
	 * variant it holds under `value` is `<Union><Key>Value`, so the two never collide and drop the
	 * union.
	 */
	it("name an enveloped union's anonymous variant after the envelope property holding it", () => {
		const { projector, book } = fresh();
		expect(projector.output(typeOf(service, "Shapes.Parcel"))).toEqual(named("Parcel", true));
		expect(book.collisions).toEqual([]);
		expect(defOf(projector, "Parcel")).toMatchObject({ members: ["ParcelDot", "ParcelCircle"] });
		expect(fieldOf(projector, "ParcelDot", "value").type).toEqual(named("ParcelDotValue", true));
		expect(fieldOf(projector, "ParcelDotValue", "x").type).toEqual(named("Int", true));
		// Claimed as the member holding it, `<owner>.<member>`, as a model's anonymous member is.
		expect(book.owners("ParcelDotValue")).toEqual(["union Shapes.Parcel.dot.value"]);
	});

	/**
	 * An envelope always projects, so a variant may be the union itself: its envelope holds the
	 * union under `value`, and the schema refers only to types it defines.
	 */
	it("project an enveloped union whose variant is the union itself", () => {
		const { projector } = fresh();
		expect(projector.output(typeOf(service, "Shapes.Nest"))).toEqual(named("Nest", true));
		expect(defOf(projector, "Nest")).toMatchObject({ members: ["NestNest", "NestCircle"] });
		expect(fieldOf(projector, "NestNest", "value").type).toEqual(named("Nest", true));
		expect(undefinedTypesOf(projector)).toEqual([]);
		expect(projector.warnings).toEqual([]);
	});

	/**
	 * **A union a variant holds is decided whole, there too.** A variant that holds its
	 * union, ahead of one that projects to no object type, used to keep the union's name while the
	 * union itself became `JSON`: `schema.graphql` named a type it never defined, and the emitter
	 * stopped with `Unknown type "Knot"`. The union is `JSON`, warned, and so is every field holding
	 * it, whichever is reached first.
	 */
	it.each([
		[
			"Shapes.Knot",
			"Shapes.Loop",
			"Loop",
			"variant open is not a model that projects to an object type",
		],
		[
			"Shapes.Tangle",
			"Shapes.Coil",
			"Coil",
			"derived model Frayed does not project to an object type",
		],
	])(
		"project %s as JSON, and %s's field holding it as JSON too, whichever is reached first",
		(union, holder, holderName, why) => {
			const name = union.slice("Shapes.".length);
			const unionFirst = fresh().projector;
			expect(unionFirst.output(typeOf(service, union))).toEqual(named("JSON", true));
			const holderFirst = fresh().projector;
			holderFirst.output(typeOf(service, holder));
			expect(holderFirst.output(typeOf(service, union))).toEqual(named("JSON", true));
			for (const projector of [unionFirst, holderFirst]) {
				expect(fieldOf(projector, holderName, "next").type).toEqual(
					listOf(named("JSON", true), true),
				);
				expect(projector.defs().map((def) => def.name)).not.toContain(name);
				expect(undefinedTypesOf(projector)).toEqual([]);
				// Warned once, named by where it was first reached.
				const warned = projector.warnings.filter(
					(warning) => warning.target === typeOf(service, union),
				);
				expect(warned.map((warning) => warning.reason)).toEqual([why]);
			}
		},
	);

	/**
	 * design.md § Types: a `@discriminator` base is `<Name>Interface`, implemented by its own object
	 * type and by each derived model, resolved by the discriminator, the base for any other value.
	 * Its fields are decided once every member's are, as `defineInterfaces` decides them.
	 */
	it("project a @discriminator base as an interface its own object type and each derived model implement", () => {
		const { projector, book } = fresh();
		expect(projector.output(model("Shapes.Pet"))).toEqual(named("PetInterface", true));
		expect(book.owners("Pet")).toEqual(["model Shapes.Pet"]);
		expect(book.owners("PetInterface")).toEqual(["model Shapes.Pet as an interface"]);
		expect(defOf(projector, "PetInterface")).toMatchObject({
			kind: "interface",
			fields: [],
			members: ["Pet", "Cat", "Dog"],
			resolveBy: {
				kind: "base",
				rule: {
					property: "species",
					mapping: {
						cat: { schema: validatorOf("Shapes.Cat"), type: "Cat" },
						dog: { schema: validatorOf("Shapes.Dog"), type: "Dog" },
					},
					base: "Pet",
				},
			},
		});
		expect(fieldsOf(projector, "Pet").map((field) => field.name)).toEqual(["species", "name"]);
		expect(fieldsOf(projector, "Cat").map((field) => field.name)).toEqual([
			"species",
			"name",
			"lives",
		]);
		expect(projector.defineInterfaces(new Set(["PetInterface", "Pet", "Cat", "Dog"]))).toEqual([]);
		expect(fieldsOf(projector, "PetInterface").map((field) => field.name)).toEqual([
			"species",
			"name",
		]);
		for (const member of ["Pet", "Cat", "Dog"]) {
			expect(defOf(projector, member)).toMatchObject({ interfaces: ["PetInterface"] });
		}
	});

	it("project an input union as JSON, without a warning", () => {
		const { projector } = fresh();
		expect(projector.input(typeOf(service, "Shapes.Shape"), Visibility.Create)).toEqual(
			named("JSON", true),
		);
		expect(projector.warnings).toEqual([]);
	});

	it("project any other union as JSON, with a warning saying which and why", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(fieldOf(projector, "Widget", "either").type).toEqual(named("JSON", true));
		expect(projector.warnings).toMatchObject([
			{
				what: "model Shapes.Widget.either",
				reason: "its variants are neither all literals nor discriminated",
			},
		]);
	});

	/**
	 * `unknown` admits `null`, as the library's `z.unknown()` does, so a required `unknown` is a
	 * NULLABLE `JSON`: non-null, a legal `{ anything: null }` nulled its parent with an error. A
	 * `Record` is an object, never `null`, so it stays non-null.
	 */
	it("project Record and unknown as JSON, silently, unknown nullable as null is one of its values", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		expect(fieldOf(projector, "Widget", "labels").type).toEqual(named("JSON", true));
		expect(fieldOf(projector, "Widget", "anything").type).toEqual(named("JSON", false));
		expect(projector.warnings.map((warning) => warning.what)).toEqual([
			"model Shapes.Widget.either",
		]);
	});

	/**
	 * The plan's union rule: any other union is `JSON` with a warning, once per type. GraphQL refuses
	 * an enum with no value (section 3.9), so a union of `null` alone is one of them.
	 */
	it("project a union of null alone as a nullable JSON, and warn for a union once however often it is used", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Unions"));
		expect(fieldOf(projector, "Unions", "nothing").type).toEqual(named("JSON", false));
		expect(fieldOf(projector, "Unions", "either").type).toEqual(named("JSON", true));
		expect(fieldOf(projector, "Unions", "again").type).toEqual(named("JSON", true));
		const why = "its variants are neither all literals nor discriminated";
		expect(reasons(projector)).toEqual([
			["model Shapes.Unions.nothing", why],
			["model Shapes.Unions.either", why],
		]);
		expect(projector.defs().map((def) => def.name)).not.toContain("Nothing");
	});

	it("project a discriminated union a variant refers back to, through its own name", () => {
		const { projector } = fresh();
		expect(projector.output(typeOf(service, "Shapes.Expr"))).toEqual(named("Expr", true));
		expect(fieldOf(projector, "Sum", "terms").type).toEqual(listOf(named("Expr", true), true));
		expect(defOf(projector, "Expr")).toMatchObject({ members: ["Lit", "Sum"] });
		expect(projector.warnings).toEqual([]);
	});

	it("name an anonymous variant from the union and its key, claimed as that member", () => {
		const { projector, book } = fresh();
		projector.output(typeOf(service, "Shapes.Inline"));
		expect(defOf(projector, "Inline")).toMatchObject({
			members: ["InlineDot", "InlineBox"],
			resolveBy: { mapping: { dot: "InlineDot", box: "InlineBox" } },
		});
		expect(book.owners("InlineDot")).toEqual(["union Shapes.Inline.dot"]);
	});

	it("project a discriminated union with a variant that is no object as JSON, warned, every time", () => {
		const { projector } = fresh();
		const loose = typeOf(service, "Shapes.Loose");
		expect(projector.output(loose)).toEqual(named("JSON", true));
		expect(projector.output(loose)).toEqual(named("JSON", true));
		expect(reasons(projector)).toEqual([
			[
				"union Shapes.Loose.open",
				"it carries additional properties, which a GraphQL object type cannot",
			],
			["Shapes.Loose", "variant open is not a model that projects to an object type"],
		]);
	});

	/**
	 * design.md § Types: a nested base is an interface of its own, implementing its parent's, and
	 * resolved by its own rule inside its parent's; every member implements every base interface above
	 * it. The discriminator is the type its base declares, on every member, and never null.
	 */
	it("project a nested @discriminator base as an interface implementing its parent's", () => {
		const { projector, book } = fresh();
		expect(projector.output(model("Shapes.Vehicle"))).toEqual(named("VehicleInterface", true));
		expect(defOf(projector, "VehicleInterface")).toMatchObject({
			members: ["Vehicle", "Car", "Electric", "Boat"],
			resolveBy: {
				kind: "base",
				rule: {
					property: "kind",
					mapping: {
						car: {
							schema: validatorOf("Shapes.Car"),
							rule: {
								property: "fuel",
								mapping: { electric: { schema: validatorOf("Shapes.Electric"), type: "Electric" } },
								base: "Car",
							},
						},
						boat: { schema: validatorOf("Shapes.Boat"), type: "Boat" },
					},
					base: "Vehicle",
				},
			},
		});
		expect(defOf(projector, "CarInterface")).toMatchObject({
			interfaces: ["VehicleInterface"],
			members: ["Car", "Electric"],
		});
		for (const member of ["Vehicle", "Car", "Electric", "Boat"]) {
			expect(fieldOf(projector, member, "kind").type).toEqual(named("VehicleKind", true));
		}
		// Named for the base declaring it, wherever a member reached it first.
		expect(book.owners("VehicleKind")).toEqual(["model Shapes.Vehicle.kind"]);
		const reached = new Set([
			"VehicleInterface",
			"CarInterface",
			"Vehicle",
			"Car",
			"Electric",
			"Boat",
		]);
		expect(projector.defineInterfaces(reached)).toEqual([]);
		expect(fieldsOf(projector, "VehicleInterface").map((field) => field.name)).toEqual([
			"kind",
			"seats",
		]);
		expect(fieldsOf(projector, "CarInterface").map((field) => field.name)).toEqual([
			"kind",
			"seats",
			"fuel",
		]);
		expect(defOf(projector, "Electric")).toMatchObject({
			interfaces: ["CarInterface", "VehicleInterface"],
		});
		expect(defOf(projector, "Boat")).toMatchObject({ interfaces: ["VehicleInterface"] });
	});

	it("project a @discriminator hierarchy a derived model refers back to, through its interface", () => {
		const { projector } = fresh();
		expect(projector.output(model("Shapes.Node"))).toEqual(named("NodeInterface", true));
		expect(fieldOf(projector, "Branch", "children").type).toEqual(
			listOf(named("NodeInterface", true), true),
		);
		expect(defOf(projector, "NodeInterface")).toMatchObject({
			members: ["Node", "Leaf", "Branch"],
		});
		expect(projector.warnings).toEqual([]);
	});

	/**
	 * `resolveType` reads the discriminator from the wire value, by the discriminator's own name
	 * where only derived models declare it; the base's own object type carries it then as the
	 * `String` `@typespec/openapi3` adds to the base, and the subtypes' literals are that `String`.
	 */
	it("resolve a hierarchy whose discriminator only its derived models declare, the base carrying it", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Event"));
		expect(defOf(projector, "EventInterface")).toMatchObject({
			resolveBy: {
				kind: "base",
				rule: {
					property: "kind",
					mapping: {
						click: { schema: validatorOf("Shapes.Click"), type: "Click" },
						press: { schema: validatorOf("Shapes.Press"), type: "Press" },
					},
					base: "Event",
				},
			},
		});
		expect(fieldsOf(projector, "Event").map((field) => [field.name, field.type])).toEqual([
			["at", named("Int", true)],
			["kind", named("String", true)],
		]);
		expect(fieldOf(projector, "Click", "kind").type).toEqual(named("String", true));
	});

	it("project a @discriminator hierarchy with a derived model that is no object as JSON, warned, every time", () => {
		const { projector } = fresh();
		expect(projector.output(model("Shapes.Loosened"))).toEqual(named("JSON", true));
		expect(projector.output(model("Shapes.Loosened"))).toEqual(named("JSON", true));
		expect(reasons(projector)).toEqual([
			[
				"Shapes.OpenDerived",
				"it carries additional properties, which a GraphQL object type cannot",
			],
			["Shapes.Loosened", "derived model OpenDerived does not project to an object type"],
		]);
	});

	it("project a @discriminator base that carries additional properties as JSON, warned", () => {
		const { projector } = fresh();
		expect(projector.output(model("Shapes.Sprawl"))).toEqual(named("JSON", true));
		expect(reasons(projector)).toEqual([
			["Shapes.Sprawl", "it carries additional properties, which a GraphQL object type cannot"],
		]);
		expect(projector.defs().map((def) => def.name)).not.toContain("SprawlInterface");
	});

	/**
	 * design.md § Types: an interface field is one every implementer projects identically. `Memo`
	 * narrows `body` to non-null and replaces `meta` with a model of its own, so neither is on
	 * `NoteInterface`; `reply` holds the base again, which its own object type is built once for.
	 * An interface field has no arguments, resolver or directives: each implementer's field has them.
	 */
	it("give a base's interface only the fields every member projects identically", () => {
		const { projector } = fresh();
		expect(projector.output(model("Shapes.Note"))).toEqual(named("NoteInterface", true));
		expect(shapeOf(projector, "Note")).toEqual([
			["kind", named("String", true)],
			["body", named("String", false)],
			["meta", named("NoteMeta", true)],
			["reply", named("NoteInterface", false)],
		]);
		expect(shapeOf(projector, "Memo")).toEqual([
			["kind", named("String", true)],
			["body", named("String", true)],
			["meta", named("MemoMeta", true)],
			["reply", named("NoteInterface", false)],
			["title", named("String", false)],
		]);
		expect(projector.defineInterfaces(new Set(["NoteInterface", "Note", "Memo"]))).toEqual([]);
		const plain = { description: undefined, deprecationReason: undefined, arguments: [] };
		expect(fieldsOf(projector, "NoteInterface")).toEqual([
			{
				name: "kind",
				wire: "kind",
				type: named("String", true),
				...plain,
				call: undefined,
				directives: [],
			},
			{
				name: "reply",
				wire: "reply",
				type: named("NoteInterface", false),
				...plain,
				call: undefined,
				directives: [],
			},
		]);
		expect(interfacesOf(projector, "Memo")).toEqual(["NoteInterface"]);
	});

	it("give a base's interface nothing, and its members no interface, where the plan did not reach it", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Note"));
		expect(projector.defineInterfaces(new Set(["Note", "Memo"]))).toEqual([]);
		expect(fieldsOf(projector, "NoteInterface")).toEqual([]);
		expect(interfacesOf(projector, "Note")).toBeUndefined();
		expect(interfacesOf(projector, "Memo")).toBeUndefined();
	});

	/**
	 * openapi3 publishes `discriminator.propertyName` as the key a value is dispatched by, and composes
	 * `Bird` from `Animal` with `allOf`: the base's `kind`, sent as `type`, is a property of both, and
	 * `kind` is the one openapi3 adds to the base and `Bird` declares.
	 */
	it("resolve a base by the wire key its discriminator names, where its own declaration is sent as another", () => {
		const { projector } = fresh();
		expect(projector.output(model("Shapes.Animal"))).toEqual(named("AnimalInterface", true));
		expect(defOf(projector, "AnimalInterface")).toMatchObject({
			resolveBy: {
				kind: "base",
				rule: {
					property: "kind",
					mapping: { bird: { schema: validatorOf("Shapes.Bird"), type: "Bird" } },
					base: "Animal",
				},
			},
		});
		expect(fieldsOf(projector, "Animal").map((field) => [field.name, field.wire])).toEqual([
			["type", "type"],
			["legs", "legs"],
			["kind", "kind"],
		]);
		expect(fieldsOf(projector, "Bird").map((field) => [field.name, field.wire])).toEqual([
			["type", "type"],
			["legs", "legs"],
			["kind", "kind"],
			["wings", "wings"],
		]);
	});

	it("keep a nested base's interface implementing its parent's when the nested base is reached again", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Vehicle"));
		expect(projector.output(model("Shapes.Car"))).toEqual(named("CarInterface", true));
		expect(defOf(projector, "CarInterface")).toMatchObject({ interfaces: ["VehicleInterface"] });
	});

	it("record a union named as a taken name as a collision, and keep the first", () => {
		const { projector, book } = fresh();
		projector.output(looseAt("nested"), {
			name: "Shape",
			owner: "model Shapes.Adrift.held.nested",
		});
		projector.output(looseAt("spare"), {
			name: "Pet",
			owner: "model Shapes.Adrift.held.spare",
		});
		projector.output(typeOf(service, "Shapes.Shape"));
		projector.output(model("Shapes.Pet"));
		expect(book.collisions).toEqual([
			{ name: "Shape", first: "model Shapes.Adrift.held.nested", second: "union Shapes.Shape" },
			{ name: "Pet", first: "model Shapes.Adrift.held.spare", second: "model Shapes.Pet" },
		]);
		expect(defOf(projector, "Shape").kind).toBe("object");
		expect(defOf(projector, "Pet").kind).toBe("object");
	});
});

/**
 * design.md § Types: a model, enum or union named as a root type, a built-in scalar or one of the
 * runtime's scalars is `JSON`, with a `projected-as-json` warning that names the reserved name.
 */
describe("a name GraphQL already owns", () => {
	it("is JSON for a model, enum, union of literals, discriminated union or @discriminator base", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Reserved.Users"));
		expect(shapeOf(projector, "Users")).toEqual([
			["query", named("JSON", true)],
			["string", named("JSON", true)],
			["duration", named("JSON", true)],
			["subscription", named("JSON", true)],
			["id", named("JSON", true)],
			["mutation", named("JSON", true)],
			["float", named("JSON", true)],
		]);
		expect(projector.defs().map((def) => def.name)).toEqual(["JSON", "Users"]);
	});

	it("is warned with the name it took and whose that name is", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Reserved.Users"));
		const taken = (name: string, owner: string): string =>
			`its GraphQL name '${name}' is reserved, being ${owner}; rename it in TypeSpec`;
		expect(reasons(projector)).toEqual([
			["model Shapes.Reserved.Users.query", taken("Query", "a GraphQL root type")],
			["model Shapes.Reserved.Users.string", taken("String", "a scalar GraphQL builds in")],
			[
				"model Shapes.Reserved.Users.duration",
				taken("Duration", "a scalar this emitter's runtime defines"),
			],
			["Shapes.Reserved.Subscription", taken("Subscription", "a GraphQL root type")],
			["model Shapes.Reserved.Users.id", taken("ID", "a scalar GraphQL builds in")],
			["model Shapes.Reserved.Users.mutation", taken("Mutation", "a GraphQL root type")],
			["Shapes.Reserved.Float", taken("Float", "a scalar GraphQL builds in")],
		]);
	});

	/**
	 * An anonymous type is one GraphQL type wherever it is reached, named after the first member
	 * that reaches it; where that name is reserved, it is `JSON` everywhere, not a type of its own
	 * under the next member's name.
	 */
	it("keeps an anonymous model JSON where another member reaches it again", () => {
		const { projector } = fresh();
		expect(typeAt("Shapes.Big", "again")).toBe(typeAt("Shapes.Big", "integer"));
		projector.output(model("Shapes.Big"));
		expect(fieldOf(projector, "Big", "integer").type).toEqual(named("JSON", true));
		expect(fieldOf(projector, "Big", "again").type).toEqual(named("JSON", true));
		expect(projector.defs().map((def) => def.name)).not.toContain("BigAgain");
	});

	/** GraphQL enums are input and output types alike, so a union of literals is one in both. */
	it("keeps a union of literals JSON as input where its output name is reserved", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Big"));
		expect(fieldOf(projector, "Big", "decimal").type).toEqual(named("JSON", true));
		// `Big` differs at Create only by a read-only `id`, so the request is its canonical schema.
		projector.input(model("Shapes.Big"), Visibility.Create);
		expect(fieldOf(projector, "BigInput", "decimal").type).toEqual(named("JSON", true));
		// Published at 3.1, where the read-only `id` is required in the request too.
		expect(fieldOf(projector, "BigInput", "id").type).toEqual(named("String", true));
		expect(projector.defs().map((def) => def.name)).not.toContain("BigDecimal");
	});

	it.each([
		["Big", "Plot"],
		["Plot", "Big"],
	])(
		"keep a union of literals JSON where a second member reaches it under a name of its own, %s first",
		(...holders) => {
			const { projector } = fresh();
			for (const holder of holders) projector.output(model(`Shapes.${holder}`));
			expect(fieldOf(projector, "Plot", "axis").type).toEqual(named("JSON", true));
			expect(projector.defs().map((def) => def.name)).not.toContain("PlotAxis");
			expect(projector.shared).toEqual([]);
		},
	);
});

describe("names", () => {
	it("record two models converting to one name as a collision, naming both owners", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Gadget"));
		projector.output(model("Shapes.gadget_"));
		expect(book.collisions).toEqual([
			{ name: "Gadget", first: "model Shapes.Gadget", second: "model Shapes.gadget_" },
		]);
	});

	it("record two properties converting to one field name as a collision", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.Pair"));
		expect(book.collisions).toEqual([
			{
				name: "Pair.createdAt",
				first: "model Shapes.Pair: created_at",
				second: "model Shapes.Pair: createdAt",
			},
		]);
	});

	it("record two properties converting to one input field name as a collision", () => {
		const { projector, book } = fresh();
		projector.input(model("Shapes.Pair"), Visibility.Create);
		expect(book.collisions).toEqual([
			{
				name: "PairInput.createdAt",
				first: "model Shapes.Pair as input: created_at",
				second: "model Shapes.Pair as input: createdAt",
			},
		]);
	});

	it("define a generated type idempotently, and a different one under a taken name as a collision", () => {
		const { projector, book } = fresh();
		const page = { kind: "object", name: "PageInfo", description: undefined, fields: [] } as const;
		projector.define(page);
		projector.define(page);
		expect(book.collisions).toEqual([]);
		projector.define({ kind: "input", name: "PageInfo", description: undefined, fields: [] });
		expect(book.collisions).toEqual([
			{
				name: "PageInfo",
				first: "generated object PageInfo",
				second: "generated input PageInfo (a second, different definition)",
			},
		]);
		expect(defOf(projector, "PageInfo").kind).toBe("object");
	});

	it("list defs sorted by name", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Widget"));
		const names = projector.defs().map((def) => def.name);
		expect(names).toEqual([...names].sort());
	});
});

/**
 * design.md § Types, "Shared fields are an interface": a named model two or more reached output
 * types are built from, by `extends` or by a spread, is `<Name>Interface`, with each field every
 * implementer projects identically, and each of those types implements it. An `alias` has no name to
 * give one.
 */
describe("interfaces", () => {
	const BUILT = [
		"Shapes.ImplThree",
		"Shapes.ImplOne",
		"Shapes.ImplTwo",
		"Shapes.Count",
		"Shapes.Ratio",
		"Shapes.Whole",
		"Shapes.Part",
		"Shapes.Piece",
		"Shapes.Shown",
		"Shapes.Hidden",
		"Shapes.AliasOne",
		"Shapes.AliasTwo",
		"Shapes.CopyOne",
		"Shapes.CopyTwo",
		"Shapes.DeepOne",
		"Shapes.DeepTwo",
		"Shapes.OnlySolo",
	];

	function built(): { projector: TypeProjector; book: NameBook; defined: string[] } {
		const { projector, book } = fresh();
		for (const reference of BUILT) projector.output(model(reference));
		const reached = new Set(projector.defs().map((def) => def.name));
		return { projector, book, defined: projector.defineInterfaces(reached) };
	}

	/**
	 * **A body of one model's spread properties is that model**, on the wire and here (`Copies`), not
	 * a second type built from it: beside the one type that does spread it, the model is shared by no
	 * two types, so no interface is made of it.
	 */
	it("count a body that is one model's spread as that model, not as a type built from it", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Copies"));
		projector.output(model("Shapes.GadgetPlus"));
		const reached = new Set(projector.defs().map((def) => def.name));
		expect(projector.defineInterfaces(reached)).toEqual([]);
	});

	/**
	 * **An open model is no interface's source**, as no GraphQL type states an open object: two
	 * closed types spreading `Ajar` share it, but not its base `AjarBase`, which carries additional
	 * properties of its own, though they are built from it transitively.
	 */
	it("make no interface of a model with additional properties of its own", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.AjarOne"));
		projector.output(model("Shapes.AjarTwo"));
		const reached = new Set(projector.defs().map((def) => def.name));
		expect(projector.defineInterfaces(reached)).toEqual(["AjarInterface"]);
	});

	it("are made from a base or a spread source two reached types share, transitively", () => {
		const { defined } = built();
		expect(defined.toSorted()).toEqual([
			"AlphaInterface",
			"LabelledInterface",
			"MeasureInterface",
			"MidInterface",
			"MiddleInterface",
			"RootInterface",
			"ZetaInterface",
		]);
	});

	it("are implemented by each type built from the source, listed by name", () => {
		const { projector } = built();
		expect(interfacesOf(projector, "ImplOne")).toEqual([
			"AlphaInterface",
			"MidInterface",
			"ZetaInterface",
		]);
		expect(interfacesOf(projector, "ImplThree")).toEqual(["ZetaInterface"]);
		expect(interfacesOf(projector, "DeepTwo")).toEqual(["MiddleInterface", "RootInterface"]);
		expect(interfacesOf(projector, "Hidden")).toEqual(["LabelledInterface"]);
	});

	it("are not made from an alias, a model copied by is, or a source only one type is built from", () => {
		const { projector } = built();
		expect(interfacesOf(projector, "AliasOne")).toBeUndefined();
		expect(interfacesOf(projector, "CopyOne")).toBeUndefined();
		expect(interfacesOf(projector, "OnlySolo")).toBeUndefined();
	});

	/**
	 * The source's doc describes the interface and each field, whatever an implementer redeclares; a
	 * field is a plain read, as each implementer's is.
	 */
	it("carry the source's docs and each field every implementer projects identically", () => {
		const { projector } = built();
		expect(defOf(projector, "ZetaInterface")).toEqual({
			kind: "interface",
			name: "ZetaInterface",
			description: "The z-shaped part.",
			fields: [
				{
					name: "z",
					wire: "z",
					type: named("String", true),
					description: "The zeta.",
					deprecationReason: undefined,
					arguments: [],
					call: undefined,
					directives: [],
				},
			],
		});
	});

	/**
	 * GraphQL requires an implementer's field to be a subtype of the interface's: a property narrowed
	 * to different types (`int32` here, `float64` there), or hidden from reads in one implementer,
	 * stays on the types alone, and a source with no field left makes no interface.
	 */
	it("leave out a field an implementer narrows differently or does not read, and make none of a source with no field left", () => {
		const { projector } = built();
		expect(fieldsOf(projector, "MeasureInterface").map((field) => field.name)).toEqual(["unit"]);
		expect(fieldsOf(projector, "LabelledInterface").map((field) => field.name)).toEqual(["note"]);
		expect(interfacesOf(projector, "Whole")).toBeUndefined();
	});

	/**
	 * TypeSpec accepts a model that extends a model spreading it: each is built from the other alone,
	 * so neither is shared by two types, and neither is its own source.
	 */
	it("are not made from a model that an extends and a spread loop back to", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Clasp"));
		projector.output(model("Shapes.Hook"));
		const reached = new Set(projector.defs().map((def) => def.name));
		expect(reached).toEqual(new Set(["Clasp", "Hook"]));
		expect(projector.defineInterfaces(reached)).toEqual([]);
		expect(interfacesOf(projector, "Clasp")).toBeUndefined();
	});

	/** Whichever implementer is reached first, a field one of them does not read stays off. */
	it("leave out a field the first type reached does not read", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Hidden"));
		projector.output(model("Shapes.Shown"));
		const reached = new Set(projector.defs().map((def) => def.name));
		expect(projector.defineInterfaces(reached)).toEqual(["LabelledInterface"]);
		expect(fieldsOf(projector, "LabelledInterface").map((field) => field.name)).toEqual(["note"]);
	});

	/**
	 * **An interface is built only over the object types this projector registered.** A caller's
	 * hint that claims a model's own name as the model would leave an enum where its object was; the
	 * interface refuses to read fields that are not there.
	 */
	it("refuse to build an interface over a name a caller re-registered as another kind", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.ImplOne"));
		projector.output(model("Shapes.ImplTwo"));
		projector.output(looseAt("stage"), {
			name: "ImplOne",
			owner: "model Shapes.ImplOne",
		});
		expect(defOf(projector, "ImplOne").kind).toBe("enum");
		expect(() => projector.defineInterfaces(new Set(["ImplOne", "ImplTwo"]))).toThrow(
			/^ImplOne is no object type this projector registered$/,
		);
	});

	/** As on an object type, a field is named from its JSON wire name and keeps it to read it back. */
	it("name each field from the source property's JSON name", () => {
		const { projector } = built();
		expect(fieldsOf(projector, "AlphaInterface").map((field) => [field.name, field.wire])).toEqual([
			["a", "a"],
			["alphaCode", "alpha_code"],
		]);
	});

	it("count only the types the plan reached", () => {
		const { projector } = fresh();
		for (const reference of ["Shapes.ImplOne", "Shapes.ImplTwo", "Shapes.ImplThree"]) {
			projector.output(model(reference));
		}
		expect(projector.defineInterfaces(new Set(["ImplOne", "ImplThree"]))).toEqual([
			"ZetaInterface",
		]);
		expect(interfacesOf(projector, "ImplOne")).toEqual(["ZetaInterface"]);
		expect(interfacesOf(projector, "ImplTwo")).toBeUndefined();
	});

	it("record an interface whose name is taken as a collision, and make none", () => {
		const { projector, book } = fresh();
		projector.output(model("Shapes.ImplOne"));
		projector.output(model("Shapes.ImplTwo"));
		projector.define({ kind: "object", name: "MidInterface", description: undefined, fields: [] });
		const defined = projector.defineInterfaces(new Set(["ImplOne", "ImplTwo"]));
		expect(defined.toSorted()).toEqual(["AlphaInterface", "ZetaInterface"]);
		expect(book.collisions).toEqual([
			{
				name: "MidInterface",
				first: "generated object MidInterface",
				second: "model Shapes.Mid as an interface",
			},
		]);
		expect(interfacesOf(projector, "ImplOne")).toEqual(["AlphaInterface", "ZetaInterface"]);
	});
});

/**
 * design.md § Arguments and input: a default is stated in the schema, an enum's by its value's
 * CONSTANT_CASE name, whether the enum is declared or a union of literals, and the method's contract: no literal where the default has no spelling in the type, an object,
 * list or scalar-constructor default, or one whose JSON type is not the GraphQL type's. A JSON
 * number is an IEEE double, so a default no double holds exactly has no spelling either.
 */
describe("defaults", () => {
	const valueOf = (property: string): Value | undefined =>
		propertyOf("Shapes.Defaults", property).defaultValue;

	it.each<[string, DefaultLiteral | undefined]>([
		["text", { kind: "STRING", value: "hi" }],
		["flag", { kind: "BOOLEAN", value: true }],
		["count", { kind: "INT", value: "5" }],
		["ratio", { kind: "FLOAT", value: "1.5" }],
		["whole", { kind: "INT", value: "2" }],
		["big", { kind: "INT", value: "7" }],
		["amount", { kind: "FLOAT", value: "2.5" }],
		["tiny", undefined],
		["digits", undefined],
		["maybe", { kind: "NULL" }],
		["status", { kind: "ENUM", value: "DONE" }],
		["shade", { kind: "ENUM", value: "DARK" }],
		["tags", undefined],
		["stamp", undefined],
	])("%s's default is %j", (property, expected) => {
		const { projector } = fresh();
		projector.input(model("Shapes.Defaults"), Visibility.Create);
		expect(fieldOf(projector, "DefaultsInput", property).defaultValue).toEqual(expected);
	});

	/**
	 * Two enums of one GraphQL name collide, and `graphql-name-collision` drops every party at
	 * planning; until then a default from the second names no value of the first, so none is stated.
	 */
	it("states no default whose value names no value of the enum its name reached", () => {
		const { projector } = fresh();
		projector.input(model("Shapes.Defaults"), Visibility.Create);
		projector.input(model("Shapes.EnumClash"), Visibility.Create);
		expect(fieldOf(projector, "EnumClashInput", "status").defaultValue).toBeUndefined();
	});

	it.each<[string, string, TypeRef, DefaultLiteral | undefined]>([
		[
			"a string on ID, which serialises as a String",
			"text",
			named("ID", true),
			{ kind: "STRING", value: "hi" },
		],
		["a string on JSON", "text", named("JSON", false), { kind: "STRING", value: "hi" }],
		["a boolean on JSON", "flag", named("JSON", false), { kind: "BOOLEAN", value: true }],
		["an integer on JSON", "count", named("JSON", false), { kind: "INT", value: "5" }],
		["a fraction on JSON", "ratio", named("JSON", false), { kind: "FLOAT", value: "1.5" }],
		["a string on Int", "text", named("Int", true), undefined],
		["a boolean on String", "flag", named("String", true), undefined],
		["a fraction on Int", "ratio", named("Int", true), undefined],
		["a fraction on Long, an integer scalar", "ratio", named("Long", true), undefined],
		["null on a non-null type", "maybe", named("String", true), undefined],
		["a string on a list", "text", listOf(named("String", true), true), undefined],
		["a string on a type the projector never defined", "text", named("Gadget", true), undefined],
	])("%s is %j", (_, property, ref, expected) => {
		const { projector } = fresh();
		projector.output(model("Shapes.Odd"));
		expect(projector.defaultLiteralOf(valueOf(property), ref)).toEqual(expected);
	});

	it("is no literal where there is no default", () => {
		const { projector } = fresh();
		expect(projector.defaultLiteralOf(undefined, named("String", false))).toBeUndefined();
	});
});

describe("addFields", () => {
	it("appends to an object, and refuses a duplicate or anything else", () => {
		const { projector } = fresh();
		projector.output(model("Shapes.Gadget"));
		const extra: OutputFieldPlan = {
			name: "related",
			wire: "related",
			type: named("Gadget", false),
			description: undefined,
			deprecationReason: undefined,
			arguments: [],
			call: undefined,
			directives: [],
		};
		projector.addFields("Gadget", [extra]);
		expect(fieldsOf(projector, "Gadget").map((field) => field.name)).toEqual(["id", "related"]);
		expect(() => projector.addFields("Gadget", [extra])).toThrow(/already has a field related/);
		expect(() => projector.addFields("Missing", [extra])).toThrow(/not an object type/);
	});
});

/**
 * **A shape the library refuses is still projected, without a throw or a loop.** An emit carries on
 * past a library's error, so `refused.tsp` declares one of each shape `typespec-http-zod` refuses with
 * an error of its own, compiled with exactly those errors expected. A scalar whose `@encode` names
 * itself states no other wire type: without the guard, `#scalar` called itself for ever.
 */
describe("shapes the library refuses", () => {
	let refused: Program;
	let typeSchemaNames: ReadonlyMap<Type, string>;
	beforeAll(async () => {
		const compiled = await emittedServicesOf(
			here,
			"refused",
			"refused",
			refusalsOf("types/refused"),
		);
		refused = compiled.program;
		typeSchemaNames = new Map(compiled.services.flatMap((each) => [...each.typeSchemaNames]));
	});

	function projectorOf(): TypeProjector {
		return new TypeProjector(refused, new NameBook(), typeSchemaNames);
	}

	function declared(reference: string): Type {
		const [type] = refused.resolveTypeReference(reference);
		if (type === undefined) throw new Error(`refused.tsp declares no ${reference}`);
		return type;
	}

	it.each([
		["stamp", named("UTCDateTimeHuman", true)],
		["selfish", named("String", true)],
	])("%s under its encoding is %j", (property, expected) => {
		const projector = projectorOf();
		projector.output(declared("Refused.Encodings"));
		expect(fieldOf(projector, "Encodings", property).type).toEqual(expected);
	});

	it("projects a template as String, and void as JSON, warned", () => {
		const projector = projectorOf();
		projector.output(declared("Refused.Odd"));
		expect(fieldOf(projector, "Odd", "template").type).toEqual(named("String", true));
		expect(fieldOf(projector, "Odd", "hollow").type).toEqual(named("JSON", true));
		expect(reasons(projector)).toEqual([
			["model Refused.Odd.hollow", "`void` has no GraphQL type"],
		]);
	});

	it.each([
		["Refused.Fallback", "its default variant carries no discriminator value"],
		["Refused.Bundle", "variant many is not a model that projects to an object type"],
	])("projects %s as JSON, warned", (reference, reason) => {
		const projector = projectorOf();
		expect(projector.output(declared(reference))).toEqual(named("JSON", true));
		expect(reasons(projector)).toEqual([[reference, reason]]);
	});

	/**
	 * design.md § Types: a subtype the library refuses whole has no validator it publishes, so no
	 * value is one. The base's rule maps no discriminator value to it, a nested base's neither, and
	 * the value is answered as the base.
	 */
	it("maps no discriminator value to a subtype the library publishes no validator for", () => {
		const published = (reference: string): string | undefined =>
			typeSchemaNames.get(declared(reference));
		expect(published("Refused.Wolf")).toBeUndefined();
		expect(published("Refused.Canine")).toBeUndefined();
		const projector = projectorOf();
		expect(projector.output(declared("Refused.Beast"))).toEqual(named("BeastInterface", true));
		const def = defOf(projector, "BeastInterface");
		expect(def.kind === "interface" ? def.resolveBy : def).toEqual({
			kind: "base",
			rule: {
				property: "kind",
				mapping: { bear: { schema: published("Refused.Bear"), type: "Bear" } },
				base: "Beast",
			},
		});
		expect(defOf(projector, "CanineInterface")).toMatchObject({
			resolveBy: {
				rule: {
					mapping: { coyote: { schema: published("Refused.Coyote"), type: "Coyote" } },
					base: "Canine",
				},
			},
		});
	});
});
