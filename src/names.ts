import { camelCase, constantCase, pascalCase, split, splitSeparateNumbers } from "change-case";

/**
 * GraphQL names, by the conventions graphql.org, Apollo and the large public schemas share: types
 * PascalCase, fields and arguments camelCase, enum values CONSTANT_CASE.
 *
 * **The pipeline is upstream's, step for step**: `@typespec/graphql`'s `src/lib/naming.ts` (MIT),
 * so a model is named the same by either emitter. `test/names/upstream.test.ts` grades every
 * function here against a copy of that file vendored at a pinned commit.
 *
 * **One departure, and the oracle names it.** Upstream can produce a name that starts with `__`
 * (`"--"`, `"__typename"`), which GraphQL reserves for introspection and graphql-js refuses. Every
 * name produced here collapses a leading run of underscores to one, so every name is valid.
 *
 * PURE: it imports `change-case` and nothing else, no compiler and no Node builtin, so no name it
 * produces depends on the environment the emitter runs in. A wire name is never changed by this;
 * resolvers map back to it.
 */

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** graphql-js's name rule, and the reservation of a leading `__` for introspection. */
export function isGraphQLName(name: string): boolean {
	return GRAPHQL_NAME.test(name) && !name.startsWith("__");
}

function stripNamespace(name: string): string {
	const parts = name.trim().split(".");
	return parts[parts.length - 1] ?? name;
}

function sanitize(name: string): string {
	const replaced = name.replaceAll("[]", "Array").replaceAll(/\W/g, "_");
	return /^[_a-zA-Z]/.test(replaced) ? replaced : `_${replaced}`;
}

/**
 * Upstream's splitter: an all-caps run inside a mixed-case name is split into letters, so
 * `XMLParser` and `HTTPStatus` keep their capitals through the case conversion.
 */
function splitWithAcronyms(skipStart: boolean, name: string): string[] {
	const parts = split(name);
	if (name === name.toUpperCase()) return parts;
	return parts.flatMap((part, index) => {
		if (skipStart && index === 0) return part;
		if (/^[A-Z]+$/.test(part)) return part.split("");
		return part;
	});
}

function toPascal(name: string): string {
	if (/^[A-Z]+$/.test(name)) return name;
	return pascalCase(name, { prefixCharacters: "_", split: splitWithAcronyms.bind(null, false) });
}

/** The departure: `__` is introspection's, so a leading run of underscores becomes one. */
function unreserved(name: string): string {
	return name.replace(/^_{2,}/, "_");
}

/** A type name: the namespace stripped, PascalCase. Always a valid GraphQL name. */
export function typeNameOf(raw: string): string {
	return unreserved(toPascal(sanitize(stripNamespace(raw))));
}

/** A field or argument name: camelCase. Always a valid GraphQL name. */
export function fieldNameOf(raw: string): string {
	return unreserved(
		camelCase(sanitize(raw), { prefixCharacters: "_", split: splitWithAcronyms.bind(null, true) }),
	);
}

/** An enum value name: CONSTANT_CASE, digits split off as upstream splits them. Always valid. */
export function enumValueNameOf(raw: string): string {
	return unreserved(
		constantCase(sanitize(raw), { split: splitSeparateNumbers, prefixCharacters: "_" }),
	);
}

const RANGE_NAMES: Readonly<Record<string, string>> = {
	"1XX": "Informational",
	"2XX": "Success",
	"3XX": "Redirection",
	"4XX": "ClientError",
	"5XX": "ServerError",
	default: "Default",
};

/**
 * **The reason phrase of every status code a server can answer with**: every code in
 * `typespec-http-zod`'s `STATUS_CODES`, which `test/names/names.test.ts` checks.
 *
 * **Fixed here rather than read from `node:http`**, so a generated type name or error code never
 * depends on the Node that runs the emitter. Node 22 still says "Payload Too Large" and
 * "Unprocessable Entity" where RFC 9110 renamed both, and a release that caught up would have
 * renamed generated types under every consumer.
 *
 * Sources:
 * - RFC 9110 (HTTP Semantics) § 15 for every code it defines;
 * - the IANA HTTP Status Code Registry (https://www.iana.org/assignments/http-status-codes) for the
 *   rest, with the RFC that registered each named beside it.
 *
 * RFC 9110 marks two codes "(Unused)". 306 keeps that word. 418 keeps "I'm a teapot", the phrase
 * of RFC 2324 that RFC 9110 § 15.5.19 reserves the code over, since it is what every deployment
 * that sends 418 means by it.
 */
