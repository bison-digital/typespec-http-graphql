import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compile, NodeHost, type Program } from "@typespec/compiler";
import { getAllHttpServices, getServers, type HttpOperation } from "@typespec/http";
import { resolveOperationId } from "@typespec/openapi";
import { getVersion } from "@typespec/versioning";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/**
 * **What a corpus scenario's spec publishes, read from the spec and from the document
 * `@typespec/openapi3` writes for it: never from either server under test.**
 *
 * The replay asks it what a server's refusal cannot say for itself: where a deployer mounts the
 * routes, which version they serve, whether a request the corpus sends is for any operation the spec
 * declares, and whether a request or response the corpus sends is one the published document allows.
 * The corpus is written for clients, and some of its entries test how a client copes with a server
 * that breaks the contract; a server refusing those is right, and they are counted apart from the
 * refusals that are findings.
 *
 * **The document, not the library's Zod.** The library is one of the two servers the replay grades,
 * and it refuses some things the document allows (a date-time header as an HTTP-date, an extensible
 * discriminator it does not know); judging the corpus by it would file those findings as the
 * corpus's fault. OpenAPI's `discriminator` is an annotation (OAS 3.1.1 § 4.8.25), so it is not
 * enforced here: validation is `oneOf`, `anyOf`, `required` and `enum`, as the schema states them.
 */
export interface Published {
	/** Where the routes are mounted: the `@server` URL's path, its version parameter the latest. */
	readonly prefix: string;
	/** The version the routes serve, the last the spec declares; `undefined` when unversioned. */
	readonly latest: string | undefined;
	/** The version a request asks for in its path, by the `@server` template; `undefined` if none. */
	versionOf(pathname: string): string | undefined;
	/** Whether any operation the spec declares, in any version, is routed at `method pathname`. */
	declares(method: string, pathname: string): boolean;
	/** Why a request breaks every operation it could be for, by the document; or `undefined`. */
	requestViolation(method: string, pathname: string, body: SentBody): string | undefined;
	/** Why a response body breaks what every operation routed there publishes; or `undefined`. */
	responseViolation(
		method: string,
		pathname: string,
		status: number,
		body: unknown,
	): string | undefined;
}

export interface SentBody {
	readonly present: boolean;
	readonly contentType: string | undefined;
}

interface DocumentOperation {
	readonly operationId?: string;
	readonly requestBody?: {
		readonly required?: boolean;
		readonly content?: Readonly<Record<string, unknown>>;
	};
	readonly responses?: Readonly<
		Record<string, { readonly content?: Readonly<Record<string, { readonly schema?: object }>> }>
	>;
}

interface Document {
	readonly paths?: Readonly<Record<string, Readonly<Record<string, DocumentOperation>>>>;
	readonly components?: object;
}

const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An RFC 6570 path template as a pattern over a request path: a literal as itself, a simple
 * expression one segment's text, `{+x}` anything, and `{/x}`, `{;x}` and `{.x}` as many of their
 * prefixed parts as are sent. Query expressions are dropped: a path is matched, not a query.
 */
function pathPattern(template: string): string {
	let pattern = "";
	for (const [, expression, literal] of template.matchAll(/\{([^}]*)\}|([^{]+)/g)) {
		if (literal !== undefined) {
			const cut = literal.indexOf("?");
			if (cut >= 0) return pattern + escape(literal.slice(0, cut));
			pattern += escape(literal);
			continue;
		}
		switch (expression?.[0]) {
			case "?":
			case "&":
				break;
			case "+":
			case "#":
				pattern += ".*";
				break;
			case "/":
				pattern += "(?:/[^/]*)*";
				break;
			case ";":
				pattern += "(?:;[^/]*)*";
				break;
			case ".":
				pattern += "(?:\\.[^/]*)*";
				break;
			default:
				pattern += "[^/]*";
		}
	}
	return pattern;
}

/** The media type of a `Content-Type`, without its parameters. */
const mediaTypeOf = (contentType: string): string =>
	(contentType.split(";")[0] ?? "").trim().toLowerCase();

/**
 * Everything the spec publishes for one scenario, or why it cannot be read: a `@server` whose path
 * has a parameter that is neither the version nor defaulted cannot be mounted by a deployer either.
 */
