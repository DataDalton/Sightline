import { sql } from "../data/lakebase";

// Aggregates behind the admin section.
//
// Every figure here comes from usage_events, which records one row per page
// view, query, export and error. That makes adoption, cost and failure
// answerable from one table rather than from log scraping.

export interface UsageSummary {
	activeUsers: number;
	pageViews: number;
	queries: number;
	exports: number;
	errors: number;
	cacheHitRate: number;
	medianQueryMs: number;
	p95QueryMs: number;
}

export interface ReportUsage {
	reportId: string;
	title: string;
	categoryId: string | null;
	views: number;
	distinctUsers: number;
	avgDurationMs: number;
	lastViewed: string | null;
}

export interface UserUsage {
	userEmail: string;
	events: number;
	reports: number;
	exports: number;
	lastSeen: string;
}

export interface SlowQuery {
	sourceKey: string | null;
	queries: number;
	avgQueryMs: number;
	maxQueryMs: number;
	cacheHitRate: number;
}

export interface ExportRecord {
	logId: string;
	recordId: string;
	action: string;
	changedBy: string;
	changedOn: string;
	detail: string | null;
	notes: string | null;
}

function windowClause(days: number): string {
	return `occurred_on > now() - interval '${Math.max(1, Math.min(days, 365))} days'`;
}

export async function getUsageSummary(days = 7): Promise<UsageSummary> {
	const rows = await sql<{
		active_users: string;
		page_views: string;
		queries: string;
		exports: string;
		errors: string;
		cache_hits: string;
		cacheable: string;
		median_ms: string | null;
		p95_ms: string | null;
	}>(
		`SELECT
		   count(DISTINCT user_email)::text AS active_users,
		   count(*) FILTER (WHERE event_type = 'page_view')::text AS page_views,
		   count(*) FILTER (WHERE event_type = 'query')::text AS queries,
		   count(*) FILTER (WHERE event_type = 'export')::text AS exports,
		   count(*) FILTER (WHERE event_type = 'error')::text AS errors,
		   count(*) FILTER (WHERE cache_hit IS TRUE)::text AS cache_hits,
		   count(*) FILTER (WHERE cache_hit IS NOT NULL)::text AS cacheable,
		   percentile_cont(0.5) WITHIN GROUP (ORDER BY query_ms)
		     FILTER (WHERE query_ms IS NOT NULL)::text AS median_ms,
		   percentile_cont(0.95) WITHIN GROUP (ORDER BY query_ms)
		     FILTER (WHERE query_ms IS NOT NULL)::text AS p95_ms
		 FROM usage_events
		 WHERE ${windowClause(days)}`,
	);

	const row = rows[0];
	const cacheHits = Number(row?.cache_hits ?? 0);
	const cacheable = Number(row?.cacheable ?? 0);

	return {
		activeUsers: Number(row?.active_users ?? 0),
		pageViews: Number(row?.page_views ?? 0),
		queries: Number(row?.queries ?? 0),
		exports: Number(row?.exports ?? 0),
		errors: Number(row?.errors ?? 0),
		cacheHitRate: cacheable > 0 ? (cacheHits / cacheable) * 100 : 0,
		medianQueryMs: Math.round(Number(row?.median_ms ?? 0)),
		p95QueryMs: Math.round(Number(row?.p95_ms ?? 0)),
	};
}

export async function getReportUsage(
	days = 7,
	limit = 25,
): Promise<ReportUsage[]> {
	const rows = await sql<{
		report_id: string;
		title: string | null;
		category_id: string | null;
		views: string;
		distinct_users: string;
		avg_duration: string | null;
		last_viewed: string | null;
	}>(
		`SELECT e.report_id,
		        r.title,
		        r.category_id,
		        count(*)::text AS views,
		        count(DISTINCT e.user_email)::text AS distinct_users,
		        avg(e.duration_ms)::text AS avg_duration,
		        max(e.occurred_on)::text AS last_viewed
		 FROM usage_events e
		 LEFT JOIN reports r ON r.report_id = e.report_id
		 WHERE ${windowClause(days)} AND e.report_id IS NOT NULL
		 GROUP BY e.report_id, r.title, r.category_id
		 ORDER BY count(*) DESC
		 LIMIT $1`,
		[limit],
	);

	return rows.map((row) => ({
		reportId: row.report_id,
		title: row.title ?? "(deleted report)",
		categoryId: row.category_id,
		views: Number(row.views),
		distinctUsers: Number(row.distinct_users),
		avgDurationMs: Math.round(Number(row.avg_duration ?? 0)),
		lastViewed: row.last_viewed,
	}));
}

