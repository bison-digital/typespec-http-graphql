# `expected.graphql`: where it comes from

`expected.graphql` is the GraphQL schema a person would write by hand for the domain `rest.tsp`
declares. It is the oracle `idiom.test.ts` grades the emitter's schema against, so it must never be
written from the emitter's output.

**Every edit to it is recorded below, with what changed and on what authority**, and
`idiom.test.ts` holds the file to the digest at the end. An edit that is not recorded fails the
suite. An unrecorded edit would let the oracle drift toward the emitter: an early revision changed the
file's input shape to match a rule the emitter already followed, and the table records that
decision.

## Sources

Each choice in the file rests on one of these, and none on what the emitter writes:

| choice                                                                                                            | authority                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| types PascalCase, fields and arguments camelCase, enum values CONSTANT_CASE                                       | graphql.org's naming conventions; the GitHub and Shopify public schemas                                                                              |
| a field's name is its REST property's JSON name in camelCase                                                      | design.md § Names: a field reads the same in REST and GraphQL                                                                                        |
| root fields and links nullable                                                                                    | graphql.org Best Practices § Nullability; GitHub's and Shopify's root fields                                                                         |
| `Connection { edges, nodes, pageInfo }`, `Edge { node, cursor: String! }`, `PageInfo`                             | relay.dev/graphql/connections.htm §§3, 5; `nodes` from GitHub's and PostGraphile's schemas                                                           |
| `first: Int = 50, after: String`                                                                                  | the Relay connection arguments (§4); the default is `PageRequest.limit`'s own, so a client sees it                                                   |
| a mutation takes `input: <Name>Input!`                                                                            | Relay's mutation convention                                                                                                                          |
| a mutation answers a `<Name>Result` union of its outcomes, errors as members                                      | graphql.org's error-handling guidance ("business logic errors belong in the schema"); Apollo's "errors as data"                                      |
| a bodyless outcome is a type with `success: Boolean!`, no HTTP status                                             | a GraphQL object type needs a field, and HTTP is not the client's vocabulary (design.md § Results)                                                   |
| the problem types implement `ProblemFieldsInterface`                                                              | the shared-error-interface pattern (_Production Ready GraphQL_; the "errors as unions" pattern); upstream TypeSpec's `Interface` suffix              |
| `@cost` on every root field and link, `@listSize` on connections, `assumedSize` only where `first` has no default | ibm.github.io/graphql-specs/cost-spec.html, §7, §8 and §9.2.4                                                                                        |
| dates `UTCDateTime` with `@specifiedBy`                                                                           | scalars.graphql.org, through upstream `@typespec/graphql`'s scalar mappings                                                                          |
| identifiers `String!`, not `ID!`                                                                                  | design.md § Considered and decided against: a path parameter cannot be proven a key, and `ID` beside `String` arguments refuses a client's variables |

## Changes

| date       | change                                                                                                                                                | why                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-14 | written                                                                                                                                               | the first hand-written schema; its input shape was revised there to match the emitter, as the paragraph above records                                                                                                                                                                                                                                         |
| 2026-10-14 | `first: Int = 50` on every connection                                                                                                                 | the page size's default is stated in the schema, as design.md now requires                                                                                                                                                                                                                                                                                    |
| 2026-10-14 | `cursor: String!` on every edge                                                                                                                       | relay.dev §3.1: every edge has a cursor                                                                                                                                                                                                                                                                                                                       |
| 2026-10-14 | `ProblemFieldsInterface`, implemented by the three problem types; `success: Boolean!` on `DeleteBookNoContent`; `assumedSize: 50` on each `@listSize` | a client selects the problem fields across a result union's members; no HTTP status in a type; a cost analysis bounds an unsliced connection. `rest.tsp`'s `ProblemFields` became a named model so it has a name an interface can take                                                                                                                        |
| 2026-10-14 | `assumedSize: 50` removed from each `@listSize` again                                                                                                 | the cost specification allows `assumedSize` beside `slicingArguments` only where no slicing argument has a default (§9.2.4), and reads `first`'s default, `= 50`, as if the query had sent it (§8.2). The row above added it on a misreading of the same specification; `test/idiom/cost-directives.ts` now grades §9 over every emitted schema and this file |
| 2026-10-22 | every type, field, argument and enum value renamed to a bookshop's: publishers, authors, editors, books and editions                                  | `rest.tsp` was rewritten in a bookshop's vocabulary with its shapes unchanged (nesting, nullability, enums, connections, mutations and error arms), and this file renamed by the same mapping, not from emitted output                                                                                                                                        |

## Digest

`sha256 cab22010a23257491bdd50e3813aeafa02eeb5901468c6a850cfe5612b87171a`
