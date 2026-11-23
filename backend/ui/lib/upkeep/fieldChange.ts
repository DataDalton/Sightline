import type { PoolClient } from "pg";
import { sql, transaction } from "../data/lakebase";
import { insertLog } from "../activityLog";
import { invalidateDefinitions } from "../platform/definitionCache";
import {
	dropField,
	namesIn,
	removing,
	renaming,
	walkAlert,
	walkBoard,
	walkClauses,
	walkDeckSteps,
	walkExplore,
	walkList,
	walkPage,
	walkSavedView,
	walkSheet,
	walkVisual,
	type FieldVisit,
} from "../platform/fieldWalk";
import { writeVersion } from "../platform/versionWrite";
import { linkChange } from "../updates/links";
import { validateVisual } from "../visuals/validate";
import { reloadRegistryEverywhere } from "../semantic/registry";

// A field of one source renamed or removed, carried to everything built on it.
//
// Every stored item that names the field is found and rewritten in one
// transaction, so either all of them follow the change or none do. Each kind of
// item is walked by lib/platform/fieldWalk, which knows every place it can name
// a field, so a rename and a removal reach exactly the same places.
//
// A report changed this way gets a new version with a label saying why, written
// as any edit is, so its history shows what changed and an editor with it open
// picks the change up. A visual that a removal leaves unable to draw is turned
// off in that same version rather than left showing an error, and is listed in
// the result so it can be replaced.
//
// After the transaction the same search runs again. Anything still naming the
// old field is returned as left, which should always be empty, so a gap in what
// is walked shows up as a failure rather than as a report quietly broken.

export interface FieldChange {
	sourceKey: string;
	field: string;
	// The new name for a rename. Null removes the field.
	to: string | null;
	// Who the change is recorded against, a person or the assistant.
	actor: string;
	// Why, shown as the version label of each report changed.
	reason: string;
	// Leaves protected reports and pages as they are, for changes nobody
	// confirmed by hand. They are listed in the result instead.
	skipProtected?: boolean;
	// The update the change was made because of. Each report version is linked
	// to it with what changed in that report.
	updateId?: string | null;
}

export interface FieldChangeResult {
	sourceKey: string;
	field: string;
	to: string | null;
	// Items rewritten, by kind.
	changed: Record<string, number>;
	// Reports given a new version.
	reports: { reportId: string; slug: string; title: string }[];
	// Visuals a removal left unable to draw, turned off in their report's new
	// version.
	hidden: {
		reportId: string;
		visualId: string;
		title: string | null;
		visualType: string;
	}[];
	// Reports left unchanged because they or the page are protected.
	protectedReports: { reportId: string; slug: string; title: string }[];
	// Items that cannot work without the field and were turned off, such as an
	// alert watching a removed measure.
	turnedOff: { kind: string; id: string; name: string }[];
	// Places still naming the old field after the change. Empty unless a kind of
	// item is not walked.
	left: { kind: string; id: string; reportId?: string }[];
}

type Json = Record<string, unknown>;

