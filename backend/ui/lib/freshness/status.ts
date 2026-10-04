import { sql } from "../data/lakebase";
import {
	cachedDefinition,
	invalidateDefinitions,
} from "../platform/definitionCache";
import { describePattern, type LateState } from "./arrivals";
import type { StoredPattern } from "./lateness";
import { lookedOnSql } from "./marks";

// Where each source's data stands, for everyone who reads it rather than
// only for the people who look after it, and who has asked to be told when
// a source is late.

export interface SourceStatus {
	sourceKey: string;
	title: string;
	description: string | null;
	state: LateState | "unwatched";
	// Whether its tables are watched for changes, rather than refreshed on a
	// timer, which is what lets it be judged late at all.
	watched: boolean;
	live: boolean;
	// When the source last changed. For a late source this is when its late
	// table last loaded, since the newest change of a table that did load
	// says nothing about the one that did not.
	lastChanged: string | null;
	// The table holding a source back, named when the source reads more than
	// one and is late.
	lateTable: string | null;
	expectedBy: string | null;
	checkedOn: string | null;
	pattern: string | null;
	subscribed: boolean;
}

// The sources running late or overdue, for the home page of everyone who can
// read them. The same rows for every reader, so held once and narrowed to what
// each reader can reach in memory. Held until the evaluator moves a source in
// or out of being late, which drops it on every instance. See
// lib/platform/changes.
export interface LateSource {
	sourceKey: string;
	title: string;
	state: "late" | "overdue";
	expectedBy: string | null;
	lastChanged: string | null;
}

const lateKey = "freshness:late";

// Drops this and every source's standing held in lib/freshness/lateness.
export function lateStandingChanged(): void {
	invalidateDefinitions("freshness:");
}

export async function lateSources(
	sourceKeys: string[] | null,
): Promise<LateSource[]> {
	const all = await cachedDefinition(lateKey, async () => {
		const rows = await sql<{
			source_key: string;
			title: string;
			late_state: "late" | "overdue";
			expected_by: string | null;
			last_arrival: string | null;
			data_changed_on: string | null;
		}>(
			`SELECT source_key, title, late_state, expected_by::text,
			        last_arrival::text, data_changed_on::text
			 FROM data_sources
			 WHERE is_active AND late_state IN ('late', 'overdue')
			 ORDER BY lower(title)`,
		);
		return rows.map(
			(r): LateSource => ({
				sourceKey: r.source_key,
				title: r.title,
				state: r.late_state,
				expectedBy: r.expected_by,
				// As in statusOf, the late table's last load.
				lastChanged: r.last_arrival ?? r.data_changed_on,
			}),
		);
	});
	if (!sourceKeys) return all;
	const reachable = new Set(sourceKeys);
	return all.filter((s) => reachable.has(s.sourceKey));
}

export async function statusOf(
	sourceKeys: string[] | null,
	email: string,
	timeZone: string,
): Promise<SourceStatus[]> {
	const rows = await sql<{
		source_key: string;
		title: string;
		description: string | null;
		late_state: string | null;
		freshness_mode: string;
		is_live: boolean;
		data_changed_on: string | null;
		last_arrival: string | null;
		expected_by: string | null;
		checked_on: string | null;
		arrival_pattern: StoredPattern | null;
		base_tables: string[] | null;
		subscribed: boolean;
	}>(
		`SELECT s.source_key, s.title, s.description, s.late_state, s.base_tables,
		        s.freshness_mode, s.is_live, s.data_changed_on::text,
		        s.last_arrival::text, s.expected_by::text,
		        ${lookedOnSql("s")}::text AS checked_on,
		        s.arrival_pattern,
		        EXISTS (SELECT 1 FROM late_subscriptions l
		                WHERE l.source_key = s.source_key AND l.email = $2)
		          AS subscribed
		 FROM data_sources s
		 WHERE s.is_active
		   AND ($1::text[] IS NULL OR s.source_key = ANY($1::text[]))
		 ORDER BY lower(s.title)`,
		[sourceKeys, email.toLowerCase()],
	);
	return rows.map((r) => {
		const behind = r.late_state === "late" || r.late_state === "overdue";
		const lastChanged =
			behind && r.last_arrival
				? r.last_arrival
				: [r.data_changed_on, r.last_arrival]
						.filter((t): t is string => Boolean(t))
						.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
		const table = r.arrival_pattern?.table ?? null;
		const lateTable =
			behind && table && (r.base_tables?.length ?? 0) > 1
				? (table.split(".").pop() ?? table)
				: null;
		return {
			sourceKey: r.source_key,
			title: r.title,
			description: r.description,
			state: (r.late_state as LateState | null) ?? "unwatched",
			watched: r.freshness_mode === "checked",
			live: r.is_live,
			lastChanged: lastChanged ?? null,
			lateTable,
			expectedBy: r.expected_by,
			checkedOn: r.checked_on,
			pattern: r.arrival_pattern
				? describePattern(r.arrival_pattern, timeZone)
				: null,
			subscribed: r.subscribed,
		};
	});
}

export async function setLateSubscription(
	email: string,
	sourceKey: string,
	subscribed: boolean,
): Promise<void> {
	if (subscribed) {
		await sql(
			`INSERT INTO late_subscriptions (email, source_key)
			 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[email.toLowerCase(), sourceKey],
		);
	} else {
		await sql(
			`DELETE FROM late_subscriptions WHERE email = $1 AND source_key = $2`,
			[email.toLowerCase(), sourceKey],
		);
	}
}

export async function lateSubscribers(sourceKey: string): Promise<string[]> {
	const rows = await sql<{ email: string }>(
		`SELECT email FROM late_subscriptions WHERE source_key = $1`,
		[sourceKey],
	);
	return rows.map((r) => r.email);
}
