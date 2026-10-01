import { insertLog } from "../activityLog";
import { sql, transaction } from "../data/lakebase";
import { invalidateAccessCache } from "../platform/access";
import { invalidateDefinitions } from "../platform/definitionCache";
import { itemLink, purgeDate, type RetentionKind } from "./rules";

// What an owner does with retention: mark an item Keep, see what went to the
// bin, and bring it back.
//
// Every statement here names the owner in its WHERE, so an id belonging to
// somebody else changes nothing and answers exactly as one that does not
// exist. Only the owner of an item reaches it, never somebody it was shared
// with and never an administrator acting for them.

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isItemId(value: unknown): value is string {
	return typeof value === "string" && uuidPattern.test(value);
}

// The table behind each kind other than pages, which live among reports and
// are handled on their own.
const tables: Record<
	Exclude<RetentionKind, "page">,
	{ table: string; key: string; title: string }
> = {
	sheet: { table: "sheets", key: "sheet_id", title: "title" },
	board: { table: "boards", key: "board_id", title: "title" },
	exploreView: { table: "explore_views", key: "view_id", title: "name" },
};

function owner(email: string): string {
	return email.trim().toLowerCase();
}

// Drops what this replica holds about personal pages, so one that left or
// returned from the bin is seen that way at once. Other replicas follow
// within their cache lifetime, as for a page deleted by hand.
export function forgetPages(reportId?: string): void {
	invalidateAccessCache();
	invalidateDefinitions("navigation:");
	invalidateDefinitions("report:");
	if (reportId) invalidateDefinitions(`report-body:${reportId}`);
	else invalidateDefinitions("report-body:");
	invalidateDefinitions("search:");
}

// Marks an item Keep, or clears the mark. Answers whether the caller owns an
// item of that kind and id that is not in the bin.
export async function setKeep(
	email: string,
	kind: RetentionKind,
	id: string,
	keep: boolean,
): Promise<boolean> {
	if (!isItemId(id)) return false;
	const rows =
		kind === "page"
			? await sql<{ id: string }>(
					`UPDATE reports SET keep = $3
					 WHERE report_id = $1 AND lower(owner_email) = $2
					   AND is_personal = TRUE AND is_active = TRUE
					   AND removed_on IS NULL
					 RETURNING report_id::text AS id`,
					[id, owner(email), keep],
				)
			: await sql<{ id: string }>(
					`UPDATE ${tables[kind].table} SET keep = $3
					 WHERE ${tables[kind].key} = $1 AND owner_email = $2
					   AND removed_on IS NULL
					 RETURNING ${tables[kind].key}::text AS id`,
					[id, owner(email), keep],
				);
	if (rows.length === 0) return false;
	void insertLog({
		recordType: kind,
		recordId: id,
		action: keep ? "retention_keep" : "retention_unkeep",
		changedBy: email,
	});
	return true;
}

export interface BinItem {
	kind: RetentionKind;
	id: string;
	title: string;
	removedOn: string;
	// When it is deleted for good.
	purgeOn: string;
}

interface BinRow {
	kind: RetentionKind;
	id: string;
	title: string;
	removed_on: Date | string;
}

// Everything of the caller's in the bin, newest first.
export async function listBin(email: string): Promise<BinItem[]> {
	const params = [owner(email)];
	const rows = await sql<BinRow>(
		`SELECT 'page' AS kind, report_id::text AS id, title, removed_on
		 FROM reports
		 WHERE lower(owner_email) = $1 AND is_personal = TRUE
		   AND is_active = FALSE AND removed_on IS NOT NULL
		 UNION ALL
		 SELECT 'sheet', sheet_id::text, title, removed_on
		 FROM sheets WHERE owner_email = $1 AND removed_on IS NOT NULL
		 UNION ALL
		 SELECT 'board', board_id::text, title, removed_on
		 FROM boards WHERE owner_email = $1 AND removed_on IS NOT NULL
		 UNION ALL
		 SELECT 'exploreView', view_id::text, name, removed_on
		 FROM explore_views WHERE owner_email = $1 AND removed_on IS NOT NULL
		 ORDER BY removed_on DESC
		 LIMIT 500`,
		params,
	);
	return rows.map((row) => {
		const removed = new Date(row.removed_on);
		return {
			kind: row.kind,
			id: row.id,
			title: row.title,
			removedOn: removed.toISOString(),
			purgeOn: purgeDate(removed).toISOString(),
		};
	});
}

// Brings an item back from the bin as it was, counting the restore as use so
// it is not warned about again straight away. Answers where it opens, or null
// when the caller has no such item in the bin.
export async function restoreItem(
	email: string,
	kind: RetentionKind,
	id: string,
): Promise<{ link: string } | null> {
	if (!isItemId(id)) return null;

	if (kind === "page") {
		const restored = await transaction(async (client) => {
			const rows = await client.query<{ slug: string }>(
				`UPDATE reports
				 SET is_active = TRUE, removed_on = NULL, restored_on = now()
				 WHERE report_id = $1 AND lower(owner_email) = $2
				   AND is_personal = TRUE AND is_active = FALSE
				   AND removed_on IS NOT NULL
				 RETURNING slug`,
				[id, owner(email)],
			);
			if (rows.rows.length === 0) return null;
			// The grants the removal switched off, and only those, so a share
			// the owner withdrew before it went to the bin stays withdrawn.
			await client.query(
				`UPDATE access_policies
				 SET is_active = TRUE, retention_held = FALSE
				 WHERE resource_type = 'report' AND resource_id = $1
				   AND retention_held = TRUE`,
				[id],
			);
			return rows.rows[0];
		});
		if (!restored) return null;
		forgetPages(id);
		void insertLog({
			recordType: "report",
			recordId: id,
			action: "retention_restore",
			changedBy: email,
		});
		return { link: itemLink("page", id, restored.slug) };
	}

	const { table, key } = tables[kind];
	const rows = await sql<{ id: string }>(
		`UPDATE ${table}
		 SET removed_on = NULL, last_opened_on = now()
		 WHERE ${key} = $1 AND owner_email = $2 AND removed_on IS NOT NULL
		 RETURNING ${key}::text AS id`,
		[id, owner(email)],
	);
	if (rows.length === 0) return null;
	void insertLog({
		recordType: kind,
		recordId: id,
		action: "retention_restore",
		changedBy: email,
	});
	return { link: itemLink(kind, id) };
}
