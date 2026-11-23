import { sql } from "../data/lakebase";

// What has happened to a report since its guide was last brought up to date.
//
// Each event that could make a guide wrong or incomplete adds a reason to the
// report: a chart added or removed, an update about its data, a field placed on
// it, it being shared. The assistant's upkeep reads them once the report has
// been quiet for a while, so the edits somebody makes while building a page,
// or the several updates one release posts, become one change to the guide
// rather than one per event. See lib/guide/assistant.

export type GuideReasonKind =
	| "published"
	| "created"
	| "structure"
	| "update"
	| "field"
	| "removed"
	| "redefined";

export interface GuideReason {
	kind: GuideReasonKind;
	// One line saying what happened, written for the model and for the label on
	// the version the edit is saved as.
	text: string;
	// The update the reason came from, so the guide's version links to it.
	updateId?: string;
}

interface Queryable {
	query: (text: string, params?: unknown[]) => Promise<unknown>;
}

// Adds reasons to reports. Inside a transaction when a client is given, so a
// reason is recorded only with the change that caused it.
export async function markGuidePending(
	reportIds: string[],
	reasons: GuideReason[],
	client?: Queryable,
): Promise<void> {
	const ids = [...new Set(reportIds.filter(Boolean))];
	if (ids.length === 0 || reasons.length === 0) return;
	const statement = `UPDATE reports
		 SET guide_pending = COALESCE(guide_pending, '[]'::jsonb) || $2::jsonb,
		     guide_pending_since = COALESCE(guide_pending_since, now()),
		     guide_pending_last = now()
		 WHERE report_id = ANY($1::uuid[]) AND is_active AND NOT is_personal`;
	const params = [ids, JSON.stringify(reasons)];
	if (client) await client.query(statement, params);
	else await sql(statement, params);
}

// Shared reports that read any of the sources, or are named directly.
export async function reportsFor(input: {
	sourceKeys: string[];
	reportIds: string[];
}): Promise<string[]> {
	if (input.sourceKeys.length === 0 && input.reportIds.length === 0)
		return [];
	const rows = await sql<{ report_id: string }>(
		`SELECT DISTINCT r.report_id::text
		 FROM reports r
		 LEFT JOIN report_pages p ON p.report_id = r.report_id AND p.is_active
		 LEFT JOIN report_visuals v ON v.page_id = p.page_id AND v.is_active
		 WHERE r.is_active AND NOT r.is_personal
		   AND (r.report_id::text = ANY($2::text[])
		        OR r.source_key = ANY($1::text[])
		        OR p.source_key = ANY($1::text[])
		        OR v.source_key = ANY($1::text[]))`,
		[input.sourceKeys, input.reportIds],
	);
	return rows.map((row) => row.report_id);
}

// The same reason told twice, as an edit made and then made again, is one.
export function distinctReasons(reasons: GuideReason[]): GuideReason[] {
	const seen = new Set<string>();
	return reasons.filter((reason) => {
		const key = `${reason.kind}\u0000${reason.text}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
