import { sql, transaction } from "../data/lakebase";
import { insertLog } from "../activityLog";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { cachedDefinition, invalidateDefinitions } from "./definitionCache";
import { openReportPage } from "./reports";

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

// A view that cannot be stored as asked, which is the caller's to fix.
export class ViewInputError extends Error {}

// Largest stored configuration. A view holds column choices, filters and
// options, which is far below this, and a body past it is refused rather than
// kept on every read of the page.
export const maxViewConfigBytes = 64 * 1024;

// The report a page belongs to, when the caller may open that report, or null.
// A view is read and written by page, so every route checks this first. A page
// that does not exist and one the caller cannot open answer the same.
export async function openablePageReport(
	policy: PolicyClass,
	identity: Identity,
	pageId: string,
): Promise<string | null> {
	return (
		(await openReportPage(policy, identity, pageId))?.report.reportId ??
		null
	);
}

// Views the caller can open for a page: their own, plus any shared with a
// group they belong to.
//
// Every view on the page is held, per page, until one on it is saved or
// removed, which drops it on every instance. See lib/platform/changes. Each
// reader's own and shared ones are picked out in memory, so a page nobody has
// saved a view on costs no question at all once it is held.
function viewsKey(pageId: string): string {
	return `views:${pageId.toLowerCase()}|`;
}

function pageViews(pageId: string): Promise<ViewRow[]> {
	return cachedDefinition(viewsKey(pageId), () =>
		sql<ViewRow>(
			`SELECT view_id, owner_email, report_id, page_id, name, config,
			        is_default, is_shared, shared_with, modified_on
			 FROM saved_views
			 WHERE page_id = $1
			 ORDER BY is_default DESC, name`,
			[pageId],
		),
	);
}

export async function listViews(
	email: string,
	grants: string[],
	pageId: string,
): Promise<SavedView[]> {
	const owner = email.toLowerCase();
	const groups = new Set(grants);
	return (await pageViews(pageId))
		.filter(
			(row) =>
				row.owner_email.toLowerCase() === owner ||
				(row.is_shared &&
					(row.shared_with ?? []).some((g) => groups.has(g))),
		)
		.map((row) => toView(row, email));
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
	const config = JSON.stringify(input.config ?? {});
	if (Buffer.byteLength(config, "utf8") > maxViewConfigBytes) {
		throw new ViewInputError("This view holds too much to save.");
	}

	const shared = input.sharedWith ?? [];
	const owner = email.toLowerCase();

	// The write and the clearing of any other default land together, and the
	// clearing happens only once the write has shown the caller owns the view.
	// Only one default per user per page.
	const saved = await transaction(async (client) => {
		let row: ViewRow | undefined;
		if (input.viewId) {
			// The owner check is in the WHERE clause rather than a separate
			// read, so there is no window between checking and writing.
			const updated = await client.query<ViewRow>(
				`UPDATE saved_views
				 SET name = $3, config = $4, is_default = $5, is_shared = $6,
				     shared_with = $7::text[], modified_on = now()
				 WHERE view_id = $1 AND lower(owner_email) = $2
				 RETURNING view_id, owner_email, report_id, page_id, name,
				           config, is_default, is_shared, shared_with,
				           modified_on`,
				[
					input.viewId,
					owner,
					input.name,
					config,
					input.isDefault ?? false,
					input.isShared ?? false,
					shared,
				],
			);
			row = updated.rows[0];
			if (!row) {
				throw new Error("View not found, or you do not own it");
			}
		} else {
			const created = await client.query<ViewRow>(
				`INSERT INTO saved_views
				   (owner_email, report_id, page_id, name, config, is_default,
				    is_shared, shared_with)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])
				 RETURNING view_id, owner_email, report_id, page_id, name,
				           config, is_default, is_shared, shared_with,
				           modified_on`,
				[
					email,
					input.reportId,
					input.pageId,
					input.name,
					config,
					input.isDefault ?? false,
					input.isShared ?? false,
					shared,
				],
			);
			row = created.rows[0];
		}

		if (row && input.isDefault) {
			await client.query(
				`UPDATE saved_views SET is_default = FALSE
				 WHERE page_id = $1 AND lower(owner_email) = $2
				   AND view_id <> $3`,
				[row.page_id, owner, row.view_id],
			);
		}
		return row;
	});
	if (saved.page_id) invalidateDefinitions(viewsKey(saved.page_id));

	await insertLog({
		recordType: "saved_view",
		recordId: saved.view_id,
		action: input.viewId ? "update" : "create",
		changedBy: email,
		notes: input.name,
	});
	return toView(saved, email);
}

export async function deleteView(
	email: string,
	viewId: string,
): Promise<boolean> {
	const rows = await sql<{ page_id: string | null }>(
		`DELETE FROM saved_views
		 WHERE view_id = $1 AND lower(owner_email) = $2
		 RETURNING page_id::text`,
		[viewId, email.toLowerCase()],
	);
	if (rows.length === 0) return false;
	if (rows[0].page_id) invalidateDefinitions(viewsKey(rows[0].page_id));

	await insertLog({
		recordType: "saved_view",
		recordId: viewId,
		action: "delete",
		changedBy: email,
	});
	return true;
}
