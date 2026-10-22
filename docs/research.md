# How other ecosystems generate GraphQL — research, 2026-10-13

The evidence behind `design.md`. Every claim here was read from a primary source: repository source,
official documentation or the npm registry. Claims marked **verified** were also checked by hand:
the quotation, the archive state and the PR merge date were re-read from the source.

## The question

How do other generators build GraphQL from a contract, in other stacks and languages? The design
has to be idiomatic and stay on the beaten track, and it must still stand if either the REST
surface or the GraphQL surface is removed.

## TypeSpec itself

- **`@typespec/graphql` 0.4.0** (Microsoft and Pinterest; npm, 2026-10-08):
  - **Output:** SDL only, with no resolvers, no server code and no roadmap for either.
  - **Decorators** (namespace `TypeSpec.GraphQL`):
    - `@query`, `@mutation` and `@subscription` (no arguments);
    - `@operationFields(Model, ...ops)`, where the field name is the operation name and every
      operation parameter becomes an argument;
    - `@schema`, `@graphqlInterface`, `@compose` and `@specifiedBy`;
    - `scalar ID`.
  - **Selection:** only operations carrying a kind decorator reach the root types.
  - **What it ignores:** it does not read `@key`, the paging decorators, `@error` or
    `@encodedName`.
  - **Dependencies:** it is built on Alloy, `@typespec/emitter-framework` and
    `@typespec/mutator-framework`.
  - **Tried:** it would not load as published (an `@alloy-js/core` 0.25.0 vs 0.24.1 clash).
    With one version forced, its emitter ran out of memory (4 GB) on a three-operation spec.
- **Its design review, microsoft/typespec#4933** (verified):
  - It considered inferring Query/Mutation from HTTP verbs and dropped it.
  - bterlson: "I'm a fan of doing the strict emit route only … adding support for an additional
    protocol requires decorators sometimes (this is def. true for e.g. protobuf)."
  - steverice: "If we infer by default that any HTTP operation should be placed at the top level
    of a root operation type, that goes against good GraphQL schema design."
- **`@typespec/protobuf`:**
  - its decorators live in their own namespace (`TypeSpec.Protobuf`);
  - its only peer dependency is the compiler;
  - it selects operations explicitly with `@Protobuf.service`.
- **Core decorators that belong to no protocol** (compiler 1.17, `namespace TypeSpec`):
  - `@key` and `@error`;
  - `@list`, `@pageItems`, `@continuationToken`, `@pageSize`, `@offset` and `@nextLink`;
  - Lifecycle visibility, `@doc`, `#deprecated` and `@encodedName`.
- **Keeping one surface's settings in their own file:** Azure's TypeSpec convention is a `client.tsp`
  applied with `@@`: "DON'T import or use `@azure-tools/typespec-client-generator-core` in other
  files aside from client.tsp".
- **The official server emitters** (`http-server-js`, `http-server-csharp`) put domain values on
  the success path. Neither is protocol-neutral.

## IDL-first: protobuf, Smithy and Google

