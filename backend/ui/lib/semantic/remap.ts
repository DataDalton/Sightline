import type { PoolClient } from "pg";
import { sql, transaction } from "../data/lakebase";
import { insertLog } from "../activityLog";
import { invalidateDefinitions } from "../platform/definitionCache";
import { findDependents, type Dependent } from "../platform/dependents";
import {
	renameInAlert,
	renameInExplore,
	renameInNames,
	renameInPage,
	renameInSheet,
	renameInVisual,
} from "../platform/fieldRefs";
import { loadRegistry } from "./registry";

// Pointing everything that names a missing field at its new name, in one step.
//
// A field renamed upstream leaves reports, alerts, page alerts, sheets and
// saved views naming a field that no longer exists. Each of them could be
// opened and repaired by hand, which is what nobody does, so the item stays
// broken. When an administrator confirms the rename, every one of them is
// rewritten in one transaction, so either all of them follow the new name or
// none do.
//
// A report changed this way gets a new version and an entry in its edit log
// like any other edit, so its history says what happened and an editor with it
// open picks the change up.

export class RemapError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export interface RemapResult {
	sourceKey: string;
	from: string;
	to: string;
	// Items rewritten, by kind.
	changed: Record<string, number>;
	// Reports given a new version.
	reports: string[];
}

interface FieldRow {
	field_name: string;
	field_kind: string;
	status: string;
}

type Ops = { type: string; [key: string]: unknown }[];

function count(changed: Record<string, number>, kind: string): void {
	changed[kind] = (changed[kind] ?? 0) + 1;
}

// Rewrites one report's visuals and page settings, then records the change as
// that report's next version, the way an edit is recorded. See applyEdits in
// lib/platform/editing.
async function remapReport(
	client: PoolClient,
	reportId: string,
	dependents: Dependent[],
	from: string,
	to: string,
	email: string,
	changed: Record<string, number>,
): Promise<boolean> {
	const locked = await client.query<{
		version: string;
		is_personal: boolean;
	}>(
		`SELECT version, is_personal FROM reports
		 WHERE report_id = $1 FOR UPDATE`,
		[reportId],
	);
	const report = locked.rows[0];
	if (!report) return false;

	const operations: Ops = [];

	for (const dependent of dependents) {
		if (dependent.kind === "visual") {
			const row = await client.query<{ config: unknown }>(
				`SELECT config FROM report_visuals
				 WHERE visual_id = $1 FOR UPDATE`,
				[dependent.id],
			);
			if (!row.rows[0]) continue;
			const renamed = renameInVisual(row.rows[0].config, from, to);
			if (!renamed.changed) continue;
			await client.query(
				`UPDATE report_visuals SET config = $2::jsonb
				 WHERE visual_id = $1`,
				[dependent.id, JSON.stringify(renamed.value)],
			);
			operations.push({
				type: "updateVisual",
				visualId: dependent.id,
				config: renamed.value as Record<string, unknown>,
			});
			count(changed, "visual");
		} else if (dependent.kind === "pageFreshness") {
			const row = await client.query<{ config: unknown }>(
				`SELECT config FROM report_pages
				 WHERE page_id = $1 FOR UPDATE`,
				[dependent.id],
			);
			if (!row.rows[0]) continue;
			const renamed = renameInPage(row.rows[0].config, from, to);
			if (!renamed.changed) continue;
			await client.query(
				`UPDATE report_pages SET config = $2::jsonb WHERE page_id = $1`,
				[dependent.id, JSON.stringify(renamed.value)],
			);
			// Page settings merge on replay, so only the part that changed is
			// sent.
			operations.push({
				type: "updatePage",
				pageId: dependent.id,
				config: {
					freshness: (renamed.value as { freshness?: unknown })
						.freshness,
				},
			});
			count(changed, "pageFreshness");
		}
	}

	if (operations.length === 0) return false;

	const nextVersion = Number(report.version ?? 0) + 1;
	await client.query(
		`UPDATE reports SET version = $2, modified_by = $3, modified_on = now()
		 WHERE report_id = $1`,
		[reportId, nextVersion, email],
	);

	const opRow = await client.query<{ seq: string }>(
		`INSERT INTO report_ops (report_id, actor, origin_id, op)
		 VALUES ($1, $2, NULL, $3)
		 RETURNING seq`,
		[reportId, email, JSON.stringify({ version: nextVersion, operations })],
	);
	const seq = Number(opRow.rows[0]?.seq ?? 0);

	// A personal page keeps no version history, as with any other edit.
	if (!report.is_personal) {
		const visuals = await client.query(
			`SELECT v.visual_id, v.page_id, v.visual_type, v.title, v.source_key,
			        v.config, v.layout_x, v.layout_y, v.layout_w, v.layout_h,
			        v.sort_order, v.is_active
			 FROM report_visuals v
			 JOIN report_pages p ON p.page_id = v.page_id
			 WHERE p.report_id = $1`,
			[reportId],
		);
		const pages = await client.query(
			`SELECT page_id, slug, title, source_key, config, sort_order, is_active
			 FROM report_pages WHERE report_id = $1`,
			[reportId],
		);
		const header = await client.query(
			`SELECT title, description FROM reports WHERE report_id = $1`,
			[reportId],
		);
		await client.query(
			`INSERT INTO report_versions
			   (report_id, version, label, snapshot, created_by)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (report_id, version) DO NOTHING`,
			[
				reportId,
				nextVersion,
				`Field ${from} renamed to ${to}`.slice(0, 200),
				JSON.stringify({
					visuals: visuals.rows,
					pages: pages.rows,
					report: header.rows[0] ?? null,
				}),
				email,
			],
		);
	}

	await client.query(`SELECT pg_notify($1, $2)`, [
		`report_${reportId.replace(/-/g, "")}`,
		JSON.stringify({ seq, version: nextVersion, actor: email }),
	]);
	return true;
}

