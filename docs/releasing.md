# Releasing

This package depends on `typespec-http-zod` **through the registry**, by version range, and is used
beside `typespec-hono` built on the same library minor. The pair a consumer actually gets,
`pnpm add -D typespec-http-graphql` pulling the library transitively, is a resolution the test
suite never performs: it installs the versions its lockfile names.

## What each release names

| this package | `typespec-http-zod` | beside `typespec-hono` | `@typespec/*` | `graphql` |
| ------------ | ------------------- | ---------------------- | ------------- | --------- |
| 0.1.0        | `^0.33.0`           | 0.30.0                 | 1.15 or later | 17        |
| 0.2.0        | `^0.34.0`           | 0.31.0                 | 1.15 or later | 17        |
| 0.3.0        | `^0.34.0`           | 0.31.1                 | 1.15 or later | 17        |
| 0.3.1        | `^0.34.0`           | 0.31.1                 | 1.15 or later | 17        |
| 0.4.0        | `^0.34.0`           | 0.31.1                 | 1.15 or later | 17        |
| 0.4.1        | `^0.34.0`           | 0.31.1                 | 1.15 or later | 17        |
| 0.5.0        | `^0.34.0`           | 0.31.1                 | 1.15 or later | 17        |

A new library minor is a new row: `^0.34.0` does not reach 0.35.0. Move this package's range in the
same round as `typespec-hono`'s, so a consumer installs one copy of the library for both surfaces.

## Rehearse against a local registry, not against tarballs

`pnpm pack` and a `file:` dependency is quicker and is **not** the same test: it skips resolving this
package by its range. `typespec-http-mcp`'s `docs/releasing.md` has the method: publish to a
verdaccio registry at the release version with the real ranges, install into an empty directory,
check what resolved, compile, type-check a hand-written consumer, serve it, and keep a control that
goes red. Record each rehearsal's proof here, under its version, so a later one is compared rather
than merely repeated.

### `0.2.0`, rehearsed with `typespec-http-zod` 0.34.0 and `typespec-hono` 0.31.0

The five packages of the round were published to the rehearsal registry at their release versions,
this one naming `"typespec-http-zod": "^0.34.0"`, and installed into an empty directory with
`typespec-hono`, `typespec-postman` and `typespec-http-mcp`: one `typespec-http-zod@0.34.0`, deduped
under all four, `zod@4.6.5`, `graphql@17.0.2`. There, against a hand-written consumer:

