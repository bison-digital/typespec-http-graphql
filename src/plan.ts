import type { Program, Type } from "@typespec/compiler";
import { getDeprecationDetails, getDoc, getTypeName, isNullType } from "@typespec/compiler";
import type { EmittedService } from "typespec-http-zod";
import { type ConnectionVerdict, connectionOf, defineConnection } from "./connections.js";
import { type JsonDeclaration, jsonDeclarationsOf } from "./decorators.js";
import { dispositionOf, type FieldInputs, mutationInputsOf, queryInputsOf } from "./inputs.js";
import {
	type AppliedDirective,
	asNullable,
	type CallPlan,
	type ConnectionPlan,
	listOf,
	named,
	type OutputFieldPlan,
	type Projection,
	type SchemaPlan,
	type TypeDef,
	type TypeRef,
} from "./model.js";
import { type Collision, NameBook, typeNameOf } from "./names.js";
import {
	batchResultOf,
	type FieldResult,
	mutationResultOf,
	queryResultOf,
	statusCodesTable,
} from "./results.js";
import type { LinkField, RootField, Surface, SurfaceDiagnostic } from "./surface.js";
import { TypeProjector } from "./types.js";

/**
 * One service's `SchemaPlan`, from its checked surface: every root field, every link, and every type
 * they reach, before anything is written.
 *
 * **A link is planned only once its parent is reachable**, to a fixpoint, because one link can make
 * another's parent reachable (`Book.author` reaches `Author`, which makes a link on `Author`
 * plannable). A link whose parent never reaches the schema is dropped with `link-target-unreachable`,
 * and its operation's types are never projected, so they can neither appear in the schema nor
 * collide with anything that does.
 *
 * **A name collision drops every declaration that reaches either party** (`graphql-name-collision`):
 * keeping one would make the schema depend on declaration order. A collision is a type name
 * (`Gadget`), a member of one (`Pair.createdAt`), or an argument of one field
 * (`Query.widgets(pageSize)`). After the drops, reachability is computed again, so a link whose parent
 * was reachable only through a dropped root is dropped too.
 */

export interface PlannedService {
	readonly plan: SchemaPlan;
	/** link-target-unreachable and graphql-name-collision for each drop, then not-a-connection, projected-as-json and anonymous-type-shared. */
	readonly warnings: readonly SurfaceDiagnostic[];
	readonly emitted: number; // root and link fields in the plan
	readonly dropped: number; // dropped at planning (unreachable links, name collisions)
}

/** One planned root field or link, with what the plan needs to keep or drop it. */
interface Planned {
	readonly kind: "query" | "mutation" | "link";
	/** `Query.book`, `Mutation.createBook`, `Book.author`: its argument claims' prefix. */
	readonly key: string;
	readonly declaration: RootField | LinkField;
	/** The object type a link is a field of; `undefined` for a root field. */
	readonly parent: string | undefined;
	readonly field: OutputFieldPlan;
	readonly verdict: ConnectionVerdict;
	/**
	 * Where this is one arm of a link chosen by a kind: the field its arms share, and the member it
	 * answers. Each arm is planned, kept and dropped as the declaration it is, and the arms that
	 * survive are written as one field.
	 */
	readonly arm?: { readonly group: KeyedGroup; readonly member: string | undefined };
}

/** The field the arms of a link chosen by a kind are one of. Shared by identity between its arms. */
interface KeyedGroup {
	/** The parent's wire key holding the kind. */
	readonly property: string;
}

/**
 * **A parameter that carries a credential by the standards that define it**: a cookie (RFC 6265, a
 * session's own carrier), or a header named `Authorization` or `Proxy-Authorization` (RFC 9110
 * §11.6.2, §11.7.2) or `Cookie`. Required, it stays an argument and is warned `transport-argument`.
 * Any other required header is domain input by its declaration (`x-api-version`), warned by nothing:
 * a warning on the common case would teach a spec author to ignore it. A credential declared through
 * `@useAuth` is never an argument at all.
 */
