# Changelog

Every notable change to this package. The format follows Keep a Changelog, and the version follows
semantic versioning.

## [0.2.0] - 2026-10-21

Requires `typespec-http-zod` `^0.34.0`.

**Upgrading:** a type under a `@friendlyName` is now named by it, so its GraphQL name changes where
one is applied: `Located<Conflict>` under `@friendlyName("Located{name}", P)` was
`LocatedOfConflict` and is `LocatedConflict`, as in the OpenAPI document and the validators. Move a
client's fragments and `__typename` checks with it. The README's mount answers through
`c.newResponse`; copy it, or keep any middleware headers yourself.

### Added

- **`typeCost(request)` and `typeCostLimit(maximum)`**: the cost specification's Type Cost
  (§5.3.2.1), the objects a document's response can hold, beside `operationCost`'s Field Cost, the
  handler calls it can make. A connection's `nodes` is one field however many items it holds, so a
  document choosing `nodes` over `edges` paid less Field Cost for the same items: through `nodes`
  three books, their authors and three editors of each cost 11, through `edges` 23. Their Type
  Costs, 20 and 32, count every object both ways. `typeCostLimit` answers
  `TYPE_COST_LIMIT_EXCEEDED`, and the README's mount applies both limits.
- **A link bound to a list is a list field**: `@@link(Product, "tags", Tags.read, #{ id: "tag_ids" })`
  over `tag_ids: string[]` is `tags: [Tag]`, one call per id through the call memo, a 404 that
  item's `null` and a failure that item's error. The list must declare `@maxItems`, and the field is
  weighed at it, `@cost(weight: "20") @listSize(assumedSize: 20)`, so `costLimit` still bounds the
  calls a document makes: `link-list-unbounded` drops one without, and `link-list-not-bindable` one
  binding a second list or a list to an `@list` operation.
- **`@inputHeader(operation, parameter)`**: an optional header taken as input of one operation, an
  argument of a query field or link and a field of a mutation's input. An `Idempotency-Key` belongs
  to the one write it protects, which the `/graphql` request's own headers cannot say. One naming no
  optional header of its operation is warned `input-header-ignored`.
- **`@json(target)`**: a projection as `JSON` the surface means, accepted in `graphql.tsp`, so it
  raises no `projected-as-json` and a spec can build under `warn-as-error` with `rest.tsp` free of
  GraphQL. A `#suppress` there could not reach the warning, which targets the type in `rest.tsp`.
  One on a type projected as a type of its own is warned `not-projected-as-json`.
- **A field's own description**, `#{ description: "..." }` after `@queryField`'s and
  `@mutationField`'s name and `@link`'s parameters, in place of the operation's doc comment, which is
  written for REST.
- **`extensions.operationId` on every field that calls a handler**, and on no other. Every field has a
  resolver, so graphql-js's `isDefaultResolver` cannot tell a tracer a handler call from a property
  read. The README's "Tracing" says which channels fire through Yoga, and how to have graphql-js
  execute so they do.
- The README's "Testing it": the `graphql` alias a project testing its server under vitest needs, or
  every request through Yoga answers `"Unexpected error."`.
- `typespec-http-graphql/package.json` is exported.

### Changed

- **A `@friendlyName` names its type**, a template's instances included, as `@typespec/openapi3` and
  `typespec-http-zod` name it.
- **A link may fill a parameter that narrows its property's type**: a `string` id fills a
  `@pattern(...) scalar TagId extends string` parameter, and the operation's Zod schema checks the
  value as the link resolves, `BAD_USER_INPUT` at the link where it breaks the pattern.
  `link-type-mismatch` says a list of values the parameter accepts binds too.
- **`handlersFor` is called once per context value**, when the first field calls a handler, not once
  per call.
- **The README's mount answers through `c.newResponse`**, so headers middleware set with `c.header()`
  before `/graphql`, a request id among them, reach its response as they reach a REST route's.
- `@listSize(assumedSize:)` reads `@maxValueExclusive`, and the bounds of the scalars a page size
  extends, as well as `@maxValue`.
- Requires `typespec-http-zod` `^0.34.0`, which writes every file in the order the spec declares it,
  so declaring or removing the GraphQL surface changes no byte another emitter writes, a link to an
  interface declared after its model included. The README's "Removing it" is graded on that spec too.

### Fixed

