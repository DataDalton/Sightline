import { sql } from "../data/lakebase";
import { describePattern, type LateState } from "./arrivals";
import type { StoredPattern } from "./lateness";

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
	lastChanged: string | null;
	expectedBy: string | null;
	checkedOn: string | null;
	pattern: string | null;
	subscribed: boolean;
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
		subscribed: boolean;
	}>(
		`SELECT s.source_key, s.title, s.description, s.late_state,
		        s.freshness_mode, s.is_live, s.data_changed_on::text,
		        s.last_arrival::text, s.expected_by::text, s.checked_on::text,
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
		const lastChanged = [r.data_changed_on, r.last_arrival]
			.filter((t): t is string => Boolean(t))
			.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
		return {
			sourceKey: r.source_key,
			title: r.title,
			description: r.description,
			state: (r.late_state as LateState | null) ?? "unwatched",
			watched: r.freshness_mode === "checked",
			live: r.is_live,
			lastChanged: lastChanged ?? null,
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
