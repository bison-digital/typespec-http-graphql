import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getEncode, type ModelProperty, type Program, type Scalar } from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import { type Context, Hono } from "hono";
import { armFor, type ResponseArm } from "typespec-http-zod/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { corpusScenarios, libraryRefusalsOf, packageRoot } from "../support/corpus.js";
import { declareEveryOperation } from "../support/declare-every-operation.js";
import { openApiVersionsOf } from "../support/openapi-versions.js";
import { ratchet } from "../support/ratchet.js";
import {
	argumentsFor,
	dispositionOf,
	documentFor,
	expectedFor,
	type Fixture,
	isMember,
	isSuccess,
	loadFixture,
	pagingOf,
	type RootField,
	asExpected,
} from "../support/surface-harness.js";
import { Untranslatable } from "../support/wire-walk.js";
import { executeThroughYoga, type GraphQLResult } from "../support/yoga.js";
import { type Published, publishDocument, publishedBy, type SentBody } from "./published.js";

/**
 * **Spector replay: every request the `@typespec/http-specs` corpus declares, sent to REST and to
 * GraphQL, with one handler behind both, and the two compared.**
 *
 * The corpus's own `mockapi.js` declares, per scenario, the exact request a conformant client sends
 * and the response a conformant server answers. Those values were chosen by the corpus's authors,
 * not by this package, which is what makes them an oracle. For each one:
 *
 * 1. **REST.** The request is built as spector's own client builds it, and goes to the published
 *    `typespec-hono` server, generated from the same compile and mounted where a deployer mounts it,
 *    under the `@server` URL's path. The handler answers the mock's declared response, its headers
 *    in the types the handler returns them, and records what it was handed: input **A**. That the
 *    server called a handler at all, and which, is how a mock entry is paired with its operation.
 * 2. **GraphQL.** The same operation's root field is called with the arguments a client writes for
 *    A (`argumentsFor`, by the upstream naming), through Yoga. The handler answers the same response
 *    and records input **B**.
 * 3. **Compared.** B is A, but for the one class design.md names: an optional header is never a
 *    GraphQL argument, so it is absent. And the field answers what design.md § Results gives the
 *    mock's response, restated in `test/support/surface-harness.ts` and computed from the REST
 *    response's body parsed by the library's own schema for its status.
 *
 * Every entry that cannot be compared is counted by why, under a ceiling in `baseline.json`. A REST
 * refusal is a finding, listed by name in the report's `restFindings`, unless the spec itself says
 * why no server should serve the entry (`published.ts`): it asks for a version older than the one
 * served, its corpus response is itself an error, or the request or response breaks what the spec
 * publishes. Those are counted apart, each listed with its reason in the report's `corpus`.
 */

const outRoot = join(packageRoot, "test", ".out-replay");

/** What the corpus's mock helpers declare, as far as this oracle reads it. */
interface MockBody {
	readonly kind?: string;
	readonly contentType: string;
	readonly rawContent:
		| string
		| Uint8Array
		| { readonly serialize: (config: { readonly baseUrl: string }) => string }
		| undefined;
}
interface MockApi {
	readonly uri: string;
	readonly method: string;
	readonly request?: {
		readonly body?: MockBody;
		readonly query?: Readonly<Record<string, unknown>>;
		readonly pathParams?: Readonly<Record<string, unknown>>;
		readonly headers?: Readonly<Record<string, unknown>>;
	};
	readonly response: {
		readonly status: number;
		readonly headers?: Readonly<Record<string, unknown>>;
		readonly body?: MockBody;
	};
}

const BASE_URL = "http://replay.test";

