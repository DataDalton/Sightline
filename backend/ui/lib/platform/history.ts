import { sql, transaction } from "../data/lakebase";
import type { PolicyClass } from "../auth/policy";
import { assertCanEdit } from "./editing";
import { insertLog } from "../activityLog";
import { diffSnapshots, type Change, type Snapshot } from "./versionDiff";
import { diffVersions, type VersionDiff } from "./versionDetail";

// The edit history of a report, and putting a version back.
//
// Every save already wrote a full snapshot, so the history is a read rather
// than a new kind of record. What was missing was a way to see it and a way to
// act on it, which is most of the value: a record nobody can read is a backup,
// not a history.
//
// A restore never rewrites the past. It applies an old snapshot as a new
// version, so the thing being undone stays in the record and the restore
// itself can be undone in turn. Anything else loses the evidence of what
// happened, which is exactly what someone reaches for a history to find.

export interface HistoryEntry {
	version: number;
	author: string | null;
	createdOn: string;
	label: string | null;
	changes: Change[];
	// True for the version the report is currently on.
	isCurrent: boolean;
}

interface VersionRow {
	version: string | number;
	label: string | null;
	snapshot: Snapshot;
	created_by: string | null;
	created_on: string;
}

export async function listHistory(
	reportId: string,
	limit = 60,
): Promise<HistoryEntry[]> {
	// One extra row, because describing the oldest entry in the window needs
	// the version before it to compare against.
	const rows = await sql<VersionRow>(
		`SELECT version, label, snapshot, created_by, created_on::text
		 FROM report_versions
		 WHERE report_id = $1
		 ORDER BY version DESC
		 LIMIT $2`,
		[reportId, limit + 1],
	);

	const current = await sql<{ version: string | number }>(
		`SELECT version FROM reports WHERE report_id = $1`,
		[reportId],
	);
	const currentVersion = Number(current[0]?.version ?? 0);

	const entries: HistoryEntry[] = [];
	for (let i = 0; i < Math.min(rows.length, limit); i++) {
		const row = rows[i];
		// Ordered newest first, so the version before this one is the next in
		// the array. Its absence means this is the first version there is.
		const previous = rows[i + 1]?.snapshot ?? null;

		entries.push({
			version: Number(row.version),
			author: row.created_by,
			createdOn: row.created_on,
			label: row.label,
			changes: diffSnapshots(previous, row.snapshot),
			isCurrent: Number(row.version) === currentVersion,
		});
	}
	return entries;
}

// A version number nobody wrote. Named rather than generic so the route can
// answer 404 instead of reporting an internal failure for a link that simply
// points at a version this report never had.
export class VersionNotFoundError extends Error {}

// One version set against another, property by property.
//
// Read on demand rather than folded into listHistory, because a snapshot is the
// whole report and sixty of them is not a list, it is the report sixty times
// over. The comparison someone actually opens is one at a time.
export async function versionComparison(
	reportId: string,
	version: number,
	against?: number,
): Promise<VersionDiff> {
	const snapshotAt = async (wanted: number): Promise<Snapshot | null> => {
		const rows = await sql<{ snapshot: Snapshot }>(
			`SELECT snapshot FROM report_versions
			 WHERE report_id = $1 AND version = $2`,
			[reportId, wanted],
		);
		return rows[0]?.snapshot ?? null;
	};

	// Nothing named to compare against means the version before this one, which
	// is what the history list is already describing.
	let base = against;
	if (base === undefined) {
		const rows = await sql<{ version: string | number }>(
			`SELECT version FROM report_versions
			 WHERE report_id = $1 AND version < $2
			 ORDER BY version DESC LIMIT 1`,
			[reportId, version],
		);
		base = rows[0] === undefined ? undefined : Number(rows[0].version);
	}

	// Older on the left whichever way round they were asked for, so the
	// columns always read as before and after rather than reversing under
	// someone who picked the newer one first.
	const [from, to] =
		base !== undefined && base > version
			? [version, base]
			: [base, version];

	const previous = from === undefined ? null : await snapshotAt(from);
	// A version that was asked for by name and is not there is a wrong number,
	// not an empty left hand side. Reading it as nothing to compare against
	// would report the whole report as newly added.
	if (from !== undefined && !previous) {
		throw new VersionNotFoundError(`Version ${from} does not exist`);
	}

	const next = await snapshotAt(to);
	if (!next) throw new VersionNotFoundError(`Version ${to} does not exist`);

	return diffVersions(previous, next, from ?? null, to);
}

export interface RestoreResult {
	version: number;
	seq: number;
	restoredFrom: number;
}

