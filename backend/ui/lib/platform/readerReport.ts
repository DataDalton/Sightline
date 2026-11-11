import { sql } from "../data/lakebase";
import {
	cachedDefinition,
	invalidateDefinitions,
	peekDefinition,
} from "./definitionCache";
import type {
	ForecastRecordRow,
	GoalProgressRow,
	LastSeenRow,
	ReaderReport,
} from "./readerRows";

// One person's own rows on one report, read together as the report opens. Their forecast
// records, goal history, progress through its decks and the figures they last saw on each
// page are four tables, and each surface used to read its own as it opened. Here they are
// one statement on the first open, and none afterwards until one of them is written.
//
// A write whose new rows are known updates the held copy, so looking again reads nothing.
// One whose rows are not known drops it, and the next open reads it again.

// Per reader keys end the reader's part with '|', so one person's held reports on every
// report drop together. See lib/platform/definitionCache.
const readerPrefix = (email: string) => `reader-report:${email.toLowerCase()}|`;
const readerKey = (email: string, reportId: string) =>
	`${readerPrefix(email)}${reportId.toLowerCase()}`;

export function readerReport(
	email: string,
	reportId: string,
): Promise<ReaderReport> {
	return cachedDefinition(readerKey(email, reportId), async () => {
		const [row] = await sql<{
			forecasts: ForecastRecordRow[];
			goal_progress: GoalProgressRow[];
			deck_seen: { deck_id: string; epoch: number }[];
			last_seen: LastSeenRow[];
		}>(
			`SELECT
			   coalesce((
			     SELECT json_agg(json_build_object(
			              'visual_id', f.visual_id, 'measure', f.measure,
			              'period', f.period, 'predicted', f.predicted,
			              'low', f.low_value, 'high', f.high_value, 'actual', f.actual)
			            ORDER BY f.period)
			     FROM forecast_records f
			     WHERE f.user_email = lower($1)
			       AND f.visual_id IN (
			         SELECT v.visual_id::text FROM report_visuals v
			         JOIN report_pages p ON p.page_id = v.page_id
			         WHERE p.report_id = $2::uuid)
			   ), '[]'::json) AS forecasts,
			   coalesce((
			     SELECT json_agg(json_build_object(
			              'goal_id', g.goal_id::text, 'day', g.day::text, 'value', g.value)
			            ORDER BY g.day)
			     FROM goal_progress g
			     JOIN goals o ON o.goal_id = g.goal_id
			     WHERE g.user_email = lower($1) AND o.report_id = $2::uuid
			   ), '[]'::json) AS goal_progress,
			   coalesce((
			     SELECT json_agg(json_build_object(
			              'deck_id', d.deck_id::text, 'epoch', d.epoch))
			     FROM deck_progress d
			     JOIN report_decks k ON k.deck_id = d.deck_id
			     WHERE k.report_id = $2::uuid AND lower(d.user_email) = lower($1)
			   ), '[]'::json) AS deck_seen,
			   coalesce((
			     SELECT json_agg(json_build_object(
			              'page_id', l.page_id, 'figures', l.figures,
			              'seen_on', l.seen_on))
			     FROM last_seen_figures l
			     JOIN report_pages p ON p.page_id::text = l.page_id
			     WHERE l.user_email = lower($1) AND p.report_id = $2::uuid
			   ), '[]'::json) AS last_seen`,
			[email, reportId],
		);
		return {
			forecasts: row?.forecasts ?? [],
			goalProgress: row?.goal_progress ?? [],
			deckSeen: row?.deck_seen ?? [],
			lastSeen: (row?.last_seen ?? []).map((seen) => ({
				...seen,
				seen_on: new Date(seen.seen_on).toISOString(),
			})),
		};
	});
}

// Replaces the held copy with what a write left behind, on this instance, and has every
// other instance drop theirs. Nothing is held when nothing was, since the next open reads
// it whole anyway.
export async function updateReaderReport(
	email: string,
	reportId: string,
	change: (held: ReaderReport) => ReaderReport,
): Promise<void> {
	const key = readerKey(email, reportId);
	const held = peekDefinition<ReaderReport>(key);
	invalidateDefinitions(key);
	if (held) await cachedDefinition(key, async () => change(held));
}

// Drops the held copy of one report for a person, or of every report when the report
// a write belongs to is not known.
export function dropReaderReport(email: string, reportId?: string): void {
	invalidateDefinitions(
		reportId ? readerKey(email, reportId) : readerPrefix(email),
	);
}

// The report each visual sits on, for a forecast card, which knows its visual but not its
// report. A visual never moves to another report, so each answer is held for good once
// found. One on a board or not saved yet has none, and is not held, so its card reads its
// own records.
const visualReportKey = (visualId: string) =>
	`visual-report:${visualId.toLowerCase()}|`;

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reportsOfVisuals(
	visualIds: string[],
): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	const missing: string[] = [];
	for (const visualId of new Set(visualIds)) {
		const held = peekDefinition<string>(visualReportKey(visualId));
		if (held) found.set(visualId, held);
		else if (uuidPattern.test(visualId)) missing.push(visualId);
	}
	if (missing.length === 0) return found;
	const rows = await sql<{ visual_id: string; report_id: string }>(
		`SELECT v.visual_id::text AS visual_id, p.report_id::text AS report_id
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 WHERE v.visual_id = ANY($1::uuid[])`,
		[missing.map((id) => id.toLowerCase())],
	);
	for (const row of rows) {
		const asked = missing.find(
			(id) => id.toLowerCase() === row.visual_id,
		) as string;
		found.set(asked, row.report_id);
		void cachedDefinition(
			visualReportKey(row.visual_id),
			async () => row.report_id,
		);
	}
	return found;
}