| Project                                | Query/Mutation                                                                                                               | Edges                                               | Paging            | Errors                       | Calls the implementation                 | Status             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------- | ---------------------------- | ---------------------------------------- | ------------------ |
| Google Rejoiner (Java)                 | explicit `@Query`/`@Mutation` in Java modules                                                                                | `@SchemaModification(addField, onType)` in code     | Relay `Node` only | top-level                    | arbitrary code, network stubs            | archived 2024      |
| ysugimoto/grpc-graphql-gateway (Go)    | explicit `(graphql.schema).type` per RPC; unannotated RPCs are skipped                                                       | `(graphql.field).resolver` names an RPC             | none              | top-level, `extensions.code` | network proxy                            | v0.24.0, 2025      |
| danielvladco/go-proto-gql              | every RPC; defaults to Mutation unless marked                                                                                | none                                                | none              | gqlgen default               | in-process `XServer` by default          | dormant since 2022 |
| proto-graphql / protoc-gen-pothos (TS) | **explicit `(graphql.rpc).operation`; switched from an idempotency rule to explicit opt-in on 2026-07-14** (verified, PR #9) | `batch` option; parent→request key mapping designed | none              | top-level, `extensions.code` | Connect transport, in-process or remote  | active             |
| Google `google.api.http` / AIP         | HTTP rules are per-RPC annotations, or out-of-band service-config YAML                                                       | `resource_reference` (no GraphQL tool reads it)     | `page_token`      | `google.rpc.Status`          | grpc-gateway calls the server in-process | —                  |
| smithy4s-caliban                       | `@readonly` → Query; no GraphQL traits                                                                                       | none                                                | none              | none                         | the same in-process service              | stale              |

Nothing in this family generates Relay connections, and nobody infers edges from neutral references.

## REST/OpenAPI → GraphQL

| Tool                                | Query/Mutation                                             | Edges                                                                                | Errors                                     | Status                             |
| ----------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------- |
| IBM openapi-to-graphql              | GET → Query, with an override                              | OpenAPI `links` only; one study found links in 3 of 1,500+ specs                     | top-level, details in `extensions`         | **archived 2026-06-02** (verified) |
| GraphQL Mesh / `@omnigraph/openapi` | GET → Query, with an override                              | OAS `links`, HATEOAS, or `@resolveTo` in config (with `keyField`/`keysArg` batching) | top-level by default; status unions opt-in | active                             |
| Apollo Connectors                   | by where the field is written in hand-written SDL          | `$this`, `entity: true`, `$batch`                                                    | top-level `CONNECTOR_FETCH`                | GA 2025                            |
| StepZen / IBM API Connect           | by schema position                                         | `@materializer(query, arguments: [{name, field}])`                                   | —                                          | active                             |
| Grafbase, WunderGraph               | hand-written SDL with REST bindings; OpenAPI paths removed | —                                                                                    | —                                          | —                                  |

- **Apollo** (verified): "at Apollo, we generally discourage the use of schema autogeneration tools …
  they lead you in precisely the opposite direction of taking a client-first approach to schema
  design."
- **graphql.org:** "prefer building a GraphQL schema that describes how clients use the data,
  rather than mirroring the legacy database schema." It also says every entry point should share
  one business-logic layer.
- **Direction of travel:** away from full generation, toward hand-authored SDL annotated with
  bindings. Every tool here proxies over the network, because none of them owns the backend.

## Model-first: one model behind REST and GraphQL

| System                         | Edges declared by                                                                      | Root naming                                     | Paging                             | Errors                                             | Shared execution                                            | One surface off       |
| ------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- | --------------------- |
| PostGraphile v5                | foreign keys, plus smart tags (which can live in a separate `postgraphile.tags.json5`) | `allUsers`, `userById`, `createUser`            | Relay                              | top-level                                          | GraphQL only                                                | `@behavior`           |
| Microsoft Data API builder 2.1 | config `relationships` (source fields, target fields)                                  | `book_by_pk`, `books`, `createBook`             | `items`, `endCursor`               | top-level                                          | one engine behind REST and GraphQL                          | per entity and global |
| Hasura v2 / DDN                | FK or `manual_configuration`; `Relationship` objects                                   | `users`, `users_by_pk`, `insert_x`              | limit/offset; Relay at `/v1/relay` | top-level                                          | v2 builds REST **on** GraphQL, so GraphQL cannot be removed | DDN: by metadata      |
| Amplify Gen 2                  | `a.hasMany`/`a.belongsTo` with an explicit reference field                             | `getTodo`, `listTodos`, `createTodo`            | `nextToken`                        | `{data, errors}`                                   | GraphQL only                                                | `disableOperations`   |
| Supabase                       | foreign keys                                                                           | `blogCollection`, `blogByPk`                    | Relay                              | —                                                  | two engines read one catalogue                              | independent           |
| Strapi, Directus               | content model                                                                          | `restaurant`, `restaurants`, `createRestaurant` | Relay or `items`                   | —                                                  | one service layer                                           | `shadowCRUD`          |
| Netflix DGS                    | `@DgsData` and DataLoaders                                                             | hand-written                                    | `@connection` codegen              | top-level, errors-as-data left to the author       | —                                                           | —                     |
| Hot Chocolate                  | `[DataLoader]` and `[Parent]`                                                          | `GetUsersAsync` → `users`                       | Relay                              | **`[Error(typeof X)]` → a payload `errors` union** | —                                                           | —                     |

- **Edges are always declared:** by a foreign key, config or code, never by guessing from names.
- **Root names** are `user`/`users`/`createUser`, always with an explicit override.
- **Relay connections** are used wherever a stable cursor exists.
- **Generators put errors at the top level.** Typed errors as data come from **declared** errors
  (Hot Chocolate).
- **Dual-surface products share one service layer.** Layering one surface on the other (Hasura v2)
  makes it impossible to remove.

## What this package takes from it

| Finding                                                                   | Design consequence                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Explicit opt-in everywhere that has matured                               | The surface is declared in `graphql.tsp`; nothing is projected automatically             |
| Protocol settings live in their own namespace and file                    | The decorators sit in namespace `HttpGraphQL`, applied with `@@` in one file             |
| Edges are a target plus a parameter binding                               | `@link(Parent, name, operation, #{ param: "property" })`                                 |
| Relay where a cursor exists; core paging decorators belong to no protocol | Connections are derived from `@list`, `@pageItems`, `@continuationToken` and `@pageSize` |
| Errors as data only for declared errors                                   | Mutation unions from declared `@error` arms; 404 → null on reads                         |
| One service layer behind every surface                                    | Resolvers call the same handler object as REST and MCP                                   |
| Generated schemas need an escape hatch                                    | `createSchema`'s `extend`                                                                |
| Upstream's emitter is unusable here (Alloy, 0.x, OOM)                     | Borrow its naming and scalar conventions, not its package                                |