function carriesCredentials(parameter: { readonly type: string; readonly name: string }): boolean {
	if (parameter.type === "cookie") return true;
	if (parameter.type !== "header") return false;
	return ["authorization", "proxy-authorization", "cookie"].includes(parameter.name.toLowerCase());
}

/** `@cost(weight: "1")` on every root field and link: each calls a handler. */
const COST: AppliedDirective = { name: "cost", arguments: { weight: "1" } };

/**
 * **A link bound to a list calls once per value**, so its field costs a call for each value it can
 * hold: `@cost(weight:)` its list's `@maxItems`, and `@listSize(assumedSize:)` the same, so what is
 * selected below counts once per item. The specification weighs a field once however long its list
 * (§5.3.2.2); weighed at 1, `tags { id }` would cost one call where it makes fifty.
 */
function listLinkDirectivesOf(maxItems: number): readonly AppliedDirective[] {
	return [
		{ name: "cost", arguments: { weight: String(maxItems) } },
		{ name: "listSize", arguments: { assumedSize: maxItems } },
	];
}

/**
 * **A batched link's weight is the calls it can make**: one call carries the values of many parents,
 * so a field's own values take `ceil(L / n)` calls at most, `L` the most it holds (its list's
 * `@maxItems`, or one) and `n` the most one call carries (the batch parameter's `@maxItems`, or every
 * value). A batch that can answer 404 has each of those values retried alone, `L` calls more. Field
 * Cost is counted per field, so a batched link never weighs less than the link it replaces: the
 * saving is in calls made, and a cost limit still bounds them.
 */
function batchLinkDirectivesOf(
	maxItems: number | undefined,
	size: number | undefined,
	projection: Readonly<Record<string, Projection>>,
): readonly AppliedDirective[] {
	const held = maxItems ?? 1;
	const retried = Object.values(projection).some(
		(arm) => arm.as === "null" || (arm.as === "byStatus" && arm.nullOn404),
	);
	const weight = (size === undefined ? 1 : Math.ceil(held / size)) + (retried ? held : 0);
	return [
		{ name: "cost", arguments: { weight: String(weight) } },
		...(maxItems === undefined
			? []
			: [{ name: "listSize" as const, arguments: { assumedSize: maxItems } }]),
	];
}

/**
 * `@listSize` on every connection field, sized by `first`: by its default when the query sends none,
 * else by `assumedSize`, the largest page size the operation accepts (`ConnectionPlan.maximum`),
 * where `first` has no default to read (§8.2, §9.2.4 of the cost specification).
 */
function listSizeOf(connection: ConnectionPlan): AppliedDirective {
	return {
		name: "listSize",
		arguments: {
			...(connection.assumedSize === undefined ? {} : { assumedSize: connection.assumedSize }),
			slicingArguments: ["first"],
			sizedFields: ["edges", "nodes"],
			requireOneSlicingArgument: false,
		},
	};
}

/** GraphQL requires a Query type; a surface that declares no query gets this one field. */
const EMPTY_QUERY: OutputFieldPlan = {
	name: "_empty",
	wire: "_empty",
	type: named("Boolean", false),
	description: "Always null: GraphQL requires a Query type, and this schema declares no query.",
	deprecationReason: undefined,
	arguments: [],
	call: undefined,
	directives: [],
};

/** Queries are planned before mutations, so a type both reach is named from the read side. */
const ORDER = { query: 0, mutation: 1 } as const;

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function innermostName(ref: TypeRef): string {
	return ref.kind === "named" ? ref.name : innermostName(ref.of);
}

/** The refs a field's type and arguments start from. */
function refsOf(field: OutputFieldPlan): TypeRef[] {
	return [field.type, ...field.arguments.map((argument) => argument.type)];
}