/** design.md § Results: the codes it fixes, and every other status's RFC 9110 reason phrase. */
const CODES: Readonly<Record<number, string>> = {
	400: "BAD_USER_INPUT",
	401: "UNAUTHENTICATED",
	402: "PAYMENT_REQUIRED",
	403: "FORBIDDEN",
	405: "METHOD_NOT_ALLOWED",
	406: "NOT_ACCEPTABLE",
	407: "PROXY_AUTHENTICATION_REQUIRED",
	408: "REQUEST_TIMEOUT",
	409: "CONFLICT",
	410: "GONE",
	411: "LENGTH_REQUIRED",
	412: "PRECONDITION_FAILED",
	413: "CONTENT_TOO_LARGE",
	414: "URI_TOO_LONG",
	415: "UNSUPPORTED_MEDIA_TYPE",
	416: "RANGE_NOT_SATISFIABLE",
	417: "EXPECTATION_FAILED",
	421: "MISDIRECTED_REQUEST",
	422: "BAD_USER_INPUT",
	426: "UPGRADE_REQUIRED",
	428: "PRECONDITION_REQUIRED",
	429: "RATE_LIMITED",
	431: "REQUEST_HEADER_FIELDS_TOO_LARGE",
	500: "INTERNAL_SERVER_ERROR",
	501: "NOT_IMPLEMENTED",
	502: "BAD_GATEWAY",
	503: "SERVICE_UNAVAILABLE",
	504: "GATEWAY_TIMEOUT",
	505: "HTTP_VERSION_NOT_SUPPORTED",
};

/** The permissive deps every corpus server is mounted with: anyone, anything accepted. */
const REST_DEPS = {
	authorize: () => async (_c: Context, next: () => Promise<void>) => {
		await next();
	},
	context: () => ({ subject: "replay" }),
	noContext: (c: Context) => c.json({ title: "Unauthorized" }, 401),
	notAcceptable: (c: Context) => c.body(null, 406),
	invalid: (result: { readonly success: boolean }, c: Context) =>
		result.success ? undefined : c.json({ title: "Bad Request" }, 400),
};

function textOf(body: MockBody | undefined): string | Uint8Array | undefined {
	const raw = body?.rawContent;
	if (raw === undefined) return undefined;
	if (typeof raw === "string" || raw instanceof Uint8Array) return raw;
	return raw.serialize({ baseUrl: BASE_URL });
}

const isJson = (contentType: string | undefined): boolean =>
	contentType !== undefined && /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType);

/**
 * A header, query or response-header value as the wire carries it. The corpus writes a value some
 * languages spell differently (a date) as a spec-api MATCHER, which serialises to the canonical form.
 */
function wireTextOf(value: unknown): string {
	if (
		typeof value === "object" &&
		value !== null &&
		"serialize" in value &&
		typeof value.serialize === "function"
	) {
		return String(
			(value.serialize as (config: { baseUrl: string }) => unknown)({ baseUrl: BASE_URL }),
		);
	}
	return String(value);
}

/**
 * The mock's exact request, as spector's own client sends it (`makeServiceCall` and `resolveUrl`,
 * `@typespec/spector/dist/src/actions/helper.js`, which it does not export); or why this oracle
 * cannot send it. Path parameters are substituted as spector substitutes them, and then its `\:`,
 * the escape its mock server's router needs for a literal colon, is undone. A body's own content
 * type overrides any `Content-Type` header the mock declares, as spector's spread does.
 */
function requestOf(api: MockApi): { readonly request: Request; readonly body: SentBody } | string {
	const request = api.request ?? {};
	if (request.body?.kind === "multipart") return "multipart";
	let uri = api.uri;
	for (const [name, value] of Object.entries(request.pathParams ?? {})) {
		uri = uri.replaceAll(`:${name}`, String(value));
	}
	uri = uri.replaceAll("\\:", ":");
	const url = new URL(uri, BASE_URL);
	for (const [name, value] of Object.entries(request.query ?? {})) {
		for (const item of Array.isArray(value) ? value : [value]) {
			url.searchParams.append(name, wireTextOf(item));
		}
	}
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers ?? {})) {
		headers.set(name, wireTextOf(value));
	}
	const body = textOf(request.body);
	const contentType = request.body?.contentType;
	if (contentType !== undefined && contentType !== "") headers.set("content-type", contentType);
	return {
		request: new Request(url, {
			method: api.method.toUpperCase(),
			headers,
			...(body === undefined ? {} : { body: body as BodyInit }),
		}),
		body: { present: body !== undefined, contentType: headers.get("content-type") ?? undefined },
	};
}

