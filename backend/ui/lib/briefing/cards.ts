import { todayIn } from "../alerts/anomaly";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { intervalFor, requestCheck } from "../freshness/checker";
import { overdue } from "../freshness/marks";
import { answerTtlSeconds, isShareable } from "../query/cache";
import { assertCanReadSource, QueryAccessError } from "../query/execute";
import { QuerySpecError } from "../query/spec";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import type { Card } from "./card";
import { cardKey, cardScope } from "./keys";
import {
	BriefingItemError,
	checkItem,
	computeCard,
	type ComputedCard,
} from "./read";
import { readCards, writeCard, type StoredCard } from "./store";
import type { WatchItem } from "./watch";

// The cards of one briefing, as they become known.
//
// Every stored card is handed over first, fresh or not, so the page draws
// the last figures at once. Each one that is not fresh is then worked out
// under the reader's own token and handed over again. The first reader after
// a change works out a shared card for everyone it may be shared with, and
// a reader arriving while that is under way waits on the same work.

export interface CardEvent {
	id: string;
	card: Card | null;
	// True while a newer card is being worked out behind this one.
	updating: boolean;
	error?: string;
}

// Cards worked out at once for one reader. Each is one warehouse question for
// its history, then one per breakdown asked together.
const parallel = 6;

// Work under way on this replica, by card and day.
const working = new Map<string, Promise<ComputedCard>>();

interface Due {
	item: WatchItem;
	source: SemanticSource;
	scope: string;
	key: string;
	held: StoredCard | undefined;
}

function withId(card: Card | null, id: string): Card | null {
	return card ? { ...card, id } : null;
}

function messageOf(error: unknown): string {
	if (
		error instanceof QueryAccessError ||
		error instanceof BriefingItemError ||
		error instanceof QuerySpecError
	)
		return error.message;
	console.error("A briefing figure could not be read:", error);
	return "This figure could not be read.";
}

// A watched dataset that has gone too long without a look, because the
// warehouse was stopped, is looked at now, as a report page would ask.
function nudge(source: SemanticSource): void {
	if (overdue(source.sourceKey, intervalFor(source)))
		requestCheck(source.sourceKey);
}

function workOut(
	identity: Identity,
	due: Due,
	today: string,
): Promise<ComputedCard> {
	const flight = `${due.key}|${today}`;
	const existing = working.get(flight);
	if (existing) return existing;
	const run = computeCard(identity, due.item, today)
		.then((computed) => {
			void writeCard({
				key: due.key,
				today,
				scope: due.scope,
				sourceKey: due.item.sourceKey,
				card: computed.card,
				computedAt: computed.computedAt,
				expiresAt:
					computed.computedAt + answerTtlSeconds(due.source) * 1000,
			});
			return computed;
		})
		.finally(() => working.delete(flight));
	working.set(flight, run);
	return run;
}

export async function briefingCards(
	identity: Identity,
	items: WatchItem[],
	timeZone: string,
	emit: (event: CardEvent) => void,
): Promise<void> {
	const today = todayIn(timeZone);
	const policy = await resolvePolicyClass(identity);
	// A class that could not be resolved means the platform does not know
	// what this reader may see, so nothing is handed over.
	if (policy.degraded) {
		for (const item of items)
			emit({
				id: item.id,
				card: null,
				updating: false,
				error: "Access could not be verified. Group membership is temporarily unavailable.",
			});
		return;
	}

	const checked: Omit<Due, "held">[] = [];
	await Promise.all(
		items.map(async (raw) => {
			try {
				const item = checkItem(raw);
				await assertCanReadSource(identity, item.sourceKey);
				const source = getSource(item.sourceKey) as SemanticSource;
				const scope = cardScope(
					{
						shareable: isShareable(source),
						filtered: source.hasRowFilter,
					},
					policy.id,
					identity.email,
				);
				checked.push({
					item,
					source,
					scope,
					key: cardKey(scope, item),
				});
			} catch (error) {
				emit({
					id: raw.id,
					card: null,
					updating: false,
					error: messageOf(error),
				});
			}
		}),
	);

	const stored = await readCards(
		checked.map((c) => c.key),
		today,
	);
	const due: Due[] = [];
	for (const entry of checked) {
		const held = stored.get(entry.key);
		if (held)
			emit({
				id: entry.item.id,
				card: withId(held.card, entry.item.id),
				updating: !held.fresh,
			});
		if (held?.fresh) nudge(entry.source);
		else due.push({ ...entry, held });
	}

	let next = 0;
	const worker = async () => {
		while (next < due.length) {
			const entry = due[next++];
			try {
				const computed = await workOut(identity, entry, today);
				emit({
					id: entry.item.id,
					card: withId(computed.card, entry.item.id),
					updating: false,
				});
			} catch (error) {
				// The last card stays up when a new one could not be worked
				// out, and stops saying it is updating.
				const message = messageOf(error);
				emit({
					id: entry.item.id,
					card: withId(entry.held?.card ?? null, entry.item.id),
					updating: false,
					error: entry.held ? undefined : message,
				});
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(parallel, due.length) }, worker),
	);
}
