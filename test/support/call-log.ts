/**
 * **Every handler call one test made, in order, with the input each was handed.**
 *
 * The acceptance arms are about calls as much as values: a link whose bound id is `null` must make
 * NO call, fifty parents of one author must make ONE, and a header argument must reach the handler
 * under its wire name. A count or an input can only be asserted if something recorded it.
 *
 * Inputs are cloned when recorded, so a handler that mutates its input cannot rewrite the log.
 */

/** One handler call: which operation, and the input it was handed, as it was handed. */
export interface Call {
	readonly operationId: string;
	readonly input: Readonly<Record<string, unknown>>;
}

type Handler = (context: never, input: never) => unknown;

export class CallLog {
	readonly #calls: Call[] = [];

	get calls(): readonly Call[] {
		return this.#calls;
	}

	/** The same handlers, each recording its call before it runs. One wrapped object serves every surface. */
	wrap<T extends Readonly<Record<string, Handler>>>(handlers: T): T {
		const wrapped: Record<string, Handler> = {};
		for (const [operationId, handler] of Object.entries(handlers)) {
			wrapped[operationId] = (context, input) => {
				this.#calls.push({
					operationId,
					input: structuredClone(input as Readonly<Record<string, unknown>>),
				});
				return handler(context, input);
			};
		}
		return wrapped as T;
	}

	count(operationId: string): number {
		return this.#calls.filter((call) => call.operationId === operationId).length;
	}

	inputsOf(operationId: string): readonly Readonly<Record<string, unknown>>[] {
		return this.#calls.filter((call) => call.operationId === operationId).map((call) => call.input);
	}

	clear(): void {
		this.#calls.length = 0;
	}
}