/** The names reachable from `roots` through object fields and arguments, input fields and union members. */
function reachableFrom(defs: ReadonlyMap<string, TypeDef>, roots: readonly TypeRef[]): Set<string> {
	const seen = new Set<string>();
	const queue = roots.map(innermostName);
	for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
		if (seen.has(name)) continue;
		seen.add(name);
		const def = defs.get(name);
		if (def?.kind === "object" || def?.kind === "interface") {
			for (const field of def.fields) queue.push(...refsOf(field).map(innermostName));
			// A base's interface reaches every object type a value may be, and the interface it implements.
			if (def.kind === "interface") queue.push(...(def.members ?? []), ...(def.interfaces ?? []));
		} else if (def?.kind === "input") {
			for (const field of def.fields) queue.push(innermostName(field.type));
		} else if (def?.kind === "union") {
			queue.push(...def.members);
		}
	}
	return seen;
}

/**
 * The types the roots reach, counting in each link whose parent they reach, to a fixpoint; and the
 * links that kept.
 */
function liveOf(
	defs: ReadonlyMap<string, TypeDef>,
	planned: readonly Planned[],
): { readonly types: Set<string>; readonly links: Set<Planned> } {
	const roots = planned.filter((entry) => entry.kind !== "link");
	const types = reachableFrom(
		defs,
		roots.flatMap((root) => refsOf(root.field)),
	);
	const links = new Set<Planned>();
	for (let grew = true; grew;) {
		grew = false;
		for (const link of planned) {
			if (link.parent === undefined || links.has(link) || !types.has(link.parent)) continue;
			links.add(link);
			for (const name of reachableFrom(defs, refsOf(link.field))) types.add(name);
			grew = true;
		}
	}
	return { types, links };
}

function defsByName(projector: TypeProjector): Map<string, TypeDef> {
	return new Map(projector.defs().map((def) => [def.name, def]));
}

function fieldOf(
	program: Program,
	declaration: RootField | LinkField,
	kind: CallPlan["kind"],
	inputs: FieldInputs,
	result: FieldResult,
	connection: ConnectionPlan | undefined,
): OutputFieldPlan {
	const operation = declaration.operation.operation;
	const maxItems = "bindings" in declaration ? declaration.maxItems : undefined;
	const batch = "bindings" in declaration ? declaration.batch : undefined;
	return {
		name: declaration.name,
		wire: declaration.name,
		// A list link is a list of what one call answers, each item null where its call answers none.
		type: maxItems === undefined ? result.type : listOf(asNullable(result.type), false),
		// `graphql.tsp`'s own, where it gives one: the operation's doc is written for REST.
		description: declaration.description ?? getDoc(program, operation),
		deprecationReason: getDeprecationDetails(program, operation)?.message,
		arguments: inputs.arguments,
		call: {
			kind,
			operationId: declaration.route.operationId,
			authentication: declaration.route.authentication,
			security: declaration.route.security,
			inputSchema: `${declaration.route.operationId}GraphQLInput`,
			responses: declaration.names.responses,
			bound:
				"bindings" in declaration
					? declaration.bindings.map((binding) => ({
							wire: binding.wire,
							parent: binding.parentWire,
							...(binding.list ? { list: true as const } : {}),
						}))
					: [],
			supplied: inputs.supplied,
			projection: result.projection,
			connection,
			...(batch === undefined
				? {}
				: {
						batch: { wire: batch.wire, key: batch.key, items: batch.items, size: batch.size },
					}),
		},
		directives:
			batch !== undefined
				? batchLinkDirectivesOf(maxItems, batch.size, result.projection)
				: maxItems !== undefined
					? listLinkDirectivesOf(maxItems)
					: connection === undefined
						? [COST]
						: [COST, listSizeOf(connection)],
	};
}

/**
 * A root field: its connection verdict, then its result, then its inputs. The result goes before the
 * inputs so a model both reach is named, and its anonymous members are named, from the output side.
 */