- **A connection resumed after a cursor partway into a page could not take `first` at the page
  size's `@maxValue`**: the page was asked for `first` plus the items skipped, past the maximum, and
  refused naming `first`. It is asked for no more than the maximum; the page then holds fewer than
  `first` items, as Relay allows, and its last edge goes on at the next page.
- **"Named after the first declared" was the first the checker filed.** A model declared first that
  names a later one files the later one ahead of the models between, so a type two members hold
  was named after the wrong one: `PaintTone` for `LampTone` where `Lamp` is declared first.
- **A warning about a type two services project is reported once**, at the declaration it is
  about: `projected-as-json` was raised once per service.

## [0.1.0] - 2026-10-20

The first release.

### Added

- `@queryField`, `@mutationField` and `@link`, in namespace `HttpGraphQL`: the GraphQL surface,
  declared in one `graphql.tsp`. They record only; every check runs when this emitter runs.
- `schema.graphql`: the SDL with its applied directives, checked with `buildSchema` and
  `validateSchema` before it is written.
- `graphql.gen.ts`: `createSchema(handlersFor, deps, extend?)`, whose resolvers call the handler
  object `typespec-hono`'s `registerRoutes` takes, validated by the same Zod schemas;
  `GraphQLOperations<C>`, identical per operation to `typespec-hono`'s `Operations<C>`; and
  `GraphQLTypes` for the escape hatch.
- `graphql-runtime.gen.ts`: the runtime, copied beside the generated code; it imports only `graphql`.
- Relay connections from TypeSpec's core paging decorators, with an opaque cursor on every edge
  that a client can resume after, `startCursor` and `endCursor` the first and last edges', a
  negative `first` refused and a page longer than `first` cut to it.
- Errors as data: a mutation always answers a `<Name>Result` union, so a REST operation's first
  error response adds a member rather than breaking the field; a `default`, `4XX` or `5XX` response
  is decided by the status the handler answers; a bodyless member carries `success`.
- Named models two or more output types share become `<Name>Interface`, implemented by each.
- A `@discriminator` base becomes `<Name>Interface`, implemented by the base's own object type and by
  each subtype, so a value that is no valid instance of the subtype its discriminator names, or names
  none, answers as the base, as REST serves it: the subtype's own validator decides, imported by the
  name the library publishes for the type. A base under a base is an interface implementing its
  parent's, and the discriminator has the type its base declares on every member. A base is
  resolved by the wire key its discriminator names, even where its own declaration of that property
  is sent under another `@encodedName`.
- An anonymous model or union is named after the model its type was declared in, and the member,
  with its own view suffix as input: an inherited, spread or `is`-copied member has one name
  whichever operation reaches it first, and a member a visibility transform reshapes is the copying
  model's. One that members of two declared models hold, through an `alias` or by inheriting from an
  instance whose composed name leaves out an argument, is named after the first declared, and
  warned `anonymous-type-shared`, so a field added to `graphql.tsp` renames nothing.
- A model's inherited properties are flattened by wire key, as openapi3's `allOf` composes them, so a
  redeclaration under another `@encodedName` is a field of its own.
- Built on `typespec-http-zod` 0.33.0, graded against `typespec-hono` 0.30.0. A request reads a model
  as `@typespec/openapi3` does: a body differing from its model only by read-only properties is the
  model itself, those properties optional where openapi3 publishes OpenAPI 3.0, its default, and
  required as declared at 3.1. An encoded list parameter reaches the handler as the document
  publishes it, on REST and GraphQL alike. Two inputs under one key are read from the library's
  `sharedInputKeys`, and a body declared `void` from its media types.
- Arguments in their wire form, `@encode` included, and a date-time header with none as the RFC 7231
  HTTP-date TypeSpec sends; scalar defaults stated in the schema;
  `#deprecated` on arguments; a required `| null` input that GraphQL lets a client omit reaches the
  handler as the `null` the operation requires; Zod issues with the argument path a client wrote
  beside the REST route's.
- IBM cost directives in the SDL and in field `extensions`, valid by the specification's §9, and
  enforced by the runtime: `operationCost`, `costLimit`, and the validation rules `depthLimit` and
  `aliasLimit`.
- A per-request call memo for links, forgotten when a mutation starts.
- Nineteen diagnostics, every one a warning, among them `transport-argument` for a credential that
  stays an argument.
- Runs on graphql-js 17 through its current API alone: no deprecated API in the code or what it
  emits, and no deprecated package in the tree, each checked by a gate shown able to fail. graphql 16
  is not supported, since it offers only the scalar API 17 deprecates.
