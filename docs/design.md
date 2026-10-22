# `typespec-http-graphql` — design

**Status:** built, as version 0.2.0. The cross-ecosystem research behind it is in
[`research.md`](research.md); the README states the package as it ships.

## What it is

A TypeSpec emitter that emits a **GraphQL surface declared in the spec**. Its resolvers call the
same `(ctx, input) => { status, body, headers }` handlers that a `typespec-hono` server and a
`typespec-http-mcp` tool surface call.

The spec says which operations are GraphQL root fields, what they are called, and how types link
to each other. It says this in one file, `graphql.tsp`, with this package's three decorators. The
emitter does the mechanics:

- types from the TypeSpec models;
- arguments and input objects;
- Relay connections from TypeSpec's core paging decorators;
- errors as data;
- cost hints;
- a resolver for every field, calling the shared handler.

It emits **no server, no framework code, and no code built by a code-generation library**.

- **Output:** a graphql-js `GraphQLSchema` and its SDL.
- **Servers:** any GraphQL-over-HTTP server serves it; Yoga is the one the README shows.
- **Hono:** appears only in the consumer's mount.
- **Runtimes:** the output runs unchanged on Node and on Cloudflare Workers.

## Why generate, and why this shape

The research ([`research.md`](research.md)) found one consensus across every ecosystem it covered:

- TypeSpec's own `@typespec/graphql`;
- the gRPC→GraphQL generators;
- the OpenAPI→GraphQL tools;
- PostGraphile, Hasura, Microsoft's Data API builder and the headless CMSs;
- Hot Chocolate and Netflix DGS.

**The GraphQL surface is declared explicitly, and the generator does the mechanics.**