function planRoot(program: Program, root: RootField, projector: TypeProjector): Planned {
	const verdict: ConnectionVerdict =
		root.kind === "query" ? connectionOf(program, root.operation, projector) : { kind: "plain" };
	const connection = verdict.kind === "connection" ? verdict.plan : undefined;
	const connectionType =
		connection === undefined ? undefined : defineConnection(connection, projector);
	const result =
		root.kind === "query"
			? queryResultOf(program, root.route, root.operation, projector, root.name, connectionType)
			: mutationResultOf(program, root.route, root.operation, projector, root.name);
	const inputs =
		root.kind === "query"
			? queryInputsOf(program, root, projector, connection)
			: mutationInputsOf(program, root, projector);
	return {
		kind: root.kind,
		key: `${root.kind === "query" ? "Query" : "Mutation"}.${root.name}`,
		declaration: root,
		parent: undefined,
		field: fieldOf(program, root, root.kind, inputs, result, connection),
		verdict,
	};
}

/**
 * A link: a query field of its parent, its generated types named `<Parent><Link>...`, and an arm of
 * a link chosen by a kind `<Parent><Link><Value>...`, after the first value that chooses it, so that
 * no two arms claim one name.
 */
function planLink(
	program: Program,
	link: LinkField,
	parent: string,
	projector: TypeProjector,
): Planned {
	const verdict = connectionOf(program, link.operation, projector);
	const connection = verdict.kind === "connection" ? verdict.plan : undefined;
	const connectionType =
		connection === undefined ? undefined : defineConnection(connection, projector);
	const [value] = link.when?.values ?? [];
	const enclosing = `${parent}${typeNameOf(link.name)}${value === undefined ? "" : typeNameOf(value)}`;
	const result =
		link.batch === undefined
			? queryResultOf(program, link.route, link.operation, projector, enclosing, connectionType)
			: batchResultOf(link.route, link.operation, projector, enclosing, link.batch.item);
	const inputs = queryInputsOf(program, link, projector, connection);
	return {
		kind: "link",
		key: `${parent}.${link.name}`,
		declaration: link,
		parent,
		field: fieldOf(program, link, "link", inputs, result, connection),
		verdict,
	};
}

/**
 * **What an arm answers, as union members**: its own object type, or the members of the result union
 * its projection tags; otherwise why no union can hold it. A discriminated union or an interface
 * resolves an answer by its shape, never by the arm, so neither can stand in a union resolved by
 * arms; a list, a scalar or a connection is no object type at all.
 */
function membersOfArm(
	planned: Planned,
	defs: ReadonlyMap<string, TypeDef>,
): { readonly members: readonly string[]; readonly member: string | undefined } | string {
	if (planned.verdict.kind === "connection") return "a connection";
	const listed = "bindings" in planned.declaration && planned.declaration.maxItems !== undefined;
	const ref =
		listed && planned.field.type.kind === "list" ? planned.field.type.of : planned.field.type;
	if (ref.kind === "list") return "a list";
	const def = defs.get(ref.name);
	if (def?.kind === "object") return { members: [ref.name], member: ref.name };
	if (def?.kind === "union" && def.resolveBy.kind === "member") {
		return { members: def.members, member: undefined };
	}
	if (def?.kind === "union") return "a union resolved by its discriminator";
	if (def?.kind === "interface") return "an interface";
	if (def?.kind === "enum") return "an enum";
	const projections = Object.values(planned.field.call?.projection ?? {});
	if (ref.name === "Boolean" && projections.some((projection) => projection.as === "true")) {
		return "no body";
	}
	return "a scalar";
}

/**
 * **An arm's arguments as the field would state them once**: by name, whatever order the operation
 * declares them in, each with its type and default. A type is spelled out to what a client may send:
 * an enum's values and an input object's fields, read from `defs` as they stand when the arm is
 * planned. Two arms' anonymous types are named alike, after the field, so a later arm's would
 * otherwise replace an earlier one's under the same name and pass for it.
 */