| step                                                                                        | result                                                                                                          |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tsp compile . --warn-as-error`, with `@json` and `@inputHeader` in `graphql.tsp`           | exit 0                                                                                                          |
| a Shop spec with and without `graphql.tsp`, a link to an interface declared after its model | `app.gen.ts`, `schemas.gen.ts`, the document and the collection the same; routes `Status`, `Widgets`, `Gadgets` |
| Field Cost through `nodes` and `edges`; Type Cost                                           | 11 and 23; 20 and 32                                                                                            |
| a resume at the page size's maximum                                                         | one handler call, no error                                                                                      |
| the README's mount behind a request-id middleware                                           | the header kept on 200 and on a malformed body's 400                                                            |
| graphql 17's tracing channels through Yoga, then with `useEngine`                           | `parse`, `validate`; then `execute` and 17 `resolve`                                                            |
| a consumer's vitest through Yoga, without the README's alias, then with it                  | the realm error; a pass                                                                                         |
| this package's suite against the rehearsal packages                                         | 1,280 passed, removability included                                                                             |

### `0.3.0`, rehearsed with `typespec-http-zod` 0.34.0 and `typespec-hono` 0.31.1

This package was published to the rehearsal registry at 0.3.0, naming `"typespec-http-zod": "^0.34.0"`,
and installed into an empty directory with `typespec-hono` 0.31.1: one `typespec-http-zod@0.34.0`
under both, `zod@4.6.5`, `graphql@17.0.2`, `graphql-yoga@5.24.6`. There, a bookshop whose books link
their author and their four editors, and authors their publisher, through batch reads, the authors'
`ids` under `@maxItems(50)`, and whose reviews link a book or an author by `subject_type`:

| step                                                                                                              | result                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `tsp compile . --warn-as-error`                                                                                   | exit 0                                                                                       |
| fifty books, their authors and the authors' publishers, through Yoga as "Node" mounts it                          | `Books_list`, one `Authors_batchGet` of 50 ids, one `Publishers_batchGet`                    |
| the same books' authors and editors: 250 distinct ids                                                             | five `Authors_batchGet` of 50                                                                |
| three books, one author unknown, the batch read answering 404 for it                                              | one call of 3, then three of 1; authors `a1`, `null`, `a3`                                   |
| four reviews, of a book, a book, an author and a series                                                           | `Books_read` twice, `Authors_read` once; `Book`, `Book`, `Author`, `null`                    |
| Field Cost of `book { author }`, of `book { editors }`, and of both with the publisher                            | 3, 6 and 9                                                                                   |
| `graphqlRequestsOf` on a program not yet emitted, then after `compile` through the API                            | `undefined`; four requests, every document valid against `schema.graphql`                    |
| `variables` for `book` and for `createBook`                                                                       | `{ id: "b1" }`; `{ input: { id, title, authorId } }`                                         |
| `tsc` over a hand-written consumer, `strict` + `exactOptionalPropertyTypes`, one handler object for both surfaces | exit 0                                                                                       |
| the 49 fixtures under `test/` that use neither `when` nor `batch`, compiled by 0.2.1 and by 0.3.0                 | 143 files and every diagnostic the same; `graphql-runtime.gen.ts` the new runtime, as copied |
| this package's suite                                                                                              | 1,368 passed                                                                                 |

**And its controls.** The same page with the author link unbatched makes 50 `Authors_read` calls. The
consumer with an author lacking `publisher_id` fails with two `TS2322`, and restored from a byte copy,
`cmp` clean, passes again.

### `0.3.1`, rehearsed the same way

Published to the rehearsal registry at 0.3.1, naming `"typespec-http-zod": "^0.34.0"`, and installed
into an empty directory with `typespec-hono` 0.31.1: one `typespec-http-zod@0.34.0` under both. The
0.3.0 bookshop gave every result in the table above again, the consumer's `tsc` exit 0. Then the specs
0.3.1 fixes, each against the installed package:

| step                                                                                    | result                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| a batched link whose list fills another parameter                                       | `link-batch-invalid`, the list and the parameter named              |
| arms whose anonymous enums share a name but not their values                            | `link-arms-conflict` on both                                        |
| every root field of five specs with result unions, envelopes and connections of scalars | each document valid; a discriminated union's every member a success |
| two batched links to one batch read, one by `id`, one by `handle`, one value for both   | each its own author, in two calls                                   |

### `0.4.0`, rehearsed with `typespec-postman` 0.8.0

Published to the rehearsal registry at 0.4.0, naming `"typespec-http-zod": "^0.34.0"`, with
`typespec-postman` 0.8.0 naming it `^0.4.0`, and installed into an empty directory with
`typespec-hono` 0.31.1: one `typespec-http-zod@0.34.1`, deduped under both, `graphql@17.0.2`,
`graphql-yoga@6.0.0`. There, a bookshop whose create answers the book, whose `status` is an enum, or
a problem whose `status` is an `Int!`:

| step                                                                                                | result                                                                             |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `tsp compile .` with `@typespec/openapi3`, this package, `typespec-hono` and `typespec-postman`     | exit 0                                                                             |
| every document `graphqlRequestsOf` wrote, through graphql-js `validate`                             | none refused; with 0.3.1 from npm, `createBook` is, `Fields "status" conflict`     |
| every fixture under `test/`, compiled by 0.3.1 from npm and by the rehearsal 0.4.0                  | 217 files the same byte for byte, and the same diagnostics, for each of 64 entries |
| the collection run by the Postman CLI against the generated server, which refuses a duplicate title | exit 0, every assertion passing; `createBook` reads `bookId` out of its answer     |

### `0.4.1`, rehearsed with `typespec-postman` 0.8.0

0.4.0's release stopped before npm, so 0.4.1 is rehearsed as the first 0.4 published.
Published to a fresh rehearsal registry at 0.4.1 with `typespec-postman` 0.8.0 naming `^0.4.0`, and
installed into an empty directory with `typespec-hono` 0.31.1, as 0.4.0 was:

| step                                                                                                | result                                                                                  |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| every document `graphqlRequestsOf` wrote for the bookshop, through graphql-js `validate`            | none refused                                                                            |
| every fixture under `test/`, compiled by the rehearsal 0.4.0 and 0.4.1                              | 217 files the same byte for byte, and the same diagnostics, for each of 63 entries      |
| the collection run by the Postman CLI against the generated server, which refuses a duplicate title | exit 0, 18 assertions passing                                                           |
| the same bookshop with no delete                                                                    | `graphql-create-repeated` on `Books.create`; the run fails at `createBook`, as it warns |
| pnpm, installing 0.4.1 beside `typespec-postman` 0.8.0                                              | no peer issue                                                                           |

### `0.5.0`, rehearsed with `typespec-postman` 0.9.0

Published to the rehearsal registry at 0.5.0, naming `"typespec-http-zod": "^0.34.0"`, with
`typespec-postman` 0.9.0 naming it `^0.4.1 || ^0.5.0`, and installed into an empty directory with
`typespec-hono` 0.31.1: one `typespec-http-zod@0.34.1`, deduped under both, `graphql@17.0.2`. There,
a bookshop whose `books` take a `tag`, weigh 2, and page by a size declaring `@minValue(1)
@maxValue(100)`; whose shelves page by one declaring `@minValue(5)`, and a catalog by a `float64`
declaring `@maxValue(10.5)`; with a list behind `@useAuth`, books carrying a bounded and an unbounded
list of tags, and a create taking `AuthorInput`s:

| step                                                                                                                  | result                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsp compile .` with this package, `typespec-hono` and `typespec-postman`                                             | exit 0; `input AuthorInput`, `tags: [Tag!]! @listSize(assumedSize: 10)`, `notes: [Tag!]!`                                                                                           |
| `tsc` over the generated files, `strict`, `exactOptionalPropertyTypes`, `noUnusedLocals`                              | exit 0                                                                                                                                                                              |
| `books(first: 0)`                                                                                                     | no edge, `hasNextPage: true`, an `endCursor`; the handler asked for `limit: 1`                                                                                                      |
| `shelves(first: 2)`, then `first: 2` after its `endCursor`                                                            | the first two shelves, the handler asked for `limit: 5`; then the third and fourth                                                                                                  |
| the `endCursor` of `books(tag: "scifi")`, given to `books(tag: "scifi", first: 3)`, `books(tag: "poetry")`, `authors` | the first asks its handler for the backend's token; the other two `BAD_USER_INPUT`, no handler called                                                                               |
| that connection's cursor forged to skip 100, then 101, past the page size's maximum                                   | the handler asked for `limit: 100` for each, no page past the maximum                                                                                                               |
| `catalog(first: 10)`, then `catalog(first: 11)`                                                                       | the handler asked for `limit: 10`; then `BAD_USER_INPUT`                                                                                                                            |
| the list behind `@useAuth`, unauthenticated, with `first: -1`, then with a cursor no connection issued                | `UNAUTHENTICATED` for each, no handler called                                                                                                                                       |
| Field Cost of `books(first: 2) { nodes { id } }`; Type Cost of the tags, then the notes                               | 3; 12, then `Infinity`                                                                                                                                                              |
| the same, installed with 0.4.1 from npm, the `weight` dropped                                                         | `first: 0` and `shelves(first: 2)` `BAD_USER_INPUT`; the scifi cursor taken by both others; `BAD_USER_INPUT` first behind `@useAuth`; the tags `Infinity`; `input AuthorInputInput` |
| every fixture under `test/`, compiled by 0.4.1 from npm and by the rehearsal 0.5.0                                    | 68 compiles; every file beyond the runtime copy the same but where the changelog says it moves                                                                                      |
| a bookshop declaring `@maxValue(10.5)` and `@minValueExclusive(2.5)` on `float64` page sizes, compiled by both        | `maximum: 10` and `minimum: 3` in the call, and `@listSize(assumedSize: 10)`, where 0.4.1 writes neither bound                                                                      |
| `typespec-postman` 0.9.0's own fixtures, with both emitters, under 0.4.1 and under 0.5.0                              | every collection the same byte for byte                                                                                                                                             |
| pnpm, installing 0.5.0 beside `typespec-postman` 0.9.0; beside 0.8.0                                                  | no peer issue; an unmet peer, 0.8.0 naming `^0.4.1`                                                                                                                                 |

## Release sequence

1. Four gates, each checked by **exit code**: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
   `pnpm test`. Where `src/` changed since the last mutation run, `pnpm test:mutation` too: a fresh
   run (delete `test/mutation/.out/`), every survivor killed or written as an equivalent.
2. The `CHANGELOG.md` section: `## [X.Y.Z] - YYYY-MM-DD`, in place of `Unreleased`. The release
   workflow publishes that section as the GitHub release's notes, and fails on a version without one.
3. Commit, `git tag vX.Y.Z`, `git push origin main`.
4. Push the tag **separately**: a lightweight tag does not travel with `--follow-tags`.
5. Confirm by SHA with `gh run list --json headSha,conclusion`, then with
   `npm view typespec-http-graphql version`. The registry lags the workflow by a minute; that is not a
   failure.
6. **Name the exact version wherever the release is announced.** pnpm 11 holds back a version newer
   than its minimum release age, so on the day of a release `pnpm add -D typespec-http-graphql`
   quietly installs the one before it. `pnpm add -D typespec-http-graphql@X.Y.Z` installs the release
   and lists it in `minimumReleaseAgeExclude`, with the `typespec-http-zod` it needs.
