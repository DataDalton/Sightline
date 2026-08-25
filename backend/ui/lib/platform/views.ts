import { sql } from "../data/lakebase";
import { insertLog } from "../activityLog";

// Per-user saved views: a person's own filters, column selection, sort and
// options for a page. Saving a view never mutates the underlying report, so
// one user's customization cannot change what anyone else sees.
//
// A view can be shared with groups, which makes it readable by others but
// still owned and editable only by its author.

export interface SavedViewConfig {
	// Columns the user chose, in their order. Empty means the page default.
	dimensions?: string[];
	measures?: string[];
	filters?: unknown[];
	sort?: { field: string; direction: "asc" | "desc" }[];
	options?: Record<string, unknown>;
}

export interface SavedView {
	viewId: string;
	ownerEmail: string;
	reportId: string | null;
	pageId: string | null;
	name: string;
	config: SavedViewConfig;
	isDefault: boolean;
	isShared: boolean;
	sharedWith: string[];
	// True when the caller owns it, so the client knows whether to offer edit.
	isOwner: boolean;
	modifiedOn: string;
}

interface ViewRow {
	view_id: string;
	owner_email: string;
	report_id: string | null;
	page_id: string | null;
	name: string;
	config: SavedViewConfig;
	is_default: boolean;
	is_shared: boolean;
	shared_with: string[] | null;
	modified_on: string;
}

function toView(row: ViewRow, email: string): SavedView {
	return {
		viewId: row.view_id,
		ownerEmail: row.owner_email,
		reportId: row.report_id,
		pageId: row.page_id,
		name: row.name,
		config: row.config ?? {},
		isDefault: row.is_default,
		isShared: row.is_shared,
		sharedWith: row.shared_with ?? [],
		isOwner: row.owner_email.toLowerCase() === email.toLowerCase(),
		modifiedOn: row.modified_on,
	};
}

// Views the caller can open for a page: their own, plus any shared with a
// group they belong to.
export async function listViews(
	email: string,
	grants: string[],
	pageId: string,
): Promise<SavedView[]> {
	const rows = await sql<ViewRow>(
		`SELECT view_id, owner_email, report_id, page_id, name, config,
		        is_default, is_shared, shared_with, modified_on
		 FROM saved_views
		 WHERE page_id = $1
		   AND (
		     lower(owner_email) = $2
		     OR (is_shared = TRUE AND shared_with && $3::text[])
		   )
		 ORDER BY is_default DESC, name`,
		[pageId, email.toLowerCase(), grants],
	);
	return rows.map((row) => toView(row, email));
}

export interface SaveViewInput {
	viewId?: string;
	reportId: string | null;
	pageId: string;
	name: string;
	config: SavedViewConfig;
	isDefault?: boolean;
	isShared?: boolean;
	sharedWith?: string[];
}

export async function saveView(
	email: string,
	input: SaveViewInput,
): Promise<SavedView> {
	// Only one default per user per page, so an existing default is cleared
	// before the new one is written.
	if (input.isDefault) {
		await sql(
			`UPDATE saved_views SET is_default = FALSE
			 WHERE page_id = $1 AND lower(owner_email) = $2`,
			[input.pageId, email.toLowerCase()],
		);
	}

	const shared = input.sharedWith ?? [];

	if (input.viewId) {
		// The owner check is in the WHERE clause rather than a separate read,
		// so there is no window between checking and writing.
		const rows = await sql<ViewRow>(
			`UPDATE saved_views
			 SET name = $3, config = $4, is_default = $5, is_shared = $6,
			     shared_with = $7::text[], modified_on = now()
			 WHERE view_id = $1 AND lower(owner_email) = $2
			 RETURNING view_id, owner_email, report_id, page_id, name, config,
			           is_default, is_shared, shared_with, modified_on`,
			[
				input.viewId,
				email.toLowerCase(),
				input.name,
				JSON.stringify(input.config),
				input.isDefault ?? false,
				input.isShared ?? false,
				shared,
			],
		);
		const updated = rows[0];
		if (!updated) {
			throw new Error("View not found, or you do not own it");
		}

		await insertLog({
			recordType: "saved_view",
			recordId: updated.view_id,
			action: "update",
			changedBy: email,
			notes: input.name,
		});
		return toView(updated, email);
	}

	const rows = await sql<ViewRow>(
		`INSERT INTO saved_views
		   (owner_email, report_id, page_id, name, config, is_default,
		    is_shared, shared_with)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])
		 RETURNING view_id, owner_email, report_id, page_id, name, config,
		           is_default, is_shared, shared_with, modified_on`,
		[
			email,
			input.reportId,
			input.pageId,
			input.name,
			JSON.stringify(input.config),
			input.isDefault ?? false,
			input.isShared ?? false,
			shared,
		],
	);

	const created = rows[0];
	await insertLog({
		recordType: "saved_view",
		recordId: created.view_id,
		action: "create",
		changedBy: email,
		notes: input.name,
	});
	return toView(created, email);
}

export async function deleteView(
	email: string,
	viewId: string,
): Promise<boolean> {
	const rows = await sql<{ view_id: string }>(
		`DELETE FROM saved_views
		 WHERE view_id = $1 AND lower(owner_email) = $2
		 RETURNING view_id`,
		[viewId, email.toLowerCase()],
	);
	if (rows.length === 0) return false;

	await insertLog({
		recordType: "saved_view",
		recordId: viewId,
		action: "delete",
		changedBy: email,
	});
	return true;
}
