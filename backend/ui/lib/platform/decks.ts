import { randomUUID } from "node:crypto";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { resolvePolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { insertLog } from "../activityLog";
import { notify } from "../notify/store";
import { cleanDeckInput, type Deck } from "../visuals/deck";
import { invalidateDefinitions } from "./definitionCache";
import { assertCanEdit } from "./editing";

// Walkthroughs and slides saved against a report, who has been through them, who is
// presenting right now, and the record kept when a report is printed.
//
// Presenting needs nothing saved, so it does not appear here. See lib/visuals/deck.

export class DeckError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

interface DeckRow {
	deck_id: string;
	kind: Deck["kind"];
	title: string;
	steps: Deck["steps"];
	prompt_once: boolean;
	epoch: number;
	record_field: string | null;
	record_source: string | null;
	require_record: boolean;
}

function toDeck(row: DeckRow): Deck {
	return {
		deckId: row.deck_id,
		kind: row.kind,
		title: row.title,
		steps: row.steps,
		promptOnce: row.prompt_once,
		epoch: row.epoch,
		recordField: row.record_field,
		recordSource: row.record_source,
		requireRecord: row.require_record,
	};
}

const deckColumns = `deck_id::text AS deck_id, kind, title, steps, prompt_once, epoch,
	record_field, record_source, require_record`;

export interface DeckStats {
	deckId: string;
	started: number;
	finished: number;
}

export async function getDeck(
	reportId: string,
	deckId: string,
): Promise<Deck | null> {
	const rows = await sql<DeckRow>(
		`SELECT ${deckColumns} FROM report_decks
		 WHERE report_id = $1 AND deck_id::text = $2 AND is_active = TRUE`,
		[reportId, deckId],
	);
	return rows[0] ? toDeck(rows[0]) : null;
}

export async function listDecks(
	reportId: string,
	email: string,
	withStats: boolean,
): Promise<{
	decks: Deck[];
	seen: Record<string, number>;
	stats: DeckStats[];
}> {
	const [decks, seen, stats] = await Promise.all([
		sql<DeckRow>(
			`SELECT ${deckColumns} FROM report_decks
			 WHERE report_id = $1 AND is_active = TRUE
			 ORDER BY created_on`,
			[reportId],
		),
		sql<{ deck_id: string; epoch: number }>(
			`SELECT p.deck_id::text AS deck_id, p.epoch
			 FROM deck_progress p
			 JOIN report_decks d ON d.deck_id = p.deck_id
			 WHERE d.report_id = $1 AND lower(p.user_email) = lower($2)`,
			[reportId, email],
		),
		withStats
			? sql<{ deck_id: string; started: string; finished: string }>(
					`SELECT p.deck_id::text AS deck_id,
					        count(*) FILTER (WHERE p.started_on IS NOT NULL)::text AS started,
					        count(*) FILTER (WHERE p.finished_on IS NOT NULL)::text AS finished
					 FROM deck_progress p
					 JOIN report_decks d ON d.deck_id = p.deck_id
					 WHERE d.report_id = $1
					 GROUP BY p.deck_id`,
					[reportId],
				)
			: Promise.resolve([]),
	]);
	return {
		decks: decks.map(toDeck),
		seen: Object.fromEntries(seen.map((row) => [row.deck_id, row.epoch])),
		stats: stats.map((row) => ({
			deckId: row.deck_id,
			started: Number(row.started),
			finished: Number(row.finished),
		})),
	};
}

export async function saveDeck(
	policy: PolicyClass,
	email: string,
	reportId: string,
	deckId: string | null,
	input: unknown,
): Promise<Deck> {
	await assertCanEdit(policy, email, reportId);
	const deck = cleanDeckInput(input, randomUUID);
	const values = [
		reportId,
		deck.kind,
		deck.title,
		JSON.stringify(deck.steps),
		deck.promptOnce,
		deck.recordField,
		deck.recordSource,
		deck.requireRecord,
		email,
	];
	const rows = deckId
		? await sql<DeckRow>(
				`UPDATE report_decks
				 SET kind = $2, title = $3, steps = $4::jsonb, prompt_once = $5,
				     record_field = $6, record_source = $7, require_record = $8,
				     modified_by = $9, modified_on = now()
				 WHERE deck_id = $10 AND report_id = $1 AND is_active = TRUE
				 RETURNING ${deckColumns}`,
				[...values, deckId],
			)
		: await sql<DeckRow>(
				`INSERT INTO report_decks
				   (report_id, kind, title, steps, prompt_once, record_field,
				    record_source, require_record, modified_by)
				 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
				 RETURNING ${deckColumns}`,
				values,
			);
	if (!rows[0]) throw new DeckError("Not found", 404);
	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: deckId ? "update_deck" : "create_deck",
		changedBy: email,
		newValue: deck.title,
	});
	return toDeck(rows[0]);
}