interface Answer {
	readonly status: number;
	readonly body: unknown;
	readonly headers: Readonly<Record<string, unknown>>;
}

/** The response the mock declares, its headers as wire text. */
function answerOf(api: MockApi): Answer | string {
	const text = textOf(api.response.body);
	if (text !== undefined && !isJson(api.response.body?.contentType)) return "non-json-response";
	let body: unknown;
	if (text !== undefined) {
		body = JSON.parse(typeof text === "string" ? text : new TextDecoder().decode(text));
	}
	const headers = Object.fromEntries(
		Object.entries(api.response.headers ?? {}).map(([name, value]) => [name, wireTextOf(value)]),
	);
	return { status: api.response.status, body, headers };
}

/** The standard scalars whose header value is a JSON number to the library. */
const NUMERIC = new Set([
	"int8",
	"int16",
	"int32",
	"int64",
	"uint8",
	"uint16",
	"uint32",
	"uint64",
	"safeint",
	"integer",
	"float",
	"float32",
	"float64",
	"numeric",
	"decimal",
	"decimal128",
]);

/** The values a header's wire text may stand for, by the declared property's type and `@encode`. */
function decodedHeader(program: Program, text: string, property: ModelProperty): unknown[] {
	let scalar: Scalar | undefined = property.type.kind === "Scalar" ? property.type : undefined;
	while (scalar !== undefined && !program.checker.isStdType(scalar)) scalar = scalar.baseScalar;
	if (scalar === undefined) return [];
	const encoding = getEncode(program, property)?.encoding;
	const number = Number(text);
	const numeric = text.trim() !== "" && Number.isFinite(number) ? [number] : [];
	if (scalar.name === "boolean") return text === "true" ? [true] : text === "false" ? [false] : [];
	if (scalar.name === "utcDateTime" || scalar.name === "offsetDateTime") {
		if (encoding === "unixTimestamp") return numeric;
		const time = Date.parse(text);
		return Number.isNaN(time) ? [] : [new Date(time).toISOString()];
	}
	if (scalar.name === "duration") {
		return encoding === "seconds" || encoding === "milliseconds" ? numeric : [];
	}
	return NUMERIC.has(scalar.name) ? numeric : [];
}

/** The headers `operation` declares for a response with `status`, by wire name. */
function responseHeadersOf(operation: HttpOperation, status: number): [string, ModelProperty][] {
	return operation.responses
		.filter(({ statusCodes: codes }) =>
			typeof codes === "number"
				? codes === status
				: codes === "*" || (status >= codes.start && status <= codes.end),
		)
		.flatMap((response) => response.responses)
		.flatMap((content) => Object.entries(content.headers ?? {}));
}

/**
 * **The mock's response as the operation's handler returns it.** The corpus writes a response
 * header as wire text, by any letter case; a handler returns it under the name the operation
 * declares, in the type the library's header schema validates. So each header is keyed by its
 * declared name, matched without case, and its value is the wire text where the schema takes that,
 * or else the value the text stands for by the declared type: a number for a numeric or
 * `unixTimestamp` header, an ISO string for a date. A value the schema takes in no form stays wire
 * text, and the REST route refusing it is a finding.
 */
