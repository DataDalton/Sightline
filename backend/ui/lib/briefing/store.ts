import { batchedRead } from "../data/batch";
import { sql } from "../data/lakebase";
import type { Card } from "./card";

// Cards kept between visits, in the platform store, so they survive a restart
// and every replica reads the same ones.
//
// A card is fresh while three things hold: it was worked out for today, its
// dataset has not changed since the answers it was built from were computed,
// and it is inside the time the dataset's answers are kept for. A card that
// is not fresh is still handed out, marked as such, so the page shows the
// last figures at once while new ones are worked out.
//
// A card held for everyone is handed out, and stored, only while its dataset
// is still recorded as carrying no catalogue filter or mask. Asked in the same
// statement as the read or write, as the result cache asks it.

export interface StoredCard {
	key: string;
	card: Card | null;
	fresh: boolean;
	// When the card was last judged, or null for one stored before that was
	// recorded.
	judgedAt: number | null;
}

// The most recent card for each key on or before the day given. An earlier
// day's card is what a reader sees first thing in the morning while today's
// is worked out.
//
// Read for everyone opening their home page at about the same time in one
// statement for each day asked about. See lib/data/batch.
const storedCards = batchedRead<
	{ key: string; today: string },
	StoredCard | null
>(
	async (asked) => {
		const byDay = new Map<string, string[]>();
		for (const { key, today } of asked) {
			const keys = byDay.get(today) ?? [];
			keys.push(key);
			byDay.set(today, keys);
		}
		const found = new Map<string, StoredCard | null>();
		await Promise.all(
			[...byDay].map(async ([today, keys]) => {
				const rows = await sql<{
					card_key: string;
					card: Card | null;
					fresh: boolean;
					judged_on: string | null;
				}>(
					`SELECT DISTINCT ON (c.card_key) c.card_key, c.card,
					        c.judged_on::text AS judged_on,
					        (c.day = $2::date AND c.expires_on > now()
					         AND c.computed_on >= coalesce(d.data_changed_on, '-infinity'))
					          AS fresh
					 FROM briefing_cards c
					 LEFT JOIN data_sources d ON d.source_key = c.source_key
					 WHERE c.card_key = ANY($1) AND c.day <= $2::date
					   AND (c.scope <> 'unfiltered' OR NOT coalesce(d.has_row_filter, FALSE))
					 ORDER BY c.card_key, c.day DESC`,
					[keys, today],
				);
				for (const row of rows) {
					found.set(cardId(row.card_key, today), {
						key: row.card_key,
						card: row.card,
						fresh: row.fresh === true,
						judgedAt: row.judged_on
							? Date.parse(row.judged_on)
							: null,
					});
				}
			}),
		);
		return found;
	},
	({ key, today }) => cardId(key, today),
	null,
);

function cardId(key: string, today: string): string {
	return JSON.stringify([key, today]);
}

export async function readCards(
	keys: string[],
	today: string,
): Promise<Map<string, StoredCard>> {
	const found = new Map<string, StoredCard>();
	if (keys.length === 0) return found;
	try {
		const cards = await Promise.all(
			keys.map((key) => storedCards({ key, today })),
		);
		for (const card of cards) {
			if (card) found.set(card.key, card);
		}
	} catch (error) {
		// A failed read means every card is worked out afresh, never an
		// error the reader sees.
		console.warn("Stored briefing cards could not be read:", error);
	}
	return found;
}

// Stores a card unless one computed from newer answers is already there, so
// a slow computation that started before a change cannot replace a card
// worked out after it.
export async function writeCard(entry: {
	key: string;
	today: string;
	scope: string;
	sourceKey: string;
	card: Card | null;
	computedAt: number;
	expiresAt: number;
}): Promise<void> {
	try {
		await sql(
			`INSERT INTO briefing_cards
			   (card_key, day, scope, source_key, card, computed_on, expires_on,
			    judged_on)
			 SELECT $1::text, $2::date, $3::text, $4::text, $5::jsonb,
			        to_timestamp($6::double precision),
			        to_timestamp($7::double precision), now()
			 WHERE $3::text <> 'unfiltered' OR NOT EXISTS (
			   SELECT 1 FROM data_sources d
			   WHERE d.source_key = $4::text AND d.has_row_filter)
			 ON CONFLICT (card_key, day) DO UPDATE SET
			   card = EXCLUDED.card,
			   computed_on = EXCLUDED.computed_on,
			   expires_on = EXCLUDED.expires_on,
			   judged_on = EXCLUDED.judged_on
			 WHERE briefing_cards.computed_on <= EXCLUDED.computed_on`,
			[
				entry.key,
				entry.today,
				entry.scope,
				entry.sourceKey,
				JSON.stringify(entry.card),
				entry.computedAt / 1000,
				entry.expiresAt / 1000,
			],
		);
	} catch (error) {
		// A card that could not be kept is worked out again next visit.
		console.warn("A briefing card could not be stored:", error);
	}
}