// Rewrites a JSON column on one row through a pure renamer, and reports
// whether anything changed.
async function remapRow(
	client: PoolClient,
	table: string,
	idColumn: string,
	jsonColumn: string,
	id: string,
	rename: (value: unknown) => { value: unknown; changed: boolean },
	extraSet = "",
	extraParams: unknown[] = [],
): Promise<boolean> {
	const row = await client.query<{ value: unknown }>(
		`SELECT ${jsonColumn} AS value FROM ${table}
		 WHERE ${idColumn}::text = $1 FOR UPDATE`,
		[id],
	);
	if (!row.rows[0]) return false;
	const renamed = rename(row.rows[0].value);
	if (!renamed.changed) return false;
	await client.query(
		`UPDATE ${table} SET ${jsonColumn} = $2::jsonb${extraSet}
		 WHERE ${idColumn}::text = $1`,
		[id, JSON.stringify(renamed.value), ...extraParams],
	);
	return true;
}

export async function remapField(
	email: string,
	sourceKey: string,
	from: string,
	to: string,
): Promise<RemapResult> {
	if (!sourceKey || !from || !to) {
		throw new RemapError(
			"Name the dataset, the old field and the new one.",
		);
	}
	if (from === to) throw new RemapError("The two names are the same.");

	const rows = await sql<FieldRow>(
		`SELECT field_name, field_kind, status FROM source_fields
		 WHERE source_key = $1 AND field_name = ANY($2::text[])`,
		[sourceKey, [from, to]],
	);
	const old = rows.find((r) => r.field_name === from);
	const next = rows.find((r) => r.field_name === to);
	if (!old)
		throw new RemapError(`${from} is not a field of this dataset.`, 404);
	if (!next)
		throw new RemapError(`${to} is not a field of this dataset.`, 404);
	if (old.status !== "missing") {
		throw new RemapError(
			`${from} is still published by the dataset, so nothing needs remapping.`,
		);
	}
	if (next.status !== "active") {
		throw new RemapError(`${to} is not published by the dataset either.`);
	}
	// A measure grouped by, or a dimension summed, would change what every
	// query built on it means.
	if (old.field_kind !== next.field_kind) {
		throw new RemapError(
			`${from} is a ${old.field_kind} and ${to} is a ${next.field_kind}. Only a field of the same kind can take its place.`,
		);
	}

	// Found before the transaction, and every row re-read under a lock inside
	// it, so an item edited in between is rewritten from what it holds now.
	const dependents = await findDependents(sourceKey, from);

	const changed: Record<string, number> = {};
	const reports: string[] = [];

	await transaction(async (client) => {
		const byReport = new Map<string, Dependent[]>();
		const seen = new Set<string>();
		for (const dependent of dependents) {
			// One entry per item, however many places in it name the field.
			const key = `${dependent.kind}\u0000${dependent.id}`;
			if (seen.has(key)) continue;
			seen.add(key);

			if (
				(dependent.kind === "visual" ||
					dependent.kind === "pageFreshness") &&
				dependent.report
			) {
				const held = byReport.get(dependent.report.reportId) ?? [];
				held.push(dependent);
				byReport.set(dependent.report.reportId, held);
				continue;
			}

			let rewritten = false;
			switch (dependent.kind) {
				case "savedView":
					rewritten = await remapRow(
						client,
						"saved_views",
						"view_id",
						"config",
						dependent.id,
						(v) => renameInVisual(v, from, to),
						", modified_on = now()",
					);
					break;
				case "exploration":
					rewritten = await remapRow(
						client,
						"explorations",
						"exploration_id",
						"config",
						dependent.id,
						(v) => renameInVisual(v, from, to),
						", modified_on = now()",
					);
					break;
				case "exploreView":
					rewritten = await remapRow(
						client,
						"explore_views",
						"view_id",
						"state",
						dependent.id,
						(v) => renameInExplore(v, from, to),
						", modified_on = now()",
					);
					break;
				case "alert":
					rewritten = await remapRow(
						client,
						"alert_rules",
						"rule_id",
						"definition",
						dependent.id,
						(v) => renameInAlert(v, from, to),
						", modified_on = now()",
					);
					break;
				case "pageAlert":
					// Its report's history is not versioned for page alerts,
					// so the rewrite is recorded with the rest of the remap
					// in the activity log.
					rewritten = await remapRow(
						client,
						"page_alerts",
						"alert_id",
						"definition",
						dependent.id,
						(v) => renameInAlert(v, from, to),
						", modified_on = now(), modified_by = $3",
						[email],
					);
					break;
				case "sheet":
					// The version is what an open copy polls to know it
					// should reload.
					rewritten = await remapRow(
						client,
						"sheets",
						"sheet_id",
						"definition",
						dependent.id,
						(v) => renameInSheet(v, from, to),
						", version = version + 1, modified_on = now(), modified_by = $3",
						[email],
					);
					break;
				// Rewritten below with the source, and through the page's
				// scorecards respectively.
				case "sourceDefaultTime":
				case "delivery":
					break;
			}
			if (rewritten) count(changed, dependent.kind);
		}

		for (const [reportId, items] of byReport) {
			if (
				await remapReport(
					client,
					reportId,
					items,
					from,
					to,
					email,
					changed,
				)
			) {
				reports.push(reportId);
			}
		}

		// What an alert checked while its owner is away was recorded against
		// field names, and so was the mapping of the source's filters to
		// fields. Both follow the rename rather than go stale.
		const recordings = await client.query<{
			owner_email: string;
			fields: string[];
		}>(
			`SELECT owner_email, fields FROM alert_access
			 WHERE source_key = $1 AND fields ? $2 FOR UPDATE`,
			[sourceKey, from],
		);
		for (const recording of recordings.rows) {
			const renamed = renameInNames(recording.fields, from, to);
			if (!renamed.changed) continue;
			await client.query(
				`UPDATE alert_access SET fields = $3::jsonb
				 WHERE owner_email = $1 AND source_key = $2`,
				[
					recording.owner_email,
					sourceKey,
					JSON.stringify(renamed.value),
				],
			);
			count(changed, "alertAccess");
		}

		const source = await client.query<{
			access_fields: string[] | null;
			default_time_field: string | null;
		}>(
			`SELECT access_fields, default_time_field FROM data_sources
			 WHERE source_key = $1 FOR UPDATE`,
			[sourceKey],
		);
		const held = source.rows[0];
		if (held) {
			const fields = Array.isArray(held.access_fields)
				? renameInNames(held.access_fields, from, to)
				: null;
			const defaultTime =
				held.default_time_field === from ? to : held.default_time_field;
			if (fields?.changed || defaultTime !== held.default_time_field) {
				await client.query(
					`UPDATE data_sources
					 SET access_fields = $2::jsonb, default_time_field = $3,
					     modified_on = now()
					 WHERE source_key = $1`,
					[
						sourceKey,
						fields
							? JSON.stringify(fields.value)
							: held.access_fields === null
								? null
								: JSON.stringify(held.access_fields),
						defaultTime,
					],
				);
				if (fields?.changed) count(changed, "accessFields");
				if (defaultTime !== held.default_time_field) {
					count(changed, "sourceDefaultTime");
				}
			}
		}

		// The labels somebody wrote for the old name belong to the field, so
		// they move with it. A label already on the new field is kept.
		await client.query(
			`UPDATE source_fields AS n
			 SET display_name = coalesce(o.display_name, n.display_name),
			     description  = coalesce(o.description, n.description),
			     format_hint  = coalesce(o.format_hint, n.format_hint),
			     folder       = coalesce(o.folder, n.folder),
			     is_default   = o.is_default OR n.is_default,
			     modified_by  = $4,
			     modified_on  = now()
			 FROM source_fields AS o
			 WHERE n.source_key = $1 AND n.field_name = $3
			   AND o.source_key = $1 AND o.field_name = $2`,
			[sourceKey, from, to, email],
		);
		await client.query(
			`UPDATE source_fields
			 SET renamed_to = $3, rename_candidate = NULL,
			     rename_confidence = NULL, is_default = FALSE,
			     modified_by = $4, modified_on = now()
			 WHERE source_key = $1 AND field_name = $2`,
			[sourceKey, from, to, email],
		);
	});

	// This replica drops what it held at once. Another serves the previous
	// definition until its entry lapses, as after any edit.
	for (const reportId of reports) {
		invalidateDefinitions(`report-body:${reportId}`);
	}
	if (reports.length > 0) invalidateDefinitions("report:");
	await loadRegistry(true);

	void insertLog({
		recordType: "source",
		recordId: sourceKey,
		action: "remap_field",
		fieldName: from,
		oldValue: from,
		newValue: to,
		changedBy: email,
		notes: JSON.stringify({ changed, reports: reports.length }),
	});

	return { sourceKey, from, to, changed, reports };
}