function handedAnswer(fixture: Fixture, operationId: string, answer: Answer): Answer {
	const root = fixture.roots.find((candidate) => candidate.operationId === operationId);
	if (root === undefined) return answer;
	const arms = fixture.library[root.names.responses] as readonly ResponseArm[];
	const arm = armFor(arms, answer.status);
	const schemaName = arm === undefined ? undefined : root.names.arms[arms.indexOf(arm)]?.headers;
	const schema =
		schemaName === undefined
			? undefined
			: (fixture.library[schemaName] as { readonly shape: Readonly<Record<string, ZodType>> });
	const declared = responseHeadersOf(root.operation, answer.status);
	const headers: Record<string, unknown> = {};
	for (const [wire, value] of Object.entries(answer.headers)) {
		const same = (name: string): boolean => name.toLowerCase() === wire.toLowerCase();
		const name = arm?.headers?.find((header) => same(header.name))?.name ?? wire;
		const property = declared.find(([key]) => same(key))?.[1];
		const field = schema?.shape[name];
		const text = String(value);
		const forms = [
			text,
			...(property === undefined ? [] : decodedHeader(fixture.program, text, property)),
		];
		headers[name] =
			forms.find((form) => field === undefined || field.safeParse(form).success) ?? text;
	}
	return { ...answer, headers };
}

const compared = { entries: 0, success: 0, errors: 0, nulls: 0 };
const skipped: Record<string, number> = {};
const violations: string[] = [];
let total = 0;
/** Each entry REST did not serve as the corpus says it should, by name: findings for typespec-hono. */
const restFindings: string[] = [];
/** Each entry no server should serve as the corpus has it, by name, with the spec's reason. */
const corpusEntries: string[] = [];
const skip = (reason: string, where?: string): void => {
	skipped[reason] = (skipped[reason] ?? 0) + 1;
	if (where !== undefined && reason.startsWith("rest-")) restFindings.push(`${reason}: ${where}`);
};
const corpus = (reason: string, where: string, why: string): void => {
	skipped[reason] = (skipped[reason] ?? 0) + 1;
	corpusEntries.push(`${reason}: ${where}: ${why}`);
};

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const left = a as Readonly<Record<string, unknown>>;
	const right = b as Readonly<Record<string, unknown>>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) if (!deepEqual(left[key], right[key])) return false;
	return true;
}

/** A, less what design.md says GraphQL never sends: every optional header. */
function expectedHandedOf(
	root: RootField,
	a: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const omitted = new Set(
		root.operation.parameters.parameters
			.filter((parameter) => dispositionOf(parameter) === "omitted")
			.map((parameter) => parameter.name),
	);
	return Object.fromEntries(Object.entries(a).filter(([key]) => !omitted.has(key)));
}