export async function restoreVersion(
	policy: PolicyClass,
	email: string,
	reportId: string,
	version: number,
): Promise<RestoreResult> {
	await assertCanEdit(policy, email, reportId);

	return transaction(async (client) => {
		// The same lock a save takes, so a restore and an edit cannot
		// interleave and produce a report that is half of each.
		const current = await client.query<{ version: string }>(
			`SELECT version FROM reports WHERE report_id = $1 FOR UPDATE`,
			[reportId],
		);
		const currentVersion = Number(current.rows[0]?.version ?? 0);

		const found = await client.query<{ snapshot: Snapshot }>(
			`SELECT snapshot FROM report_versions
			 WHERE report_id = $1 AND version = $2`,
			[reportId, version],
		);
		const snapshot = found.rows[0]?.snapshot;
		if (!snapshot) throw new Error(`Version ${version} does not exist`);

		const visuals = snapshot.visuals ?? [];

		for (const visual of visuals) {
			await client.query(
				`INSERT INTO report_visuals
				   (visual_id, page_id, visual_type, title, source_key, config,
				    layout_x, layout_y, layout_w, layout_h, sort_order, is_active)
				 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
				 ON CONFLICT (visual_id) DO UPDATE SET
				   visual_type = EXCLUDED.visual_type,
				   title = EXCLUDED.title,
				   source_key = EXCLUDED.source_key,
				   config = EXCLUDED.config,
				   layout_x = EXCLUDED.layout_x,
				   layout_y = EXCLUDED.layout_y,
				   layout_w = EXCLUDED.layout_w,
				   layout_h = EXCLUDED.layout_h,
				   sort_order = EXCLUDED.sort_order,
				   is_active = EXCLUDED.is_active`,
				[
					visual.visual_id,
					visual.page_id,
					visual.visual_type,
					visual.title,
					visual.source_key,
					JSON.stringify(visual.config ?? {}),
					// An older snapshot predates layout being recorded. Nothing
					// sensible can be restored for it, so the current position
					// is kept rather than everything being stacked at the
					// origin.
					visual.layout_x ?? 0,
					visual.layout_y ?? 0,
					visual.layout_w ?? 6,
					visual.layout_h ?? 4,
					visual.sort_order ?? 0,
					visual.is_active ?? true,
				],
			);
		}

		// A visual added after the restored version goes away. Deactivated
		// rather than deleted, so restoring forward brings it back.
		const keep = visuals.map((v) => v.visual_id);
		await client.query(
			`UPDATE report_visuals v
			 SET is_active = FALSE
			 FROM report_pages p
			 WHERE p.page_id = v.page_id
			   AND p.report_id = $1
			   AND NOT (v.visual_id = ANY($2::uuid[]))`,
			[reportId, keep],
		);

		for (const page of snapshot.pages ?? []) {
			await client.query(
				`UPDATE report_pages
				 SET title = COALESCE($3, title),
				     config = COALESCE($4::jsonb, config),
				     is_active = COALESCE($5, is_active)
				 WHERE page_id = $2 AND report_id = $1`,
				[
					reportId,
					page.page_id,
					page.title ?? null,
					page.config ? JSON.stringify(page.config) : null,
					page.is_active ?? null,
				],
			);
		}

		if (snapshot.report) {
			await client.query(
				`UPDATE reports SET title = COALESCE($2, title),
				                    description = $3
				 WHERE report_id = $1`,
				[
					reportId,
					snapshot.report.title ?? null,
					snapshot.report.description ?? null,
				],
			);
		}

		const nextVersion = currentVersion + 1;
		await client.query(
			`UPDATE reports
			 SET version = $2, modified_by = $3, modified_on = now()
			 WHERE report_id = $1`,
			[reportId, nextVersion, email],
		);

		// Written to the op feed so live editors know to reload. A restore
		// cannot be replayed as a list of operations, so it says what it is and
		// the client fetches the report again.
		const opRow = await client.query<{ seq: string }>(
			`INSERT INTO report_ops (report_id, actor, origin_id, op)
			 VALUES ($1, $2, NULL, $3)
			 RETURNING seq`,
			[
				reportId,
				email,
				JSON.stringify({
					version: nextVersion,
					operations: [{ type: "restore", fromVersion: version }],
				}),
			],
		);

		// The restore is itself a version, so it can be undone the same way
		// anything else can.
		await client.query(
			`INSERT INTO report_versions
			   (report_id, version, label, snapshot, created_by)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (report_id, version) DO NOTHING`,
			[
				reportId,
				nextVersion,
				`Restored version ${version}`,
				JSON.stringify(snapshot),
				email,
			],
		);

		void insertLog({
			recordType: "report",
			recordId: reportId,
			action: "restore_version",
			changedBy: email,
			newValue: JSON.stringify({
				restoredFrom: version,
				version: nextVersion,
			}),
		});

		return {
			version: nextVersion,
			seq: Number(opRow.rows[0]?.seq ?? 0),
			restoredFrom: version,
		};
	});
}