export async function getUserUsage(days = 7, limit = 25): Promise<UserUsage[]> {
	const rows = await sql<{
		user_email: string;
		events: string;
		reports: string;
		exports: string;
		last_seen: string;
	}>(
		`SELECT user_email,
		        count(*)::text AS events,
		        count(DISTINCT report_id)::text AS reports,
		        count(*) FILTER (WHERE event_type = 'export')::text AS exports,
		        max(occurred_on)::text AS last_seen
		 FROM usage_events
		 WHERE ${windowClause(days)}
		 GROUP BY user_email
		 ORDER BY count(*) DESC
		 LIMIT $1`,
		[limit],
	);

	return rows.map((row) => ({
		userEmail: row.user_email,
		events: Number(row.events),
		reports: Number(row.reports),
		exports: Number(row.exports),
		lastSeen: row.last_seen,
	}));
}

// Where warehouse time is actually going, so a slow source can be found
// without guessing.
export async function getSlowSources(days = 7): Promise<SlowQuery[]> {
	const rows = await sql<{
		source_key: string | null;
		queries: string;
		avg_ms: string | null;
		max_ms: string | null;
		hits: string;
		total: string;
	}>(
		`SELECT source_key,
		        count(*)::text AS queries,
		        avg(query_ms)::text AS avg_ms,
		        max(query_ms)::text AS max_ms,
		        count(*) FILTER (WHERE cache_hit IS TRUE)::text AS hits,
		        count(*) FILTER (WHERE cache_hit IS NOT NULL)::text AS total
		 FROM usage_events
		 WHERE ${windowClause(days)} AND event_type = 'query'
		 GROUP BY source_key
		 ORDER BY avg(query_ms) DESC NULLS LAST
		 LIMIT 20`,
	);

	return rows.map((row) => {
		const total = Number(row.total);
		return {
			sourceKey: row.source_key,
			queries: Number(row.queries),
			avgQueryMs: Math.round(Number(row.avg_ms ?? 0)),
			maxQueryMs: Math.round(Number(row.max_ms ?? 0)),
			cacheHitRate: total > 0 ? (Number(row.hits) / total) * 100 : 0,
		};
	});
}

// The export audit trail. Every export writes a requested row and then either
// a completed or a failed row, so a request with no completion is itself
// meaningful.
export async function getExportAudit(limit = 100): Promise<ExportRecord[]> {
	const rows = await sql<{
		log_id: string;
		record_id: string;
		action: string;
		changed_by: string;
		changed_on: string;
		new_value: string | null;
		notes: string | null;
	}>(
		`SELECT log_id, record_id, action, changed_by, changed_on,
		        new_value, notes
		 FROM activity_log
		 WHERE record_type = 'export'
		 ORDER BY changed_on DESC
		 LIMIT $1`,
		[limit],
	);

	return rows.map((row) => ({
		logId: row.log_id,
		recordId: row.record_id,
		action: row.action,
		changedBy: row.changed_by,
		changedOn: row.changed_on,
		detail: row.new_value,
		notes: row.notes,
	}));
}

// Daily activity, for a trend line rather than a single number.
export async function getDailyActivity(
	days = 30,
): Promise<{ day: string; events: number; users: number }[]> {
	const rows = await sql<{ day: string; events: string; users: string }>(
		`SELECT date_trunc('day', occurred_on)::date::text AS day,
		        count(*)::text AS events,
		        count(DISTINCT user_email)::text AS users
		 FROM usage_events
		 WHERE ${windowClause(days)}
		 GROUP BY 1
		 ORDER BY 1`,
	);

	return rows.map((row) => ({
		day: row.day,
		events: Number(row.events),
		users: Number(row.users),
	}));
}