/** One mock entry, replayed against both surfaces. */
async function replay(
	fixture: Fixture,
	published: Published,
	rest: Hono,
	api: MockApi,
	where: string,
): Promise<void> {
	const sent = requestOf(api);
	if (typeof sent === "string") return skip(sent);
	const { request } = sent;
	const answer = answerOf(api);
	if (typeof answer === "string") return skip(answer);
	const { method } = request;
	const { pathname } = new URL(request.url);
	const asked = published.versionOf(pathname);
	if (asked !== undefined && asked !== published.latest) {
		return corpus(
			"old-version",
			where,
			`asks for ${asked}; the routes serve ${String(published.latest)}`,
		);
	}
	const { recorder } = fixture;

	recorder.reset();
	recorder.answer = (operationId) => handedAnswer(fixture, operationId, answer);
	const response = await rest.request(request);
	const [call] = recorder.calls;
	if (call === undefined) {
		const refused = response.status >= 400 && response.status < 500;
		if (refused && answer.status >= 400) {
			return corpus(
				"expected-refusal",
				where,
				`the corpus answers ${String(answer.status)}, REST refused ${String(response.status)} before any handler`,
			);
		}
		const unrouted = response.status === 404 || response.status === 405;
		if (unrouted && !published.declares(method, pathname)) {
			return corpus(
				"corpus-undeclared-route",
				where,
				`${method} ${pathname} is no route the spec declares`,
			);
		}
		const violation = refused ? published.requestViolation(method, pathname, sent.body) : undefined;
		if (violation !== undefined) {
			return corpus("corpus-request-violates-document", where, violation);
		}
		return skip(unrouted ? "rest-unrouted" : `rest-refused-${String(response.status)}`, where);
	}
	if (response.status !== answer.status) {
		const violation = published.responseViolation(method, pathname, answer.status, answer.body);
		if (violation !== undefined) {
			return corpus("corpus-response-violates-document", where, violation);
		}
		return skip("rest-response-refused", where);
	}
	const a = call.input as Readonly<Record<string, unknown>>;
	const root = fixture.roots.find((candidate) => candidate.operationId === call.operationId);
	if (root === undefined) return skip("surface-dropped");
	const paging = root.kind === "query" ? pagingOf(fixture.program, root.operation) : undefined;
	if (paging !== undefined && Object.prototype.hasOwnProperty.call(a, paging.after)) {
		return skip("continuation-token");
	}

	let args: Readonly<Record<string, unknown>>;
	try {
		args = argumentsFor(fixture, root, a).args;
	} catch (error) {
		if (!(error instanceof Untranslatable)) throw error;
		return skip("untranslatable");
	}
	recorder.reset();
	recorder.answer = (operationId) => handedAnswer(fixture, operationId, answer);
	const result: GraphQLResult = await executeThroughYoga(
		fixture.schema,
		documentFor(fixture, root, args),
		{},
	);
	const b = recorder.calls.find((candidate) => candidate.operationId === root.operationId)?.input;
	compared.entries += 1;

	if (b === undefined) {
		violations.push(
			`${where}: REST called ${root.operationId}, GraphQL called nothing: ${JSON.stringify(result.errors?.map((error) => error.message))}`,
		);
		return;
	}
	const handed = expectedHandedOf(root, a);
	if (!deepEqual(b, handed)) {
		violations.push(
			`${where}: GraphQL handed ${JSON.stringify(b)}, REST handed ${JSON.stringify(handed)}`,
		);
	}

	const arms = fixture.library[root.names.responses] as readonly ResponseArm[];
	const arm = armFor(arms, answer.status);
	const parsed = arm?.schema === undefined ? undefined : arm.schema.parse(answer.body);
	const value = result.data?.[root.name];
	const status = answer.status;
	if (isSuccess(status) || (root.kind === "mutation" && isMember(status))) {
		compared.success += 1;
		let expected: unknown;
		try {
			expected = expectedFor(fixture, root, status, parsed, arms);
		} catch (error) {
			if (!(error instanceof Untranslatable)) throw error;
			return skip("untranslatable-response");
		}
		if (result.errors !== undefined) {
			violations.push(
				`${where}: answered errors ${JSON.stringify(result.errors.map((error) => error.message))} for ${String(status)}`,
			);
		} else if (!deepEqual(asExpected(value, expected), expected)) {
			violations.push(
				`${where}: answered ${JSON.stringify(asExpected(value, expected))}, expected ${JSON.stringify(expected)}`,
			);
		}
		return;
	}
	if (root.kind === "query" && status === 404) {
		compared.nulls += 1;
		if (value !== null || result.errors !== undefined) {
			violations.push(
				`${where}: a 404 answered ${JSON.stringify(value)} with errors ${JSON.stringify(result.errors)}`,
			);
		}
		return;
	}
	compared.errors += 1;
	const [error] = result.errors ?? [];
	const code = CODES[status];
	if (status >= 300 && status < 400) {
		if (error?.message !== "Unexpected error.") {
			violations.push(
				`${where}: a ${String(status)} answered ${JSON.stringify(result.errors)}, not a masked error`,
			);
		}
		return;
	}
	const extensions = error?.extensions ?? {};
	if (
		extensions["code"] !== code ||
		extensions["status"] !== status ||
		!deepEqual(extensions["body"], parsed)
	) {
		violations.push(
			`${where}: a ${String(status)} answered ${JSON.stringify(result.errors)}, expected code ${String(code)} with the body`,
		);
	}
}

