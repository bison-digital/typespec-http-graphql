import {
	type CallableMessage,
	createTypeSpecLibrary,
	type DiagnosticReport,
	type JSONSchemaType,
	paramMessage,
	type Program,
	type TypeSpecLibrary,
} from "@typespec/compiler";
import {
	EmitterOptionsSchema as httpZodOptions,
	type EmitterOptions as HttpZodOptions,
} from "typespec-http-zod";

/**
 * Exactly what `typespec-http-zod` accepts, and nothing more.
 *
 * **This emitter adds no option, and that is a decision rather than an omission.** Its sibling
 * selects tools by tag because MCP has no other place to say which operations are tools. GraphQL
 * has one: `graphql.tsp` names every field. An option that also selected operations would be a
 * second statement of the surface, and two statements of one fact are how they come to disagree.
 *
 * **Aliased, never restated.** This emitter runs the whole library and writes beside its output, so
 * every option the library accepts has to reach it. A second literal list would reject an option
 * added there as unknown, or accept it and drop it silently. `test/options.test.ts` grades the
 * forwarding as a CLASS, and grades that nothing was added.
 */
export type EmitterOptions = HttpZodOptions;

/** The library's schema, forwarded as published, so a key it gains arrives here for free. */
const EmitterOptionsSchema: JSONSchemaType<EmitterOptions> = httpZodOptions;

/**
 * What this emitter reports, beyond what the library does.
 *
 * **Every one is a WARNING, never an error.** A TypeSpec `error` sets `program.hasError()`, and
 * `@typespec/openapi3` then writes nothing, so an error here would cost a consumer their OpenAPI
 * document over one GraphQL field. A project that wants these to fail CI sets `warn-as-error`.
 *
 * **Each message says what was dropped and what still works.** A declaration this emitter cannot
 * serve is dropped from the GraphQL schema only; the operation is still a route on the HTTP surface,
 * and a reader of the message should not have to work that out.
 */
