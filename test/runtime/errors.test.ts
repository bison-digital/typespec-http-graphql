import {
	ResponseContractError as ServerResponseContractError,
	UndeclaredStatusError as ServerUndeclaredStatusError,
} from "typespec-hono/runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	InputAssemblyError,
	ResponseContractError,
	UndeclaredStatusError,
	UnprojectedStatusError,
} from "../../src/runtime.js";

/**
 * **The errors a server masks, as the developer reading its log meets them.** Two are the sibling
 * server emitter's own classes, copied because emitted output never imports a library, so they are
 * graded against `typespec-hono/runtime`'s: the same message and fields for the same arguments. The
 * two only this package throws are held to messages written out here.
 */

const issues = z.object({ message: z.string() }).safeParse({}).error?.issues ?? [];

describe("the classes the sibling server emitter declares", () => {
	it("ResponseContractError says what the server's says, with the same fields", () => {
		const mine = new ResponseContractError("Books_create", 409, issues);
		const theirs = new ServerResponseContractError("Books_create", 409, issues);
		expect(issues).not.toEqual([]);
		expect({
			message: mine.message,
			name: mine.name,
			operationId: mine.operationId,
			status: mine.status,
			issues: mine.issues,
		}).toEqual({
			message: theirs.message,
			name: theirs.name,
			operationId: theirs.operationId,
			status: theirs.status,
			issues: theirs.issues,
		});
		expect(mine).toBeInstanceOf(Error);
	});

	/** Every shape a handler's result can take, including the ones that carry no status at all. */
	it.each([
		["a declared shape with an undeclared status", { status: 418, body: {} }],
		["a status that is a string", { status: "418" }],
		["an object with no status", {}],
		["null", null],
		["undefined", undefined],
		["a string", "418"],
		["a number", 418],
	])("UndeclaredStatusError says what the server's says, for %s", (_shape, result) => {
		const mine = new UndeclaredStatusError("Books_create", result);
		const theirs = new ServerUndeclaredStatusError("Books_create", result);
		expect({
			message: mine.message,
			name: mine.name,
			operationId: mine.operationId,
			result: mine.result,
		}).toEqual({
			message: theirs.message,
			name: theirs.name,
			operationId: theirs.operationId,
			result: theirs.result,
		});
	});

	/** The comparison above means something only if the messages it compares tell results apart. */
	it("names the status a result carries, and says when it carries none", () => {
		expect(new UndeclaredStatusError("Books_create", { status: 418 }).message).toBe(
			"Books_create answered 418, which its document does not declare",
		);
		expect(new UndeclaredStatusError("Books_create", null).message).toBe(
			"Books_create answered no status, which its document does not declare",
		);
	});
});

describe("the classes only this package throws", () => {
	it("UnprojectedStatusError names the operation and the status its field does not project", () => {
		const error = new UnprojectedStatusError("Books_create", 302);
		expect({
			message: error.message,
			name: error.name,
			operationId: error.operationId,
			status: error.status,
		}).toEqual({
			message: "Books_create answered 302, which its GraphQL field does not project",
			name: "UnprojectedStatusError",
			operationId: "Books_create",
			status: 302,
		});
	});

	it("InputAssemblyError names the operation and the key it does not declare", () => {
		const error = new InputAssemblyError("Books_read", "book-id");
		expect({
			message: error.message,
			name: error.name,
			operationId: error.operationId,
			key: error.key,
		}).toEqual({
			message: "Books_read was assembled an input key it does not declare: book-id",
			name: "InputAssemblyError",
			operationId: "Books_read",
			key: "book-id",
		});
	});
});