beforeAll(async () => {
	const specsRoot = realpathSync(
		join(packageRoot, "node_modules", "@typespec", "http-specs", "specs"),
	);
	const corpusRoot = dirname(specsRoot);
	for (const { name, main } of corpusScenarios()) {
		const mocks = join(
			corpusRoot,
			"dist",
			"specs",
			relative(specsRoot, dirname(main)),
			"mockapi.js",
		);
		const { Scenarios } = (await import(mocks)) as {
			readonly Scenarios: Readonly<Record<string, { readonly apis: readonly MockApi[] }>>;
		};
		const entries = Object.entries(Scenarios).flatMap(([scenario, mock]) =>
			mock.apis.map((api, index) => ({ api, where: `${name} ${scenario}#${String(index)}` })),
		);
		total += entries.length;
		const spec = join(outRoot, name, "spec");
		await declareEveryOperation(main, spec);
		const documentDir = join(outRoot, name, "document");
		await publishDocument(main, documentDir);
		const loaded = await loadFixture(
			`corpus:${name}`,
			join(spec, "graphql.tsp"),
			join(outRoot, name, "emitted"),
			{
				withServer: true,
				expectedErrors: libraryRefusalsOf(name),
				openApiVersions: openApiVersionsOf(`corpus:${name}`),
				documentDir,
			},
		);
		if ("skip" in loaded) {
			for (const _ of entries) skip(`fixture-${loaded.skip}`);
			continue;
		}
		const published = publishedBy(loaded.fixture.program, documentDir);
		if (typeof published === "string") {
			for (const _ of entries) skip(`fixture-${published}`);
			continue;
		}
		const routes = (await import(join(loaded.fixture.serverDir, "app.gen.ts"))) as {
			readonly registerRoutes: (
				app: Hono,
				handlersFor: () => object,
				deps: typeof REST_DEPS,
			) => void;
		};
		const served = new Hono();
		routes.registerRoutes(served, () => loaded.fixture.recorder.handlers, REST_DEPS);
		// Mounted where a deployer mounts the routes: under the `@server` URL's path, which
		// typespec-hono's routes leave out (bison-digital/typespec-hono#3).
		const rest = published.prefix === "" ? served : new Hono().route(published.prefix, served);
		for (const { api, where } of entries) {
			await replay(loaded.fixture, published, rest, api, where);
		}
	}
}, 1_800_000);

afterAll(() => {
	mkdirSync(outRoot, { recursive: true });
	writeFileSync(
		join(outRoot, "report.json"),
		`${JSON.stringify({ total, compared, skipped, violations, restFindings, corpus: corpusEntries }, null, "\t")}\n`,
	);
});

describe("the corpus's own requests, through REST and GraphQL", () => {
	it("hands the handler what REST hands it, and answers what design.md gives the response", () => {
		expect(violations).toEqual([]);
	});

	it("compared most of what the corpus declares, and holds every count to the baseline", () => {
		expect(total).toBeGreaterThanOrEqual(800);
		const { problems } = ratchet(
			join(fileURLToPath(new URL(".", import.meta.url)), "baseline.json"),
			"Spector replay: every @typespec/http-specs mock request sent to typespec-hono and to the " +
				"GraphQL surface with one handler behind both. Floors: entries compared, as a success value, " +
				"a 404 null and a top-level error. Ceilings: every entry not compared, by why; rest-* are " +
				"findings, corpus-*, expected-refusal and old-version entries no server should serve as the " +
				"corpus has them, each listed with its reason. The full list " +
				"of what was found is in .out-replay/report.json. Held by test/support/ratchet.ts.",
			{
				floors: {
					"mocks:declared": total,
					"mocks:compared": compared.entries,
					"mocks:compared-success": compared.success,
					"mocks:compared-null": compared.nulls,
					"mocks:compared-error": compared.errors,
				},
				ceilings: skipped,
			},
		);
		expect(problems).toEqual([]);
	});
});
