import { todayIn } from "../alerts/anomaly";
import type { LoadEvidence, Observation } from "../alerts/completeness";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { intervalFor, requestCheck } from "../freshness/checker";
import { loadEvidence } from "../freshness/loads";
import { overdue } from "../freshness/marks";
import { answerTtlSeconds, isShareable } from "../query/cache";
import { assertCanReadSource, QueryAccessError } from "../query/execute";
import { QuerySpecError } from "../query/spec";
import { isAdditiveMeasure } from "../semantic/aggregation";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import { observationsOf, outgrown, type Card } from "./card";
import { cardDigest, cardKey, cardScope, figureDigest } from "./keys";
import { figureKey, readObservations, writeObservations } from "./observations";
import {
	BriefingItemError,
	checkItem,
	computeCard,
	type CardContext,
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
//
// Before any card is worked out, when each dataset last loaded and what each
// figure read as while earlier periods settled are read from the platform
// store, once for the whole briefing. Each card worked out then adds what it
// read for its recent periods. See lib/alerts/completeness.

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

// Cards worked out at once on this replica across every reader, so a burst of
// briefings opening together queues here rather than at the warehouse.
const replicaParallel = 24;
let running = 0;
const waiting: (() => void)[] = [];

async function gated<T>(task: () => Promise<T>): Promise<T> {
	if (running >= replicaParallel)
		await new Promise<void>((resolve) => waiting.push(resolve));
	else running++;
	try {
		return await task();
	} finally {
		// A waiter takes over the slot directly, so the count holds steady.
		const wake = waiting.shift();
		if (wake) wake();
		else running--;
	}
}

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

// What the platform store says about the due cards' datasets and figures,
// read once for the whole briefing.
async function contextsFor(
	due: Due[],
	timeZone: string,
): Promise<Map<Due, CardContext>> {
	const contexts = new Map<Due, CardContext>();
	if (due.length === 0) return contexts;
	const figures = due.map((d) => ({
		scope: d.scope,
		digest: cardDigest(d.item),
	}));
	const [loads, observed] = await Promise.all([
		loadEvidence(due.map((d) => d.item.sourceKey)),
		readObservations(figures),
	]);
	due.forEach((d, i) => {
		const load: LoadEvidence | null = loads.get(d.item.sourceKey) ?? null;
		const observations: Observation[] =
			observed.get(figureKey(figures[i])) ?? [];
		contexts.set(d, {
			timeZone,
			load,
			observations,
			additive: isAdditiveMeasure(
				d.source.measures.find((m) => m.name === d.item.measure),
			),
		});
	});
	return contexts;
}

function workOut(
	identity: Identity,
	due: Due,
	today: string,
	context: CardContext,
): Promise<ComputedCard> {
	const flight = `${due.key}|${today}`;
	const existing = working.get(flight);
	if (existing) return existing;
	const run = gated(() => computeCard(identity, due.item, today, context))
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
			if (computed.card)
				void writeObservations({
					scope: due.scope,
					digest: cardDigest(due.item),
					figure: figureDigest(
						due.item.sourceKey,
						due.item.measure,
						due.item.timeField,
					),
					sourceKey: due.item.sourceKey,
					observations: observationsOf(
						computed.card,
						computed.computedAt,
						context.timeZone,
					),
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
	// Aborted once the reader has gone. No new card is started after that,
	// and cards already started finish and are stored.
	closed?: AbortSignal,
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
	const now = Date.now();
	for (const entry of checked) {
		const held = stored.get(entry.key);
		// A card judged while its period was young, or while a load was
		// still to come, is judged again once that has passed, although its
		// data may not have changed.
		const current =
			held?.fresh === true &&
			!(held.card && outgrown(held.card, timeZone, now));
		if (held)
			emit({
				id: entry.item.id,
				card: withId(held.card, entry.item.id),
				updating: !current,
			});
		if (current) nudge(entry.source);
		else due.push({ ...entry, held });
	}

	const contexts = await contextsFor(due, timeZone);
	let next = 0;
	const worker = async () => {
		while (next < due.length && !closed?.aborted) {
			const entry = due[next++];
			try {
				const computed = await workOut(
					identity,
					entry,
					today,
					contexts.get(entry) as CardContext,
				);
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
