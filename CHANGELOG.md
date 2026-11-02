# Changelog

Every notable change to this package. The format follows Keep a Changelog, and the version follows
semantic versioning.

## [0.5.0] - 2026-11-02

A minor: a connection pages differently on `first: 0` and beneath a minimum page size, and refuses
another connection's cursor, an input type a model already names keeps that name, and a bounded list
states its bound. What regenerating changes, beside `graphql-runtime.gen.ts`, the runtime copy:

- `graphql.gen.ts`, for a connection whose page size declares a minimum: its call carries it.
- `schema.graphql` and `graphql.gen.ts`, for a list bounded by `@maxItems`: `@listSize`, on an
  interface's field too, where every implementer's field states the same.
- Both, for a connection whose page size's bound is a fraction: its call carries the whole bound
  within it, and where that bound is a maximum and the page size has no default, the connection's
  `@listSize` carries it as `assumedSize`, as it does for a whole maximum.
- Both, for a model named as an input type, and for a field given a `weight`.

Measured over every fixture of this package's suite, 68 compiles, against 0.4.1 from npm: every
other file is what 0.4.1 writes. No fixture that compiles declares a fractional bound; a bookshop
declaring `@maxValue(10.5)` and `@minValueExclusive(2.5)` was compiled by both to measure that case.

### Fixed

- **`first: 0` answers no edge where the page size declares a minimum.** It was written to the page
  size as it is, so a page size declaring `@minValue(1)`, as a REST `limit` usually does, refused it
  as `BAD_USER_INPUT`, against Relay §4.4. The handler is now asked for one item past those skipped,
  the least that tells whether an edge follows.
- **No handler is asked for a page below the page size's minimum**, for `first: 0` or for a `first`
  beneath it, `first: 2` beside `@minValue(5)`: it is asked for the minimum, and the edges are cut to
  `first`, as Relay §4.4 asks. A fractional bound is the whole bound within it, `@minValue(2.5)`
  three items and `@maxValue(10.5)` ten, where it bounded nothing.
- **`after` refuses a cursor another connection issued.** A cursor held a backend token and a skip
  count, so a cursor from one connection given to another handed its handler the other list's token.
  A connection is its field's operation and every other argument and bound value, as Relay counts
  one, so a cursor of `books(tag: "scifi")` is refused by `books(tag: "poetry")`, as one of another
  operation is, and as a raw backend token already was: `BAD_USER_INPUT`, before any handler call.
  **A cursor issued by 0.4 or earlier is refused the same way**: a client paging across the upgrade
  is answered `BAD_USER_INPUT`, and starts again at the first page.
- **A cursor asks for no page past 2^31 - 1, the largest `first` GraphQL carries.** Resuming from a
  cursor asks for its skip plus `first`, and a cursor is unsigned, so where the page size declares
  no maximum a forged skip asked for a page of any size up to 2^53. A skip past 2^31 - 1 is now
  `BAD_USER_INPUT`, and no page past 2^31 - 1 is asked for. Where the page size declares a maximum,
  the page asked for stays within it, as in 0.4, whatever the skip; a skip past the maximum is taken,
  since a backend that answers a page longer than it was asked for issues one. Without a maximum, a
  forged cursor can still ask for a page of 2^31 - 1 items, which no cost limit counts, so bound
  every page size a client can reach.
- **Who may call is answered before a page's arguments are.** A bad cursor or a negative `first` was
  refused before `authorize` ran, so a caller who may not call heard what was wrong with its paging
  rather than `UNAUTHENTICATED` or `FORBIDDEN`.

### Added

- **`weight` on `@queryField`, `@mutationField` and `@link`**: the calls one call of the field
  makes, where its handler calls more than one backend. It multiplies the weight the field is given,
  so `costLimit` counts every call a document makes. A number written as GraphQL writes a Float, as
  `@cost(weight:)` takes one, and at least 0, this package's own rule; another, or one too small for
  a double, `"1e-400"`, is `invalid-weight`, and the declaration is dropped. A product past the
  largest double is that double, a Float GraphQL can write.
- **`@listSize(assumedSize: N)` on a list field bounded by `@maxItems(N)`**, its property's or its
  array type's (cost specification §8.1), so `typeCost` counts its items where it assumed it
  infinite, and `typeCostLimit` admits a document selecting it. An interface's field states it too,
  where every implementer's field states the same, so an analyser costing a selection on the
  interface finds it. In a list of lists that is the outer list's bound: `@listSize` has one size,
  so an inner list stays infinite.