const diagnostics = {
	/**
	 * A service with no GraphQL field left: none was declared, or every declaration failed its
	 * checks and was reported on its own. Not a defect in itself (a spec may serve one service over
	 * GraphQL and another over HTTP only), so it says what happened and nothing more.
	 */
	"no-fields-declared": {
		severity: "warning",
		messages: {
			default: paramMessage`No GraphQL field of '${"service"}' survives its checks, so no GraphQL file is written for it. Its operations are still served over HTTP.`,
		},
	},
	/**
	 * A root field or link name GraphQL cannot carry. Refused rather than rewritten: the name is the
	 * one `graphql.tsp` states, and a re-spelling would be a field no reader of that file can predict.
	 */
	"invalid-graphql-name": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"name"}' (${"declaration"}) is not a GraphQL name: one is letters, digits and '_', does not start with a digit, and does not start with '__'. The declaration is dropped; the operation is still served over HTTP.`,
		},
	},
	/**
	 * Two things reach one GraphQL name: two root fields, two fields of one type, or, at planning,
	 * two types, union members or arguments. **Every party is dropped**, because keeping the first
	 * would make the schema depend on the order the compiler happened to apply decorators in.
	 */
	"graphql-name-collision": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"first"}' and '${"second"}' both become the GraphQL name '${"name"}', so every declaration of that name is dropped rather than one chosen by declaration order. Rename one in graphql.tsp. The operations are still served over HTTP.`,
		},
	},
	/** One operation named as a root field twice. The first declaration is kept. */
	"declared-twice": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"operationId"}' is declared as a root field more than once. The first declaration is kept and this one is dropped; reach the operation from elsewhere in the graph with '@link'.`,
		},
	},
	"unknown-link-parameter": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' fills '${"parameter"}', which is not a path, query, header or cookie parameter of '${"operationId"}', so the link is dropped. Name the parameter as TypeSpec declares it; a body property cannot be filled from the parent. The operation is still served over HTTP.`,
		},
	},
	"unknown-link-property": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' reads '${"property"}', which is not a property of '${"model"}', so the link is dropped. Name the property as TypeSpec declares it. The operation is still served over HTTP.`,
		},
	},
	/**
	 * A link reads its bound property off the parent's READ body, so a property that body never carries
	 * (create-only, or an HTTP header) would leave the link `null` on every request, silently.
	 */
	"link-property-unreadable": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' reads '${"property"}', which a client never reads in the body of '${"model"}' (it is not visible on read, or it is an HTTP header), so the link could never resolve and is dropped. Bind a property the read body carries. The operation is still served over HTTP.`,
		},
	},
	/**
	 * A bound property that is neither a value the parameter accepts, by its type or a scalar its type
	 * extends, nor a list of them. The property's own nullability is not compared: a `null` or absent
	 * value resolves the link to `null` without calling the handler.
	 */
	"link-type-mismatch": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' fills '${"parameter"}' from '${"property"}', which is neither a value the parameter accepts nor a list of them, so the link is dropped. The operation is still served over HTTP.`,
		},
	},
	/**
	 * A link bound to a list it cannot serve as one field: a second list, whose product with the
	 * first no field could be, or an operation that answers a page, of which a field cannot be a list.
	 */
	"link-list-not-bindable": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' binds the list '${"property"}', but ${"reason"}, so the link is dropped. The operation is still served over HTTP.`,
		},
	},
	/**
	 * A link bound to a list with no `@maxItems`. It calls once per value, so without a bound no cost
	 * analysis can bound the calls one parent's field makes, and `costLimit` could not hold.
	 */
	"link-list-unbounded": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' calls its operation once for each value of the list '${"property"}', which declares no @maxItems, so no cost limit can bound the calls it makes and the link is dropped. Declare @maxItems on that property. The operation is still served over HTTP.`,
		},
	},
	/**
	 * A link's `when` that cannot choose it: it names no property or more than one, a property that
	 * holds no string, or a value the property never holds, which would leave the link `null` on every
	 * parent, silently.
	 */
	"link-when-mismatch": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' cannot be chosen as its 'when' says: ${"reason"}, so the link is dropped. The operation is still served over HTTP.`,
		},
	},
	/**
	 * Links of one parent sharing a name, at least one with `when`, that cannot be one field: each
	 * value of one property chooses at most one of them, and they share everything the field states
	 * once. **Every party is dropped**, as for any other collision of names.
	 */
	"link-arms-conflict": {
		severity: "warning",
		messages: {
			default: paramMessage`The links '${"link"}' cannot be one field: ${"reason"}, so every one of them is dropped. The operations are still served over HTTP.`,
		},
	},
	/**
	 * An arm of a link chosen by a kind whose operation answers what no GraphQL union can hold as a
	 * member: a union's members are object types, and the union resolves each answer by its arm.
	 */
	"link-arm-not-object": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' calls '${"operationId"}', which answers ${"answers"}, not an object type a union can hold, so that arm is dropped. The operation is still served over HTTP.`,
		},
	},
	/**
	 * A link whose `batch` the operation cannot serve: a batch read takes the values as one list in
	 * the query, answers one list of items, and each item carries the value it was asked for under
	 * `key`, which is how an answer reaches the parent that asked.
	 */
	"link-batch-invalid": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' cannot call '${"operationId"}' as a batch: ${"reason"}, so the link is dropped. The operation is still served over HTTP.`,
		},
	},
	/**
	 * An `@inputHeader` naming what is no optional header of its operation, so it changes nothing: a
	 * required header is input already, a one-literal header is supplied, and any other parameter is
	 * input or bound as it is.
	 */
	"input-header-ignored": {
		severity: "warning",
		messages: {
			default: paramMessage`'@inputHeader' names '${"parameter"}' of '${"operationId"}', which ${"reason"}, so it changes nothing. Name an optional header of the operation, as TypeSpec declares it.`,
		},
	},
	/**
	 * A `@json` on a type this service projects as a GraphQL type of its own: it accepts a JSON
	 * projection that does not happen, so it does nothing, and its author meant something else.
	 */
	"not-projected-as-json": {
		severity: "warning",
		messages: {
			default: paramMessage`'@json' accepts '${"target"}' as the 'JSON' scalar, but it is projected as '${"name"}', a GraphQL type of its own, so the declaration does nothing. Remove it from graphql.tsp.`,
		},
	},
	/**
	 * A link to an unsafe method. A link resolves whenever a query selects it, so one that changed
	 * state would change it on a read, once per parent in a list.
	 */
	"link-not-safe": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' calls '${"operationId"}', a ${"verb"} operation. A link runs whenever a query selects it, so it must call a safe method (GET); the link is dropped. The operation is still served over HTTP.`,
		},
	},
	/**
	 * A Query field over an unsafe method. **A warning that keeps the field**, because a POST search
	 * is a read that happens to need a body, and refusing it would push it into Mutation.
	 */
	"query-not-safe": {
		severity: "warning",
		messages: {
			default: paramMessage`The Query field '${"name"}' calls '${"operationId"}', a ${"verb"} operation, which is not a safe method. It is still emitted, since a search by POST is a read; declare it with '@mutationField' if it changes state.`,
		},
	},
	"head-operation": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"operationId"}' is a HEAD operation, which answers no body for a GraphQL selection to read, so its declaration is dropped. It is still served over HTTP.`,
		},
	},
	"non-json-request": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"operationId"}' takes a request body that is not JSON (${"types"}), which GraphQL arguments cannot carry, so its declaration is dropped. It is still served over HTTP.`,
		},
	},
	/**
	 * A request body with no properties to merge into the handler's input. The input is one object,
	 * and the document states the body apart from the parameters, so an unnamed body is merged into
	 * it: a scalar, an array or a discriminated union has nothing to merge, and naming it under an
	 * invented key would publish an argument no reader of the document could predict. The refusal
	 * `typespec-http-mcp` makes, for the same reason.
	 */
	"non-object-body": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"operationId"}' has a request body with no properties to merge into its GraphQL input (${"types"}), so its declaration is dropped. Name the body with '@body' to carry it as one field. It is still served over HTTP.`,
		},
	},
	"non-json-response": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"operationId"}' answers ${"status"} with ${"types"}, which a GraphQL result cannot carry, so its declaration is dropped. It is still served over HTTP.`,
		},
	},
	/**
	 * Two inputs of an operation under one name. The handler takes one object keyed by wire name,
	 * the input every server built on the library hands it, so a header and a query parameter both
	 * named `x` reach it as one `x`, and a GraphQL field could pass only one of them.
	 */
	"shared-input-key": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"operationId"}' has two inputs named '${"name"}' (${"locations"}), which its handler's input, keyed by name, carries as one, so no GraphQL field can pass both and its declaration is dropped.`,
		},
	},
	/** A link on a model no emitted field returns: a field on a type nothing reaches is never selected. */
	"link-target-unreachable": {
		severity: "warning",
		messages: {
			default: paramMessage`The link '${"link"}' is declared on '${"model"}', which no emitted GraphQL field returns, so the link is dropped: nothing could ever select it. The operation is still served over HTTP.`,
		},
	},
	/**
	 * An `@list` operation without the five core paging decorators a Relay connection needs. Still
	 * a field, typed as its declared response, so nothing is lost but the connection shape.
	 */
	"not-a-connection": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"operationId"}' is an '@list' operation but not a Relay connection: it lacks ${"missing"}. It is projected as its declared response type.`,
		},
	},
	/**
	 * A required cookie, or `Authorization`, `Proxy-Authorization` or `Cookie` header, that stays an
	 * argument. A GraphQL argument is document text, which servers log, persisted queries store and
	 * `GET /graphql` puts in a URL; a credential so carried leaks. Kept, since the field cannot be called
	 * without it, and warned so the spec can say otherwise.
	 */
	"transport-argument": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"field"}' takes the required ${"location"} '${"name"}' as an argument, which a GraphQL document carries in text that servers log and cache. If it is a credential, declare it through @useAuth, or make it optional so the field leaves it to the /graphql request itself.`,
		},
	},
	"projected-as-json": {
		severity: "warning",
		messages: {
			default: paramMessage`${"what"} is projected as the 'JSON' scalar because ${"reason"}. Its value is still validated by the operation's Zod schema.`,
		},
	},
	/**
	 * Members of two or more declared models hold one anonymous type, through an `alias` or an
	 * instance whose composed name leaves out an argument. It is one GraphQL type named after the
	 * first member declared, so declaring another before it renames the type a client selects.
	 */
	"anonymous-type-shared": {
		severity: "warning",
		messages: {
			default: paramMessage`${"holders"} hold one anonymous type, named '${"name"}' after the first of them declared, so declaring another holder before it renames the GraphQL type. Declare it as a model, union or enum to give it a name of its own.`,
		},
	},
	/**
	 * Another emitter writes where this one writes, with library options that disagree. Fires only
	 * when they differ: sharing a directory with matching options is how one set of validators
	 * serves both surfaces, and it is silent.
	 */
	"shared-output-dir": {
		severity: "warning",
		messages: {
			default: paramMessage`'${"emitter"}' writes to the same emitter-output-dir as this emitter with different options (${"differing"}), so 'schemas.gen.ts' is written twice with different content and whichever emitter is listed LAST in 'emit:' wins. Give each emitter its own 'emitter-output-dir', or set the same values on both.`,
		},
	},
} as const;