// --- Drill-ins -------------------------------------------------------------

// The aggregates above answer "what is being used". These answer "by whom" and
// "what did this person do", which is the question an admin actually has when
// a figure looks wrong: a spike is only meaningful once you can see whether it
// was thirty people or one person refreshing.

export interface ReportViewer {
	userEmail: string;
	views: number;
	exports: number;
	errors: number;
	firstViewed: string;
	lastViewed: string;
	avgDurationMs: number;
}

export async function getReportViewers(
	reportId: string,
	days = 30,
	limit = 200,
): Promise<ReportViewer[]> {
	const rows = await sql<{
		user_email: string;
		views: string;
		exports: string;
		errors: string;
		first_viewed: string;
		last_viewed: string;
		avg_duration: string | null;
	}>(
		`SELECT user_email,
		        count(*) FILTER (WHERE event_type = 'page_view')::text AS views,
		        count(*) FILTER (WHERE event_type = 'export')::text AS exports,
		        count(*) FILTER (WHERE event_type = 'error')::text AS errors,
		        min(occurred_on)::text AS first_viewed,
		        max(occurred_on)::text AS last_viewed,
		        avg(duration_ms)::text AS avg_duration
		 FROM usage_events
		 WHERE report_id = $1 AND ${windowClause(days)}
		 GROUP BY user_email
		 ORDER BY count(*) FILTER (WHERE event_type = 'page_view') DESC,
		          max(occurred_on) DESC
		 LIMIT $2`,
		[reportId, limit],
	);

	return rows.map((row) => ({
		userEmail: row.user_email,
		views: Number(row.views),
		exports: Number(row.exports),
		errors: Number(row.errors),
		firstViewed: row.first_viewed,
		lastViewed: row.last_viewed,
		avgDurationMs: Math.round(Number(row.avg_duration ?? 0)),
	}));
}

export interface ActivityEvent {
	occurredOn: string;
	eventType: string;
	reportId: string | null;
	reportTitle: string | null;
	reportSlug: string | null;
	sourceKey: string | null;
	durationMs: number | null;
	queryMs: number | null;
	rowCount: number | null;
	cacheHit: boolean | null;
	errorMessage: string | null;
}

// One person's history, newest first.
//
// Individual events rather than counts, because the question behind "what has
// this user done" is usually a specific one: which report did they export,
// what were they looking at when it failed, how much of their time is spent
// waiting.
export async function getUserActivity(
	userEmail: string,
	days = 30,
	limit = 300,
): Promise<ActivityEvent[]> {
	const rows = await sql<{
		occurred_on: string;
		event_type: string;
		report_id: string | null;
		title: string | null;
		slug: string | null;
		source_key: string | null;
		duration_ms: number | string | null;
		query_ms: number | string | null;
		row_count: number | string | null;
		cache_hit: boolean | string | null;
		error_message: string | null;
	}>(
		`SELECT e.occurred_on::text,
		        e.event_type,
		        e.report_id,
		        r.title,
		        r.slug,
		        e.source_key,
		        e.duration_ms,
		        e.query_ms,
		        e.row_count,
		        e.cache_hit,
		        e.error_message
		 FROM usage_events e
		 LEFT JOIN reports r ON r.report_id = e.report_id
		 WHERE e.user_email = $1 AND ${windowClause(days)}
		 ORDER BY e.occurred_on DESC
		 LIMIT $2`,
		[userEmail, limit],
	);

	const toNumber = (value: number | string | null) =>
		value === null || value === "" ? null : Number(value);

	return rows.map((row) => ({
		occurredOn: row.occurred_on,
		eventType: row.event_type,
		reportId: row.report_id,
		reportTitle: row.title,
		reportSlug: row.slug,
		sourceKey: row.source_key,
		durationMs: toNumber(row.duration_ms),
		queryMs: toNumber(row.query_ms),
		rowCount: toNumber(row.row_count),
		// The SQL driver returns a boolean and the statement API returns the
		// string, so both spellings are accepted.
		cacheHit:
			row.cache_hit === null
				? null
				: row.cache_hit === true || row.cache_hit === "true",
		errorMessage: row.error_message,
	}));
}