const REASON_PHRASES: Readonly<Record<number, string>> = {
	100: "Continue",
	101: "Switching Protocols",
	102: "Processing", // IANA, RFC 2518
	103: "Early Hints", // IANA, RFC 8297
	200: "OK",
	201: "Created",
	202: "Accepted",
	203: "Non-Authoritative Information",
	204: "No Content",
	205: "Reset Content",
	206: "Partial Content",
	207: "Multi-Status", // IANA, RFC 4918
	208: "Already Reported", // IANA, RFC 5842
	226: "IM Used", // IANA, RFC 3229
	300: "Multiple Choices",
	301: "Moved Permanently",
	302: "Found",
	303: "See Other",
	304: "Not Modified",
	305: "Use Proxy",
	306: "Unused",
	307: "Temporary Redirect",
	308: "Permanent Redirect",
	400: "Bad Request",
	401: "Unauthorized",
	402: "Payment Required",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	406: "Not Acceptable",
	407: "Proxy Authentication Required",
	408: "Request Timeout",
	409: "Conflict",
	410: "Gone",
	411: "Length Required",
	412: "Precondition Failed",
	413: "Content Too Large",
	414: "URI Too Long",
	415: "Unsupported Media Type",
	416: "Range Not Satisfiable",
	417: "Expectation Failed",
	418: "I'm a teapot", // RFC 2324, reserved by RFC 9110 § 15.5.19
	421: "Misdirected Request",
	422: "Unprocessable Content",
	423: "Locked", // IANA, RFC 4918
	424: "Failed Dependency", // IANA, RFC 4918
	425: "Too Early", // IANA, RFC 8470
	426: "Upgrade Required",
	428: "Precondition Required", // IANA, RFC 6585
	429: "Too Many Requests", // IANA, RFC 6585
	431: "Request Header Fields Too Large", // IANA, RFC 6585
	451: "Unavailable For Legal Reasons", // IANA, RFC 7725
	500: "Internal Server Error",
	501: "Not Implemented",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
	505: "HTTP Version Not Supported",
	506: "Variant Also Negotiates", // IANA, RFC 2295
	507: "Insufficient Storage", // IANA, RFC 4918
	508: "Loop Detected", // IANA, RFC 5842
	510: "Not Extended", // IANA, RFC 2774 (registered as obsoleted)
	511: "Network Authentication Required", // IANA, RFC 6585
};

/**
 * A status's reason phrase, with the apostrophe in "I'm a teapot" dropped so it reads as one word
 * rather than splitting off an `M`.
 */
function phraseOf(status: number): string | undefined {
	return REASON_PHRASES[status]?.replaceAll("'", "");
}

/**
 * A status as a type-name suffix: its reason phrase in PascalCase (`404` → `NotFound`,
 * `"4XX"` → `ClientError`), so a wrapper reads `CreateBookNoContent`.
 */
export function reasonTypeNameOf(status: number | string): string {
	const range = RANGE_NAMES[String(status)];
	if (range !== undefined) return range;
	const phrase = phraseOf(Number(status));
	return phrase === undefined ? `Status${String(status)}` : typeNameOf(phrase);
}

/**
 * A status as an error code: its reason phrase in CONSTANT_CASE (`410` → `GONE`, `412` →
 * `PRECONDITION_FAILED`), the form Apollo's own codes take (`INTERNAL_SERVER_ERROR`).
 */
export function reasonCodeOf(status: number): string {
	const phrase = phraseOf(status);
	return phrase === undefined ? `STATUS_${status}` : enumValueNameOf(phrase);
}

export interface Collision {
	readonly name: string;
	readonly first: string;
	readonly second: string;
}

/**
 * Who owns each GraphQL name. A second owner claiming a taken name is a collision.
 *
 * **Every owner is kept, not only the first**, because the caller drops every party to a collision:
 * keeping the first would make the schema depend on the order things were walked in.
 * `owners(name)` is how the caller finds them all.
 */
export class NameBook {
	readonly #owners = new Map<string, string[]>();
	readonly #collisions: Collision[] = [];

	get collisions(): readonly Collision[] {
		return this.#collisions;
	}

	/** True when `owner` is the name's first owner; false, and the collision recorded, otherwise. */
	claim(name: string, owner: string): boolean {
		const owners = this.#owners.get(name);
		if (owners === undefined) {
			this.#owners.set(name, [owner]);
			return true;
		}
		const first = owners[0];
		if (first === owner) return true;
		if (!owners.includes(owner)) {
			owners.push(owner);
			if (first !== undefined) this.#collisions.push({ name, first, second: owner });
		}
		return false;
	}

	/** Every owner that claimed `name`, first claimant first. */
	owners(name: string): readonly string[] {
		return this.#owners.get(name) ?? [];
	}
}