### Changed

- **An input type whose model is named as one keeps the model's name**: `AuthorInput` is
  `AuthorInput`, not `AuthorInputInput`, as `@typespec/graphql` names it, wherever no other type owns
  that name; a model that is also an output type keeps the suffix on its input type, and so does each
  of two input types planned from one model. Where another model is named `AuthorInputInput`, the
  two collide as they did in 0.4, warned `graphql-name-collision`. The input types
  this renames are named in each variable definition that uses one, so a client document or a
  persisted query declaring `$author: AuthorInputInput!` fails validation once the schema is
  regenerated, and has to name `AuthorInput`. The name holds while the model is only an input: a read
  that later answers it makes it an output type too, and its input type `AuthorInputInput` again.
- **The README's mount on graphql-yoga 6**: Yoga's `requestId` takes the id the host's middleware
  set, so `/graphql` answers with the id the rest of the app logs, and on Node, with Yoga's execution
  cancellation, a client that goes away is answered without an error logged, and no further handler
  call is made for it. The mount's `app.onError` answers every other error as Hono's own handler
  does, keeping the headers middleware set. The examples are run on graphql-yoga 6.

## [0.4.1] - 2026-11-02

0.4.0 was tagged, and its release stopped before npm, so 0.4.1 is the first 0.4 published. Every file
this emitter writes is what 0.4.0 writes; `graphqlRequestsOf` is what changes.

### Fixed

- **A recursive union no longer stops `graphqlRequestsOf`.** A variant whose payload is the union it
  is a variant of, as a rule over another rule is, was selected without end, and the call overflowed
  the stack, so a tool reading the requests, as typespec-postman does, wrote none of them. A
  recursive type is now cut where `@graphql-tools/utils`' `buildOperationNodeForField` cuts one by
  default: a payload whose type is an object the selection is already inside a field of is left out,
  and so is a union's member that is one. The test suite holds the selection to that function's own
  document. 0.3 had this too.
- **`resultPathsOf` walks a list at the root.** A query answering `Book[]` named `["books", "id"]`
  for `["id"]`, a path no answer has, and nothing for `["0", "id"]`. The body's own index now comes
  first, as its array has it.
- **`resultPathsOf` finds a value below a union nested in the answer**, as a create answering a
  discriminated union beside a problem has one, where every member of that union holds the value
  under one response name. A value its members hold under two names, or that one of them lacks, has
  no path, since the path cannot name the member.
- The README's `createBook` document is the one its surface writes, abridged, and the documentation
  suite now holds it to that.

## [0.4.0] - 2026-11-01

A minor: `graphqlRequestsOf` publishes a new member, `resultPathsOf`, and writes other documents
where a union's members cannot share a field's name. Every file this emitter writes is what 0.3.1
writes.

### Fixed

- **`graphqlRequestsOf` writes a document the schema accepts where a union's members share a field
  name with another response shape.** A book's `status` enum beside a problem's `status: Int!`, or a
  nullable `title` beside a problem's `title: String!`, were selected under one response name in two
  fragments, which GraphQL refuses (spec §5.3.2): `Fields "status" conflict because they return
conflicting types "BookStatus!" and "Int!"`. Such a field is now aliased.
  - The first field under a name keeps it, and a later one is compared with that first one, never
    with the last one written, as Apollo Federation's query planner decides. Two objects answering
    under one name have their selections compared below them.
  - The alias is spelled as `@graphql-tools/utils` spells one, the field's name and its type with
    `!` as `NonNull`, `[` as `List` and `]` dropped: `statusIntNonNull: status`.
  - An alias never takes the name another field of the set is selected by; `__alias_<n>` follows it
    where it would.
- **A link is never selected as a variant's payload.** A discriminated variant whose only field
  beside the discriminator was a link had that link selected, so the request called a second handler.

### Added

- **`GraphQLRequest.resultPathsOf(wire)`**: where each success member of a field's answer holds a
  value of the REST response's body, by typename, the path below `data` with any alias in it.
  typespec-postman 0.8.0 reads a created id out of a create mutation's answer with it.