function count(changed: Record<string, number>, kind: string): void {
	changed[kind] = (changed[kind] ?? 0) + 1;
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

// The reports that read a source anywhere, through the report, a page or a
// visual. Items keyed only by report, such as tours and briefing choices, are
// changed only within these.
const reportsReadingSource = `
	SELECT DISTINCT r.report_id
	FROM reports r
	LEFT JOIN report_pages p ON p.report_id = r.report_id
	LEFT JOIN report_visuals v ON v.page_id = p.page_id
	WHERE r.source_key = $1 OR p.source_key = $1 OR v.source_key = $1`;

// The pages whose own settings or visuals read the source.
const pagesReadingSource = `
	SELECT DISTINCT p.page_id
	FROM report_pages p
	JOIN reports r ON r.report_id = p.report_id
	LEFT JOIN report_visuals v ON v.page_id = p.page_id
	WHERE coalesce(p.source_key, r.source_key) = $1
	   OR coalesce(v.source_key, p.source_key, r.source_key) = $1`;

// --- Reports ---------------------------------------------------------------

interface ReportWork {
	visuals: Map<string, { config: unknown; hide: boolean }>;
	pages: Map<string, unknown>;
}

async function changeReports(
	client: PoolClient,
	change: FieldChange,
	visit: FieldVisit,
	result: FieldChangeResult,
): Promise<void> {
	const { sourceKey, field } = change;
	const work = new Map<string, ReportWork>();
	const workFor = (reportId: string): ReportWork => {
		let held = work.get(reportId);
		if (!held) {
			held = { visuals: new Map(), pages: new Map() };
			work.set(reportId, held);
		}
		return held;
	};

	const visuals = await client.query<{
		visual_id: string;
		report_id: string;
		visual_type: string;
		title: string | null;
		config: unknown;
		is_active: boolean;
		protected: boolean;
		slug: string;
		report_title: string;
	}>(
		`SELECT v.visual_id, p.report_id, v.visual_type, v.title, v.config,
		        v.is_active, (r.protect_edit OR p.protect_edit) AS protected,
		        r.slug, r.title AS report_title
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE coalesce(v.source_key, p.source_key, r.source_key) = $1
		   AND strpos(v.config::text, $2) > 0
		 FOR UPDATE OF v`,
		[sourceKey, field],
	);
	const protectedIds = new Map<
		string,
		{ reportId: string; slug: string; title: string }
	>();
	const skip = (reportId: string, slug: string, title: string) => {
		protectedIds.set(reportId, { reportId, slug, title });
	};
	for (const row of visuals.rows) {
		const walked = walkVisual(row.config, visit);
		if (!walked.changed) continue;
		if (change.skipProtected && row.protected) {
			skip(row.report_id, row.slug, row.report_title);
			continue;
		}
		// A removal can leave a visual without what it needs to draw, such as a
		// chart with no measure. It is turned off rather than left failing.
		const hide =
			change.to === null &&
			row.is_active &&
			validateVisual(row.visual_type, walked.value as never, null).some(
				(problem) => problem.severity === "error",
			);
		workFor(row.report_id).visuals.set(row.visual_id, {
			config: walked.value,
			hide,
		});
		if (hide) {
			result.hidden.push({
				reportId: row.report_id,
				visualId: row.visual_id,
				title: row.title,
				visualType: row.visual_type,
			});
		}
	}

	const pages = await client.query<{
		page_id: string;
		report_id: string;
		config: unknown;
		protected: boolean;
		slug: string;
		title: string;
	}>(
		`SELECT p.page_id, p.report_id, p.config,
		        (r.protect_edit OR p.protect_edit) AS protected, r.slug, r.title
		 FROM report_pages p
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE p.page_id IN (${pagesReadingSource})
		   AND strpos(coalesce(p.config, '{}'::jsonb)::text, $2) > 0
		 FOR UPDATE OF p`,
		[sourceKey, field],
	);
	for (const row of pages.rows) {
		const walked = walkPage(row.config, visit);
		if (walked.changed && change.skipProtected && row.protected) {
			skip(row.report_id, row.slug, row.title);
			continue;
		}
		if (walked.changed) {
			workFor(row.report_id).pages.set(row.page_id, walked.value);
		}
	}

	result.protectedReports.push(...protectedIds.values());

	for (const [reportId, held] of work) {
		const versioned = await versionReport(client, reportId, held, change);
		if (versioned) result.reports.push(versioned);
		for (const _ of held.visuals) count(result.changed, "visual");
		for (const _ of held.pages) count(result.changed, "page");
	}
}

// Writes one report's changed visuals and pages and records them as its next
// version, the way an edit is recorded. See applyEdits in lib/platform/editing.
async function versionReport(
	client: PoolClient,
	reportId: string,
	held: ReportWork,
	change: FieldChange,
): Promise<{ reportId: string; slug: string; title: string } | null> {
	const locked = await client.query<{
		version: string;
		is_personal: boolean;
		slug: string;
		title: string;
	}>(
		`SELECT version, is_personal, slug, title FROM reports
		 WHERE report_id = $1 FOR UPDATE`,
		[reportId],
	);
	const report = locked.rows[0];
	if (!report) return null;

	const operations: Json[] = [];
	for (const [visualId, { config, hide }] of held.visuals) {
		await client.query(
			`UPDATE report_visuals
			 SET config = $2::jsonb,
			     is_active = CASE WHEN $3 THEN FALSE ELSE is_active END
			 WHERE visual_id = $1`,
			[visualId, json(config), hide],
		);
		operations.push({ type: "updateVisual", visualId, config });
		if (hide) operations.push({ type: "removeVisual", visualId });
	}
	for (const [pageId, config] of held.pages) {
		await client.query(
			`UPDATE report_pages SET config = $2::jsonb WHERE page_id = $1`,
			[pageId, json(config)],
		);
		operations.push({ type: "updatePage", pageId, config });
	}

	const nextVersion = Number(report.version ?? 0) + 1;
	await client.query(
		`UPDATE reports SET version = $2, modified_by = $3, modified_on = now()
		 WHERE report_id = $1`,
		[reportId, nextVersion, change.actor],
	);
	const opRow = await client.query<{ seq: string }>(
		`INSERT INTO report_ops (report_id, actor, origin_id, op)
		 VALUES ($1, $2, NULL, $3)
		 RETURNING seq`,
		[reportId, change.actor, json({ version: nextVersion, operations })],
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
			`SELECT title, description, theme, guide FROM reports WHERE report_id = $1`,
			[reportId],
		);
		await writeVersion(client, {
			reportId,
			version: nextVersion,
			label: change.reason.slice(0, 200),
			snapshot: {
				visuals: visuals.rows,
				pages: pages.rows,
				report: header.rows[0] ?? null,
			},
			createdBy: change.actor,
			updateId: change.updateId ?? null,
		});
	}
	if (change.updateId) {
		const hidden = [...held.visuals.values()].filter((v) => v.hide).length;
		const parts = [
			held.visuals.size > 0
				? `${held.visuals.size} visual${held.visuals.size === 1 ? "" : "s"}`
				: "",
			held.pages.size > 0
				? `${held.pages.size} page setting${held.pages.size === 1 ? "" : "s"}`
				: "",
		].filter(Boolean);
		const verb =
			change.to === null
				? "Took it out of"
				: `Pointed at ${change.to} in`;
		await linkChange(
			{
				updateId: change.updateId,
				kind: report.is_personal ? "report" : "reportVersion",
				reportId,
				version: report.is_personal ? null : nextVersion,
				title: report.title,
				message: `${change.reason}. ${verb} ${parts.join(" and ")}.${
					hidden > 0
						? ` Turned off ${hidden} visual${hidden === 1 ? "" : "s"} left with nothing to show.`
						: ""
				}`,
				actor: change.actor,
			},
			client,
		);
	}

	await client.query(`SELECT pg_notify($1, $2)`, [
		`report_${reportId.replace(/-/g, "")}`,
		json({ seq, version: nextVersion, actor: change.actor }),
	]);
	return { reportId, slug: report.slug, title: report.title };
}

