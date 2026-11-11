import { NextRequest } from "next/server";

// Requests a page makes as it opens, answered while its document renders.
//
// Each is put to the same route handler the browser would reach, under the
// headers of the request for the document, so the answer carries the same
// access checks and the same shape. Keyed as the browser asks for each, and
// handed to it with the document, so it draws from these rather than asking.
// One that fails or refuses is left out and the browser asks for it as before.
//
// Every request answered here is one the server does not have to route,
// authenticate and answer separately, which is most of what a small request
// costs it.

// Each route declares its own parameters, so a handler is taken whatever they
// are and given the ones its ask names.
type Handler = (request: NextRequest, context: never) => Promise<Response>;

export interface Ask {
	// The key the browser asks under, which is also the address put to the
	// handler.
	key: string;
	handler: Handler;
	// The route's parameters, for a handler under a dynamic segment.
	params?: Record<string, string>;
}

// How long one ask may take before it is left out. Each ask has its own, so one that has
// to reach the warehouse, such as a goal's figure, cannot use up the budget the whole page
// renders under and cost every other answer with it.
const askDeadlineMs = 150;

export async function answeredHere(
	incoming: Headers,
	asks: Ask[],
): Promise<Record<string, unknown>> {
	const answered = await Promise.all(
		asks.map(async ({ key, handler, params }) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const answer = (async () => {
					const response = await handler(
						new NextRequest(new URL(key, "http://localhost"), {
							headers: incoming,
						}),
						{ params: Promise.resolve(params ?? {}) } as never,
					);
					if (!response.ok) return null;
					return [key, await response.json()] as const;
				})();
				// A late answer is dropped here and the browser asks for it as before.
				answer.catch(() => {});
				return await Promise.race([
					answer,
					new Promise<null>((resolve) => {
						timer = setTimeout(() => resolve(null), askDeadlineMs);
					}),
				]);
			} catch {
				return null;
			} finally {
				clearTimeout(timer);
			}
		}),
	);
	return Object.fromEntries(answered.filter((a) => a !== null));
}