- **Inferring GraphQL from HTTP verbs was tried and dropped.** TypeSpec's design review rejected it
  because it "goes against good GraphQL schema design" (microsoft/typespec#4933).
- **proto-graphql moved to explicit per-RPC opt-in** on 2026-07-14.
- **Apollo "generally discourage[s] the use of schema autogeneration tools"**, because they mirror
  the backend instead of serving clients.
- **IBM's openapi-to-graphql**, which projected every endpoint, was archived on 2026-06-02.
- **Edges are always declared, never guessed from `fooId` names.** Each one names the operation to
  call and which parent field fills its argument.

So this emitter projects nothing automatically. **An operation is a GraphQL field only because
`graphql.tsp` says so.** That is the client-first design Apollo asks for, written in TypeSpec rather
than in a second schema.

### Single source of truth

Every fact is stated once:

| Fact                                                         | Where it is stated                |
| ------------------------------------------------------------ | --------------------------------- |
| A book's fields, nullability, docs, enums, validation        | `models/`, read by every emitter  |
| `GET /v1/books/{id}` reads one                               | `rest.tsp`, with `@typespec/http` |
| The GraphQL field `book` reads one                           | `graphql.tsp`, with this package  |
| `Book.author` is fetched by `Authors.read` using `author_id` | `graphql.tsp`, with this package  |

The last two rows are graph design. REST never needed them, so they have to be written somewhere,
and hand-writing the schema would not remove them. It would only add a second copy of the first
row, which is where drift comes from.

`graphql.tsp` is to GraphQL what `rest.tsp` is to HTTP: the protocol-specific part of one spec.
Every reference in it is checked by the compiler, so renaming an operation breaks the build rather
than the runtime.

**Trip-wires.** Either of these means GraphQL has become a different product from the REST API, and
hand-writing that part becomes the honest choice:

- most wanted GraphQL fields map to no REST operation;
- `graphql.tsp` starts needing models of its own.

The escape hatch below covers the odd exception without abandoning generation.

### Removable in both directions

- **Dropping GraphQL:** delete `graphql.tsp` and the emitter's line in `tspconfig.yaml`. Nothing
  else changes.
  - Adding a GraphQL surface file leaves the published `@typespec/openapi3`, `typespec-http-zod`
    and `typespec-hono` output byte-identical.
  - The comparison that holds it catches a planted leak.
  - This is an oracle below.
- **Dropping OpenAPI or the REST server:** this emitter depends on neither. The GraphQL schema's
  shape comes from `graphql.tsp` and TypeSpec core: models, `@error`, the paging decorators,
  visibility, `@doc` and `#deprecated`.
  - HTTP is read in exactly two places.
  - **The handler binding:** the shared handlers take an input merged from HTTP parameter groups
    and return HTTP statuses, so the resolvers do too.
  - **One warning:** a `@queryField` on an unsafe method.
  - If the spec ever lost `@typespec/http` entirely, the binding module would change, and
    `graphql.tsp` and the schema would not.

## Independence

**Every emitter in this family is independent, and this one is no exception.**

- **No other package changes for its sake.** That covers `typespec-http-zod`, `typespec-hono`,
  `typespec-http-mcp`, `typespec-openapi-document` and `typespec-postman`. Nothing is added, lifted,
  renamed or re-released to suit this emitter.
- **It consumes `typespec-http-zod` the way `typespec-http-mcp` does:** as a published dependency,
  through its existing public API, at a version range it does not ask to move. Facts the library
  does not publish are read from the TypeSpec program here.
- **No runtime or build dependency on `typespec-hono` or `typespec-http-mcp`.** The emitted code
  imports only `graphql` and the `schemas.gen.ts` the library writes.
- **No code-generation library**, in the emitter or in what it emits:
  - no Alloy;
  - no `@typespec/emitter-framework` and no `@typespec/mutator-framework`;
  - no graphql-codegen;
  - no TypeSpec library that loads one of these.

  Output is written as source text, as the sibling emitters write theirs. A dev-only tool that
  prints source, as Stryker's instrumenter prints each mutant, is not one: it generates nothing this
  package ships or emits.

- **The one point of contact is a dev-only test**: the handler signatures graded against the
  _published_ `typespec-hono`'s emitted `Operations`, as `typespec-http-mcp` grades its own.
- **A sibling may read what this emitter planned, and nothing here changes for it.**
  `graphqlRequestsOf(program)` is a read of the plans `$onEmit` recorded, one request per root field,
  which typespec-postman reaches through `program.emitters`, so it reads the copy the compiler ran.
  Asking writes, reports and plans nothing; before `$onEmit` has run it answers `undefined`.

### Why not an existing package

| Option                                                                | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@typespec/graphql` 0.4.0                                             | <ul><li>Emits SDL only, with no resolvers.</li><li>Built on Alloy, the emitter framework and the mutator framework.</li><li>Importing it, even for its decorators, loads Alloy.</li><li>As published, it would not load: it requires `@alloy-js/core ^0.25.0`, while its peer `@typespec/emitter-framework ~0.21.0` brings `0.24.1`.</li><li>With that forced into line, its emitter ran out of memory (4 GB) on a three-operation probe.</li><li>Its `@operationFields` turns every operation parameter into a field argument and cannot fill one from the parent, so an edge over an existing operation cannot be expressed.</li></ul>Its conventions are kept: naming, the `Input` suffix, scalar names and nullability from `\| null`. |
| Mesh Compose + Hive Gateway over the OpenAPI document                 | <ul><li>The schema's shape is generated rather than designed.</li><li>It bypasses the handlers and the Zod validators.</li><li>It adds a second serialisation hop and a second toolchain.</li></ul>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A hand-written schema (Pothos, or SDL plus graphql-codegen resolvers) | A second statement of every type, which drifts. Codegen is a code-generation library.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@hono/graphql-server`                                                | Pinned to graphql 16, with no plugin system. It could serve this schema; it is too thin to be the source of one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## The GraphQL surface: `graphql.tsp`

### Vocabulary

Five decorators in namespace `HttpGraphQL`, declared in `lib/decorators.tsp`:

```tsp
namespace HttpGraphQL;

/** What a field's declaration may say beyond its name. */
model FieldOptions {
  /** The field's description, in place of the operation's doc comment, which is written for REST. */
  description?: string;
}

/** What a link's declaration may say beyond its name, its operation and its parameters. */
model LinkOptions extends FieldOptions {
  /** The value or values of one of the model's properties that choose this link. */
  when?: Record<string | string[]>;
  /** Call `operation`, a batch read, once for the values of many parents. */
  batch?: BatchOptions;
}

/** How a batch read's answer is matched back to the values it was sent. */
model BatchOptions {
  /** The item property holding the value the item was asked for. */
  key: string;
  /** The answer's property holding the items, where it is no list and holds more than one. */
  items?: string;
}

/** Expose `target` as the root Query field `name`. */
extern dec queryField(target: Operation, name: valueof string, options?: valueof FieldOptions);

/** Expose `target` as the root Mutation field `name`. */
extern dec mutationField(target: Operation, name: valueof string, options?: valueof FieldOptions);

/**
 * Give `target`'s GraphQL object type a field `name`, resolved by calling `operation`. Each entry of
 * `parameters` fills one of the operation's parameters from one of `target`'s properties
 * (parameter name → property name, both as declared in TypeSpec). Every other parameter the
 * operation takes becomes an argument of the field.
 */
extern dec link(
  target: Model,
  name: valueof string,
  operation: Operation,
  parameters?: valueof Record<string>,
  options?: valueof LinkOptions,
);

/** Take `target`'s optional header `parameter` as input of the fields that call it. */
extern dec inputHeader(target: Operation, parameter: valueof string);

/** Accept that `target` is projected as the `JSON` scalar: no `projected-as-json` for it. */
extern dec json(target: ModelProperty | Model | Union | Enum | Scalar);
```

A bookshop's surface, for illustration:

```tsp
// graphql.tsp: the GraphQL surface. Delete this file and the emitter line to drop GraphQL.
import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Bookshop;

@@queryField(Books.read, "book");
@@queryField(Books.list, "books");
@@mutationField(Books.create, "createBook");

@@link(Book, "author", Authors.read, #{ authorId: "author_id" });
@@link(Book, "editor", Editors.read, #{ editorId: "editor_id" });
@@link(Book, "editions", BookEditions.list, #{ bookId: "id" });
```

- **The names are not `@query`/`@mutation`** because `@typespec/http` has an `@query`, and the two
  would be ambiguous in any file that uses both namespaces.
- **`@link` follows OpenAPI's Link Object:** a target operation, plus parameters taken from the
  parent.
- **Applied with `@@`, in one file.** This keeps `rest.tsp` and `models/` free of GraphQL, as
  Azure's TypeSpec convention keeps client customisations in `client.tsp` ("DON'T import or use
  `@azure-tools/typespec-client-generator-core` in other files aside from client.tsp").
- **`FieldOptions` is a model, not a positional argument**, as `@typespec/http` takes its options,
  so an option added later needs no new position. `description` replaces the operation's doc: a
  REST doc may name a 404 a GraphQL client never sees, or a query string it cannot send.
- **A link chosen by a kind is several `@link`s under one name, each with `when`**, rather than one
  declaration mapping kinds to operations. An operation is a type, never a TypeSpec value, so
  `#{ book: Books.read }` cannot be written; a model expression of operations can, but each arm's
  parameters would then be a second map keyed the same way, and the two would drift. Declarations
  that must agree to be one thing have precedent in `@sharedRoute`, whose `shared-inconsistency`
  refuses one operation of a route left without it, as `link-arms-conflict` refuses one arm left
  without `when`.
- **`batch` is an option of `@link`, not a decorator of its own**: a batched link binds, names and
  checks its parent's properties as any link does, and differs only in how its calls are made.
- **`@inputHeader` names its operation and a parameter, as `@link` does**, rather than the parameter
  itself: a declaration is checked against the operations a service serves, by identity, which a
  versioned spec projects anew, decorators re-run, and an operation is the established key.
- **`@json` accepts rather than forces.** It names a projection the spec author means, so
  `warn-as-error` stays usable with `rest.tsp` free of GraphQL: a `#suppress` reaches only the
  node a diagnostic targets, the type in `rest.tsp`, and TypeSpec diagnostics carry no related
  location to move it to. On a type GraphQL can state it is warned `not-projected-as-json`.
- **The decorators only record.** Each implementation stores its arguments in the library's state
  and checks nothing. Every check is made by the emitter, so the checks run only when GraphQL is
  being emitted, and never stop another emitter.

### Why this package has decorators when its siblings have none

`typespec-http-zod` ships zero decorators, because "a decorator is a second contract". A decorator
there would let the spec state something the OpenAPI document cannot publish.

That rule holds here too. These decorators state the GraphQL contract itself, which exists nowhere
else in the spec. Neither the document nor any validator reads them. TypeSpec's own protocol
libraries take the same view ("adding support for an additional protocol requires decorators
sometimes (this is def. true for e.g. protobuf)", microsoft/typespec#4933).

### Checks on a declaration

A failed check is a **warning that drops the declaration**, never an error. A spec author who wants
these to fail CI sets `warn-as-error`.

| Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Diagnostic                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| The name is a GraphQL name (`/^[_A-Za-z][_0-9A-Za-z]*$/`, not starting `__`)                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `invalid-graphql-name`                                                                           |
| No two root fields of one root type share a name, and no link shares a name with its type's other fields                                                                                                                                                                                                                                                                                                                                                                                                                       | `graphql-name-collision` (every party is dropped)                                                |
| An operation is declared at most once as a root field                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `declared-twice`                                                                                 |
| Every key of `parameters` is a parameter of `operation`, and every value is a property of `target`                                                                                                                                                                                                                                                                                                                                                                                                                             | `unknown-link-parameter`, `unknown-link-property`                                                |
| Every bound property is in the parent's read body: visible on read, and not an HTTP header                                                                                                                                                                                                                                                                                                                                                                                                                                     | `link-property-unreadable`                                                                       |
| A bound property is a value the parameter accepts, by the compiler's assignability to the parameter's type or to a scalar that type extends (the operation's Zod schema checks the narrowing at call time), or a list of such values, ignoring the property's nullability                                                                                                                                                                                                                                                      | `link-type-mismatch`                                                                             |
| A link binds at most one list, and not to an `@list` operation: a field is one list, of single items                                                                                                                                                                                                                                                                                                                                                                                                                           | `link-list-not-bindable`                                                                         |
| A bound list declares `@maxItems`, which bounds the calls one parent's field makes                                                                                                                                                                                                                                                                                                                                                                                                                                             | `link-list-unbounded`                                                                            |
| A `@queryField` targets a method IANA's registry marks safe                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `query-not-safe` (warning only; the field is still emitted, for POST searches)                   |
| The operation is servable as a field: not HEAD; a JSON request; every member of every body-carrying response served as JSON, with no bytes, stream or other media-type alternative, because the handler's result type must equal the HTTP server's and GraphQL cannot project those; an unnamed body has properties to merge, as MCP refuses a scalar, array or discriminated one; and no two inputs the library reports under one key (`EmittedRoute.sharedInputKeys`), since the handler's input is one object keyed by name | `non-json-request`, `non-json-response`, `head-operation`, `non-object-body`, `shared-input-key` |
| `@link` targets a model that reaches the schema as an output type                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `link-target-unreachable`                                                                        |
| A link's `when` names exactly one property of the parent, carried in its read body and holding strings, and values of it the property can hold                                                                                                                                                                                                                                                                                                                                                                                 | `link-when-mismatch`, or the property checks above                                               |
| Links of one parent sharing a name, at least one with `when`, are one field: all with `when`, by one property, no value choosing two, all or none bound to a list, one description at most, and, once planned, the same arguments                                                                                                                                                                                                                                                                                              | `link-arms-conflict` (every party is dropped)                                                    |
| Each arm of a link chosen by a kind answers an object type or a result union whose members its projection tags: a union's members are object types, resolved by the arm                                                                                                                                                                                                                                                                                                                                                        | `link-arm-not-object` (that arm is dropped)                                                      |
| A batched link's operation is a batch read of its values: a list query parameter, which one value alone satisfies, filled from a value of its items or a list of them; not `@list`; one success body that is a list of models or holds one, `items` naming it where it holds more; and a required, readable `key` of the item whose type accepts the bound value                                                                                                                                                               | `link-batch-invalid`                                                                             |

`emitted + dropped === declared` is asserted in the emitter.

**Each diagnostic is reported once per program.** Each service is checked and planned on its own,
and the compiler keeps every diagnostic it is given, so a type two services project, or a `@json`
naming one, would be warned once per service at the one declaration it is about. The emitter
reports a diagnostic of the same target, code and format once.

## A handler's input: derived here, graded against the server

**Where a request body reaches a handler's input is decided once**, by the library, and published as
`EmittedRoute.bodyProperty` and `rawBodyProperty`.

What this emitter writes for itself, from `RouteSchemaNames`:

- the groups merged, in the order path, query, header, cookie, then body;
- the named body, optional where the document says so;
- the negotiated `accept` literal.

This is the same rendering `typespec-http-mcp` does around its argument schema. It is graded with
`Identical<>`, per operation, against the published `typespec-hono`'s `Operations`. A divergence
fails to compile.

## What it emits

These files sit beside the library's `schemas.gen.ts`. Their names clash with no other emitter's.

| File                     | Contents                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.graphql`         | The published SDL, the counterpart of the OpenAPI document. It is printed by this emitter from its model, **with applied directives** (`@cost`, `@listSize`, `@deprecated`, `@specifiedBy`), because graphql-js `printSchema` drops applied directives. It is checked with `buildSchema` and `validateSchema` before it is written. |
| `graphql.gen.ts`         | <ul><li>`createSchema`.</li><li>The graphql-js type constructors, with fields as thunks, so recursive types work and nothing parses SDL at start-up.</li><li>`GraphQLOperations<C>`.</li><li>`GraphQLTypes`, the exported type objects the escape hatch uses.</li></ul>                                                             |
| `graphql-runtime.gen.ts` | A verbatim copy of `src/runtime.ts`: <ul><li>the scalars;</li><li>result projection;</li><li>connection assembly;</li><li>the per-request call memo;</li><li>the cost directive definitions;</li><li>error classes;</li><li>`GraphQLDeps`.</li></ul>                                                                                |

## The consumer's API

```ts
export function createSchema<X extends object, C, T extends GraphQLOperations<C>>(
	handlersFor: (context: X) => GraphQLExhaustive<T>,
	deps: GraphQLDeps<X, C>,
	extend?: (types: GraphQLTypes) => GraphQLExtension<X>,
): GraphQLSchema;
```

- **`X` is the GraphQL context value** the server hands every resolver. It is an object, because
  the per-request memo is keyed on it.
- **`handlersFor` returns the same object** a consumer gives `registerRoutes`:
  - `GraphQLExhaustive` requires a handler for every operation `graphql.tsp` exposes, directly or
    through a link;
  - it accepts handlers for every other operation the document declares, as MCP's
    `ToolsExhaustive` does;
  - it refuses a handler for an operation that does not exist.
- **The schema is built once**, at module scope. Per-request state arrives through `X`.

```ts
export interface GraphQLDeps<X, C> {
	/** Same semantics as RouteDeps/ToolDeps: any one requirement authorises; `{}` is anonymous. */
	readonly authorize: (
		context: X,
		requirements: readonly SecurityRequirement[],
	) => Awaitable<"allow" | "unauthenticated" | "forbidden">;
	/** As ToolDeps.context; `null` is answered UNAUTHENTICATED. */
	readonly context: (context: X, authentication: "none" | "optional" | "required") => C | null;
}
```

**Authorisation is per field, at call time**, from the operation's `@useAuth`, as on the HTTP
surface. A gateway that authenticates before GraphQL still passes the requirements through, and its
`authorize` answers from what the gate already verified.

### The escape hatch

`extend` lets a consumer hand-write a field that no operation provides, using the generated types:

```ts
export interface GraphQLExtension<X> {
	readonly query?: GraphQLFieldConfigMap<unknown, X>;
	readonly mutation?: GraphQLFieldConfigMap<unknown, X>;
	readonly fields?: { readonly [K in keyof GraphQLTypes]?: GraphQLFieldConfigMap<unknown, X> };
}
```

- **A collision with a generated field throws when the schema is built**, naming both.
- **`schema.graphql` is the generated part.** A consumer that extends the schema publishes
  `printSchema` of the extended one.
- This is the same escape hatch generated schemas use elsewhere: Mesh's
  `additionalTypeDefs`/`additionalResolvers` and Hasura's actions.

The mount, shown in the README for Node and for Workers, and exercised by tests on both:

```ts
const schema = createSchema((x) => handlersFor(x.c), deps);
const yoga = createYoga({ schema });
app.on(["GET", "POST"], "/graphql", (c) => yoga.fetch(c.req.raw, { c }));
```

## Projection rules

### Root fields

- **Root field names are verbatim.** Each is the name `graphql.tsp` gives, which by convention is
  a noun for a read (`book`, `books`) and a verb phrase for a mutation
  (`createBook`). PostGraphile, Hasura, Strapi, Hot Chocolate and Data API builder all use
  this pattern.
- **Root fields are nullable**, the GraphQL default and GitHub's and Shopify's practice, so one
  failing root does not null out its siblings.
- **The empty Query.** A schema whose surface declares no query still has a `Query` type, because
  GraphQL requires one. It carries a single nullable `_empty: Boolean` field.

### Links

A `@link(Parent, "name", operation, parameters)` gives the parent's GraphQL object type a field
`name`:

- **Its arguments** are the operation's unbound parameters, by the argument rules below. On a
  connection, the paging parameters become `first`/`after`.
- **Its type** is the operation's success type, by the result rules for queries below: a
  connection where the operation is one.
- **It is always nullable.** A target that answers 404, or a bound property that is `null` or
  absent, gives `null` **without calling the handler** in the second case. Anything that can
  answer 404 is nullable.
- **Its resolver** builds the operation's input, from bound properties read off the parent's wire
  value, converted to the parameter's wire key, plus the field's arguments. It then calls the same
  handler, through the same validation, as a root field.
- **Deduplication per request.** Calls are memoised per GraphQL context value, keyed by operation
  and canonical input, so 50 books by one author cost one `Authors.read`. This is DataLoader's
  deduplication without the library; a batched link, below, is its batching.
- **Mutations are never memoised**, and no link may target a mutation's operation.
- **A mutation clears the request's memo as it starts.** Mutations in one document run in turn and
  may change what a read answers, so a read memoised before one would answer stale after it.
  DataLoader's own rule.
- **A link's parent value is the parent's wire body**, as the parent's handler returned it, so the
  bound property is read by its JSON wire name (`resolveEncodedName`).
- **A bound property is a value the parameter accepts**, by the compiler's assignability to the
  parameter's type or to a scalar that type extends. A parameter that narrows what it is filled
  from (`@pattern(...) scalar TagId extends string`, filled from a `string` id) is accepted as a
  constraint on the parameter itself is: the operation's Zod schema checks the value when the link
  resolves, and refuses one that breaks it as `BAD_USER_INPUT` at the link.
- **A bound list is a list field.** A property that is a list of values the parameter accepts
  (`tag_ids: string[]` filling `Tags.read`'s `id`) makes the link `[Tag]`, one call per value
  through the memo, in the list's order:
  - each item is nullable, `null` where its call answers 404, and an item whose call fails is that
    item's error, at `tags.1`, the other items resolving, as graphql-js completes a list;
  - a `null` value is that item's `null`, uncalled, and a `null` or absent list the field's;
  - one list per link, since a field is one list and not a product of two, and not to an `@list`
    operation, since a field cannot be a list of pages (`link-list-not-bindable`);
  - **the list declares `@maxItems`** (`link-list-unbounded`), the most calls one parent's field
    makes. The parent's read schema holds every response to it, and the field's cost directives
    state it (see Cost hints), so `costLimit` still bounds the calls a document can make. The
    many-to-many shape of a REST model, the edge of the graph a list of ids is.
- **A link chosen by a kind** is the field several links of one parent share, each with `when`: a
  reference whose target depends on another property, a review of a book or of an author. The
  polymorphic association of a REST model; where the parent is itself a `@discriminated` union, a
  link on each variant's model already gives each variant only its own field.
  - **Its type is the union `<Parent><Link>`** of what its arms answer, in declaration order, even
    with one arm: as for a mutation's `<Name>Result`, a second arm then adds a member rather than
    changing the field's type. Each arm is planned enclosed as `<Parent><Link><Value>`, so no two arms
    claim one name for a type they define.
  - **Its resolver reads the kind off the parent's wire value** and calls only the arm it names, each
    an ordinary link's resolver (the memo, the bindings, list links, batching, validation); a kind no
    arm names, or none, is `null` without a call. Each answer is tagged with its arm's member, so the
    union resolves by the arm, never by the body's shape. An arm answering a result union keeps the
    member its own projection tags; one answering a discriminated union or an interface, whose type
    is decided by shape, cannot be a member (`link-arm-not-object`).
  - **One call per parent**, where a link per target called every target for every parent, a 404
    for each wrong one.
- **A batched link** calls a batch read, AIP-231's `BatchGet` over HTTP: one call for the distinct
  values of every parent a document reaches at once, where the memo makes one per distinct value.
  - **The batch parameter is a list in the query**, filled from a value of its items, or from a list
    of them, which makes the field a list. A path or header list reaches the handler as text, and
    AIP-231 puts the names in a `GET`'s query. A `POST` batch read with the ids in its body is out of
    scope: a link fills no body.
  - **The field's type is the batch's item**, `null` where the answer holds none for the value. The
    items are matched by `key`, to the value as the operation's schema parses it, the first item a
    key names winning, so a batch read that omits what it does not find works, and so does one that
    answers in any order.
  - **A wave is the resolvers one execution runs before it waits**: a value is enqueued as its
    resolver runs, and the batch sent once the microtask queue has drained, by `setImmediate` where
    the runtime has it and `setTimeout(0)` where it does not, as on Workers without `nodejs_compat`.
    A microtask would split a wave whose parents settled at different depths. Fifty books make one
    call for their authors, and the authors one more for their publishers.
  - **Admission once, then each value alone.** Authorisation and the caller context run once per
    batch and first, as for every call; each value is then checked alone by the operation's schema,
    so one it refuses is that field's `BAD_USER_INPUT`, and the rest are sent. The values go in
    chunks of the parameter's `@maxItems`.
  - **A 404 for a chunk of several values sends each again alone.** AIP-231's batch is atomic, so a
    404 says one of them is missing, not which; answered `null` for all, one dangling id would blank
    its siblings, which the unbatched link never does. Any other failure is every waiting field's
    error.
  - **The memo keeps each value's answer**, so a later wave asking for it again is answered from the
    first. The queue lives inside the memo, so a mutation's clearing clears it too. A context that is
    no object has no memo, and each value is a batch of its own.

### Arguments and input

- **A Query field or a link** takes one argument per unbound path, query and cookie parameter, and
  per header the mechanics rule leaves as an argument.
- **A Mutation field** takes a single `input: <Name>Input!`, Relay's convention, where `<Name>` is
  the field name in PascalCase (`CreateBookInput`). Its fields are exactly the handler's
  merged input, with a named body as one field. An operation with no input takes no arguments.
- **Headers that are HTTP mechanics are not arguments.** In GraphQL, transport metadata rides on the
  `/graphql` request's own headers; field arguments are domain input.
  - A header whose type is a single literal is supplied by the resolver. This also covers the
    negotiated `accept`, and a merge-patch `content-type`.
  - **Every optional header is left out**, so the handler sees it as absent. Examples:
    - a request id (`X-Request-Id`): a gateway carries it through its own context;
    - the RFC 9110 §13.1 preconditions (`If-None-Match` and the rest), so a GraphQL read never
      takes the conditional 304 path.
  - Only a **required** header whose type is not a single literal is an argument.
  - **A cookie follows the same rule**: it is transport state, as a header is.
  - A required cookie, or an `Authorization`, `Proxy-Authorization` or `Cookie` header, that stays an
    argument is warned `transport-argument`: an argument is document text, which servers log and
    cache. Any other required header is domain input by its declaration and is not warned.
- **An argument's type is its wire form, its own `@encode` included.** An
  `@encode("seconds")` duration header is `DurationSeconds`, a `unixTimestamp` query parameter is
  `UTCDateTimeUnix`: the library validates the number, so the client sends the number.
  - **A date-time header with no `@encode` is RFC 7231**, `UTCDateTimeHuman` or
    `OffsetDateTimeHuman`: TypeSpec's wire form for a header, and the `http-date` `@typespec/openapi3`
    publishes for it. As there, only where the header's own type is the standard scalar, alone or
    `| null`: a declared scalar, which it publishes as a `$ref`, and a header list's items stay
    RFC 3339. typespec-http-zod still validates such a header as RFC 3339
    (bison-digital/typespec-http-zod#4), so for now the REST route and the field refuse an
    HTTP-date alike.
- **Nulls the GraphQL type cannot state are stated by the resolver.**
  - An explicit `null` for an optional field that is not `| null` is dropped, as REST sees an
    omitted key.
  - A field that is **required and `| null`** is a nullable GraphQL input, since GraphQL cannot
    require one; when the caller leaves it out, the resolver writes the `null` the operation
    requires the caller to state.
- **A default is stated in the schema**, so a client sees it: a scalar's (`first: Int = 50`,
  `priority: Int = 3`), and an enum's by the name of the value whose wire value it is
  (`order: Order = NEWEST`), for a declared enum and a union of literals alike. graphql-js hands a
  resolver an enum default's internal value, the wire value, and so does GraphQL Yoga's executor
  from `@graphql-tools/utils` 12.1.0; before it, Yoga handed the name, which the operation's Zod
  schema refuses (graphql-tools#8511), so no enum default was stated until then. The README states
  that floor, and a `test/claims/` row goes red under an older executor. The Zod schema applies every
  default too, so a default the schema cannot spell still reaches the handler.
- **`#deprecated` on an argument** is `@deprecated(reason:)` where the argument is nullable, and
  ends its description as `Deprecated: <reason>` where it is required, as on an input field.
- **A path parameter's value is validated as a value.** Where the library decodes a path
  parameter out of its segment's text (`{.param}`, `{;param}`, `primitive{param}`, a list or record),
  its path schema is `z.preprocess(uriExpansion, value)`. A GraphQL argument is the value, never that
  text, so the resolver validates it with the schema the decoding feeds (`.out`): handed to the
  decoder, `"a"` for `primitive{param}` was refused for lacking `primitive`.
- **An open body makes the input `JSON`.** A spread body that carries additional properties puts
  them at the top of the handler's input, which no closed input object can carry, so the operation
  takes one `input: JSON!` holding its input as the request carries it, warned `projected-as-json`.
  It is the handler's whole input, so it is an object, as the request body is: a string, a number
  or a list is `BAD_USER_INPUT` at `input`, never spread into keys or dropped.
- **The wire rules are code.** Each argument's wire key and null rules travel in its resolver's
  `CallRuntime.args`, and each input object field's in one `INPUT_RULES` literal, never in the
  schema's `extensions`: a schema rebuilt from its SDL, merged or transformed keeps every name and
  drops every extension. A key the resolver assembles that the operation's request schema does not
  declare is refused as a masked `InputAssemblyError`, never handed to a validator that would let it
  through unread.
- **Validation is the HTTP surface's.** The resolver assembles the wire-shaped input and validates it
  with the **same** per-operation Zod schemas from `schemas.gen.ts` before calling the handler. A
  failure is a top-level `BAD_USER_INPUT` carrying the Zod issues, each with `path` the GraphQL
  path the client wrote and `wirePath` the handler's input path, which is the REST route's. The handler receives exactly
  what the REST route's handler would.

### Connections

An operation is projected as a Relay connection (relay.dev/graphql/connections.htm) when it carries
TypeSpec's **core** paging decorators. These are protocol-neutral, and they pass through openapi3,
http-zod and typespec-hono with no diagnostic. All of these must hold:

- `@list` on the operation;
- `@pageItems` on the response's item array;
- `@continuationToken` on the response's next token;
- `@continuationToken` on the request's token parameter;
- `@pageSize` on the request's size parameter.

A spec whose `Page<Item>` and `PageRequest` lack any of these gains it there: a change to the spec,
not to any emitter.

| GraphQL                                                                                                 | From                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first: Int`                                                                                            | the `@pageSize` parameter: its default and `@maxValue` are the parameter's, enforced by the operation's Zod schema                                                                                                                                                                                                                |
| `after: String`                                                                                         | the request's `@continuationToken` parameter                                                                                                                                                                                                                                                                                      |
| `<Item>Connection { edges: [<Item>Edge!]!, nodes: [<Item>!]!, pageInfo: PageInfo! }`                    | the `@pageItems` array. `nodes` is GitHub's and PostGraphile's shortcut.                                                                                                                                                                                                                                                          |
| `<Item>Edge { node: <Item>!, cursor: String! }`                                                         | each item, with an opaque cursor (§3.1): the token of the page it came from and how many of that page's items precede the next edge. `after` it, the resolver asks the backend for that page again and skips them. The last edge of a page used whole carries the next page's start.                                              |
| `PageInfo { hasNextPage: Boolean!, hasPreviousPage: Boolean!, startCursor: String, endCursor: String }` | `startCursor` and `endCursor` are the first and last edges' cursors, null only with no edges (§5.1); an empty page with a next one has that page's start as `endCursor`. `hasNextPage` is true while the backend has a next page or the slice left items over. Forward only, so `hasPreviousPage` is `false`, which §5.1 permits. |

- **Relay §4.4, enforced.** A negative `first` is `BAD_USER_INPUT`. A page longer than `first` is cut
  to it, and the cut items are not lost: the last edge's cursor resumes within the page, and with
  `first: 0`, which leaves no edge, `endCursor` resumes where the page began. Resuming
  partway into a page asks the backend for `first` plus the items skipped, so the window holds
  `first`, **but never past the page size's maximum**, its `@maxValue` or `@maxValueExclusive` and
  those of the scalars it extends: past it the window is shorter than `first`, which §4.4's "at
  most" allows, and its last edge goes on at the next page, so no item is lost or repeated and still
  one handler call answers the field. A `first` beyond the maximum on its own is sent as it is, and
  refused by name.
- **`after` takes only a cursor this connection issued**; anything else, a raw backend token
  included, is `BAD_USER_INPUT`. The handler still receives the backend's own token, unchanged.
- **Partial paging decorators:** an `@list` operation missing any of the five, or using offset or
  link paging, is warned `not-a-connection` and projected as its declared response type. So is a
  page of lists, `@pageItems` on `T[][]`, `(T[] | null)[]` or an array of a union variant naming a
  list: an edge's `node` is one item, never a list (§3.2). A union of a list with anything else is
  one `JSON` value, so a page of those is a connection.
- **Other parameters** of a connection operation, such as filters, stay arguments.

### Results

Expected outcomes are typed data, and the top-level `errors` list is for what a client cannot act on
in its own logic. This is graphql.org's error-handling guidance ("business logic errors belong in
the schema"), _Production Ready GraphQL_, Apollo's "errors as data" and Shopify's `userErrors`.

**Queries and links:**

| Declared arm  | Becomes                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2xx           | the field's value. Several distinct success bodies make a union `<Name>Result` of them; a bodyless success is `Boolean`. |
| 404           | `null`                                                                                                                   |
| 400, 422      | top-level `BAD_USER_INPUT`                                                                                               |
| 401, 403      | top-level `UNAUTHENTICATED`, `FORBIDDEN`                                                                                 |
| 409           | top-level `CONFLICT`                                                                                                     |
| 429           | top-level `RATE_LIMITED`. Any top-level error whose arm declares `Retry-After` carries it as `extensions.retryAfter`.    |
| any other 4xx | top-level, with `code` the reason phrase in CONSTANT_CASE (`GONE`, `PRECONDITION_FAILED`)                                |

**Mutations:**

| Declared arm                 | Becomes                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| 2xx                          | a success member of `<Name>Result`                                 |
| 4xx, except 401, 403 and 429 | a typed error member of `<Name>Result`: the error model's own type |
| 401, 403, 429                | top-level, as for queries                                          |

**On both:**

- A declared 4xx body travels in `extensions.body` when the error is top-level.
- **A `default`, `4XX` or `5XX` arm is decided by the status the handler answered**, by the tables
  above: a 404 is `null` on a read, every other status its own code, and on a mutation a member-class
  status is the arm's model as a member. One fixed code per arm answered a 404 under the common
  `| Error` default as a server error on a read. The codes are one `STATUS_CODES` table, written into
  `graphql.gen.ts` where a field needs it.
- 5xx is top-level with `code` from the reason phrase, `extensions.status` and the declared body
  under `extensions.body`.
- A 1xx or a 3xx, an exact code or a range, is not projected. A `2XX` range is a success like any
  2xx: a mutation's member, a query's value.
- **The union, when there is one member:** a query's result with exactly one member is that
  member's type directly; a mutation's is always `<Name>Result`, so the first error response its REST
  operation gains adds a member rather than changing the field's type, which would break every
  client. `test/evolution/` holds that to two schema-diff judges.
- **A union member must be an object type.**
  - An arm whose body is a model is that model's type.
  - An arm that is bodyless, a list or a scalar is wrapped in a generated type named for the field
    and the status's reason phrase (`CreateBookNoContent`).
  - The wrapper carries `value` for a body. With none it carries `success: Boolean!`, true for a
    success and false for a refusal: a GraphQL object needs a field, and an HTTP status is not the
    client's vocabulary.
- **Two arms with one model are one member.**
- **`resolveType`** is decided by the arm the handler returned, never by the shape of the body.
- **The response contract is the HTTP surface's.** The resolver finds the arm with `armFor` and
  parses the body against that arm's schema, as the REST route does. With
  `seal-object-schemas: false` that parse strips the keys the schema does not declare, so a
  backend's internal fields reach a GraphQL client no more than a REST one.

**The other top-level errors:**

| `extensions.code`       | When                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BAD_USER_INPUT`        | A scalar's coercion or the request schema refuses the input. Zod issues are in `extensions.issues`.                                                               |
| `UNAUTHENTICATED`       | `deps.context` returned `null`, or `authorize` answered `"unauthenticated"`.                                                                                      |
| `FORBIDDEN`             | `authorize` answered `"forbidden"`.                                                                                                                               |
| `INTERNAL_SERVER_ERROR` | `ResponseContractError`, `UndeclaredStatusError`, a 3xx, or a handler throw. These are not `GraphQLError`s, so the server masks the detail; Yoga does by default. |

### Cost hints

The schema carries the IBM cost directives (ibm.github.io/graphql-specs/cost-spec.html), the draft
graphql.org points to:

- `@cost(weight: "1")` on every root field and link, because each calls a handler; a link bound to a
  list calls once per value, so it is weighed at its list's `@maxItems`, `@cost(weight: "20")`, with
  `@listSize(assumedSize: 20)` so what is selected below counts once per item. The specification
  weighs a field once however long its list (§5.3.2.2), so weighed at 1, `tags { id }` would cost one
  call where it makes twenty;
- a batched link at the calls its own values can take, `ceil(L / n)`, `L` the values it holds (its
  list's `@maxItems`, or one) and `n` the most one call carries (the batch parameter's `@maxItems`),
  plus `L` where the batch can answer 404, since each value is then sent again alone. Chunks are
  packed in order, so the calls a wave makes are at most the sum of its fields' weights
  (`ceil(D / n) ≤ Σ ceil(Lᵢ / n)`). Field Cost counts per field, so a batched link never weighs less
  than the link it replaces: the saving is in the calls made, and `costLimit` still bounds them;
- a link chosen by a kind at its costliest arm, and its Type Cost at its costliest member (§7.2);
- `@listSize(slicingArguments: ["first"], sizedFields: ["edges", "nodes"],
requireOneSlicingArgument: false)` on every connection field, with `assumedSize`, the largest
  page size the operation accepts (see Connections), only where `first` has no default. The
  specification reads a slicing argument's default as if the query had sent it (§8.2), and allows
  `assumedSize` beside `slicingArguments` only where no slicing argument has one (§9.2.4).

They are declared in `schema.graphql`, and repeated in each field's `extensions` (`cost`,
`listSize`) so a validation rule can read them from the runtime schema.

**The runtime enforces them, and bounds depth and aliases.** No third-party limit library
qualifies: graphql-armor and every plugin of it require graphql 16, `graphql-query-complexity`
depends on the deprecated `lodash.get`, and `graphql-depth-limit` was last published in 2022. So
`runtime.ts` exports, importing nothing but `graphql`:

- `operationCost(request)`: the specification's Field Cost by static analysis (§5.1.1, §5.3.2.2), with
  the request's variables, so it runs where they are known (Yoga's `onExecute`), not as a validation
  rule. Weights default by §7.1, an interface or union takes its costliest type (§7.2), a list is
  sized by §8, and a list with no bound below which anything is costed is unbounded;
- `costLimit(maximum)`, refusing an operation that costs more as `COST_LIMIT_EXCEEDED`;
- `typeCost(request)`: the specification's Type Cost (§5.3.2.1), "the weighted sum of the Type
  Counts", by the same reading of the document. A Type Count is how many values of a type the
  response can hold (§5.3.1.1), the root counted once (Example № 4). Field Cost bounds the handler
  calls and Type Cost the objects returned: a connection's `nodes` is one field however many items it
  holds, so a document choosing `nodes` over `edges` pays less Field Cost for the same items, but not
  less Type Cost;
- `typeCostLimit(maximum)`, refusing one whose Type Cost is more as `TYPE_COST_LIMIT_EXCEEDED`;
- `depthLimit(maximum)` and `aliasLimit(maximum)`, graphql-js validation rules, each fragment measured
  once however often it is spread, so a fragment bomb costs the rule nothing.

The README's mount applies all four and graphql-js's own `maxTokens`, and `test/socket/` serves that
mount as written.

### Types

Unchanged from upstream's conventions, with these rules:

| TypeSpec                                    | GraphQL                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| model, as output                            | object type, fields under Read visibility, as the response schema has them                                                                                                                                                                                                                         |
| model, as request input                     | input object type with the request variant's fields, named with an `Input` suffix; a model the request's visibility does not transform is its canonical, `Read` schema, read-only properties included, optional where openapi3 publishes OpenAPI 3.0 (its default) and required as declared at 3.1 |
| `extends`                                   | the base's fields flattened in, one per wire key, as openapi3's `allOf` composes them: a redeclaration under another `@encodedName` is a second field                                                                                                                                              |
| a union of models with a discriminator      | output: a union whose `resolveType` reads the discriminator; input: `JSON`                                                                                                                                                                                                                         |
| a `@discriminator` base model               | output: the interface `<Name>Interface`, implemented by the base's own object type `<Name>` and by each subtype; input: `JSON`. See below                                                                                                                                                          |
| any other union                             | `JSON`, with the warning `projected-as-json`. The Zod schema still validates it.                                                                                                                                                                                                                   |
| string enum, or a union of string literals  | an enum. Values are CONSTANT_CASE, and the wire value is the internal value.                                                                                                                                                                                                                       |
| `T \| null`, an optional property           | nullable                                                                                                                                                                                                                                                                                           |
| `T[]`                                       | `[T!]` or `[T]`, by the element's own nullability                                                                                                                                                                                                                                                  |
| `Record<T>`                                 | `JSON`                                                                                                                                                                                                                                                                                             |
| a model with additional properties          | `JSON`, warned: `...Record<T>`, `extends` or `is Record<T>` beside declared properties make the wire object open, and a GraphQL type is closed                                                                                                                                                     |
| `unknown`                                   | nullable `JSON`, since `null` is one of its values                                                                                                                                                                                                                                                 |
| `T[]` a property encodes as text            | `String`: `@encode(ArrayEncoding.commaDelimited)` puts `"a,b"` on the wire; a query parameter so encoded stays a list, split by the library                                                                                                                                                        |
| `string`, `boolean`                         | `String`, `Boolean`                                                                                                                                                                                                                                                                                |
| `int8`, `int16`, `int32`, `uint8`, `uint16` | `Int`                                                                                                                                                                                                                                                                                              |
| `float`, `float32`, `float64`               | `Float`                                                                                                                                                                                                                                                                                            |
| `int64`, `uint32`, `safeint`                | `Long`                                                                                                                                                                                                                                                                                             |
| `uint64`, `integer`                         | `BigInteger`                                                                                                                                                                                                                                                                                       |
| `numeric`, `decimal`, `decimal128`          | `Numeric`, `BigDecimal`, `BigDecimal`                                                                                                                                                                                                                                                              |
| `utcDateTime`, `offsetDateTime`             | `UTCDateTime`/`OffsetDateTime` (RFC 3339); `…Human` under `rfc7231`, and as a header with no `@encode`; `…Unix` under `unixTimestamp`                                                                                                                                                              |
| `plainDate`, `plainTime`                    | `PlainDate`, `PlainTime`                                                                                                                                                                                                                                                                           |
| `duration`                                  | `Duration` (ISO 8601); `DurationSeconds` under `seconds`; `DurationMilliseconds` under `milliseconds`; ISO 8601 stated as a number is that number, as the library validates it                                                                                                                     |
| `bytes`                                     | `Bytes` (base64); `BytesUrl` under `base64url`                                                                                                                                                                                                                                                     |
| `url`                                       | `URL`                                                                                                                                                                                                                                                                                              |
| a scalar declared in the spec               | its base's mapping                                                                                                                                                                                                                                                                                 |

- **Names.**
  - Types are PascalCase with the namespace stripped. A type's `@friendlyName`, where one is
    applied, is its name, read first as `@typespec/openapi3`'s `getOpenAPITypeName` and
    typespec-http-zod read it, so `Located<Conflict>` under `@friendlyName("Located{name}", P)` is
    `LocatedConflict` in the document, the validators and the schema. Otherwise templates are named
    as upstream names them.
  - Fields are camelCase of the property's **JSON wire name** (`resolveEncodedName`), so a field
    reads the same in REST and GraphQL.
  - Enum values are CONSTANT_CASE.
  - The pipeline is upstream's `naming.ts`.
  - **The wire is untouched:** resolvers map each GraphQL name back to the wire key.
  - **Every field reads its own property.** graphql-js's default resolver reads through the
    prototype chain and calls a function it finds, so a body without a `constructor` key answered
    `Object` called on the arguments; each generated field has a resolver that reads the key as an
    own property.
- **Anonymous types** are named from the model their type was declared in, and the member:
  `Widget.nested` is `WidgetNested`. The name is the program's, never the order a surface reaches
  the type in, so a field added to `graphql.tsp` renames nothing:
  - **An inherited or copied member is its declaring model's**, one type wherever it is reached:
    `Habitat.climate` is `HabitatClimate` in `Desert` and `Tundra` (`extends Habitat`) and in
    `Oasis` (`...Habitat`) alike. The declaring model is found through each spread or `is` copy
    that still holds the source's own type, to the deepest model whose own property it is. Named
    after the model holding it, it was whichever holder an operation reached first.
  - **Its own property.** A visibility transform's copy (`DialCreate is Create<Dial>`) names the
    source model, but a member type it reshapes is no property of that model: `Dial.face` is
    `DialFace` and `DialCreate.face` is `DialCreateFace`, while `rim`, untouched, is `DialRim` in
    both. Named after the source, the two types claimed one name.
  - **A name that tells the model apart.** A template instance whose composed name keeps every
    argument declares its members (`Shelf<string>.label` is `ShelfOfStringLabel`, by `extends` or
    `is`); one whose name leaves out an argument declares nothing, since upstream's composition
    makes `Crate<"box">` and `Crate<"bin">` both `Crate`, so `Box is Crate<"box">` declares what it
    copies.
  - **As input, the view suffix is the anonymous type's own reading**, which its input type is
    keyed by: `Gauge.reading`, which no request reshapes, is `GaugeReadingInput` under both
    `GaugeInput` and `GaugeUpdateInput`, and `Gauge.limits`, reshaped at Update, is
    `GaugeLimitsUpdateInput` there.
  - **Wherever it is reached.** A type a declared model's member holds has that member's name at
    the top of a field too, a response body or an argument, rather than the field's.
  - **Two members holding one type are named after the first declared**, the program's namespaces
    walked as declared, a namespace's own models before its children's, and warned
    (`anonymous-type-shared`). Two members hold one type only through an `alias`, which declares
    nothing (`Lamp.tone` and `Paint.tone`, both `Tone`, are `LampTone`), or by inheriting from an
    instance whose name leaves out an argument (`Low` and `High`, both `extends Crate<"x">`, share
    `LowContents`). Declaring another holder before the first renames the type, which the warning
    says; declaring the type as a model, union or enum names it for good. Named after whichever
    holder a surface reached first, a field added to `graphql.tsp` renamed it.
  - **Where no declared model holds it** (an anonymous model's member, or an operation's anonymous
    body or argument), it is named after the type or field enclosing it. The one order left: such a
    type two fields reach, an operation's anonymous body exposed both as a root field and as a link,
    or an `alias` two operations return, takes the name of the field the plan projects first
    (queries, then mutations, each by name, then links by type and name).
- **Shared fields are an interface.** A named model that two or more reached output types are built
  from, by `extends` or by a spread (`...ProblemFields`), becomes `<Name>Interface`, upstream's
  interface naming, with each field every implementer projects identically; each of those types
  implements it, so a client selects the shared fields across a result union's members. An `alias`
  has no name to give one, so share fields through a named model to get the interface. A model
  with additional properties of its own is no source, as no GraphQL type states an open object, and
  neither is an array or a `Record`.
- **A `@discriminator` base is an interface, implemented by the base's own object type.**
  - **The base is a value of its own.** `typespec-http-zod` (0.31 on) validates a base as the document
    does (OAS 3.1.1 § 4.8.25, "MUST NOT change the validation outcome"): the dispatch to its
    subtypes, then the base itself. A value whose discriminator names no subtype, or names one it is
    not a valid instance of, is served as the base. The union of the subtypes alone this emitter
    used to project had no member for it, and graphql-js answered "Abstract type must resolve to an
    Object type at runtime", while REST served it 200.
  - **An interface, not a union.** A GraphQL union "provides for no guaranteed fields" (§ 3.8); an
    interface is fields every implementer has (§ 3.7), and every member of a hierarchy has the base's.
    A field of the base's type returns the interface, so a client selects the shared fields without
    a fragment. Upstream `@typespec/graphql` makes interfaces only on its explicit decorator, and
    names a model that is both an object type and an interface `<Name>Interface`
    (`src/lib/naming.ts`); the base's own object type keeps the model's name, as every model does.
  - **The base's object type has the base's fields and none of a subtype's**, the discriminator
    among them, as the `String` openapi3 adds where no property of the base is sent under its key.
    The library's base arm validates the base's own properties and drops any other key.
  - **The discriminator is the wire key it names**, `discriminator.propertyName` in the document and
    the key the library dispatches by (`z.discriminatedUnion`). A base whose own declaration of it is
    sent as another key, `@encodedName("application/json", "type") kind`, has a `type` field and the
    `kind` openapi3 adds, and is resolved by `kind`.
  - **The discriminator has the type its base declares, on every member, and is never null**:
    `Golden`'s `kind: "golden"` is the `DogKind` `Dog` declares. One type across the hierarchy is
    what keeps it a field of every base interface, and the library refuses a body without it, even
    where the spec wrote it optional.
  - **A nested base** (`Shark`, with its own discriminator, under `Fish`) is an interface of its
    own implementing its parent's, and its members implement both. The parent resolves a value its
    discriminator names as the nested base by the nested base's own rule.
  - **`resolveType`** answers the subtype the discriminator names where that subtype's own validator
    accepts the value, the nested base's choice for a nested base it accepts, and the base's object
    type for any other value: the library's dispatch to a subtype matches exactly then, and its parsed
    output, which both surfaces carry, does not say which arm matched. The validator is imported from
    `schemas.gen.ts` by the identifier the library publishes for the type (`typeSchemaNames`, 0.33.0
    on), never one this emitter derives; a subtype it publishes none for is never chosen.
  - **A `@discriminated` union stays a union resolved by its discriminator.** The library validates
    one as a strict `z.discriminatedUnion`, so a value that passed has exactly the variant its
    discriminator names.
- **A name GraphQL already owns is never a type of the spec's.** A model, enum or union named as
  a root type (`Query`, `Mutation`, `Subscription`), a built-in scalar (`String`, `Int`, `Float`,
  `Boolean`, `ID`) or one of the runtime's scalars (`Duration`, `URL`, `JSON` and the rest) is
  `JSON`, with a `projected-as-json` warning that names the reserved name. The operation keeps its
  field; renaming the model restores its type.
- **A collision after conversion** drops every declaration that reaches either party, with
  `graphql-name-collision`.
- **Scalars** are upstream's `SCALAR_MAPPINGS` names and `@specifiedBy` URLs (scalars.graphql.org),
  with two departures:
  - the custom scalar applies to a standard scalar used directly;
  - a value whose wire form is a JSON number is never `String`.
- **One scalar, one wire form.** Serialisation emits the wire value unchanged, and input coercion
  checks the JSON type. The operation's Zod schema validates the rest.
- **Docs:** `@doc` becomes descriptions, and `#deprecated` becomes `@deprecated(reason:)`. On a
  required input field the reason ends its description instead, as `Deprecated: <reason>`: GraphQL
  refuses `@deprecated` there, and deprecating a field while it is still required is how a migration
  starts.

## Module layout

This follows `typespec-http-mcp/docs/architecture.md`. `test/architecture/` pins the boundaries a regression would cost most: `runtime.ts` reaches only `graphql` and zod, the renderers never reach the compiler, `names.ts` only `change-case`, and the decorators never `surface.ts`.

| module           | owns                                                                            | may reach                                                                                        |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `lib.ts`         | options (derived from the library's), diagnostics, the package name, state keys | the compiler, the library                                                                        |
| `decorators.ts`  | `$queryField`, `$mutationField`, `$link`: record only                           | the compiler, `lib.ts`                                                                           |
| `surface.ts`     | reads the declarations, runs the checks above, and yields the validated surface | the compiler and its typekit, `@typespec/http`, the library's types, `decorators.ts`, `names.ts` |
| `names.ts`       | GraphQL naming, matching upstream's pipeline; `NameBook`                        | `change-case` only                                                                               |
| `types.ts`       | TypeSpec type → GraphQL type model; visibility variants; scalars                | the compiler, `@typespec/http`, `@typespec/openapi` (`isReadonlyProperty`)                       |
| `inputs.ts`      | arguments, input objects, header mechanics, wire-key tables                     | the compiler, `@typespec/http`, the library's types                                              |
| `connections.ts` | core paging decorators → connection plan                                        | the compiler, `@typespec/http`                                                                   |
| `results.ts`     | arms → query and mutation result shapes, members, wrappers, codes               | the compiler, `@typespec/http`, the library                                                      |
| `model.ts`       | the shared vocabulary (TypeRef, TypeDef, FieldPlan), with no logic              | nothing                                                                                          |
| `render.ts`      | `graphql.gen.ts` from the model                                                 | `model.ts`, the library's types                                                                  |
| `sdl.ts`         | `schema.graphql` from the model, with directives, checked by `buildSchema`      | `model.ts`, `graphql`                                                                            |
| `coexistence.ts` | peer emitters writing one directory with different library options              | the compiler                                                                                     |
| `runtime.ts`     | what emitted code imports at run time                                           | **only `graphql`**; no Node builtins                                                             |
| `requests.ts`    | the recorded plans, as a document per root field and variables from REST values | `model.ts`, `names.ts`, the compiler's and the library's types                                   |
| `emitter.ts`     | orchestration, and `emitted + dropped === declared`                             | everything above                                                                                 |

**Peer dependencies:** `graphql ^17`, `zod`, `@typespec/compiler`, `@typespec/http`,
`@typespec/openapi`. `graphql` is also a build-time dependency of the emitter, for `buildSchema` and
`validateSchema`.

**Nothing deprecated.** No deprecated API in `src/`, the tests or the emitted code, and no deprecated
package anywhere in the tree. graphql 16 is outside the peer range for that reason: its scalar and
default-value API (`serialize`, `parseValue`, `parseLiteral`, `defaultValue`) is the one graphql 17
deprecates, so supporting both majors would mean shipping deprecated calls. `pnpm lint` denies
`typescript/no-deprecated`, and `test/no-deprecated.test.ts` proves the rule and the lockfile check
can each fail.

## Oracles

Each row is trusted only after a defect has been planted, seen red and reverted, as in
`typespec-http-mcp/docs/oracles.md`.

| artefact or decision                        | must agree with                                                                                                                                                              | arm                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| removability                                | REST output without the GraphQL surface                                                                                                                                      | the fixture compiled with and without `graphql.tsp`: openapi3, http-zod and typespec-hono output byte-identical                                                                                           |
| handler signatures                          | the published `typespec-hono`'s `Operations`, per operation (a dev dependency)                                                                                               | the agreement fixture: ONE object passed to `registerRoutes` and `createSchema`, with `Identical<>` per operation                                                                                         |
| `schema.graphql`                            | the schema `createSchema` builds                                                                                                                                             | `printSchema(buildSchema(sdl)) === printSchema(createSchema(...))`, plus `validateSchema` returns `[]` and the applied directives parse back                                                              |
| connections                                 | the Relay connection spec                                                                                                                                                    | assertions per spec section over every connection type: `edges` is a list of edge types, each edge has `node` and a String `cursor`, and `PageInfo` has the four fields with the spec's types             |
| idiomatic output                            | a hand-written SDL for a bookshop (publishers, authors, editors, books, editions)                                                                                            | the emitted SDL from the bookshop fixture equals it, compared with `printSchema` normalisation                                                                                                            |
| every generated name                        | graphql-js `assertName`, and upstream's naming                                                                                                                               | names tests against upstream's `naming.ts`, vendored at a pinned commit as a test oracle only                                                                                                             |
| scalar names, encodings, `@specifiedBy`     | upstream's `SCALAR_MAPPINGS`, apart from the two departures                                                                                                                  | a test over every intrinsic scalar and encoding                                                                                                                                                           |
| a value in a response                       | the REST JSON for the same call                                                                                                                                              | acceptance: one read through REST and GraphQL, compared over the selection                                                                                                                                |
| a `@discriminator` base's value             | the document `@typespec/openapi3` publishes: by OAS 3.1.1 § 4.8.25, the subtype its mapping names exactly where the value validates against it (Ajv), and otherwise the base | `test/discriminators/`: each value through REST and Yoga, its `__typename` the document's type; README § Known limits names the values held                                                               |
| input validation                            | the REST route's                                                                                                                                                             | a request REST answers 400 is `BAD_USER_INPUT` here; one REST accepts reaches the handler unchanged; the encoded list parameters, through REST and GraphQL, against the parameters the document publishes |
| result members and nulls                    | the declared arms                                                                                                                                                            | every declared arm returned once and seen as its member, null or code                                                                                                                                     |
| link deduplication                          | the call count                                                                                                                                                               | 50 parents with one bound id make one handler call per request, and two requests make two                                                                                                                 |
| a link chosen by a kind                     | the arm the parent's kind names                                                                                                                                              | three reviews, two of books and one of an author, make three calls and resolve `Book`, `Book`, `Author`; a kind no arm names calls nothing                                                                |
| batched links                               | the call count, and the wave                                                                                                                                                 | fifty books make one batch call; books, their authors and their publishers two; on Node and on workerd                                                                                                    |
| requests for other tools                    | the served schema, and the REST request with the same values                                                                                                                 | every document validates, across the corpus; the handler receives what the REST request hands it                                                                                                          |
| `emitted + dropped === declared`            | itself, with both terms non-zero                                                                                                                                             | declaration-check tests                                                                                                                                                                                   |
| every emitted file, across the whole corpus | `tsc` strict, plus `validateSchema`                                                                                                                                          | the `@typespec/http-specs` corpus, every operation declared by a test-generated `graphql.tsp`, dropped scenarios named                                                                                    |
| `runtime.ts`                                | importing only `graphql`, no Node builtin                                                                                                                                    | `test/architecture/`                                                                                                                                                                                      |
| no code-generation library                  | the dependency tree                                                                                                                                                          | a test that fails if `@alloy-js/*`, emitter-framework, mutator-framework or graphql-codegen appears in the production tree, the whole tree or the manifest                                                |
| a real server                               | **Node:** Hono on `@hono/node-server`. **Workers:** workerd via `unstable_startWorker`, without `nodejs_compat`.                                                             | the README's `graphql.ts`, written out as shown and served on both: `POST` and `GET /graphql`, its limits, and every MUST audit of `graphql-http`                                                         |
| what the README says a client sees          | rows written by hand from each README sentence, quoted verbatim                                                                                                              | `test/claims/`: data, errors and every handler call, literal; a quote gone from the README, or a claim with no row, fails                                                                                 |
| REST and GraphQL on the same request        | `@typespec/http-specs`' own mockapi requests and responses, which this package did not choose                                                                                | `test/replay/`: each request through `typespec-hono` and through Yoga, one handler object, the handler inputs and the answers compared                                                                    |
| what GraphQL accepts and what Zod accepts   | the library's own Zod schemas, on bodies and inputs generated from them                                                                                                      | `test/verdicts/`: no accepted body breaks a response, and GraphQL refuses no input Zod accepts                                                                                                            |
| a Relay client paging                       | Apollo Client's `relayStylePagination`, over a socket                                                                                                                        | `test/relay-client/`: every page walked, a resume after every edge                                                                                                                                        |
| schema evolution                            | `@graphql-inspector/core` and graphql-js `findSchemaChanges`                                                                                                                 | `test/evolution/`: a change REST clients survive breaks no GraphQL client                                                                                                                                 |
| the cost directives and the limits          | the IBM cost specification: §9's validation rules, and its worked examples                                                                                                   | `test/idiom/specifications.test.ts` over every fixture's schema; `test/limits/` against the examples' stated costs                                                                                        |
| graphql-js 17, one copy                     | the peer range, `^17.0.0`                                                                                                                                                    | the peer range, the tree, the emitted schema and Yoga, each on the one copy                                                                                                                               |
| nothing deprecated                          | the lockfile, and `typescript/no-deprecated`                                                                                                                                 | a deprecated package or API is refused, and each refusal is shown able to fail                                                                                                                            |
| start-up cost                               | a budget                                                                                                                                                                     | the schema built at a large operation count on workerd, recorded in `docs/measurements.md`                                                                                                                |

**Mutation testing runs over the request-time and projection modules.** `pnpm test:mutation` runs
Stryker, dev-only, over `runtime.ts`, `results.ts`, `connections.ts`, `inputs.ts` and `types.ts`,
with the suites that import them directly (`vitest.mutation.config.ts`). A suite that runs this
emitter over a fixture loads it from `dist/`, which Stryker does not mutate, so those suites are
graded by the oracles above instead. `test/mutation/check.test.ts` then holds the report:

- every survivor and every uncovered mutant is in `test/mutation/equivalents.json`, with the reason
  no test can tell it from the original;
- a survivor that ran fewer tests than cover it is refused, and so is a kill whose reason is a
  file-system error, and a timeout its hit limit did not stop: each is the runner, the sandbox or
  the clock deciding, not a test;
- the counts are ratcheted in `test/mutation/baseline.json`.

Stryker's vitest runner 10.0.0 is patched (`patches/`) in two places, each as an open upstream fix
makes it. Test names are joined with `" > "`, as vitest 5 matches them; joined with spaces, no test
inside a `describe` was selected and every mutant survived (stryker-js #6210). A test file that fails
as a whole is an error rather than a pass; a mutant that stopped its module loading was reported
survived (#6150, PR #6217). Delete the patch when a release carries both: the check's refusal of a
survivor that ran no test shows a regression.

Stryker's instrumenter prints each mutant with `@babel/generator`, an AST printer. It is a dev-only
tool that writes nothing this package ships or emits, so it is not a code-generation library in the
sense of § Independence, and `test/no-codegen.test.ts` does not forbid it.

## Out of scope for v1

Each is named so that leaving it out is a decision, not an oversight.

- **A batch read taking its ids in a request body.** A link fills path, query, header and cookie
  parameters from its parent, never a body, so a `POST` batch read is not a batched link's operation.
- **Global object identification** (`Node`, `node(id:)`).
- **Subscriptions**, and SSE operations as subscriptions.
- **Backward pagination** (`last`/`before`), since a continuation token pages forward only.
- **Response headers.** A success's headers are dropped.
- **`@oneOf` input unions.** Input unions are `JSON`, validated by Zod.
- **Renaming a type for GraphQL.** A collision is reported instead; the escape hatch and a model
  rename cover the rest.
- **Federation.**

## Considered and decided against

Each was weighed against the idiom it would follow, and left out for the reason given.

- **`ID` for key properties.** Nothing proves an argument is a key: `@path id: Book.id`
  resolves to a plain `string`, so `book(bookId:)` would stay `String!` beside
  `Book.id: ID!`, and graphql-js refuses a client's `$id: ID!` variable in a `String!`
  position. Identifiers are `String` throughout, which is consistent.
- **A `<Name>Success { entity }` payload wrapper around a mutation's success.** A mutation always
  answers `<Name>Result`, so an error member can be added without a break; the entity as the success
  member is the established result-union pattern. A wrapper adds a selection level to every client
  for fields no handler returns.
- **Backward paging (`last`/`before`).** Out of scope above: a continuation token pages forward
  only, and a `last` the backend cannot answer would be a promise the schema breaks.