// --- Other items -----------------------------------------------------------

// Rewrites a JSON column on every row a query finds, through a walk, and counts
// what changed.
async function rewriteRows(
	client: PoolClient,
	kind: string,
	select: string,
	params: unknown[],
	update: string,
	walk: (value: unknown) => { value: unknown; changed: boolean },
	result: FieldChangeResult,
	extra: unknown[] = [],
): Promise<void> {
	const rows = await client.query<{ id: string; value: unknown }>(
		select,
		params,
	);
	for (const row of rows.rows) {
		const walked = walk(row.value);
		if (!walked.changed) continue;
		await client.query(update, [row.id, json(walked.value), ...extra]);
		count(result.changed, kind);
	}
}

async function changeOtherItems(
	client: PoolClient,
	change: FieldChange,
	visit: FieldVisit,
	result: FieldChangeResult,
): Promise<void> {
	const { sourceKey, field, to, actor } = change;
	const removed = to === null;

	await rewriteRows(
		client,
		"block",
		`SELECT block_id::text AS id, visuals AS value FROM blocks
		 WHERE is_active AND strpos(visuals::text, $1) > 0 FOR UPDATE`,
		[field],
		`UPDATE blocks SET visuals = $2::jsonb, modified_on = now() WHERE block_id::text = $1`,
		(value) => {
			if (!Array.isArray(value)) return { value, changed: false };
			let changedAny = false;
			const next = value.map((visual: Json) => {
				if (visual?.sourceKey !== sourceKey) return visual;
				const walked = walkVisual(visual.config, visit);
				if (!walked.changed) return visual;
				changedAny = true;
				return { ...visual, config: walked.value };
			});
			return { value: next, changed: changedAny };
		},
		result,
	);

	await rewriteRows(
		client,
		"savedView",
		`SELECT view_id::text AS id, config AS value FROM saved_views
		 WHERE page_id IN (${pagesReadingSource})
		   AND strpos(config::text, $2) > 0 FOR UPDATE`,
		[sourceKey, field],
		`UPDATE saved_views SET config = $2::jsonb, modified_on = now() WHERE view_id::text = $1`,
		(value) => walkSavedView(value, visit),
		result,
	);

	await rewriteRows(
		client,
		"exploration",
		`SELECT exploration_id::text AS id, config AS value FROM explorations
		 WHERE source_key = $1 AND strpos(config::text, $2) > 0 FOR UPDATE`,
		[sourceKey, field],
		`UPDATE explorations SET config = $2::jsonb, modified_on = now() WHERE exploration_id::text = $1`,
		(value) => walkVisual(value, visit),
		result,
	);

	await rewriteRows(
		client,
		"exploreView",
		`SELECT view_id::text AS id, state AS value FROM explore_views
		 WHERE state->>'sourceKey' = $1 AND strpos(state::text, $2) > 0 FOR UPDATE`,
		[sourceKey, field],
		`UPDATE explore_views SET state = $2::jsonb, modified_on = now() WHERE view_id::text = $1`,
		(value) => walkExplore(value, visit),
		result,
	);

	await rewriteRows(
		client,
		"sheet",
		`SELECT sheet_id::text AS id, definition AS value FROM sheets
		 WHERE definition->>'sourceKey' = $1 AND strpos(definition::text, $2) > 0
		 FOR UPDATE`,
		[sourceKey, field],
		// The version is what an open copy polls to know it should reload.
		`UPDATE sheets SET definition = $2::jsonb, version = version + 1,
		        modified_on = now(), modified_by = $3
		 WHERE sheet_id::text = $1`,
		(value) => walkSheet(value, visit),
		result,
		[actor],
	);

	await rewriteRows(
		client,
		"board",
		`SELECT board_id::text AS id, definition AS value FROM boards
		 WHERE strpos(definition::text, $1) > 0 AND strpos(definition::text, $2) > 0
		 FOR UPDATE`,
		[sourceKey, field],
		`UPDATE boards SET definition = $2::jsonb, version = version + 1,
		        modified_on = now(), modified_by = $3
		 WHERE board_id::text = $1`,
		(value) => walkBoard(value, sourceKey, visit),
		result,
		[actor],
	);

	await rewriteRows(
		client,
		"tour",
		`SELECT deck_id::text AS id, steps AS value FROM report_decks
		 WHERE report_id IN (${reportsReadingSource})
		   AND strpos(steps::text, $2) > 0 FOR UPDATE`,
		[sourceKey, field],
		`UPDATE report_decks SET steps = $2::jsonb, modified_on = now(), modified_by = $3
		 WHERE deck_id::text = $1`,
		(value) => walkDeckSteps(value, visit),
		result,
		[actor],
	);
	const decks = await client.query<{ deck_id: string }>(
		`UPDATE report_decks
		 SET record_field = $3, modified_on = now(), modified_by = $4,
		     require_record = CASE WHEN $3::text IS NULL THEN FALSE ELSE require_record END,
		     record_source = CASE WHEN $3::text IS NULL THEN NULL ELSE record_source END
		 WHERE record_source = $1 AND record_field = $2
		 RETURNING deck_id`,
		[sourceKey, field, to, actor],
	);
	for (const _ of decks.rows) count(result.changed, "tourRecord");

	// Alerts and page alerts. One watching a removed measure has nothing left
	// to watch and is turned off.
	for (const table of ["alert_rules", "page_alerts"] as const) {
		const idColumn = table === "alert_rules" ? "rule_id" : "alert_id";
		const activeColumn = table === "alert_rules" ? "enabled" : "is_active";
		const rows = await client.query<{
			id: string;
			name: string;
			definition: unknown;
		}>(
			`SELECT ${idColumn}::text AS id, name, definition FROM ${table}
			 WHERE source_key = $1 AND strpos(definition::text, $2) > 0 FOR UPDATE`,
			[sourceKey, field],
		);
		for (const row of rows.rows) {
			const walked = walkAlert(row.definition, visit);
			if (!walked.changed && !walked.orphaned) continue;
			await client.query(
				`UPDATE ${table}
				 SET definition = $2::jsonb, modified_on = now(),
				     ${activeColumn} = CASE WHEN $3 THEN FALSE ELSE ${activeColumn} END
				     ${table === "page_alerts" ? ", modified_by = $4" : ""}
				 WHERE ${idColumn}::text = $1`,
				table === "page_alerts"
					? [row.id, json(walked.value), walked.orphaned, actor]
					: [row.id, json(walked.value), walked.orphaned],
			);
			count(
				result.changed,
				table === "alert_rules" ? "alert" : "pageAlert",
			);
			if (walked.orphaned) {
				result.turnedOff.push({
					kind: table === "alert_rules" ? "alert" : "pageAlert",
					id: row.id,
					name: row.name,
				});
			}
		}
	}

	// Goals measure one measure, narrowed by filters.
	const goals = await client.query<{
		goal_id: string;
		title: string;
		measure: string;
		filters: unknown;
	}>(
		`SELECT goal_id::text, title, measure, filters FROM goals
		 WHERE source_key = $1 AND is_active
		   AND (measure = $2 OR strpos(filters::text, $2) > 0)
		 FOR UPDATE`,
		[sourceKey, field],
	);
	for (const goal of goals.rows) {
		if (goal.measure === field && removed) {
			await client.query(
				`UPDATE goals SET is_active = FALSE WHERE goal_id::text = $1`,
				[goal.goal_id],
			);
			result.turnedOff.push({
				kind: "goal",
				id: goal.goal_id,
				name: goal.title,
			});
			count(result.changed, "goal");
			continue;
		}
		const filters = walkClauses(goal.filters, visit);
		const measure = goal.measure === field && to ? to : goal.measure;
		if (measure === goal.measure && json(filters) === json(goal.filters)) {
			continue;
		}
		await client.query(
			`UPDATE goals SET measure = $2, filters = $3::jsonb WHERE goal_id::text = $1`,
			[goal.goal_id, measure, json(filters)],
		);
		count(result.changed, "goal");
	}

	// Plain columns naming the field.
	if (removed) {
		const forecasts = await client.query(
			`DELETE FROM forecast_records WHERE source_key = $1 AND measure = $2`,
			[sourceKey, field],
		);
		if (forecasts.rowCount) result.changed.forecast = forecasts.rowCount;
		const notes = await client.query(
			`UPDATE value_notes SET is_active = FALSE
			 WHERE source_key = $1 AND field = $2 AND is_active`,
			[sourceKey, field],
		);
		if (notes.rowCount) result.changed.valueNote = notes.rowCount;
		const choices = await client.query(
			`DELETE FROM briefing_choices
			 WHERE measure = $2 AND report_id IN (${reportsReadingSource})`,
			[sourceKey, field],
		);
		if (choices.rowCount) result.changed.briefingChoice = choices.rowCount;
	} else {
		// A rename onto a period already recorded keeps the existing record.
		const forecasts = await client.query(
			`UPDATE forecast_records f SET measure = $3
			 WHERE f.source_key = $1 AND f.measure = $2
			   AND NOT EXISTS (
			     SELECT 1 FROM forecast_records g
			     WHERE g.user_email = f.user_email AND g.visual_id = f.visual_id
			       AND g.measure = $3 AND g.period = f.period)`,
			[sourceKey, field, to],
		);
		if (forecasts.rowCount) result.changed.forecast = forecasts.rowCount;
		await client.query(
			`DELETE FROM forecast_records WHERE source_key = $1 AND measure = $2`,
			[sourceKey, field],
		);
		const notes = await client.query(
			`UPDATE value_notes SET field = $3 WHERE source_key = $1 AND field = $2`,
			[sourceKey, field, to],
		);
		if (notes.rowCount) result.changed.valueNote = notes.rowCount;
		const choices = await client.query(
			`UPDATE briefing_choices c SET measure = $3
			 WHERE c.measure = $2 AND c.report_id IN (${reportsReadingSource})
			   AND NOT EXISTS (
			     SELECT 1 FROM briefing_choices d
			     WHERE d.user_email = c.user_email AND d.report_id = c.report_id
			       AND d.measure = $3)`,
			[sourceKey, field, to],
		);
		if (choices.rowCount) result.changed.briefingChoice = choices.rowCount;
		await client.query(
			`DELETE FROM briefing_choices
			 WHERE measure = $2 AND report_id IN (${reportsReadingSource})`,
			[sourceKey, field],
		);
	}

	// Figures a reader last saw are keyed "<source>|<measure>|<filters>".
	const prefix = `${sourceKey}|${field}|`;
	const seen = await client.query<{
		user_email: string;
		page_id: string;
		figures: Record<string, unknown>;
	}>(
		`SELECT user_email, page_id, figures FROM last_seen_figures
		 WHERE strpos(figures::text, $1) > 0 FOR UPDATE`,
		[prefix],
	);
	for (const row of seen.rows) {
		const figures: Json = {};
		for (const [key, value] of Object.entries(row.figures ?? {})) {
			if (!key.startsWith(prefix)) {
				figures[key] = value;
			} else if (to) {
				figures[`${sourceKey}|${to}|${key.slice(prefix.length)}`] =
					value;
			}
		}
		await client.query(
			`UPDATE last_seen_figures SET figures = $3::jsonb
			 WHERE user_email = $1 AND page_id = $2`,
			[row.user_email, row.page_id, json(figures)],
		);
		count(result.changed, "lastSeen");
	}

	// What a delivery last sent, keyed by measure name.
	await rewriteRows(
		client,
		"delivery",
		`SELECT delivery_id::text AS id, state AS value FROM deliveries
		 WHERE source_key = $1 AND strpos(state::text, $2) > 0 FOR UPDATE`,
		[sourceKey, field],
		`UPDATE deliveries SET state = $2::jsonb WHERE delivery_id::text = $1`,
		(value) => {
			const state = (value ?? {}) as Json;
			const values = state.values;
			if (!values || typeof values !== "object") {
				return { value, changed: false };
			}
			const next: Json = {};
			for (const [key, figure] of Object.entries(values as Json)) {
				const seenName = key === field ? (to ?? dropField) : key;
				if (seenName === dropField) continue;
				next[seenName] = figure;
			}
			return {
				value: { ...state, values: next },
				changed: json(next) !== json(values),
			};
		},
		result,
	);

	// Open suggestions carry whole visual definitions and would put the old
	// name back when approved.
	await rewriteRows(
		client,
		"suggestion",
		`SELECT suggestion_id::text AS id, operations AS value FROM report_suggestions
		 WHERE status = 'open' AND report_id IN (${reportsReadingSource})
		   AND strpos(operations::text, $2) > 0 FOR UPDATE`,
		[sourceKey, field],
		`UPDATE report_suggestions SET operations = $2::jsonb WHERE suggestion_id::text = $1`,
		(value) => {
			if (!Array.isArray(value)) return { value, changed: false };
			let changedAny = false;
			const next = value.map((operation: Json) => {
				if (!operation?.config) return operation;
				const walked =
					operation.type === "updatePage"
						? walkPage(operation.config, visit)
						: walkVisual(operation.config, visit);
				if (!walked.changed) return operation;
				changedAny = true;
				return { ...operation, config: walked.value };
			});
			return { value: next, changed: changedAny };
		},
		result,
	);

	// What an alert checked while its owner was away was recorded against
	// field names, and so was the mapping of the source's filters to fields.
	const recordings = await client.query<{
		owner_email: string;
		fields: string[];
	}>(
		`SELECT owner_email, fields FROM alert_access
		 WHERE source_key = $1 AND fields ? $2 FOR UPDATE`,
		[sourceKey, field],
	);
	for (const recording of recordings.rows) {
		// The recorded tuples are positional to these fields, so a removed
		// field drops the recording, and it is taken again on the next look.
		if (removed) {
			await client.query(
				`DELETE FROM alert_access WHERE owner_email = $1 AND source_key = $2`,
				[recording.owner_email, sourceKey],
			);
		} else {
			await client.query(
				`UPDATE alert_access SET fields = $3::jsonb
				 WHERE owner_email = $1 AND source_key = $2`,
				[
					recording.owner_email,
					sourceKey,
					json(walkList(recording.fields, visit)),
				],
			);
		}
		count(result.changed, "alertAccess");
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
			? (walkList(held.access_fields, visit) as string[])
			: held.access_fields;
		const defaultTime =
			held.default_time_field === field ? to : held.default_time_field;
		if (
			json(fields) !== json(held.access_fields) ||
			defaultTime !== held.default_time_field
		) {
			await client.query(
				`UPDATE data_sources
				 SET access_fields = $2::jsonb, default_time_field = $3,
				     modified_on = now()
				 WHERE source_key = $1`,
				[sourceKey, fields === null ? null : json(fields), defaultTime],
			);
			count(result.changed, "source");
		}
	}

	// Following a field by name. A name some other source still publishes is
	// left alone, since the follow may be about that one.
	const elsewhere = await client.query(
		`SELECT 1 FROM source_fields
		 WHERE field_name = $1 AND source_key <> $2 AND status = 'active' LIMIT 1`,
		[field, sourceKey],
	);
	if (elsewhere.rowCount === 0) {
		const follows = removed
			? await client.query(
					`DELETE FROM update_follows WHERE kind = 'field' AND value = $1`,
					[field],
				)
			: await client.query(
					`UPDATE update_follows f SET value = $2
					 WHERE f.kind = 'field' AND f.value = $1
					   AND NOT EXISTS (
					     SELECT 1 FROM update_follows g
					     WHERE g.user_email = f.user_email AND g.kind = 'field'
					       AND g.value = $2)`,
					[field, to],
				);
		if (follows.rowCount) result.changed.follow = follows.rowCount;
	}

	// The labels somebody wrote for the old name belong to the field, so they
	// move with it. A label already on the new field is kept.
	if (to) {
		await client.query(
			`UPDATE source_fields AS n
			 SET display_name = coalesce(n.display_name, o.display_name),
			     description  = coalesce(n.description, o.description),
			     format_hint  = coalesce(n.format_hint, o.format_hint),
			     folder       = coalesce(n.folder, o.folder),
			     is_default   = o.is_default OR n.is_default,
			     modified_by  = $4,
			     modified_on  = now()
			 FROM source_fields AS o
			 WHERE n.source_key = $1 AND n.field_name = $3
			   AND o.source_key = $1 AND o.field_name = $2`,
			[sourceKey, field, to, actor],
		);
		await client.query(
			`UPDATE source_fields
			 SET renamed_to = $3, rename_candidate = NULL,
			     rename_confidence = NULL, is_default = FALSE,
			     modified_by = $4, modified_on = now()
			 WHERE source_key = $1 AND field_name = $2`,
			[sourceKey, field, to, actor],
		);
	}
}