export function publishedBy(program: Program, documentDir: string): Published | string {
	const [services] = getAllHttpServices(program);
	const [service] = services;
	if (service === undefined) return "no-service";
	if (services.length > 1) return "several-services";

	const versions = getVersion(program, service.namespace)?.getVersions();
	const newest = versions?.at(-1);
	const latest = newest?.value;
	const versionEnum = newest?.enumMember.enum;

	const [server] = getServers(program, service.namespace) ?? [];
	let template = "";
	if (server !== undefined) {
		template = server.url.startsWith("{")
			? server.url.slice(server.url.indexOf("}") + 1)
			: new URL(server.url).pathname;
	}
	template = template.replace(/\/$/, "");
	let prefix = "";
	let versionPattern = "";
	let versioned = false;
	for (const [, name, literal] of template.matchAll(/\{([^}]*)\}|([^{]+)/g)) {
		if (literal !== undefined) {
			prefix += literal;
			versionPattern += escape(literal);
			continue;
		}
		const parameter = name === undefined ? undefined : server?.parameters.get(name);
		const fallback = parameter?.defaultValue;
		if (parameter !== undefined && versionEnum !== undefined && parameter.type === versionEnum) {
			if (latest === undefined) return "server-version-unknown";
			prefix += latest;
			versionPattern += "([^/]+)";
			versioned = true;
		} else if (fallback?.valueKind === "StringValue") {
			prefix += fallback.value;
			versionPattern += "[^/]+";
		} else {
			return `server-parameter-unresolved`;
		}
	}
	const version = new RegExp(`^${versionPattern}`);

	const routes = service.operations.map((operation) => ({
		operation,
		verb: operation.verb,
		pattern: new RegExp(`^${escape(prefix)}${pathPattern(operation.uriTemplate)}$`),
	}));
	const routed = (method: string, pathname: string): HttpOperation[] =>
		routes
			.filter((route) => route.verb === method.toLowerCase() && route.pattern.test(pathname))
			.map((route) => route.operation);

	const document = documentIn(documentDir, latest, newest?.name);
	const byId = new Map<string, DocumentOperation>();
	for (const item of Object.values(document?.paths ?? {})) {
		for (const operation of Object.values(item)) {
			if (typeof operation === "object" && typeof operation.operationId === "string") {
				byId.set(operation.operationId, operation);
			}
		}
	}
	const documented = (operation: HttpOperation): DocumentOperation | undefined =>
		byId.get(resolveOperationId(program, operation.operation));

	const ajv = new Ajv2020({ strict: false, validateFormats: false, validateSchema: false });
	const validators = new Map<object, ValidateFunction>();
	const validatorOf = (schema: object): ValidateFunction => {
		let validate = validators.get(schema);
		if (validate === undefined) {
			// The document's components beside the schema, so its `#/components/...` refs resolve.
			validate = ajv.compile({ ...schema, components: document?.components });
			validators.set(schema, validate);
		}
		return validate;
	};

	return {
		prefix,
		latest,
		versionOf: (pathname) => (versioned ? version.exec(pathname)?.[1] : undefined),
		declares: (method, pathname) => routed(method, pathname).length > 0,
		requestViolation(method, pathname, body) {
			const candidates = routed(method, pathname).map(documented);
			if (candidates.length === 0 || candidates.some((operation) => operation === undefined)) {
				return undefined;
			}
			const reasons = candidates.map((operation) => {
				const requestBody = operation?.requestBody;
				if (body.present && requestBody === undefined) return "a body the operation does not take";
				if (body.present && body.contentType !== undefined && requestBody?.content !== undefined) {
					const sent = mediaTypeOf(body.contentType);
					const published = Object.keys(requestBody.content).map(mediaTypeOf);
					if (!published.includes(sent)) {
						return `a ${sent} body, where the document publishes ${published.join(", ")}`;
					}
				}
				if (!body.present && requestBody?.required === true) return "no body, which is required";
				return undefined;
			});
			return reasons.every((reason) => reason !== undefined)
				? [...new Set(reasons)].join("; ")
				: undefined;
		},
		responseViolation(method, pathname, status, body) {
			const candidates = routed(method, pathname).map(documented);
			if (candidates.length === 0 || body === undefined) return undefined;
			const reasons = candidates.map((operation) => {
				const responses = operation?.responses;
				if (responses === undefined) return undefined;
				const response =
					responses[String(status)] ??
					responses[`${String(Math.floor(status / 100))}XX`] ??
					responses["default"];
				if (response === undefined) return `status ${String(status)}, which is not published`;
				const content = response.content ?? {};
				const json = Object.keys(content).find((type) =>
					/^application\/(?:[\w.+-]+\+)?json\b/i.test(type),
				);
				const schema = json === undefined ? undefined : content[json]?.schema;
				if (schema === undefined) return undefined;
				const validate = validatorOf(schema);
				if (validate(body)) return undefined;
				return `a body the published schema refuses: ${(validate.errors ?? [])
					.map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
					.join("; ")}`;
			});
			return reasons.every((reason) => reason !== undefined)
				? [...new Set(reasons)].join("; ")
				: undefined;
		},
	};
}

/**
 * **The document `@typespec/openapi3` publishes for a scenario's own `main.tsp`**, in OpenAPI 3.1,
 * whose schemas are JSON Schema 2020-12, written into `dir`. A compile of its own, apart from the
 * fixture's: where openapi3 refuses a scenario, the replay loses this evidence and nothing else, and
 * every refusal it would have explained stays a finding.
 */
export async function publishDocument(main: string, dir: string): Promise<void> {
	rmSync(dir, { recursive: true, force: true });
	try {
		await compile(NodeHost, main, {
			outputDir: dir,
			emit: ["@typespec/openapi3"],
			options: {
				"@typespec/openapi3": {
					"emitter-output-dir": dir,
					"file-type": "json",
					"openapi-versions": ["3.1.0"],
				},
			},
		});
	} catch {
		// No document, so no evidence: `publishedBy` then explains no refusal.
	}
}

/** The latest version's document: `openapi.<version>.json` for a versioned spec, else `openapi.json`. */
function documentIn(
	dir: string,
	value: string | undefined,
	name: string | undefined,
): Document | undefined {
	const names = [
		...(value === undefined ? [] : [`openapi.${value}.json`]),
		...(name === undefined ? [] : [`openapi.${name}.json`]),
		"openapi.json",
	];
	const file = names.map((candidate) => join(dir, candidate)).find((path) => existsSync(path));
	return file === undefined ? undefined : (JSON.parse(readFileSync(file, "utf8")) as Document);
}
