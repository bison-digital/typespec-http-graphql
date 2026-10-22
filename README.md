# typespec-http-graphql

A TypeSpec emitter for a **GraphQL surface declared in the spec**. It writes a graphql-js
`GraphQLSchema`, and its SDL, whose resolvers call the same `(ctx, input) => { status, body, headers }`
handlers a `typespec-hono` server calls, validated by the same Zod schemas `typespec-http-zod` writes.

**Nothing is inferred.** An operation is a GraphQL field because `graphql.tsp` says so, and two types
are linked because `graphql.tsp` names the operation that resolves the link. The emitter does the
mechanics:

- object, input, enum, interface and union types from your models;
- arguments and input objects from each operation's parameters;
- Relay connections from TypeSpec's core paging decorators;
- expected failures as typed data;
- cost hints;
- a resolver for every field, calling your handler.

It emits no server and no framework code. Any GraphQL-over-HTTP server can serve the schema; the
examples below mount GraphQL Yoga in Hono, on Node and on Cloudflare Workers.

## Install

Install it as a **devDependency**: nothing it emits imports it.

```sh
pnpm add -D typespec-http-graphql @typespec/compiler @typespec/http @typespec/openapi
pnpm add graphql zod
```

Install the three `@typespec` packages at one version, 1.15 or later. `graphql` 17 and `zod` (4.5 or
later) are peers: the emitted code imports them, so your application owns them. graphql 16 is not
supported: it offers only the scalar API graphql 17 deprecates, and nothing deprecated ships here.
Serve the schema with GraphQL Yoga on `@graphql-tools/utils` 12.1.0 or later, which
`@graphql-tools/executor` 2.0.5 requires: an earlier one hands a resolver an enum default's name
rather than its value
([ardatan/graphql-tools#8511](https://github.com/ardatan/graphql-tools/issues/8511)).

```yaml
# tspconfig.yaml
emit:
  - typespec-http-graphql
options:
  typespec-http-graphql:
    emitter-output-dir: "{project-root}/src/generated"
```

It runs `typespec-http-zod` and accepts every option that library accepts, unchanged, and adds
none of its own. Where another emitter writes the same directory, give both the same library
options or give each its own directory. Beside `typespec-hono`, install the release built on the
same `typespec-http-zod` minor, `typespec-hono` 0.30.0 for 0.33, so one copy of the library writes
the validators both surfaces use: with two, each surface validates by its own version, and each
copy reports the library's warnings again.

**The OpenAPI version `@typespec/openapi3` publishes decides how a request is read**, here as on the
REST route: its `openapi-versions` option, read whether or not openapi3 is emitted, and `3.0.0`
where it is unset. At 3.0 a request may leave out a read-only property (see
[Arguments and input](#arguments-and-input)), and typespec-http-zod refuses a `null` the 3.0
document cannot say, such as `Model | null`, `Enum | null` or `"a" | "b" | null`
(`unpublishable-null`). To declare a nullable object field, publish 3.1:

```yaml
options:
  "@typespec/openapi3":
    openapi-versions: ["3.1.0"]
```

## Declare the surface: `graphql.tsp`

One file says which operations are GraphQL fields, what they are called, and how types link:

```tsp
// The GraphQL surface. Delete this file, and its import in main.tsp, to drop GraphQL.
import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Bookshop;

@@queryField(Books.read, "book");
@@queryField(Books.list, "books");
@@queryField(Authors.read, "author");
@@mutationField(Books.create, "createBook");

@@link(Book, "author", Authors.read, #{ authorId: "author_id" });
@@link(Book, "editions", BookEditions.list, #{ bookId: "id" });
```

| decorator                                              | declares                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@queryField(operation, name)`                         | the root `Query` field `name`, resolved by `operation`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@mutationField(operation, name)`                      | the root `Mutation` field `name`, resolved by `operation`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@link(Model, name, operation, parameters?, options?)` | a field `name` on `Model`'s object type, resolved by `operation`. Each entry of `parameters` fills one of the operation's parameters from one of the model's properties, both named as TypeSpec declares them; every other parameter becomes an argument of the field. A property that is a list of values makes the field a list, one call per value. `options.when` chooses the link by a property's value, and `options.batch` calls a batch read for many parents at once (see [Links](#links)). |
| `@inputHeader(operation, parameter)`                   | the operation's optional header `parameter`, named as TypeSpec declares it, as input: an argument of a query field or link, a field of a mutation's input                                                                                                                                                                                                                                                                                                                                            |
| `@json(target)`                                        | that `target`, a model property, model, union, enum or scalar, is meant to be the `JSON` scalar: no `projected-as-json` warning for it                                                                                                                                                                                                                                                                                                                                                               |

- **Apply them with `@@`, in this one file**, so `rest.tsp` and your models stay free of GraphQL.
- **They are `queryField` and `mutationField`, not `query` and `mutation`**, because
  `@typespec/http` has an `@query` of its own.
- **A field's description is the operation's doc comment**, unless the declaration gives one of
  its own: `@@queryField(Products.read, "product", #{ description: "One product, or null." })`, and
  `@link`'s after its parameters. An operation's doc is written for REST, and may name a 404 a
  GraphQL client never sees or a query string it cannot send.
- **They only record.** Every check runs when this emitter runs, so a mistake here never stops
  another emitter. A failed check drops that one declaration with a warning; see
  [Diagnostics](#diagnostics).

## What it emits

Beside the library's `schemas.gen.ts`, for every service that declares a field:

| file                     | contents                                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.graphql`         | the SDL, with its applied directives (`@cost`, `@listSize`, `@deprecated`, `@specifiedBy`), checked with `buildSchema` and `validateSchema` before it is written. Publish it as you publish the OpenAPI document.                                   |
| `graphql.gen.ts`         | `createSchema`; the graphql-js type constructors, fields as thunks, so nothing parses SDL at start-up; `GraphQLOperations<C>`, the handler interface; `GraphQLTypes`, for the escape hatch                                                          |
| `graphql-runtime.gen.ts` | a copy of this package's runtime: the scalars, result projection, connection assembly, the per-request call memo, the cost directives and the limits that enforce them, the error classes and `GraphQLDeps`. It imports only `graphql` at run time. |

Generate them in your build or commit them; never edit them.

## Mount it

`createSchema(handlersFor, deps, extend?)` returns a `GraphQLSchema`.

- **`handlersFor(context)`** returns the handler object: the same one `typespec-hono`'s
  `registerRoutes` takes. It must have a handler for every operation `graphql.tsp` exposes, directly
  or through a link; it may carry handlers for the document's other operations; it may not carry one
  for an operation that does not exist. `context` is the GraphQL context value your server hands
  every resolver. It is called once per context value, when the first field calls a handler, so a
  factory that builds the object for a request builds it once per request.
- **`deps`** authorises and identifies the caller, with the meaning `typespec-hono`'s `RouteDeps`
  gives the same names. `authorize(context, requirements)` answers `"allow"`, `"unauthenticated"` or
  `"forbidden"` for the operation's `@useAuth` requirements, any one of which authorises, `{}` being
  the anonymous one. `context(context, authentication)` returns the caller every handler receives, or
  `null`, which is answered `UNAUTHENTICATED`.
- **Build the schema once**, at module scope. Per-request state reaches it through the context value,
  which the call memo is keyed on.
- **Give every request a context object of its own.** Calls are memoised per context object, and
  authorisation runs inside the memoised call. A context object shared across requests would answer
  one caller from another caller's calls, verdicts included. Yoga builds a fresh one per request, as
  the examples below rely on; a server that hands every request one long-lived object must not.
- **Verify the caller once per request**, in your server's context factory, and have `deps` read what
  it found. `deps` runs for every handler call, and synchronously, so a credential checked there is
  checked once per field and cannot await WebCrypto.
- **Limit what one document may ask for.** One document can nest links and repeat fields under
  aliases, and every one of them calls a handler. The runtime enforces the cost directives the
  schema carries, both ways the cost specification measures them: `costLimit` bounds the handler
  calls, `typeCostLimit` the objects returned. `depthLimit` and `aliasLimit` bound nesting and
  aliases. The example below applies all four, and graphql-js's own token limit.

`./handlers.js` in the examples is your module: `handlersFor` returns the handler object your HTTP
server is given, `verify` checks a request's credential, and `Caller` is what it establishes.

### The GraphQL server

Built once, at module scope, and mounted by the Node and Workers examples that follow.

```ts
// graphql.ts
import { parse } from "graphql";
import { createYoga, type Plugin } from "graphql-yoga";
import type { Context } from "hono";
import { createSchema } from "./generated/graphql.gen.js";
import {
	aliasLimit,
	costLimit,
	depthLimit,
	type GraphQLDeps,
	typeCostLimit,
} from "./generated/graphql-runtime.gen.js";
import { handlersFor, verify, type Caller } from "./handlers.js";

/** What your server hands Yoga per request: the request's Hono context. */
interface ServerContext {
	readonly c: Context;
}

/** What every resolver receives: the server context, and the caller verified for the request. */
interface RequestContext extends ServerContext {
	readonly caller: Caller | null;
}

const deps: GraphQLDeps<RequestContext, Caller> = {
	// The operation's `@useAuth`, as requirements: one satisfied authorises, and `{}` is anonymous.
	authorize: ({ caller }, requirements) =>
		caller !== null ||
		requirements.length === 0 ||
		requirements.some((requirement) => Object.keys(requirement).length === 0)
			? "allow"
			: "unauthenticated",
	// What the context factory verified. `null` is answered UNAUTHENTICATED.
	context: ({ caller }, authentication) =>
		caller ?? (authentication === "required" ? null : { subject: "anonymous" }),
};

export const schema = createSchema(({ c }: RequestContext) => handlersFor(c), deps);
// Handler calls, by Field Cost, and objects returned, by Type Cost: a document is held to both.
const budgets = [costLimit(1000), typeCostLimit(10_000)];

/** The limits on one document, as a Yoga plugin. */
const limits: Plugin = {
	// A document of more than 2,000 tokens is refused before it is parsed whole.
	onParse: ({ setParseFn }) => {
		setParseFn((source, options) => parse(source, { ...options, maxTokens: 2000 }));
	},
	onValidate: ({ addValidationRule }) => {
		addValidationRule(depthLimit(10));
		addValidationRule(aliasLimit(30));
	},
	// What an operation costs depends on its variables, so it is read once they are known.
	onExecute: ({ args, setResultAndStopExecution }) => {
		const refusals = budgets.flatMap((budget) => budget(args) ?? []);
		if (refusals.length > 0) setResultAndStopExecution({ errors: refusals });
	},
};

export const yoga = createYoga<ServerContext, { readonly caller: Caller | null }>({
	schema,
	// Once per request, and asynchronous, so the check can await WebCrypto.
	context: async ({ c }) => ({ caller: await verify(c.req.header("authorization")) }),
	plugins: [limits],
});
```

### Node

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { yoga } from "./graphql.js";

const app = new Hono();
app.on(["GET", "POST"], "/graphql", async (c) => {
	const response = await yoga.fetch(c.req.raw, { c });
	// Through Hono's context, so headers earlier middleware set with `c.header()` are kept.
	return c.newResponse(response.body, response);
});

serve({ fetch: app.fetch, port: 3000 });
```

### Cloudflare Workers

```ts
import { Hono } from "hono";
import { yoga } from "./graphql.js";

const app = new Hono();
app.on(["GET", "POST"], "/graphql", async (c) => {
	const response = await yoga.fetch(c.req.raw, { c });
	// Through Hono's context, so headers earlier middleware set with `c.header()` are kept.
	return c.newResponse(response.body, response);
});

export default app;
```

**Answer through `c.newResponse`, not with Yoga's `Response` as it is.** Hono applies the headers
middleware set with `c.header()` before the handler, such as a request id, only to a response built
through the context, so returning `yoga.fetch`'s own drops them from `/graphql` alone. `newResponse`
keeps Yoga's status, body and headers, its own winning a name both set.

No `nodejs_compat` flag is needed: the emitted code and its runtime import no Node builtin. The test
suite serves `graphql.ts`, as written here, on workerd without one and on Node through
`@hono/node-server`, and holds both to every MUST audit of `graphql-http`, the GraphQL over HTTP
reference implementation.

## Testing it

**Under vitest, alias `graphql` to the file Node resolves.** graphql 17 ships a second build under
the `development` export condition. Vite resolves the files it transforms, your tests and the
generated schema, by that condition, while a dependency it leaves to Node, GraphQL Yoga, gets the
other build. Two copies of graphql-js refuse each other's schemas, and every request through Yoga
answers `"Unexpected error."`, masking `Cannot use GraphQLSchema ... from another module or realm`.
One alias gives every module Node's copy:

```ts
// vitest.config.ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [{ find: /^graphql$/, replacement: fileURLToPath(import.meta.resolve("graphql")) }],
	},
});
```

**A batched link waits for a timer, so a test that fakes timers must let it run.** The batch is sent
on a macrotask, `setImmediate` or `setTimeout`, and under `vi.useFakeTimers()` that macrotask never
comes: the document never settles. Fake only the timers the test needs,
`vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })` on Node, or let the fakes
advance on their own, `vi.useFakeTimers({ shouldAdvanceTime: true })`.

## Tracing

graphql 17 publishes `graphql:parse`, `graphql:validate`, `graphql:execute` and `graphql:resolve`
on Node's `diagnostics_channel`. Two things decide what a tracer sees of this schema:

- **GraphQL Yoga executes with `@graphql-tools/executor`, which publishes nothing.** Through the
  mount above only `graphql:parse` and `graphql:validate` fire. To trace execution, have graphql-js
  execute: `useEngine` from `@envelop/core`, in Yoga's `plugins`.
- **Every field has a resolver**, reading its own property (see [Names](#names)), so
  `graphql:resolve`'s `isDefaultResolver` is false on all of them. A field that calls a handler names
  its operation in `extensions.operationId`, the id the REST route's operation has too: span those
  and leave the rest. A link chosen by a kind names every operation it may call in
  `extensions.operationIds`, since which one it calls is the parent's.

```ts
// tracing.ts
import { tracingChannel } from "node:diagnostics_channel";
import { useEngine } from "@envelop/core";
import { execute, isObjectType, parse, specifiedRules, subscribe, validate } from "graphql";
import { schema } from "./graphql.js";

/** In `createYoga`'s `plugins`, so graphql-js executes and publishes `graphql:resolve`. */
export const graphqlJsExecution = useEngine({
	parse,
	validate,
	specifiedRules,
	execute,
	subscribe,
});

/** The operation a resolved field calls, or `undefined` for one that reads a property. */
export function operationOf(parentType: string, fieldName: string): string | undefined {
	const type = schema.getType(parentType);
	const operationId = isObjectType(type)
		? type.getFields()[fieldName]?.extensions["operationId"]
		: undefined;
	return typeof operationId === "string" ? operationId : undefined;
}

tracingChannel("graphql:resolve").subscribe({
	start: (message) => {
		const { parentType, fieldName } = message as { parentType: string; fieldName: string };
		const operationId = operationOf(parentType, fieldName);
		if (operationId !== undefined) {
			// Start a span named `operationId` here, and end it in `asyncEnd`.
		}
	},
	end: () => undefined,
	asyncStart: () => undefined,
	asyncEnd: () => undefined,
	error: () => undefined,
});
```

The standard instrumentation does not reach graphql 17 yet: `@opentelemetry/instrumentation-graphql`
0.72.0 supports graphql `>=14.0.0 <17`, and `@graphql-hive/plugin-opentelemetry` 1.5.4 peers
graphql 15 or 16 (both measured 2026-10-21).

## The escape hatch

A field no operation provides is written by hand, with the generated types:

```ts
import type { Context } from "hono";
import { createSchema } from "./generated/graphql.gen.js";
import { deps, featuredBookFor, handlersFor } from "./handlers.js";

interface ServerContext {
	readonly c: Context;
}

export const schema = createSchema(
	({ c }: ServerContext) => handlersFor(c),
	deps,
	(types) => ({
		query: {
			// A field no operation provides, written by hand and typed with a generated type.
			featuredBook: {
				type: types.Book,
				resolve: (_root, _args, { c }) => featuredBookFor(c),
			},
		},
	}),
);
```

`extend` receives `GraphQLTypes`, the generated type objects, and returns fields to add: `query`,
`mutation`, and `fields` keyed by type name. A field with the name of a generated one throws when the
schema is built, naming both. `schema.graphql` is the generated part alone; when you extend the
schema, publish `printSchema` of the extended one.

## Requests for other tools

`graphqlRequestsOf(program)` answers, once this emitter has run in a compile, one request for each
root field it served, per service: a document the schema accepts, its arguments as variables and its
result selected to its leaf fields, and `variables(values)`, which turns a REST request's values into
that document's variables, so the handler receives what that REST request would hand it. A tool that
writes requests for the HTTP surface writes them for this one from it, and no document drifts from
the schema. Before this emitter has run on a program it answers `undefined`. typespec-postman writes
its collection's GraphQL requests this way.

## What a client sees

### Names

- **A `@friendlyName` names its type**, a template's instances included, as it names the OpenAPI
  component and the validator: `@friendlyName("Located{name}", P)` makes `Located<Conflict>`
  `LocatedConflict` in all three. Where none is applied, a template instance is composed as upstream
  composes it, `Page<Widget>` as `PageOfWidget`.
- Types are PascalCase with the namespace stripped; fields and arguments are camelCase of the
  property's JSON wire name, so a field reads the same in REST and GraphQL; enum values are
  CONSTANT_CASE. Root field and link names are used as `graphql.tsp` writes them.
- **Fields several types share are an interface.** A named model two or more output types are built
  from, by `extends` or a spread, is `<Name>Interface`, implemented by each of them: select
  `... on ProblemFieldsInterface { title detail }` across a result's members. Use a named model, not
  an `alias`, for fields you want shared this way.
- **A `@discriminator` base is `<Name>Interface`**, implemented by the base's own object type,
  `<Name>`, and by each subtype, and a field of the base's type returns the interface. A value is the
  subtype its discriminator names where it is a valid one, by that subtype's own validator, and
  `<Name>` for any other value the REST route serves, such as a kind no subtype names on an open base
  or `{ kind: "golden", weight: 8 }` without the `coat` a `Golden` requires. A base under a base is an
  interface of its own,
  implementing its parent's. The discriminator has the type its base declares on every member, and
  is never null.
- A member with no body carries `success: Boolean!`, true for a success and false for a refusal.
- **A type named as GraphQL already names something** (`Query`, `String`, `ID`, `Duration`, `URL`,
  `JSON` and the rest) is `JSON`, with a `projected-as-json` warning saying so; rename the model to
  give it a type of its own.
- **A projection as `JSON` that is right is accepted in `graphql.tsp`**, so a spec can build under
  `warn-as-error` with no GraphQL in its models: `@@json(Product.extra)`, for a property holding any
  JSON value, raises no `projected-as-json`. It makes nothing `JSON`; on a type GraphQL can state it
  is warned `not-projected-as-json`. A property's `@json` accepts its type, wherever that type is
  reached.
- **The wire never changes.** A handler receives `x-api-version` and `edition-name` from the
  arguments `xApiVersion` and `editionName`, and a response's `created_at` is read back under
  `createdAt`.
- **`#deprecated` becomes `@deprecated`**, except on a required input field, which GraphQL
  refuses to deprecate: there the reason ends the field's description, as `Deprecated: <reason>`.

### Arguments and input

- A query field or a link takes one argument per path, query and cookie parameter it does not bind,
  and per REQUIRED header whose type is not a single literal.
- A header whose type is one literal, such as a negotiated `accept` or a merge patch's
  `Content-Type`, is supplied by the resolver.
- **An optional header or cookie is never an argument**, and reaches the handler absent. It is HTTP transport
  metadata; a GraphQL client sends such metadata as headers of its own `/graphql` request, where your
  server and `deps` read it. So a read never sends `If-None-Match` and never takes the `304` path.
- **Unless `@inputHeader` takes it as input.** An `Idempotency-Key` belongs to the one write it
  protects, and two mutations in one document cannot share the `/graphql` request's:
  `@@inputHeader(Products.create, "idempotencyKey")` makes it `CreateProductInput.idempotencyKey`,
  sent to the handler as `Idempotency-Key`. One that names no optional header of its operation is
  warned `input-header-ignored`.
- A mutation takes one `input: <Name>Input!` whose fields are the handler's input, less the headers
  above.
- **A read-only property is sent where the request is the model itself.** A body that differs from
  its model only by read-only properties is the model's own schema, as `@typespec/openapi3`
  publishes it and the REST route validates it, so `id` and `createdAt` are input fields. At
  openapi3's default, OpenAPI 3.0, they are optional: a read-only property's `required` "take[s]
  effect on the response only" (OAS 3.0.4). Published at 3.1, they are required where the model
  requires them, and OAS 3.1.1 (§ 4.8.24.3.2) lets a client send a read-only property and the server
  ignore it. Either way, have the handler ignore them.
- An argument's type is its wire form, its own `@encode` included: an `@encode("seconds")` duration
  header is a `DurationSeconds` number, a `unixTimestamp` query parameter a `UTCDateTimeUnix` one.
- A date-time header with no `@encode` is `UTCDateTimeHuman` or `OffsetDateTimeHuman`, an RFC 7231
  HTTP-date: the form TypeSpec sends a header in, and the one `@typespec/openapi3` publishes for it.
- A `Long` or `BigInteger` beyond ±2^53 − 1 is `BAD_USER_INPUT`, as the REST route refuses it: a
  JSON number carries no larger integer exactly, so one is refused rather than rounded.
- An explicit `null` for an optional field that is not `| null` is treated as absent, as REST sees an
  omitted key. A `| null` field keeps its `null`. A field that is required and `| null` can be left
  out, since GraphQL cannot require a nullable input; the handler then receives the `null` the
  operation requires.
- A default is in the schema, an enum's by its value's name (`first: Int = 50`,
  `order: Order = NEWEST`), and the handler receives its wire value.
- `#deprecated` on a parameter is `@deprecated` on its argument, or, where the argument is required,
  `Deprecated: <reason>` at the end of its description.
- Input is validated with the operation's own Zod schemas, so a request the REST route answers `400`
  is `BAD_USER_INPUT` here, with the Zod issues in `extensions.issues`, each issue's `path` naming
  the argument you wrote (`["input", "ownerId"]`) and its `wirePath` the REST route's key (`owner_id`), and the handler receives
  exactly what the REST route's handler would.

### Nullability

- Root fields and links are nullable, so one failing field does not null its siblings.
- A link whose bound property is `null` or absent is `null`, and its handler is not called.
- A model with additional properties (`...Record<T>` beside declared properties) is `JSON`, warned
  `projected-as-json`: a GraphQL object type is closed, and the additional properties would be lost.
  A spread request body that is one makes the operation's input a single `input: JSON!`.
- A property is nullable when it is optional or `| null`; a list's items are non-null unless they are
  `| null` themselves, a connection's `node` included. An `unknown` property is nullable, as `null`
  is one of its values.
- A model's, an enum's or a literal union's `| null` needs OpenAPI 3.1: at openapi3's default, 3.0,
  typespec-http-zod refuses it as `unpublishable-null` (see [Install](#install)).

### Links

- **A link fills a parameter from a property its type accepts, or one it narrows.** A `string` id
  fills a `@pattern(...) scalar TagId extends string` parameter, and the operation's schema checks
  the value as the link resolves: one that breaks the pattern is `BAD_USER_INPUT` at that field,
  its siblings resolving.
- **A link bound to a list is a list.** With `tag_ids: string[]`,
  `@@link(Product, "tags", Tags.read, #{ id: "tag_ids" })` is `tags: [Tag]`, one call per id through
  the call memo, in the list's order. A 404 is that item's `null` and a failure that item's error,
  the other items resolving; a `null` list is `null`, an empty one `[]`.
- **The list declares `@maxItems`**, the most calls one product's `tags` makes. It is held there by
  the product's own response schema, and the field is weighed at it,
  `@cost(weight: "20") @listSize(assumedSize: 20)`, so `costLimit` still bounds the calls a
  document can make. Without one the link is dropped, `link-list-unbounded`. A link binds one list
  at most, and not to an `@list` operation (`link-list-not-bindable`).
- **A link chosen by a kind is one field over several reads.** Where one property says what another
  refers to, a review of a book or of an author, declare a link for each kind, each with `when`, under
  one name:

  ```tsp
  @@link(Review, "subject", Books.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });
  @@link(Review, "subject", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });
  ```

  `subject` is the union `ReviewSubject = Book | Author`, a member for each arm's type in the order
  they are declared. Each review reads only the operation its kind names, one call per review; a
  kind no arm names is `null`, and nothing is called. A `when` value may be a list,
  `#{ subject_type: #["book", "ebook"] }`, and a link with `when` alone is a union of its one type, so
  a second arm adds a member rather than changing the field's type under its clients.

- **The arms of one field agree.** They are chosen by values of one property, no value chooses two,
  all or none bind a list, they take the same arguments, by name in any order and each of the same
  type down to an enum's values, and at most one gives a description, which is the field's. Arms that
  do not are dropped, every one of them, `link-arms-conflict`; a `when` the property cannot hold is
  `link-when-mismatch`, and an arm whose read answers no object type a union can hold, a list or a
  connection say, is `link-arm-not-object`. The field is deprecated where every arm's read is, for
  each of their reasons.
- **A batched link reads many parents' values in one call** to a batch read: an operation taking a
  list of ids in its query and answering the items for them, as AIP-231's `BatchGet` does.

  ```tsp
  // @get @route("/batch") batchGet(@query(#{ explode: true }) @maxItems(50) ids: string[]): { authors: Author[] } | NotFound;
  @@link(Book, "author", Authors.batchGet, #{ ids: "author_id" }, #{ batch: #{ key: "id" } });
  ```

  `author` is an `Author`, the batch's item type. A batched link calls its batch read once for the
  distinct values of every parent a document reaches at once, and each field answers the item whose
  `key` is its value, or `null`. A document's books read their authors in one call, and the authors'
  publishers, batched too, in one more.

- **How a batch is sent.** The values wait until the resolvers a document is running have all run,
  a macrotask; a value its parameter refuses is that field's `BAD_USER_INPUT`, and the rest are sent;
  a batch parameter's `@maxItems` splits more values into several calls; and a 404 for several values
  sends each of them again alone, so one missing id never blanks the others. A failure of the call is
  every waiting field's error. `items` names the body's list where it holds more than one, and a link
  bound to a list sends its items. A batch read that is not a `GET` with a list in its query, answers
  a page, or answers items with no `key` is `link-batch-invalid`, as is a link filling any other
  parameter from a list. Two links to one batch read are batched apart, each matching by its own
  `key` in its own `items`.

### Errors

Expected outcomes are typed data; the top-level `errors` list is for what a client cannot act on in
its own logic.

| declared response, on a query or a link | becomes                                      |
| --------------------------------------- | -------------------------------------------- |
| 2xx                                     | the field's value                            |
| 404                                     | `null`                                       |
| 400, 422                                | top-level `BAD_USER_INPUT`                   |
| 401, 403                                | top-level `UNAUTHENTICATED`, `FORBIDDEN`     |
| 409                                     | top-level `CONFLICT`                         |
| 429                                     | top-level `RATE_LIMITED`                     |
| another 4xx                             | top-level, `code` the reason phrase (`GONE`) |

| declared response, on a mutation | becomes                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| 2xx                              | a success member of `<Name>Result`, a union even with one member |
| 4xx but 401, 403 and 429         | a typed error member of `<Name>Result`: the error model          |
| 401, 403, 429                    | top-level, as on a query                                         |

A `default`, `4XX` or `5XX` response stands for many statuses, so the status your handler answers
decides, by the tables above: a 404 under a `| Error` default arm is `null` on a query, a 400 is
`BAD_USER_INPUT`, and on a mutation a member-class status is the default arm's model as a member.

On both, a 5xx is top-level with `extensions.status` and the declared body in `extensions.body`. A
response that breaks its declared schema, an undeclared status, or a handler that throws is a plain
error the server masks: Yoga answers `INTERNAL_SERVER_ERROR` with no detail. A union member is chosen
by the status the handler returned, never by the shape of its body.

### Connections

An operation is a Relay connection when it carries all five of TypeSpec's core paging decorators:
`@list` on the operation, `@pageItems` and `@continuationToken` on the response, `@continuationToken`
and `@pageSize` on the request. Missing any of them, it is its declared response type, with the
warning `not-a-connection`.

- `first: Int` fills the `@pageSize` parameter, whose default and maximum stay the operation's; a
  negative `first` is `BAD_USER_INPUT`, and a page the backend answers longer than `first` is cut to it.
- `after: String` takes a cursor from this connection, an edge's or `pageInfo.endCursor`, and the
  handler receives the backend's own token for that page. Anything else is `BAD_USER_INPUT`.
- **Any `first` the schema accepts follows any cursor.** Resuming after an edge partway into a
  page, the handler is asked for that page again with the skipped items added to `first`, up to the
  largest page size the operation accepts: the least `@maxValue`, or `@maxValueExclusive` less one,
  of the page size and the scalars it extends. Past it the page holds fewer than `first` items, as
  Relay's "at most" allows, and its `endCursor` goes on from there: one handler call per field, and
  no item lost or repeated.
- `<Item>Connection { edges, nodes, pageInfo }`, `<Item>Edge { node, cursor }` and `PageInfo` follow
  relay.dev/graphql/connections.htm. Every edge has an opaque cursor you can resume after, which a
  Relay client such as Apollo's `relayStylePagination` relies on; `startCursor` and `endCursor` are the
  first and last edges'. Paging is forward only, so `hasPreviousPage` is `false`.

### Cost, and calls per request

- `@cost(weight: "1")` is on every root field and link, and `@listSize` on every connection field,
  in `schema.graphql` (the IBM cost directives) and in each field's `extensions` (`cost`, `listSize`),
  so a validation rule can read them from the runtime schema. A link bound to a list is weighed at
  its list's `@maxItems`, the calls it can make (see [Links](#links)). A batched link is weighed at
  the calls its own values can take, at the batch parameter's `@maxItems` to a call, and one more for
  each value where the batch can answer 404, since each is then sent again alone; Field Cost is
  counted per field, so it never weighs less than the link it replaces. A link chosen by a kind is
  weighed as its costliest arm.
- A connection is sized by `first`, or by `first`'s default where a query sends none. Where `first`
  has no default, `assumedSize` is that largest page size; the specification allows it nowhere else
  (§9.2.4).
- **Two costs, bounding two things**, both by the specification's static analysis:
  - `operationCost(request)` is an operation's Field Cost (§5.3.2.2): the fields it resolves, and so,
    with `@cost(weight: "1")` on each, the handler calls it can make. `costLimit(maximum)` refuses an
    operation that costs more, as `COST_LIMIT_EXCEEDED`.
  - `typeCost(request)` is its Type Cost (§5.3.2.1): the objects its response can hold, each at its
    type's weight, 1 by default, the root included. `typeCostLimit(maximum)` refuses one that costs
    more, as `TYPE_COST_LIMIT_EXCEEDED`.
  - Both answer with `extensions.cost` and `extensions.maximumCost`.
- **Field Cost does not bound what a document returns.** A connection's `nodes` is one field however
  many items it holds, while `edges` charges each item's `node`, so the same three books, their
  authors and three editors of each cost 11 through `nodes` and 23 through `edges`. Their Type
  Costs, 20 and 32, count every book, author and editor both ways, plus the edges `edges` really
  returns. A Field Cost limit set by measuring one path does not hold for the other; hold a document
  to both limits.
- A list with no `@listSize` below which anything is costed has no bound, as the specification
  requires, and is refused whatever the limit.
- `depthLimit(maximum)` and `aliasLimit(maximum)` are validation rules, answering
  `DEPTH_LIMIT_EXCEEDED` and `ALIAS_LIMIT_EXCEEDED`. A fragment adds no depth, and introspection is
  not counted; a fragment's aliases count once for every place it is spread.
- Calls are memoised per GraphQL context value, keyed by operation and input, so fifty books by one
  author cost one author read per request. Mutations are never memoised, and each mutation forgets
  what the request has read, so a read after it is answered afresh. A batched link's answers are
  memoised per value, so a later batch asking for one again is answered from the first.

## Known limits

Each is a fault upstream, linked where it has been reported; the README's behaviour above holds
around it.

- **An optional property named after an `Object.prototype` member** (`constructor`, `toString`,
  `valueOf` and the rest) refuses every request that leaves it out, on the REST route and here
  alike: Zod reads the inherited function as its value
  ([colinhacks/zod#6666](https://github.com/colinhacks/zod/issues/6666)). typespec-http-zod warns
  `optional-prototype-name` for such a property
  ([bison-digital/typespec-http-zod#5](https://github.com/bison-digital/typespec-http-zod/issues/5)).
- **A property named `__proto__` is never validated, and its value is dropped**: Zod skips the key
  by design ([colinhacks/zod#6386](https://github.com/colinhacks/zod/pull/6386)), so a wrong value is
  accepted. typespec-http-zod warns `unenforceable-property-name` for it
  ([bison-digital/typespec-http-zod#6](https://github.com/bison-digital/typespec-http-zod/issues/6)).

## Diagnostics

**Every diagnostic is a warning**: an error would stop `@typespec/openapi3` writing your document.
Set `warn-as-error` to make them fail a build. Each is reported once, at what it is about, however
many services meet it.

| code                       | raised when                                                                                                                                                     | the declaration                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `no-fields-declared`       | a service has no declaration in `graphql.tsp`; nothing is written for it                                                                                        | none                                |
| `invalid-graphql-name`     | a name is not a GraphQL name: `/^[_A-Za-z][_0-9A-Za-z]*$/`, not starting `__`                                                                                   | dropped                             |
| `graphql-name-collision`   | two root fields of one root type, or a link and a field of its type, share a name                                                                               | every party dropped                 |
| `declared-twice`           | an operation is declared as a root field more than once                                                                                                         | all but the first dropped           |
| `unknown-link-parameter`   | a key of `@link`'s `parameters` is not a parameter of the operation                                                                                             | dropped                             |
| `unknown-link-property`    | a value of `parameters` is not a property of the model                                                                                                          | dropped                             |
| `link-property-unreadable` | a value of `parameters` is a property the read body never carries (create-only, or a header)                                                                    | dropped                             |
| `link-type-mismatch`       | a bound property is neither a value its parameter accepts, by the parameter's type or a scalar that type extends, nor a list of them, nullability aside         | dropped                             |
| `link-list-not-bindable`   | a link binds a second list, or binds a list to an `@list` operation                                                                                             | dropped                             |
| `link-list-unbounded`      | a link binds a list that declares no `@maxItems`, so no cost limit could bound the calls it makes                                                               | dropped                             |
| `link-not-safe`            | a link targets an operation whose method is not `GET`                                                                                                           | dropped                             |
| `link-when-mismatch`       | a link's `when` names no property or several, a property that holds no string, or a value the property never holds                                              | dropped                             |
| `link-arms-conflict`       | links of one model sharing a name, at least one with `when`, cannot be one field: see [Links](#links)                                                           | every party dropped                 |
| `link-arm-not-object`      | an arm of a link chosen by a kind calls an operation answering no object type a union can hold                                                                  | that arm dropped                    |
| `link-batch-invalid`       | a link's `batch` names an operation that is no batch read of its values: no list in its query, a page, items with no `key`, or a list filling another parameter | dropped                             |
| `query-not-safe`           | a `@queryField` targets a method that is not safe                                                                                                               | kept: a `POST` search stays a query |
| `head-operation`           | the operation is `HEAD`, which answers no body to select from                                                                                                   | dropped                             |
| `non-json-request`         | the request body is not JSON                                                                                                                                    | dropped                             |
| `non-object-body`          | the request body has no properties to merge into the handler's input                                                                                            | dropped                             |
| `shared-input-key`         | two inputs the handler's input carries under one key (a header and a query `x`), as typespec-http-zod reports them                                              | dropped                             |
| `non-json-response`        | a response is not JSON                                                                                                                                          | dropped                             |
| `link-target-unreachable`  | `@link` targets a model no field returns                                                                                                                        | dropped                             |
| `not-a-connection`         | an `@list` operation lacks one of the five paging decorators                                                                                                    | kept, as its declared response      |
| `transport-argument`       | a required cookie, or `Authorization`, `Proxy-Authorization` or `Cookie` header, stays an argument, which a document carries in text servers log                | kept                                |
| `projected-as-json`        | a type GraphQL cannot express is projected as `JSON`; Zod still validates it. Not raised for a type `@json` accepts                                             | kept                                |
| `not-projected-as-json`    | a `@json` names a type this service projects as a GraphQL type of its own                                                                                       | none                                |
| `input-header-ignored`     | an `@inputHeader` names no optional header of its operation: no parameter, another kind, a required header or one of a single literal                           | none                                |
| `anonymous-type-shared`    | members of two or more models hold one anonymous type, through an `alias` or an instance such as `Crate<"x">`; it is named after the first declared             | kept                                |
| `shared-output-dir`        | another emitter writes the same directory with different library options                                                                                        | none                                |

## Removing it

Delete `graphql.tsp`, its import, and this emitter's line in `tspconfig.yaml`. Nothing else changes:
the test suite compiles a spec with and without its GraphQL surface and requires the OpenAPI
document, the Zod validators and the `typespec-hono` server to be byte-identical, a spec whose
`@link` names an interface declared after the model it decorates included. That holds on
`typespec-http-zod` 0.34.0 and later, which write in the order the spec declares; an earlier one
wrote in the order the compiler checked, which such a link changes.

## Documentation

- [`docs/design.md`](docs/design.md): the design, and every rule above in full.
- [`docs/architecture.md`](docs/architecture.md): what each module owns, and the boundaries that are enforced.
- [`docs/oracles.md`](docs/oracles.md): what each artefact is compared against, and the defect each comparison was shown to catch.
- [`docs/measurements.md`](docs/measurements.md): what building the schema costs at start-up.
- [`docs/releasing.md`](docs/releasing.md): what each release depends on, and how one is cut.
- [`CHANGELOG.md`](CHANGELOG.md).

## Licence

MIT.
