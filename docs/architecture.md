# Architecture

What each module owns, and the boundaries `test/architecture/architecture.test.ts` pins. design.md's
module table is the source; this is that table as built.

## Layers

```
                       lib.ts            options, diagnostics, PACKAGE_NAME, state keys
                       decorators.ts     record @queryField, @mutationField, @link, @inputHeader, @json
                          |
   DERIVE (read the program)                        RENDER (produce text)       CONSUMER (copied out)
     surface.ts      declarations -> checked surface   handlers.ts                 runtime.ts
     types.ts        TypeSpec types -> TypeDefs        render.ts                     scalars, armFor,
     inputs.ts       arguments, input objects          sdl.ts                        resolverFor, memo,
     connections.ts  paging decorators -> plan           |                           connections, errors
     results.ts      arms -> projections                 |
     plan.ts         one service's SchemaPlan  ----- model.ts (vocabulary, no logic) --+
     names.ts        GraphQL names (pure)
     coexistence.ts  peers writing one directory
                          \                               /
                                 emitter.ts   orchestrates, reports, asserts, writes
```

## Modules

| module           | owns                                                                                                                                | may reach                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `index.ts`       | the public API: `typespec-http-zod`'s re-exported, `$onEmit`, `$lib`, `$decorators`, `graphqlRequestsOf`                            | the modules it re-exports                                                                |
| `tsp-index.ts`   | what TypeSpec loads: `$lib` and `$decorators`                                                                                       | `lib.ts`, `decorators.ts`                                                                |
| `lib.ts`         | the options (the library's, forwarded unchanged), the diagnostics, the package name, the state keys                                 | the compiler, the library                                                                |
| `decorators.ts`  | `$queryField`, `$mutationField`, `$link`, which record and check nothing; their accessors                                           | the compiler, `lib.ts`                                                                   |
| `surface.ts`     | the declarations a service owns, every check in design.md, and the dropped ones with their reasons                                  | the compiler and its typekit, `@typespec/http`, the library, `decorators.ts`, `names.ts` |
| `names.ts`       | GraphQL names, by upstream's pipeline; reason phrases; `NameBook`                                                                   | `change-case` only                                                                       |
| `model.ts`       | the plan's vocabulary: `TypeRef`, `TypeDef`, field and call plans                                                                   | the library's types                                                                      |
| `types.ts`       | TypeSpec types as GraphQL types; visibility variants; scalars                                                                       | the compiler, `@typespec/http`                                                           |
| `inputs.ts`      | arguments, input objects, header mechanics, wire keys                                                                               | the compiler, `@typespec/http`, the library's types                                      |
| `connections.ts` | the five core paging decorators as a connection plan, or why an operation is not one                                                | the compiler                                                                             |
| `results.ts`     | declared arms as query and mutation results: members, wrappers, codes                                                               | the library                                                                              |
| `plan.ts`        | one service's `SchemaPlan`, from its surface                                                                                        | the four modules above                                                                   |
| `handlers.ts`    | the text of `GraphQLOperations<C>`: each handler's input and result types                                                           | `model.ts`, the library's types                                                          |
| `render.ts`      | the text of `graphql.gen.ts`                                                                                                        | `model.ts`, the library's types                                                          |
| `sdl.ts`         | `schema.graphql`, with applied directives, checked by `buildSchema` and `validateSchema`                                            | `model.ts`, `graphql`                                                                    |
| `coexistence.ts` | peer emitters writing one directory with different library options                                                                  | the compiler                                                                             |
| `runtime.ts`     | what emitted code imports at run time                                                                                               | **only `graphql` values and `zod` types**                                                |
| `requests.ts`    | what was planned, as requests: a document per root field, and a REST request's values as its variables, read by `graphqlRequestsOf` | `model.ts`, `names.ts`, the compiler's and the library's types                           |
| `emitter.ts`     | orchestration, and `emitted + dropped === declared` for every service; records each plan for `requests.ts`                          | everything above                                                                         |

## The rules that are enforced rather than intended

**`runtime.ts` reaches only `graphql` and `zod`, and Zod only through `import type`.** It is read off
disk and written verbatim beside the consumer's code as `graphql-runtime.gen.ts`, so anything it
imports becomes an import in their build. Under `verbatimModuleSyntax`, `import { type X } from "zod"`
still loads Zod at run time; only `import type` is erased.

**And it imports no Node builtin**, a separate arm because the closure that grades the first rule
skips `node:` specifiers so that `emitter.ts` may read the filesystem. In a Worker without
`nodejs_compat`, `node:fs` is `No such module "node:fs"`. `test/socket/` is the second half of this
rule and the only one that runs anything: it bundles the documented mount with wrangler and serves it
on workerd with `compatibility_flags: []`.

**The renderers never reach the TypeSpec compiler.** `model.ts`, `render.ts`, `sdl.ts` and
`handlers.ts` write text from the plan; the derivation modules read the program. Neither needs the
other's dependencies, and keeping them apart means a change to how the program is read cannot change
how text is written.

**`names.ts` is pure**: `change-case` and nothing else. Reason phrases are a fixed table, so the names
of generated wrapper types and error codes do not depend on the Node version running the emitter.

**The decorators record and never check.** Every check runs in `surface.ts` or later, when this
emitter runs, so a mistake in `graphql.tsp` never stops another emitter.

**The package name is a literal in exactly one module**, `lib.ts`. `coexistence.ts` finds this emitter
in the compiler's options map by it; a drifted copy would find nothing and report no collision.

## The duplication that is deliberate, and what grades it

| duplicated                            | why it cannot be shared                                                                                     | what grades it                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ResponseArm`, `armFor`               | the runtime is copied into the consumer's output, and emitted output must never import a build-time package | `test/runtime/`, against `typespec-http-zod/runtime`'s own         |
| each handler's input and result types | emitted as text into a file that imports neither sibling                                                    | `test/agreement/agreement.test.ts`, by `Identical<>` per operation |

Both follow from emitted output having to be self-contained, and both are permanent.