function argumentSignatureOf(field: OutputFieldPlan, defs: ReadonlyMap<string, TypeDef>): string {
	const seen = new Set<string>();
	const text = (ref: TypeRef): string => {
		const nullability = ref.nonNull ? "!" : "";
		if (ref.kind === "list") return `[${text(ref.of)}]${nullability}`;
		const def = defs.get(ref.name);
		if (seen.has(ref.name) || (def?.kind !== "enum" && def?.kind !== "input")) {
			return `${ref.name}${nullability}`;
		}
		seen.add(ref.name);
		const members =
			def.kind === "enum"
				? def.values.map((value) => `${value.name}=${String(value.wire)}`)
				: def.fields.map((input) => `${input.name}:${text(input.type)}`);
		return `${ref.name}{${members.join(",")}}${nullability}`;
	};
	return JSON.stringify(
		field.arguments
			.map((argument) => [argument.name, text(argument.type), argument.defaultValue] as const)
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

/**
 * **The arms of one link chosen by a kind, planned together**, once their parent is reachable:
 * each arm that can be a member, then their arguments, which the field states once, then the union
 * `<Parent><Link>` of what they answer, in the order they were declared. The field is that union even
 * with one arm, as a mutation's result is a union with one member: a second arm then adds a member
 * rather than changing the field's type under every client.
 */
function planArms(
	program: Program,
	links: readonly LinkField[],
	parent: string,
	projector: TypeProjector,
	warnings: SurfaceDiagnostic[],
): { readonly planned: readonly Planned[]; readonly dropped: number } {
	const signatures = new Map<Planned, string>();
	const arms = links.map((link) => {
		const arm = planLink(program, link, parent, projector);
		signatures.set(arm, argumentSignatureOf(arm.field, defsByName(projector)));
		return arm;
	});
	const defs = defsByName(projector);
	const members: (Planned & {
		readonly members: readonly string[];
		readonly member: string | undefined;
		readonly signature: string | undefined;
	})[] = [];
	let dropped = 0;
	for (const arm of arms) {
		const answered = membersOfArm(arm, defs);
		if (typeof answered === "string") {
			warnings.push({
				code: "link-arm-not-object",
				target: arm.declaration.node,
				format: {
					link: `${(arm.declaration as LinkField).parent.name}.${arm.field.name}`,
					operationId: arm.declaration.route.operationId,
					answers: answered,
				},
			});
			dropped += 1;
			continue;
		}
		members.push({ ...arm, ...answered, signature: signatures.get(arm) });
	}
	const [first] = members;
	if (first === undefined) return { planned: [], dropped };
	if (new Set(members.map((arm) => arm.signature)).size > 1) {
		for (const arm of members) {
			warnings.push({
				code: "link-arms-conflict",
				target: arm.declaration.node,
				format: {
					link: `${(arm.declaration as LinkField).parent.name}.${arm.field.name}`,
					reason: "their arguments differ",
				},
			});
		}
		return { planned: [], dropped: dropped + members.length };
	}
	const union = `${parent}${typeNameOf(first.field.name)}`;
	projector.define({
		kind: "union",
		name: union,
		description: undefined,
		members: [...new Set(members.flatMap((arm) => arm.members))],
		resolveBy: { kind: "member" },
	});
	const when = (first.declaration as LinkField).when;
	const group: KeyedGroup = { property: when?.parentWire ?? "" };
	const planned = members.map((arm): Planned => {
		const listed = arm.field.type.kind === "list";
		const type = listed ? listOf(named(union, false), false) : named(union, false);
		return {
			kind: arm.kind,
			key: arm.key,
			declaration: arm.declaration,
			parent: arm.parent,
			field: { ...arm.field, type },
			verdict: arm.verdict,
			arm: { group, member: arm.member },
		};
	});
	return { planned, dropped };
}

/**
 * **One field from the arms of a link chosen by a kind that survived**: the union they share, the
 * arguments each states alike, and the description `graphql.tsp` gives, never an operation's, since
 * each arm's describes a different read. Weighed as its costliest arm.
 */
function keyedFieldOf(arms: readonly Planned[]): OutputFieldPlan {
	const [first] = arms;
	if (first?.arm === undefined) throw new Error("keyedFieldOf: no arm");
	const weights = arms.map((arm) =>
		Number(
			arm.field.directives.find((directive) => directive.name === "cost")?.arguments["weight"],
		),
	);
	const sizes = arms.flatMap((arm) => {
		const size = arm.field.directives.find((directive) => directive.name === "listSize")?.arguments[
			"assumedSize"
		];
		return typeof size === "number" ? [size] : [];
	});
	// Deprecated only where every arm's read is: while one is not, some parent still has a read.
	const reasons = arms.map((arm) => arm.field.deprecationReason);
	return {
		name: first.field.name,
		wire: first.field.wire,
		type: first.field.type,
		description: first.declaration.description,
		deprecationReason: reasons.every((reason) => reason !== undefined)
			? [...new Set(reasons)].join("; ")
			: undefined,
		arguments: first.field.arguments,
		call: undefined,
		keyed: {
			property: first.arm.group.property,
			arms: arms.map((arm) => {
				const call = arm.field.call;
				if (call === undefined) throw new Error(`keyedFieldOf: ${arm.key} calls nothing`);
				return {
					values: (arm.declaration as LinkField).when?.values ?? [],
					call,
					arguments: arm.field.arguments,
					member: arm.arm?.member,
				};
			}),
		},
		directives: [
			{ name: "cost", arguments: { weight: String(Math.max(...weights)) } },
			...(sizes.length === 0
				? []
				: [{ name: "listSize" as const, arguments: { assumedSize: Math.max(...sizes) } }]),
		],
	};
}

/** The collision a planned field falls to: one in a type it reaches, or among its own arguments. */
function collisionOf(
	planned: Planned,
	defs: ReadonlyMap<string, TypeDef>,
	collisions: readonly Collision[],
): Collision | undefined {
	const reach = reachableFrom(defs, refsOf(planned.field));
	return collisions.find((collision) => {
		const argument = collision.name.indexOf("(");
		if (argument >= 0) return collision.name.slice(0, argument) === planned.key;
		return reach.has(collision.name.split(".")[0] ?? collision.name);
	});
}

/**
 * **The types each `@json` accepts as `JSON`**: a type it names, or the type of a property it names,
 * with that type's `null` set aside, as the projector meets a nullable property's type. Keyed by
 * type, because a projection is: a property of a named type accepts that type wherever it is reached,
 * where its warning, raised once per type, would have been raised once.
 */
function jsonAcceptedOf(program: Program): ReadonlyMap<Type, readonly JsonDeclaration[]> {
	const accepted = new Map<Type, JsonDeclaration[]>();
	const accept = (type: Type, declaration: JsonDeclaration): void => {
		accepted.set(type, [...(accepted.get(type) ?? []), declaration]);
	};
	for (const declaration of jsonDeclarationsOf(program)) {
		const { target } = declaration;
		const type = target.kind === "ModelProperty" ? target.type : target;
		accept(type, declaration);
		if (type.kind !== "Union") continue;
		const present = [...type.variants.values()].filter((variant) => !isNullType(variant.type));
		const [only] = present;
		if (present.length === 1 && only !== undefined) accept(only.type, declaration);
	}
	return accepted;
}

function unreachable(link: LinkField): SurfaceDiagnostic {
	return {
		code: "link-target-unreachable",
		target: link.node,
		format: { link: link.name, model: getTypeName(link.parent) },
	};
}

export function planService(
	program: Program,
	emitted: EmittedService,
	surface: Surface,
): PlannedService {
	const book = new NameBook();
	const projector = new TypeProjector(program, book, emitted.typeSchemaNames);
	const warnings: SurfaceDiagnostic[] = [];
	const planned: Planned[] = [];
	/** Counted as each drop is reported, so `emitted + dropped` is arithmetic a test can check. */
	let dropped = 0;

	const roots = [...surface.roots].sort(
		(a, b) => ORDER[a.kind] - ORDER[b.kind] || compare(a.name, b.name),
	);
	for (const root of roots) planned.push(planRoot(program, root, projector));

	const pending = [...surface.links].sort(
		(a, b) => compare(getTypeName(a.parent), getTypeName(b.parent)) || compare(a.name, b.name),
	);
	for (let grew = true; grew;) {
		const defs = defsByName(projector);
		const reachable = liveOf(defs, planned).types;
		const ready = pending.flatMap((link) => {
			const parent = projector.outputNameOf(link.parent);
			return parent !== undefined && reachable.has(parent) ? [[link, parent] as const] : [];
		});
		grew = ready.length > 0;
		/** The arms of each link chosen by a kind, by field, planned together once every one is ready. */
		const keyed = new Map<string, LinkField[]>();
		for (const [link, parent] of ready) {
			pending.splice(pending.indexOf(link), 1);
			const own = defs.get(parent);
			if (own?.kind === "object" && own.fields.some((field) => field.name === link.name)) {
				warnings.push({
					code: "graphql-name-collision",
					target: link.node,
					format: {
						name: `${parent}.${link.name}`,
						first: `${parent}.${link.name}`,
						second: `@link ${link.name}`,
					},
				});
				dropped += 1;
				continue;
			}
			if (link.when !== undefined) {
				const key = `${parent}.${link.name}`;
				keyed.set(key, [...(keyed.get(key) ?? []), link]);
				continue;
			}
			planned.push(planLink(program, link, parent, projector));
		}
		for (const links of keyed.values()) {
			const [first] = links;
			const parent = first === undefined ? undefined : projector.outputNameOf(first.parent);
			if (parent === undefined) continue;
			const arms = planArms(program, links, parent, projector, warnings);
			planned.push(...arms.planned);
			dropped += arms.dropped;
		}
	}
	for (const link of pending) {
		warnings.push(unreachable(link));
		dropped += 1;
	}

	/**
	 * Each field's argument names are claimed, so two parameters converting to one name collide. A
	 * link chosen by a kind states its arguments once, for every arm, which `planArms` has already
	 * held alike; its first arm claims them.
	 */
	const claimedBy = new Set<KeyedGroup>();
	for (const entry of planned) {
		if (entry.arm !== undefined) {
			if (claimedBy.has(entry.arm.group)) continue;
			claimedBy.add(entry.arm.group);
		}
		for (const argument of entry.field.arguments) {
			book.claim(`${entry.key}(${argument.name})`, `${entry.key}(${argument.wire})`);
		}
	}

	const defs = defsByName(projector);
	const kept: Planned[] = [];
	for (const entry of planned) {
		const collision = collisionOf(entry, defs, book.collisions);
		if (collision === undefined) {
			kept.push(entry);
			continue;
		}
		warnings.push({
			code: "graphql-name-collision",
			target: entry.declaration.node,
			format: { name: collision.name, first: collision.first, second: collision.second },
		});
		dropped += 1;
	}

	const live = liveOf(defs, kept);
	const survivors = kept.filter((entry) => entry.kind !== "link" || live.links.has(entry));
	for (const entry of kept) {
		if (entry.kind === "link" && !live.links.has(entry) && "bindings" in entry.declaration) {
			warnings.push(unreachable(entry.declaration));
			dropped += 1;
		}
	}

	const linksByParent = new Map<string, OutputFieldPlan[]>();
	const armsOf = new Map<KeyedGroup, Planned[]>();
	for (const entry of survivors) {
		if (entry.parent === undefined) continue;
		if (entry.arm !== undefined) {
			armsOf.set(entry.arm.group, [...(armsOf.get(entry.arm.group) ?? []), entry]);
			continue;
		}
		linksByParent.set(entry.parent, [...(linksByParent.get(entry.parent) ?? []), entry.field]);
	}
	for (const arms of armsOf.values()) {
		const parent = arms[0]?.parent;
		if (parent === undefined) continue;
		linksByParent.set(parent, [...(linksByParent.get(parent) ?? []), keyedFieldOf(arms)]);
	}
	for (const [parent, fields] of linksByParent) {
		projector.addFields(
			parent,
			[...fields].sort((a, b) => compare(a.name, b.name)),
		);
	}

	for (const entry of survivors) {
		for (const parameter of entry.declaration.operation.parameters.parameters) {
			if (
				!carriesCredentials(parameter) ||
				dispositionOf(parameter, entry.declaration.inputHeaders) !== "argument"
			) {
				continue;
			}
			// A link's bound parameter is filled from its parent, never written as an argument.
			const declaration = entry.declaration;
			if (
				"bindings" in declaration &&
				declaration.bindings.some((b) => b.wire === parameter.name)
			) {
				continue;
			}
			warnings.push({
				code: "transport-argument",
				target: parameter.param,
				format: {
					field:
						entry.parent === undefined ? entry.field.name : `${entry.parent}.${entry.field.name}`,
					location: parameter.type,
					name: parameter.name,
				},
			});
		}
	}
	for (const entry of survivors) {
		if (entry.verdict.kind !== "not-a-connection") continue;
		warnings.push({
			code: "not-a-connection",
			target: entry.declaration.operation.operation,
			format: {
				operationId: entry.declaration.route.operationId,
				missing: entry.verdict.missing.join(", "),
			},
		});
	}
	/**
	 * **A projection `graphql.tsp` accepts with `@json` raises no warning**, so a spec whose every
	 * other projection is right can turn on `warn-as-error` without a suppression in its models. A
	 * `@json` on a type this service projects as a type of its own is the mistake: warned, at the
	 * declaration. One on a type the service never reaches says nothing about it.
	 */
	const accepted = jsonAcceptedOf(program);
	const met = new Set<JsonDeclaration>();
	for (const warning of projector.warnings) {
		const accepting = accepted.get(warning.target);
		if (accepting !== undefined) {
			for (const declaration of accepting) met.add(declaration);
			continue;
		}
		warnings.push({
			code: "projected-as-json",
			target: warning.target,
			format: { what: warning.what, reason: warning.reason },
		});
	}
	for (const [type, declarations] of accepted) {
		const name = projector.projectedNameOf(type);
		if (name === undefined || name === "JSON") continue;
		for (const declaration of declarations) {
			if (met.has(declaration)) continue;
			met.add(declaration);
			warnings.push({
				code: "not-projected-as-json",
				target: declaration.node,
				format: { target: getTypeName(declaration.target), name },
			});
		}
	}
	for (const shared of projector.shared) {
		warnings.push({
			code: "anonymous-type-shared",
			target: shared.target,
			format: {
				holders: shared.holders.map((holder) => `'${holder}'`).join(", "),
				name: shared.name,
			},
		});
	}

	const rootsOf = (kind: "query" | "mutation"): OutputFieldPlan[] =>
		survivors
			.filter((entry) => entry.kind === kind)
			.map((entry) => entry.field)
			.sort((a, b) => compare(a.name, b.name));
	const query = rootsOf("query");
	const mutation = rootsOf("mutation");
	const reached = reachableFrom(defsByName(projector), [...query, ...mutation].flatMap(refsOf));
	for (const name of projector.defineInterfaces(reached)) reached.add(name);

	const operationIds = new Set(survivors.map((entry) => entry.declaration.route.operationId));
	const operations = emitted.routes
		.filter((route) => operationIds.has(route.operationId))
		.map((route) => {
			const names = emitted.schemaNames.get(route.operationId);
			if (names === undefined) throw new Error(`${route.operationId} has no schema names`);
			return { route, names };
		})
		.sort((a, b) => compare(a.route.operationId, b.route.operationId));

	return {
		plan: {
			types: projector.defs().filter((def) => reached.has(def.name)),
			query: query.length === 0 ? [EMPTY_QUERY] : query,
			mutation,
			operations,
			statusCodes: survivors.some((entry) =>
				Object.values(entry.field.call?.projection ?? {}).some(
					(projection) => projection.as === "byStatus",
				),
			)
				? statusCodesTable()
				: {},
			usesCost: survivors.some((entry) => entry.field.directives.length > 0),
		},
		warnings,
		emitted: survivors.length,
		dropped,
	};
}