/**
 * **Spelled out rather than inferred, for the reason `typespec-http-mcp` spells out its own.** This
 * package and `typespec-http-zod` both declare `@typespec/compiler` as a peer, so a side-by-side
 * checkout resolves two physical copies of it, and an inferred type can name the other package's
 * copy in the emitted declarations: `TS2883`, a `.d.ts` that is not portable.
 */
type Diagnostics = {
	"no-fields-declared": { readonly default: CallableMessage<["service"]> };
	"invalid-graphql-name": { readonly default: CallableMessage<["name", "declaration"]> };
	"graphql-name-collision": { readonly default: CallableMessage<["first", "second", "name"]> };
	"declared-twice": { readonly default: CallableMessage<["operationId"]> };
	"unknown-link-parameter": {
		readonly default: CallableMessage<["link", "parameter", "operationId"]>;
	};
	"unknown-link-property": { readonly default: CallableMessage<["link", "property", "model"]> };
	"link-property-unreadable": { readonly default: CallableMessage<["link", "property", "model"]> };
	"link-type-mismatch": { readonly default: CallableMessage<["link", "parameter", "property"]> };
	"link-list-not-bindable": { readonly default: CallableMessage<["link", "property", "reason"]> };
	"link-list-unbounded": { readonly default: CallableMessage<["link", "property"]> };
	"link-not-safe": { readonly default: CallableMessage<["link", "operationId", "verb"]> };
	"link-when-mismatch": { readonly default: CallableMessage<["link", "reason"]> };
	"link-arms-conflict": { readonly default: CallableMessage<["link", "reason"]> };
	"link-arm-not-object": { readonly default: CallableMessage<["link", "operationId", "answers"]> };
	"link-batch-invalid": { readonly default: CallableMessage<["link", "operationId", "reason"]> };
	"input-header-ignored": {
		readonly default: CallableMessage<["parameter", "operationId", "reason"]>;
	};
	"query-not-safe": { readonly default: CallableMessage<["name", "operationId", "verb"]> };
	"head-operation": { readonly default: CallableMessage<["operationId"]> };
	"non-json-request": { readonly default: CallableMessage<["operationId", "types"]> };
	"non-object-body": { readonly default: CallableMessage<["operationId", "types"]> };
	"non-json-response": { readonly default: CallableMessage<["operationId", "status", "types"]> };
	"shared-input-key": { readonly default: CallableMessage<["operationId", "name", "locations"]> };
	"link-target-unreachable": { readonly default: CallableMessage<["link", "model"]> };
	"not-a-connection": { readonly default: CallableMessage<["operationId", "missing"]> };
	"transport-argument": { readonly default: CallableMessage<["field", "location", "name"]> };
	"projected-as-json": { readonly default: CallableMessage<["what", "reason"]> };
	"not-projected-as-json": { readonly default: CallableMessage<["target", "name"]> };
	"anonymous-type-shared": { readonly default: CallableMessage<["holders", "name"]> };
	"shared-output-dir": { readonly default: CallableMessage<["emitter", "differing"]> };
};

