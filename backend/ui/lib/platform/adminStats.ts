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

// The same window against the daily rollup.
//
// Whole days, because that is what the rollup holds. A window asked for in days
// and answered in days is also the more honest reading: "the last seven days"
// meaning seven calendar days rather than the last hundred and sixty eight
// hours is what somebody choosing 7 expects to see.
function rolledWindow(days: number): string {
	return `day > current_date - ${Math.max(1, Math.min(days, 365))}`;
}

export async function getUsageSummary(days = 7): Promise<UsageSummary> {
	// Read from the daily rollup rather than from the events themselves.
	//
	// Every figure here is a count or a ratio over a window, which is exactly
	// what an aggregate answers, and the raw table is the one thing in the
	// schema that grows without bound by design. Distinct readers are counted
	// as rows rather than summed, because a reader active on three days is one
	// reader.
	const rows = await sql<{
		active_users: string;
		page_views: string;
		queries: string;
		exports: string;
		errors: string;
		cache_hits: string;
		cacheable: string;
	}>(
		`SELECT
		   count(DISTINCT user_email)::text AS active_users,
		   coalesce(sum(events) FILTER (WHERE event_type = 'page_view'), 0)::text AS page_views,
		   coalesce(sum(events) FILTER (WHERE event_type = 'query'), 0)::text AS queries,
		   coalesce(sum(events) FILTER (WHERE event_type = 'export'), 0)::text AS exports,
		   coalesce(sum(events) FILTER (WHERE event_type = 'error'), 0)::text AS errors,
		   coalesce(sum(cache_hits), 0)::text AS cache_hits,
		   coalesce(sum(cacheable), 0)::text AS cacheable
		 FROM usage_daily
		 WHERE ${rolledWindow(days)}`,
	);

	// Latency weighted by how many samples each day contributed, so a quiet day
	// does not count as much as a busy one. Exact within a day and a reading
	// across the window rather than a true percentile of it, which is the
	// trade a rollup makes and the reason it is stated here.
	const latency = await sql<{
		median_ms: string | null;
		p95_ms: string | null;
	}>(
		`SELECT
		   (sum(p50_ms * samples) / nullif(sum(samples), 0))::text AS median_ms,
		   (sum(p95_ms * samples) / nullif(sum(samples), 0))::text AS p95_ms
		 FROM usage_daily_latency
		 WHERE ${rolledWindow(days)}`,
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
		medianQueryMs: Math.round(Number(latency[0]?.median_ms ?? 0)),
		p95QueryMs: Math.round(Number(latency[0]?.p95_ms ?? 0)),
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
		`SELECT e.report_id::text AS report_id,
		        r.title,
		        r.category_id,
		        sum(e.events)::text AS views,
		        count(DISTINCT e.user_email)::text AS distinct_users,
		        (sum(e.duration_sum) / nullif(sum(e.duration_n), 0))::text AS avg_duration,
		        max(e.last_event)::text AS last_viewed
		 FROM usage_daily e
		 LEFT JOIN reports r ON r.report_id = e.report_id
		 WHERE ${rolledWindow(days)} AND e.report_id IS NOT NULL
		 GROUP BY e.report_id, r.title, r.category_id
		 ORDER BY sum(e.events) DESC
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
		        sum(events)::text AS events,
		        count(DISTINCT report_id)::text AS reports,
		        coalesce(sum(events) FILTER (WHERE event_type = 'export'), 0)::text AS exports,
		        max(last_event)::text AS last_seen
		 FROM usage_daily
		 WHERE ${rolledWindow(days)}
		 GROUP BY user_email
		 ORDER BY sum(events) DESC
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
		        sum(events)::text AS queries,
		        (sum(query_ms_sum) / nullif(sum(query_ms_n), 0))::text AS avg_ms,
		        max(query_ms_max)::text AS max_ms,
		        coalesce(sum(cache_hits), 0)::text AS hits,
		        coalesce(sum(cacheable), 0)::text AS total
		 FROM usage_daily
		 WHERE ${rolledWindow(days)} AND event_type = 'query'
		 GROUP BY source_key
		 ORDER BY (sum(query_ms_sum) / nullif(sum(query_ms_n), 0)) DESC NULLS LAST
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
		`SELECT day::text AS day,
		        sum(events)::text AS events,
		        count(DISTINCT user_email)::text AS users
		 FROM usage_daily
		 WHERE ${rolledWindow(days)}
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
		        coalesce(sum(events) FILTER (WHERE event_type = 'page_view'), 0)::text AS views,
		        coalesce(sum(events) FILTER (WHERE event_type = 'export'), 0)::text AS exports,
		        coalesce(sum(events) FILTER (WHERE event_type = 'error'), 0)::text AS errors,
		        min(first_event)::text AS first_viewed,
		        max(last_event)::text AS last_viewed,
		        (sum(duration_sum) / nullif(sum(duration_n), 0))::text AS avg_duration
		 FROM usage_daily
		 WHERE report_id = $1 AND ${rolledWindow(days)}
		 GROUP BY user_email
		 ORDER BY coalesce(sum(events) FILTER (WHERE event_type = 'page_view'), 0) DESC,
		          max(last_event) DESC
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

// --- Change history ---------------------------------------------------------

// Everything the platform recorded somebody doing to it.
//
// Thirty-one places write to activity_log, and until this existed two of them
// could be read back: the export filter above, and the per-report history in
// the editor. Role grants, category creation, source registration, settings
// changes and administrative reads of somebody's private page were all recorded
// and then unreachable, which is the half of an access review nobody could
// answer.

export interface ActivityRecord {
	logId: string;
	recordType: string;
	recordId: string;
	action: string;
	fieldName: string | null;
	oldValue: string | null;
	newValue: string | null;
	changedBy: string;
	changedOn: string;
	notes: string | null;
}

export interface ActivityFilter {
	// One of the record types listed by activityRecordTypes, or null for all.
	recordType?: string | null;
	// Substring, matched case insensitively against the actor.
	actor?: string | null;
	days?: number;
	limit?: number;
	// Row offset, so a long history can be walked rather than truncated
	// silently at the limit.
	offset?: number;
}

// What the log actually holds, counted, so the filter offers the types this
// deployment has rather than a list written into the source.
export async function activityRecordTypes(
	days = 30,
): Promise<{ recordType: string; events: number }[]> {
	const rows = await sql<{ record_type: string; events: string }>(
		`SELECT record_type, count(*)::text AS events
		 FROM activity_log
		 WHERE changed_on > now() - ($1 || ' days')::interval
		 GROUP BY record_type
		 ORDER BY 2 DESC`,
		[days],
	);
	return rows.map((row) => ({
		recordType: row.record_type,
		events: Number(row.events),
	}));
}

export async function getActivityLog(
	filter: ActivityFilter = {},
): Promise<{ records: ActivityRecord[]; more: boolean }> {
	const days = filter.days ?? 30;
	const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
	const offset = Math.max(filter.offset ?? 0, 0);

	// Parameterised rather than interpolated. These reach the endpoint from a
	// query string, and a record type is compared rather than concatenated so
	// there is nothing to escape.
	const rows = await sql<{
		log_id: string;
		record_type: string;
		record_id: string;
		action: string;
		field_name: string | null;
		old_value: string | null;
		new_value: string | null;
		changed_by: string;
		changed_on: string;
		notes: string | null;
	}>(
		`SELECT log_id, record_type, record_id, action, field_name,
		        old_value, new_value, changed_by, changed_on, notes
		 FROM activity_log
		 WHERE changed_on > now() - ($1 || ' days')::interval
		   AND ($2::text IS NULL OR record_type = $2)
		   AND ($3::text IS NULL OR changed_by ILIKE '%' || $3 || '%')
		 ORDER BY changed_on DESC
		 LIMIT $4 OFFSET $5`,
		[
			days,
			filter.recordType || null,
			filter.actor || null,
			// One more than asked for, so the caller can be told there is a
			// next page without running a second count over the whole table.
			limit + 1,
			offset,
		],
	);

	const more = rows.length > limit;
	return {
		records: rows.slice(0, limit).map((row) => ({
			logId: row.log_id,
			recordType: row.record_type,
			recordId: row.record_id,
			action: row.action,
			fieldName: row.field_name,
			oldValue: row.old_value,
			newValue: row.new_value,
			changedBy: row.changed_by,
			changedOn: row.changed_on,
			notes: row.notes,
		})),
		more,
	};
}