// --- Checking ---------------------------------------------------------------

// Every live item that still names the field, found by the same walks the
// change uses. Read after the change, it should find nothing.
export async function referencesTo(
	sourceKey: string,
	field: string,
): Promise<{ kind: string; id: string; reportId?: string }[]> {
	const left: { kind: string; id: string; reportId?: string }[] = [];
	const names = (walk: (visit: FieldVisit) => unknown) =>
		namesIn(walk).includes(field);
	const check = async (
		kind: string,
		query: string,
		params: unknown[],
		has: (value: unknown) => boolean,
	) => {
		const rows = await sql<{
			id: string;
			value: unknown;
			report_id?: string;
		}>(query, params);
		for (const row of rows) {
			if (has(row.value)) {
				left.push({ kind, id: row.id, reportId: row.report_id });
			}
		}
	};

	await check(
		"visual",
		`SELECT v.visual_id::text AS id, v.config AS value,
		        p.report_id::text AS report_id
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE v.is_active AND coalesce(v.source_key, p.source_key, r.source_key) = $1
		   AND strpos(v.config::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkVisual(value, visit)),
	);
	await check(
		"page",
		`SELECT page_id::text AS id, config AS value,
		        report_id::text AS report_id
		 FROM report_pages
		 WHERE page_id IN (${pagesReadingSource})
		   AND strpos(coalesce(config, '{}'::jsonb)::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkPage(value, visit)),
	);
	await check(
		"savedView",
		`SELECT view_id::text AS id, config AS value FROM saved_views
		 WHERE page_id IN (${pagesReadingSource}) AND strpos(config::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkSavedView(value, visit)),
	);
	await check(
		"exploration",
		`SELECT exploration_id::text AS id, config AS value FROM explorations
		 WHERE source_key = $1 AND strpos(config::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkVisual(value, visit)),
	);
	await check(
		"exploreView",
		`SELECT view_id::text AS id, state AS value FROM explore_views
		 WHERE state->>'sourceKey' = $1 AND strpos(state::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkExplore(value, visit)),
	);
	await check(
		"sheet",
		`SELECT sheet_id::text AS id, definition AS value FROM sheets
		 WHERE definition->>'sourceKey' = $1 AND strpos(definition::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkSheet(value, visit)),
	);
	await check(
		"board",
		`SELECT board_id::text AS id, definition AS value FROM boards
		 WHERE strpos(definition::text, $1) > 0 AND strpos(definition::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkBoard(value, sourceKey, visit)),
	);
	await check(
		"tour",
		`SELECT deck_id::text AS id, steps AS value FROM report_decks
		 WHERE is_active AND report_id IN (${reportsReadingSource})
		   AND strpos(steps::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkDeckSteps(value, visit)),
	);
	await check(
		"alert",
		`SELECT rule_id::text AS id, definition AS value FROM alert_rules
		 WHERE enabled AND source_key = $1 AND strpos(definition::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkAlert(value, visit)),
	);
	await check(
		"pageAlert",
		`SELECT alert_id::text AS id, definition AS value FROM page_alerts
		 WHERE is_active AND source_key = $1 AND strpos(definition::text, $2) > 0`,
		[sourceKey, field],
		(value) => names((visit) => walkAlert(value, visit)),
	);
	const goals = await sql<{ id: string }>(
		`SELECT goal_id::text AS id FROM goals
		 WHERE is_active AND source_key = $1
		   AND (measure = $2 OR filters @> jsonb_build_array(jsonb_build_object('field', $2::text)))`,
		[sourceKey, field],
	);
	for (const goal of goals) left.push({ kind: "goal", id: goal.id });
	const plain = await sql<{ kind: string; id: string }>(
		`SELECT 'forecast' AS kind, visual_id AS id FROM forecast_records
		   WHERE source_key = $1 AND measure = $2
		 UNION ALL
		 SELECT 'valueNote', note_id::text FROM value_notes
		   WHERE is_active AND source_key = $1 AND field = $2
		 UNION ALL
		 SELECT 'tourRecord', deck_id::text FROM report_decks
		   WHERE record_source = $1 AND record_field = $2`,
		[sourceKey, field],
	);
	left.push(...plain);
	return left;
}

// --- Entry -----------------------------------------------------------------

export async function applyFieldChange(
	change: FieldChange,
): Promise<FieldChangeResult> {
	const visit =
		change.to === null
			? removing(change.field)
			: renaming(change.field, change.to);
	const result: FieldChangeResult = {
		sourceKey: change.sourceKey,
		field: change.field,
		to: change.to,
		changed: {},
		reports: [],
		hidden: [],
		protectedReports: [],
		turnedOff: [],
		left: [],
	};

	await transaction(async (client) => {
		await changeReports(client, change, visit, result);
		await changeOtherItems(client, change, visit, result);
	});

	// This replica drops what it held at once. Another serves the previous
	// definition until its entry lapses, as after any edit.
	for (const { reportId } of result.reports) {
		invalidateDefinitions(`report-body:${reportId}`);
	}
	if (result.reports.length > 0) invalidateDefinitions("report:");
	invalidateDefinitions("views:");
	await reloadRegistryEverywhere(true);

	// What a protected report still names is known and reported on its own,
	// so it is not counted as missed.
	const kept = new Set(result.protectedReports.map((r) => r.reportId));
	result.left = (await referencesTo(change.sourceKey, change.field)).filter(
		(item) => !item.reportId || !kept.has(item.reportId),
	);

	void insertLog({
		recordType: "source",
		recordId: change.sourceKey,
		action: change.to === null ? "remove_field" : "remap_field",
		fieldName: change.field,
		oldValue: change.field,
		newValue: change.to,
		changedBy: change.actor,
		notes: json({
			changed: result.changed,
			reports: result.reports.length,
			hidden: result.hidden.length,
			left: result.left.length,
		}),
	});

	return result;
}