Requires `typespec-http-zod` `^0.34.0`, as 0.3 does.

## [0.3.1] - 2026-10-22

Fixes to 0.3.0's batched links, links chosen by a kind and `graphqlRequestsOf`. For a spec that uses
neither kind of link, every file is what 0.3.0 writes but `graphql-runtime.gen.ts`, the runtime copy.

### Fixed

- **Two batched links to one batch read are batched apart.** They shared one batch and one memo
  entry, so a link matching items by another `key`, or in another `items` list, could answer the other
  link's item for the same value.
- **A batched link filling any other parameter from a list is `link-batch-invalid`.** Its list's
  values were sent as the batch's ids, and the parameter left unset, so every call was refused.
- **The arms of a link chosen by a kind are compared by argument name**, so arms declaring the same
  arguments in another order are one field rather than dropped, **and by each argument's type down
  to an enum's values**: two arms whose anonymous enums share a name but not their values were one
  field accepting values one arm refuses, and are now `link-arms-conflict`.
- **A link chosen by a kind is deprecated where every arm's read is**, with their reasons. It never
  was.
- **`graphqlRequestsOf` writes documents the schema accepts for every root field.**
  - A union member with no leaf field of its own is selected by its `__typename`, not by an empty
    fragment that did not parse.
  - A connection of scalars or enums selects `nodes` alone.
  - A discriminated union's payload is selected under its envelope, and all its members are the
    field's success typenames, which were empty.

Requires `typespec-http-zod` `^0.34.0`, as 0.2 does. For a spec that uses neither new option, every
file is what 0.2.1 writes but `graphql-runtime.gen.ts`, the copy of this package's runtime, which
carries the new runtime.

### Added

- **A link chosen by a kind.** Several `@link`s of one model sharing a name, each with `when`, are
  one field that calls only the operation the parent's kind names: a reference whose target depends
  on another property, a review of a book or of an author, costs one call per parent rather than
  one per possible target.

  ```tsp
  @@link(Review, "subject", Books.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });
  @@link(Review, "subject", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });
  ```

  `subject` is the union `ReviewSubject = Book | Author`, a union even with one arm so that a second
  arm adds a member rather than changing the type. A kind no arm names is `null` and calls nothing.
  The field carries `extensions.operationIds`, every operation it may call. Arms that cannot be one
  field are dropped with `link-arms-conflict`, a `when` the property cannot hold with
  `link-when-mismatch`, and an arm answering no object type with `link-arm-not-object`.

- **Batched links.** `batch` on a link to a batch read, an operation taking a list of ids in its query
  as AIP-231's `BatchGet` does, sends the distinct values of every parent a document reaches at once
  in one call, and answers each field the item whose `key` is its value:

  ```tsp
  @@link(Book, "author", Authors.batchGet, #{ ids: "author_id" }, #{ batch: #{ key: "id" } });
  ```

  A page of books reads its authors in one call, and their publishers in one more, where the call
  memo made one call per distinct id. The values are sent in chunks of the batch parameter's
  `@maxItems`; a value the parameter refuses is that field's `BAD_USER_INPUT`; a 404 for several
  values sends each again alone, so one missing id blanks no other field. A batch waits for its wave
  with `setImmediate`, or `setTimeout` where there is none, as on Workers. The field is weighed at
  the calls its values can take, and the retries a 404 can cost, so `costLimit` still bounds the
  calls a document makes. `link-batch-invalid` drops a link to an operation that is no batch read of
  its values. The two compose: an arm of a link chosen by a kind may be batched.

- **`graphqlRequestsOf(program)`**: once this emitter has run in a compile, one request per root field
  it served, per service: a document the schema accepts, every argument a variable and the result
  selected to its leaf fields, and `variables(values)`, which turns a REST request's values into that
  document's variables, so the handler receives what the REST request would hand it. A tool writing
  requests for the HTTP surface writes them for this one from it; typespec-postman 0.6.0 does.

## [0.2.1] - 2026-10-22

A patch: no schema, resolver, type or emitted code changes.

### Changed

- **Comments, documentation and test fixtures are rewritten in neutral terms.** The comments in
  `graphql-runtime.gen.ts`, this package's runtime copied beside the generated code, are reworded,
  so regenerated output differs in those comments and nowhere else.

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