export async function removeDeck(
	policy: PolicyClass,
	email: string,
	reportId: string,
	deckId: string,
): Promise<void> {
	await assertCanEdit(policy, email, reportId);
	await sql(
		`UPDATE report_decks SET is_active = FALSE
		 WHERE deck_id = $1 AND report_id = $2`,
		[deckId, reportId],
	);
	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "remove_deck",
		changedBy: email,
		newValue: deckId,
	});
}

// Offers it to everybody again, as a tour of what changed after republishing, and
// tells the people who have read the report lately. Only named readers can be told,
// and those are exactly who this reaches.
export async function offerAgain(
	policy: PolicyClass,
	email: string,
	report: { reportId: string; slug: string; title: string },
	deckId: string,
): Promise<number> {
	await assertCanEdit(policy, email, report.reportId);
	const rows = await sql<{ title: string }>(
		`UPDATE report_decks SET epoch = epoch + 1, prompt_once = TRUE
		 WHERE deck_id = $1 AND report_id = $2 AND is_active = TRUE
		 RETURNING title`,
		[deckId, report.reportId],
	);
	if (!rows[0]) throw new DeckError("Not found", 404);

	const readers = await sql<{ user_email: string }>(
		`SELECT DISTINCT user_email FROM usage_events
		 WHERE report_id = $1::uuid
		   AND event_type = 'page_open'
		   AND occurred_on > now() - interval '30 days'`,
		[report.reportId],
	);
	const others = readers
		.map((row) => row.user_email)
		.filter((reader) => reader.toLowerCase() !== email.toLowerCase());
	for (const reader of others) {
		void notify(reader, {
			kind: "system",
			title: `What's new in ${report.title}`,
			body: rows[0].title,
			link: `/r/${report.slug}?tour=${deckId}`,
		}).catch((error) => {
			console.warn("A tour notification was not delivered:", error);
		});
	}
	return others.length;
}

// Recorded as somebody moves through a deck, or turns it down, which also stops it
// being offered to them again.
export async function noteProgress(
	email: string,
	reportId: string,
	deckId: string,
	stage: "started" | "finished" | "dismissed",
): Promise<void> {
	const rows = await sql<{ epoch: number }>(
		`SELECT epoch FROM report_decks
		 WHERE deck_id = $1 AND report_id = $2 AND is_active = TRUE`,
		[deckId, reportId],
	);
	if (!rows[0]) throw new DeckError("Not found", 404);
	await sql(
		`INSERT INTO deck_progress
		   (deck_id, user_email, epoch, started_on, finished_on)
		 VALUES ($1, lower($2), $3,
		         CASE WHEN $4 = 'dismissed' THEN NULL ELSE now() END,
		         CASE WHEN $4 = 'finished' THEN now() END)
		 ON CONFLICT (deck_id, user_email) DO UPDATE
		 SET epoch = EXCLUDED.epoch,
		     started_on = COALESCE(EXCLUDED.started_on, deck_progress.started_on),
		     finished_on = COALESCE(EXCLUDED.finished_on, deck_progress.finished_on)`,
		[deckId, email, rows[0].epoch, stage],
	);
}

// --- Following whoever is presenting -------------------------------------------

// The record of a report going to paper, written before the page is allowed to print.
// Written directly rather than through the activity log helper, which swallows a
// failure so it cannot stop the change it describes. Here a record that cannot be
// written has to stop the print.
export async function recordPrint(
	identity: Identity,
	report: { reportId: string; title: string },
	input: { pageId: string | null; search: string; kind?: "pdf" | "pptx" },
): Promise<void> {
	const policy = await resolvePolicyClass(identity);
	if (policy.degraded) {
		throw new DeckError(
			"Access could not be verified, so this cannot be printed right now.",
			403,
		);
	}
	await writePrintRecord(identity.email, report, input);
}

// The audit row alone, for a scheduled PDF drawn while its owner is away and whose right
// to export was confirmed while they were here.
export async function writePrintRecord(
	email: string,
	report: { reportId: string; title: string },
	input: { pageId: string | null; search: string; kind?: "pdf" | "pptx" },
): Promise<void> {
	await sql(
		`INSERT INTO activity_log
		   (record_type, record_id, action, new_value, changed_by, notes)
		 VALUES ('export', $1, $5, $2, $3, $4)`,
		[
			report.reportId,
			JSON.stringify({ pageId: input.pageId, search: input.search }),
			email,
			report.title,
			input.kind === "pptx" ? "export_pptx" : "export_pdf",
		],
	);
	// The audit screen shows this as soon as it happens, not when its list expires.
	invalidateDefinitions("admin-exports");
}
