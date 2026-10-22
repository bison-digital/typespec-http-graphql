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