/** The names of the library's state, one per kind of declaration the decorators record. */
type StateKeys = "roots" | "links" | "inputHeaders" | "json";

/**
 * This emitter's name, as `tspconfig.yaml`, the compiler and every diagnostic code spell it.
 *
 * **One literal, because two would be a guard that stops working silently.** `coexistence.ts`
 * looks this emitter up in `program.compilerOptions.options` by name; a second copy that drifted
 * would find nothing and report no collision.
 */
export const PACKAGE_NAME = "typespec-http-graphql";

export const $lib: TypeSpecLibrary<Diagnostics, EmitterOptions, StateKeys> = createTypeSpecLibrary({
	name: PACKAGE_NAME,
	diagnostics,
	emitter: { options: EmitterOptionsSchema },
	/**
	 * **Where the decorators record, and the only thing they do.** The keys are the compiler's own
	 * (`Symbol.for` of the library name and key), so the compiled decorators and the emitter read one
	 * map however many copies of this module are loaded.
	 */
	state: {
		roots: { description: "Every @queryField and @mutationField application, in order." },
		links: { description: "Every @link application, in order." },
		inputHeaders: { description: "Every @inputHeader application, in order." },
		json: { description: "Every @json application, in order." },
	},
});

export function reportDiagnostic<C extends keyof Diagnostics, M extends keyof Diagnostics[C]>(
	program: Program,
	diagnostic: DiagnosticReport<Diagnostics, C, M>,
): void {
	$lib.reportDiagnostic(program, diagnostic);
}

/** The state the decorators write and `decorators.ts`'s accessors read. */
export const GraphQLKeys: {
	readonly roots: symbol;
	readonly links: symbol;
	readonly inputHeaders: symbol;
	readonly json: symbol;
} = $lib.stateKeys;

export { EmitterOptionsSchema };
