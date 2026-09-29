import { sql } from "../data/lakebase";
import { sources } from "./datasets";

// When the demonstration's tables load, so late data has something to learn
// from and something to warn about.
//
// Its sample tables are written once and never reloaded, so their loads are
// written here instead: six weeks of weekday loads around six in the morning
// UTC, a stream for the web visits, and each morning's load while the demo
// runs. Operating spend stopped loading four days ago, so it shows as late.

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const history = 42 * day;

// The source whose loads stopped, to show what late looks like.
export const stalledSource = "finance_ledger";

// The web visits stream, loading every few minutes.
const streamingSource = "web_sessions";

// Each table lands a few minutes after the one before it, and a little
// earlier or later from one day to the next, the way a real schedule does.
function loadTime(dayStart: number, index: number, dayNumber: number): number {
	const drift = ((dayNumber * 7 + index * 3) % 11) * 2 * minute;
	return dayStart + 6 * hour + index * 4 * minute + drift;
}

function isWeekday(t: number): boolean {
	const d = new Date(t).getUTCDay();
	return d >= 1 && d <= 5;
}

async function catalogName(): Promise<string> {
	const [{ catalog }] = await sql<{ catalog: string }>(
		`SELECT current_database() AS catalog`,
	);
	return catalog;
}

export async function seedArrivals(): Promise<void> {
	const existing = await sql(`SELECT 1 FROM table_arrivals LIMIT 1`);
	if (existing.length > 0) return;

	const catalog = await catalogName();
	const now = Date.now();
	const today = Math.floor(now / day) * day;
	const rows: { table: string; at: number }[] = [];

	sources.forEach((source, index) => {
		const table = `${catalog}.${source.schema}.${source.object}`;
		if (source.key === streamingSource) {
			for (let t = now - 2 * day; t < now; t += 5 * minute) {
				rows.push({ table, at: t });
			}
			return;
		}
		const stopAt =
			source.key === stalledSource ? today - 4 * day + 12 * hour : now;
		for (let start = today - history; start <= today; start += day) {
			if (!isWeekday(start)) continue;
			const at = loadTime(start, index, Math.round(start / day));
			if (at <= stopAt) rows.push({ table, at });
		}
	});

	await sql(
		`INSERT INTO table_arrivals (table_name, arrived_on)
		 SELECT t, a FROM unnest($1::text[], $2::timestamptz[]) AS x(t, a)
		 ON CONFLICT DO NOTHING`,
		[
			rows.map((r) => r.table),
			rows.map((r) => new Date(r.at).toISOString()),
		],
	);
}

// Each weekday morning's loads, for a demo left running across days. Every
// table but the stalled one and the stream, which the feed keeps loading.
export async function landTodaysLoads(): Promise<void> {
	const now = Date.now();
	if (!isWeekday(now)) return;
	const today = Math.floor(now / day) * day;
	const catalog = await catalogName();

	const due = sources
		.map((source, index) => ({ source, index }))
		.filter(
			({ source }) =>
				source.key !== stalledSource && source.key !== streamingSource,
		)
		.map(({ source, index }) => ({
			table: `${catalog}.${source.schema}.${source.object}`,
			at: loadTime(today, index, Math.round(today / day)),
		}))
		.filter((load) => load.at <= now);
	if (due.length === 0) return;

	await sql(
		`INSERT INTO table_arrivals (table_name, arrived_on)
		 SELECT t, a FROM unnest($1::text[], $2::timestamptz[]) AS x(t, a)
		 WHERE NOT EXISTS (
		   SELECT 1 FROM table_arrivals e
		   WHERE e.table_name = x.t AND e.arrived_on >= $3::timestamptz
		 )
		 ON CONFLICT DO NOTHING`,
		[
			due.map((d) => d.table),
			due.map((d) => new Date(d.at).toISOString()),
			new Date(today).toISOString(),
		],
	);
}
