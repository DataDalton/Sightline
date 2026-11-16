import { randomUUID } from "node:crypto";
import { sql, tryAdvisoryLock } from "../data/lakebase";
import { demoMode } from "../runtime";
import { settings } from "../settings";
import { notify } from "../notify/store";
import { applyAssistantEdits, type EditOperation } from "../platform/editing";
import { createReport } from "../platform/authoring";
import { assistantNote } from "../updates/store";
import { getSource, reloadRegistryEverywhere } from "../semantic/registry";
import { syncSourceFields } from "../semantic/fieldSync";
import {
	listObjects,
	registerSource,
	sourceKeyFor,
} from "../semantic/discovery";
import { routineLooksAllowed } from "../freshness/warehouse";
import { applyFieldChange, type FieldChangeResult } from "./fieldChange";
import {
	actionKey,
	autoRenameConfidence,
	describeAction,
	planFromAbout,
	planFromSync,
	type AboutLike,
	type SyncFindings,
	type UpkeepAction,
} from "./plan";
import {
	checkReportPlan,
	checkVisual,
	layoutPage,
	newFieldEdits,
	parseJson,
	withoutFigures,
	type ReportShape,
} from "./decide";
import { describeFields, firstLook, reportsOn, sourceShape } from "./look";
import { askAsApplication, ModelUnavailable } from "./model";
import { assistantActor, assistantIdentity } from "./actor";
import { tellAboutChanges, tellItemOwners } from "./tell";
import { runFeedbackReview } from "../feedback/review";
import { runWorkPass } from "../work/releases";
import { linkChange } from "../updates/links";

// The assistant acting on its own when a change reaches a source.
//
// Each tick it reads updates it has not read for what they say changed, picks up
// fields the sync has seen missing for a day, registers new objects in the
// watched schemas, and then works through the actions that are due. Every action
// is checked against the source's fields before it is carried out, so an update
// that is early, or wrong, waits or is skipped rather than breaking a report.
//
// What it changes goes through the same paths a person's edit does, under its
// own name, with the change as the version label. What it did is written in the
// update's notes. A protected report is left alone and its owner told.

// How long an action waits for the source to show the change before trying
// again, and how many tries it gets before it is given up on.
const retryAfterSeconds = 6 * 60 * 60;
const maxAttempts = 12;
// How long a field must have been missing before it counts as removed, so a view
// being rebuilt does not empty every report built on it.
const missingForSeconds = 24 * 60 * 60;
// Actions worked per tick. The rest wait for the next one.
const perTick = 20;
const upkeepLockKey = 7_420_311;

let running = false;

interface ActionRow {
	action_key: string;
	action: UpkeepAction;
	update_id: string | null;
	attempts: number;
}

type Outcome =
	| { state: "done"; summary: string[]; result?: unknown }
	| { state: "waiting"; reason: string }
	| { state: "skipped"; reason: string };

// --- Queueing ---------------------------------------------------------------

export async function enqueue(
	actions: UpkeepAction[],
	updateId: string | null,
): Promise<void> {
	for (const action of actions) {
		await sql(
			`INSERT INTO upkeep_actions (action_key, kind, action, update_id)
			 VALUES ($1, $2, $3::jsonb, $4)
			 ON CONFLICT (action_key) DO UPDATE
			 SET update_id = coalesce(upkeep_actions.update_id, EXCLUDED.update_id)`,
			[actionKey(action), action.kind, JSON.stringify(action), updateId],
		);
	}
}

// What a field sync found, queued. Called by the daily sync after it posts its
// own entries.
export async function enqueueSyncFindings(found: SyncFindings): Promise<void> {
	await enqueue(planFromSync(found), null).catch((error) => {
		console.warn(
			"The assistant could not queue what the sync found:",
			error,
		);
	});
}

async function readUpdates(): Promise<void> {
	const updates = await sql<{ update_id: string; about: AboutLike[] }>(
		`SELECT update_id::text, about FROM updates
		 WHERE status = 'published' AND upkeep_read_on IS NULL
		   AND posted_on > now() - interval '30 days'
		 ORDER BY posted_on
		 LIMIT 100`,
	);
	for (const update of updates) {
		await enqueue(planFromAbout(update.about ?? []), update.update_id);
		await sql(
			`UPDATE updates SET upkeep_read_on = now() WHERE update_id = $1`,
			[update.update_id],
		);
	}
}

// Fields missing for long enough, with no rename in sight, become removals.
async function findRemovals(): Promise<void> {
	const missing = await sql<{ source_key: string; field_name: string }>(
		`SELECT f.source_key, f.field_name FROM source_fields f
		 JOIN data_sources s ON s.source_key = f.source_key AND s.is_active
		 WHERE f.status = 'missing' AND f.renamed_to IS NULL
		   AND f.missing_since < now() - make_interval(secs => $1)
		   AND (f.rename_candidate IS NULL OR coalesce(f.rename_confidence, 0) < 0.5)`,
		[missingForSeconds],
	);
	await enqueue(
		missing.map((row) => ({
			kind: "remove" as const,
			sourceKey: row.source_key,
			field: row.field_name,
		})),
		null,
	);

	// A rename any sync found with strong evidence, including one an
	// administrator ran by hand, which the daily path never saw.
	const renamed = await sql<{
		source_key: string;
		field_name: string;
		rename_candidate: string;
	}>(
		`SELECT f.source_key, f.field_name, f.rename_candidate FROM source_fields f
		 JOIN data_sources s ON s.source_key = f.source_key AND s.is_active
		 WHERE f.status = 'missing' AND f.renamed_to IS NULL
		   AND f.rename_candidate IS NOT NULL
		   AND f.rename_confidence >= $1`,
		[autoRenameConfidence],
	);
	await enqueue(
		renamed.map((row) => ({
			kind: "rename" as const,
			sourceKey: row.source_key,
			field: row.field_name,
			to: row.rename_candidate,
		})),
		null,
	);
}

// New tables and views in the watched schemas, registered as sources.
async function watchSchemas(): Promise<void> {
	const held = settings();
	if (!held.upkeepNewSources) return;
	for (const entry of held.upkeepWatchedSchemas) {
		const [catalog, schema] = entry.split(".");
		if (!catalog || !schema) continue;
		const objects = await listObjects(
			assistantIdentity(),
			catalog,
			schema,
		).catch((error) => {
			console.warn(`The assistant could not list ${entry}:`, error);
			return [];
		});
		for (const object of objects) {
			if (object.registered) continue;
			const sourceKey = sourceKeyFor(schema, object.name);
			try {
				await registerSource(assistantIdentity(), {
					title: titleFrom(object.name),
					description: object.comment,
					catalog,
					schema,
					object: object.name,
					kind: object.kind,
				});
				await enqueue([{ kind: "newSource", sourceKey }], null);
			} catch (error) {
				console.warn(
					`The assistant could not register ${catalog}.${schema}.${object.name}:`,
					error,
				);
			}
		}
	}
}

function titleFrom(name: string): string {
	return name
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- Checking against the source --------------------------------------------

interface FieldFacts {
	status: string;
	kind: string;
	renameCandidate: string | null;
	renameConfidence: number | null;
}

async function factsOf(
	sourceKey: string,
	fields: string[],
): Promise<Map<string, FieldFacts>> {
	const rows = await sql<{
		field_name: string;
		status: string;
		field_kind: string;
		rename_candidate: string | null;
		rename_confidence: number | null;
	}>(
		`SELECT field_name, status, field_kind, rename_candidate, rename_confidence
		 FROM source_fields WHERE source_key = $1 AND field_name = ANY($2::text[])`,
		[sourceKey, fields],
	);
	return new Map(
		rows.map((row) => [
			row.field_name,
			{
				status: row.status,
				kind: row.field_kind,
				renameCandidate: row.rename_candidate,
				renameConfidence: row.rename_confidence,
			},
		]),
	);
}

// Reads the source's fields again, so an update that arrived before the daily
// sync is checked against what the source shows now.
async function resync(sourceKey: string): Promise<void> {
	if (demoMode) return;
	await syncSourceFields(assistantIdentity(), sourceKey).catch((error) => {
		console.warn(
			`The assistant could not read the fields of ${sourceKey}:`,
			error,
		);
	});
	await reloadRegistryEverywhere(true);
}

// Waits for the source, or gives up after enough tries.
function waitOrSkip(row: ActionRow, reason: string): Outcome {
	return row.attempts + 1 >= maxAttempts
		? { state: "skipped", reason }
		: { state: "waiting", reason };
}

// --- Renames and removals ---------------------------------------------------

function reportList(result: FieldChangeResult): string {
	return result.reports.map((report) => report.title).join(", ");
}

// What a field change did, in sentences for the update's notes.
function describeChange(result: FieldChangeResult, verb: string): string[] {
	const lines: string[] = [];
	if (result.reports.length > 0) {
		lines.push(
			`${verb} on ${reportList(result)}, each saved as a new version.`,
		);
	}
	const others = Object.entries(result.changed).filter(
		([kind]) => kind !== "visual" && kind !== "page",
	);
	if (others.length > 0) {
		lines.push(
			`Also updated: ${others
				.map(([kind, n]) => `${n} ${kindWord(kind, n)}`)
				.join(", ")}.`,
		);
	}
	for (const item of result.turnedOff) {
		lines.push(
			`Turned off ${kindWord(item.kind, 1)} "${item.name}", which watched nothing else.`,
		);
	}
	if (result.protectedReports.length > 0) {
		lines.push(
			`Left ${result.protectedReports
				.map((report) => report.title)
				.join(", ")} unchanged because ${
				result.protectedReports.length === 1 ? "it is" : "they are"
			} protected. The owners have been told.`,
		);
	}
	if (result.left.length > 0) {
		lines.push(
			`${result.left.length} item${result.left.length === 1 ? "" : "s"} still name the old field and need a look.`,
		);
	}
	return lines;
}

// What each kind of item is called, one and several.
const kindWords: Record<string, [string, string]> = {
	savedView: ["saved view", "saved views"],
	exploration: ["exploration", "explorations"],
	exploreView: ["Explore view", "Explore views"],
	sheet: ["sheet", "sheets"],
	board: ["board", "boards"],
	block: ["block", "blocks"],
	tour: ["tour", "tours"],
	tourRecord: ["tour record field", "tour record fields"],
	alert: ["alert", "alerts"],
	pageAlert: ["page alert", "page alerts"],
	goal: ["goal", "goals"],
	forecast: ["forecast record", "forecast records"],
	valueNote: ["value note", "value notes"],
	briefingChoice: ["briefing choice", "briefing choices"],
	lastSeen: ["last-seen figure", "last-seen figures"],
	delivery: ["scheduled delivery", "scheduled deliveries"],
	suggestion: ["open suggestion", "open suggestions"],
	alertAccess: ["alert access record", "alert access records"],
	source: ["source setting", "source settings"],
	follow: ["follow", "follows"],
};

function kindWord(kind: string, n: number): string {
	const words = kindWords[kind];
	if (!words) return kind;
	return n === 1 ? words[0] : words[1];
}

async function tellProtectedOwners(
	result: FieldChangeResult,
	what: string,
): Promise<void> {
	if (result.protectedReports.length === 0) return;
	const owners = await sql<{
		owner_email: string;
		slug: string;
		title: string;
	}>(
		`SELECT owner_email, slug, title FROM reports
		 WHERE report_id = ANY($1::uuid[]) AND owner_email IS NOT NULL`,
		[result.protectedReports.map((report) => report.reportId)],
	);
	for (const owner of owners) {
		await notify(owner.owner_email, {
			kind: "schema",
			title: `${owner.title} needs a change it is protected from`,
			body: `${what}. The assistant left this report as it is because it is protected.`,
			link: `/r/${owner.slug}`,
		}).catch(() => {});
	}
}

async function rename(
	row: ActionRow,
	action: Extract<UpkeepAction, { kind: "rename" }>,
): Promise<Outcome> {
	if (!settings().upkeepRenames)
		return { state: "skipped", reason: "Renames are switched off" };
	let facts = await factsOf(action.sourceKey, [action.field, action.to]);
	const ready = () => {
		const to = facts.get(action.to);
		const from = facts.get(action.field);
		return to?.status === "active" && from?.status !== "active";
	};
	if (!ready()) {
		await resync(action.sourceKey);
		facts = await factsOf(action.sourceKey, [action.field, action.to]);
	}
	if (!ready()) {
		return waitOrSkip(
			row,
			`${action.sourceKey} does not show ${action.field} renamed to ${action.to} yet`,
		);
	}
	const from = facts.get(action.field);
	const to = facts.get(action.to);
	if (from && to && from.kind !== to.kind) {
		return {
			state: "skipped",
			reason: `${action.field} is a ${from.kind} and ${action.to} is a ${to.kind}, so one cannot stand in for the other`,
		};
	}
	const result = await applyFieldChange({
		sourceKey: action.sourceKey,
		field: action.field,
		to: action.to,
		actor: assistantActor,
		reason: `${action.field} renamed to ${action.to}`,
		skipProtected: true,
		updateId: row.update_id,
	});
	await tellProtectedOwners(
		result,
		`${action.field} was renamed to ${action.to}`,
	);
	await tellAboutChanges({
		updateId: row.update_id,
		sourceKey: action.sourceKey,
		what: `${action.field} was renamed to ${action.to}`,
		reportIds: result.reports.map((report) => report.reportId),
	});
	await tellItemOwners(
		result.turnedOff,
		`${action.field} was renamed to ${action.to}`,
	);
	const summary = describeChange(
		result,
		`Pointed every use of ${action.field} at ${action.to}`,
	);
	return {
		state: "done",
		summary:
			summary.length > 0 ? summary : [`Nothing used ${action.field}.`],
		result,
	};
}

async function remove(
	row: ActionRow,
	action: Extract<UpkeepAction, { kind: "remove" }>,
): Promise<Outcome> {
	if (!settings().upkeepRemovals)
		return { state: "skipped", reason: "Removals are switched off" };
	let facts = await factsOf(action.sourceKey, [action.field]);
	if (facts.get(action.field)?.status === "active") {
		await resync(action.sourceKey);
		facts = await factsOf(action.sourceKey, [action.field]);
	}
	const field = facts.get(action.field);
	if (field?.status === "active") {
		return waitOrSkip(
			row,
			`${action.sourceKey} still publishes ${action.field}`,
		);
	}
	if (field?.renameCandidate && (field.renameConfidence ?? 0) >= 0.5) {
		return {
			state: "skipped",
			reason: `${action.field} looks renamed to ${field.renameCandidate}, which somebody can confirm in the Dictionary`,
		};
	}
	const result = await applyFieldChange({
		sourceKey: action.sourceKey,
		field: action.field,
		to: null,
		actor: assistantActor,
		reason: `${action.field} removed`,
		skipProtected: true,
		updateId: row.update_id,
	});
	await tellProtectedOwners(result, `${action.field} was removed`);
	const summary = describeChange(
		result,
		`Took ${action.field} out of every visual using it`,
	);
	if (result.hidden.length > 0) {
		summary.push(
			...(await replaceHidden(
				action.sourceKey,
				action.field,
				result,
				row.update_id,
			)),
		);
	}
	await tellAboutChanges({
		updateId: row.update_id,
		sourceKey: action.sourceKey,
		what: `${action.field} was removed`,
		reportIds: result.reports.map((report) => report.reportId),
	});
	await tellItemOwners(result.turnedOff, `${action.field} was removed`);
	return {
		state: "done",
		summary:
			summary.length > 0 ? summary : [`Nothing used ${action.field}.`],
		result,
	};
}

// Visuals a removal left with nothing to show, replaced with the nearest
// equivalent the source still has. Those the model cannot replace stay off.
async function replaceHidden(
	sourceKey: string,
	field: string,
	result: FieldChangeResult,
	updateId: string | null,
): Promise<string[]> {
	const source = getSource(sourceKey);
	if (!source) return [];
	const lines: string[] = [];
	const shape = sourceShape(source);
	const reports = await reportsOn(sourceKey);
	const visualIndex = new Map<
		string,
		{ report: ReportShape; pageId: string }
	>();
	for (const report of reports) {
		for (const page of report.pages) {
			for (const visual of page.visuals) {
				visualIndex.set(visual.visualId, {
					report,
					pageId: page.pageId,
				});
			}
		}
	}
	let reply: unknown = null;
	try {
		reply = parseJson(
			await askAsApplication(
				[
					"A field was removed from a dataset, and some visuals on reports built on it were left with nothing to show.",
					"For each one, propose the closest replacement using only the fields the dataset still has, or leave it out when nothing comes close.",
					'Answer with only JSON: {"replacements": [{"visualId": "...", "visualType": "...", "title": "...", "dimensions": [...], "measures": [...]}]}.',
					"Field names must be copied exactly from the lists given.",
				].join(" "),
				{
					removedField: field,
					fields: describeFields(source),
					visuals: result.hidden.map((visual) => ({
						visualId: visual.visualId,
						visualType: visual.visualType,
						title: visual.title,
					})),
				},
			),
		);
	} catch (error) {
		if (!(error instanceof ModelUnavailable)) throw error;
		lines.push(
			`Turned off ${result.hidden.length} visual${result.hidden.length === 1 ? "" : "s"} left with nothing to show. No model is available to propose replacements.`,
		);
		return lines;
	}
	const replacements = Array.isArray(
		(reply as { replacements?: unknown })?.replacements,
	)
		? (reply as { replacements: Record<string, unknown>[] }).replacements
		: [];
	const replaced = new Set<string>();
	for (const proposal of replacements) {
		const hidden = result.hidden.find(
			(visual) => visual.visualId === proposal.visualId,
		);
		const where = hidden ? visualIndex.get(hidden.visualId) : undefined;
		if (!hidden || !where) continue;
		const checked = checkVisual(proposal, shape);
		if (!checked.value) continue;
		const old = where.report.pages
			.flatMap((page) => page.visuals)
			.find((visual) => visual.visualId === hidden.visualId);
		const operation: EditOperation = {
			type: "addVisual",
			visualId: randomUUID(),
			pageId: where.pageId,
			visualType: checked.value.visualType,
			title: checked.value.title,
			sourceKey,
			config: {
				dimensions: checked.value.dimensions,
				measures: checked.value.measures,
			},
			layout: old?.layout,
		};
		const applied = await applyToReport(
			where.report.reportId,
			[operation],
			`Replaced ${hidden.title ?? "a visual"} after ${field} was removed`,
			updateId,
		);
		if (applied) {
			replaced.add(hidden.visualId);
			lines.push(
				`Replaced ${hidden.title ?? "a visual"} on ${where.report.title} with ${checked.value.title}.`,
			);
		}
	}
	const off = result.hidden.filter(
		(visual) => !replaced.has(visual.visualId),
	);
	if (off.length > 0) {
		lines.push(
			`Turned off ${off.map((visual) => visual.title ?? "a visual").join(", ")}, which had nothing close left to show.`,
		);
	}
	return lines;
}

// Applies edits to one report at its current version. False when the report is
// protected or the edits were refused, which is logged rather than thrown, so one
// report cannot stop the rest of an action.
async function applyToReport(
	reportId: string,
	operations: EditOperation[],
	label: string,
	updateId: string | null,
): Promise<boolean> {
	if (operations.length === 0) return false;
	const current = await sql<{ version: string }>(
		`SELECT version FROM reports WHERE report_id = $1`,
		[reportId],
	);
	if (!current[0]) return false;
	try {
		await applyAssistantEdits(
			assistantActor,
			{
				reportId,
				baseVersion: Number(current[0].version),
				operations,
			},
			label,
			updateId,
		);
		return true;
	} catch (error) {
		console.warn(
			`The assistant's edit to report ${reportId} was refused:`,
			error,
		);
		return false;
	}
}

// --- New fields, definitions, sources and pages ------------------------------

async function newField(
	row: ActionRow,
	action: Extract<UpkeepAction, { kind: "newField" }>,
): Promise<Outcome> {
	if (!settings().upkeepNewFields)
		return { state: "skipped", reason: "New fields are switched off" };
	let source = getSource(action.sourceKey);
	let field =
		source &&
		[...source.dimensions, ...source.measures].find(
			(f) => f.name === action.field,
		);
	if (!field) {
		await resync(action.sourceKey);
		source = getSource(action.sourceKey);
		field =
			source &&
			[...source.dimensions, ...source.measures].find(
				(f) => f.name === action.field,
			);
	}
	if (!source || !field) {
		return waitOrSkip(
			row,
			`${action.sourceKey} does not publish ${action.field} yet`,
		);
	}
	const reports = await reportsOn(action.sourceKey);
	if (reports.length === 0) {
		return {
			state: "done",
			summary: [
				`No shared report is built on ${source.title} yet, so ${action.field} is available in Explore and the editor.`,
			],
		};
	}
	const look = await firstLook(action.sourceKey, action.field);
	let reply: unknown;
	try {
		reply = parseJson(
			await askAsApplication(
				[
					"A new field has been added to a dataset that shared reports are built on. Decide where it belongs on those reports, if anywhere.",
					"Add it to an existing table or matrix when it is a useful column there, add it to a filter when it is a category people would narrow by, and add a new chart only when the summary shows it tells something the reports do not already show.",
					"Prefer few, clearly useful changes over many. It is fine to change nothing.",
					"The summary was read only for you to decide; never repeat a figure from it.",
					'Answer with only JSON: {"edits": [{"do": "addToVisual", "visualId": "..."} or {"do": "addVisual", "pageId": "...", "visualType": "...", "title": "...", "dimensions": [...], "measures": [...]}], "note": "one or two sentences for the people who read these reports, saying what you added and why, with no numbers"}.',
					"Visual types you may use: barChart, horizontalBarChart, lineChart, areaChart, stackedBarChart, pieChart, donutChart, treemapChart, table, matrixTable, kpiRow, scatterChart, heatmapChart, dropdownFilter.",
				].join(" "),
				{
					newField: {
						name: field.name,
						kind: field.kind,
						type: field.dataType,
						description: field.description,
						expression: field.expression,
					},
					summary: look,
					fields: describeFields(source),
					reports: reports.map((report) => ({
						reportId: report.reportId,
						title: report.title,
						pages: report.pages.map((page) => ({
							pageId: page.pageId,
							title: page.title,
							visuals: page.visuals
								.filter((visual) => visual.isActive)
								.map((visual) => ({
									visualId: visual.visualId,
									visualType: visual.visualType,
									title: visual.title,
									dimensions: visual.dimensions,
									measures: visual.measures,
								})),
						})),
					})),
				},
				4000,
			),
		);
	} catch (error) {
		if (error instanceof ModelUnavailable) {
			return waitOrSkip(
				row,
				`No model is available to decide where ${action.field} belongs`,
			);
		}
		throw error;
	}
	const { byReport, doneByReport, done, skipped } = newFieldEdits(
		reply,
		action.field,
		field.kind === "measure" ? "measure" : "dimension",
		sourceShape(source),
		reports,
		() => randomUUID(),
	);
	const applied: string[] = [];
	for (const [reportId, operations] of byReport) {
		const label = `${action.field} added: ${(doneByReport.get(reportId) ?? []).join("; ")}`;
		if (
			await applyToReport(
				reportId,
				operations as EditOperation[],
				label,
				row.update_id,
			)
		) {
			applied.push(reportId);
		}
	}
	await tellAboutChanges({
		updateId: row.update_id,
		sourceKey: action.sourceKey,
		what: `${action.field} was added to ${source.title}`,
		reportIds: applied,
	});
	const note = withoutFigures(
		String((reply as { note?: unknown })?.note ?? ""),
	);
	const summary: string[] = [];
	if (applied.length > 0 && done.length > 0) {
		summary.push(
			`${done.map((line) => line[0].toUpperCase() + line.slice(1)).join(". ")}.`,
		);
		if (note) summary.push(note);
	} else {
		summary.push(
			`Looked at where ${action.field} could go on the reports built on ${source.title} and changed nothing.`,
		);
		if (note) summary.push(note);
	}
	if (skipped.length > 0) summary.push(`Left out: ${skipped.join("; ")}.`);
	return { state: "done", summary };
}

async function definition(
	row: ActionRow,
	action: Extract<UpkeepAction, { kind: "definition" }>,
): Promise<Outcome> {
	if (!settings().upkeepDefinitions)
		return {
			state: "skipped",
			reason: "Definition notes are switched off",
		};
	const source = getSource(action.sourceKey);
	if (!source)
		return waitOrSkip(
			row,
			`${action.sourceKey} is not a registered source`,
		);
	const update = row.update_id
		? (
				await sql<{ effective_on: string | null; posted_on: string }>(
					`SELECT effective_on::text, posted_on::text FROM updates WHERE update_id = $1`,
					[row.update_id],
				)
			)[0]
		: null;
	const day = (
		update?.effective_on ??
		update?.posted_on ??
		new Date().toISOString()
	).slice(0, 10);
	// Visuals reading the measure, each given a note anchored at the date it
	// changed. The update itself already marks the date on charts.
	const visuals = await sql<{
		visual_id: string;
		page_id: string;
		report_id: string;
		title: string;
	}>(
		`SELECT v.visual_id::text, v.page_id::text, p.report_id::text, r.title
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE v.is_active AND NOT r.is_personal
		   AND coalesce(v.source_key, p.source_key, r.source_key) = $1
		   AND (v.config->'measures') ? $2`,
		[action.sourceKey, action.field],
	);
	const body = `How ${action.field} is worked out changed on ${day}. Figures before and after that date are not directly comparable.`;
	let added = 0;
	for (const visual of visuals) {
		const existing = await sql(
			`SELECT 1 FROM visual_notes
			 WHERE visual_id = $1 AND author_email = $2 AND body = $3 LIMIT 1`,
			[visual.visual_id, assistantActor, body],
		);
		if (existing.length > 0) continue;
		await sql(
			`INSERT INTO visual_notes (report_id, page_id, visual_id, author_email, body, anchored_on)
			 VALUES ($1, $2, $3, $4, $5, $6::date)`,
			[
				visual.report_id,
				visual.page_id,
				visual.visual_id,
				assistantActor,
				body,
				day,
			],
		);
		added++;
	}
	const reportTitles = [...new Set(visuals.map((visual) => visual.title))];
	return {
		state: "done",
		summary:
			added > 0
				? [
						`Added a note about the change to ${added} visual${added === 1 ? "" : "s"} using ${action.field}, on ${reportTitles.join(", ")}, anchored at ${day}.`,
					]
				: [
						`No shared report shows ${action.field}, so there was nothing to note.`,
					],
	};
}

// The category a new source's report belongs in: where the reports on other
// sources from the same schema already sit, or else the first category.
async function categoryFor(sourceKey: string): Promise<string | null> {
	const source = getSource(sourceKey);
	const rows = await sql<{ category_id: string }>(
		`SELECT r.category_id FROM reports r
		 JOIN data_sources s ON s.source_key = r.source_key
		 WHERE r.is_active AND NOT r.is_personal AND r.category_id IS NOT NULL
		   AND s.catalog_name = $1 AND s.schema_name = $2
		 GROUP BY r.category_id ORDER BY count(*) DESC LIMIT 1`,
		[source?.catalog ?? "", source?.schema ?? ""],
	);
	if (rows[0]) return rows[0].category_id;
	const first = await sql<{ category_id: string }>(
		`SELECT category_id FROM categories WHERE is_active ORDER BY sort_order, name LIMIT 1`,
	);
	return first[0]?.category_id ?? null;
}

async function newSource(
	row: ActionRow,
	action: Extract<UpkeepAction, { kind: "newSource" }>,
): Promise<Outcome> {
	if (!settings().upkeepNewSources)
		return { state: "skipped", reason: "New sources are switched off" };
	const source = getSource(action.sourceKey);
	if (!source) {
		return waitOrSkip(
			row,
			`${action.sourceKey} is not registered. Add its schema to the watched schemas to have it registered on its own`,
		);
	}
	if (source.measures.length + source.dimensions.length === 0) {
		return waitOrSkip(
			row,
			`${source.title} has no fields the app can read yet`,
		);
	}
	if ((await reportsOn(action.sourceKey)).length > 0) {
		return {
			state: "done",
			summary: [`${source.title} already has a report built on it.`],
		};
	}
	const shape = sourceShape(source);
	let reply: unknown;
	try {
		const looks = await Promise.all(
			[
				...source.dimensions.slice(0, 6),
				...source.measures.slice(0, 4),
			].map((field) => firstLook(action.sourceKey, field.name)),
		);
		reply = parseJson(
			await askAsApplication(
				[
					"A new dataset is available. Design the report people will open to understand it.",
					"Lead with the few figures that matter, then how they move over time, then what drives them, then the detail. Two to four pages, each with a clear purpose.",
					"The summaries were read only for you to decide; never repeat a figure from them in any title or description.",
					'Answer with only JSON: {"title": "...", "description": "one sentence saying what the report is for", "pages": [{"title": "...", "visuals": [{"visualType": "...", "title": "...", "dimensions": [...], "measures": [...]}]}]}.',
					"Field names must be copied exactly. Visual types you may use: kpiRow, lineChart, areaChart, barChart, horizontalBarChart, stackedBarChart, comboChart, pieChart, donutChart, treemapChart, scatterChart, heatmapChart, table, matrixTable, dropdownFilter.",
				].join(" "),
				{
					dataset: {
						title: source.title,
						description: source.description,
					},
					fields: describeFields(source),
					defaultTimeField: source.defaultTimeField,
					summaries: looks.filter(Boolean),
				},
				6000,
			),
		);
	} catch (error) {
		if (error instanceof ModelUnavailable) {
			return waitOrSkip(
				row,
				`No model is available to design a report for ${source.title}`,
			);
		}
		throw error;
	}
	const { report, skipped } = checkReportPlan(reply, shape, source.title);
	if (!report) {
		return waitOrSkip(
			row,
			`The proposed report for ${source.title} had no visual that fits the dataset`,
		);
	}
	const categoryId = await categoryFor(action.sourceKey);
	const [first, ...rest] = report.pages;
	const created = await createReport(assistantIdentity(), {
		title: report.title,
		description: withoutFigures(report.description) || null,
		categoryId,
		sourceKey: action.sourceKey,
		pageTitle: first.title,
		visuals: layoutPage(first.visuals).map(({ visual, layout }) => ({
			visualType: visual.visualType,
			title: visual.title,
			dimensions: visual.dimensions,
			measures: visual.measures,
			options: {},
			layout,
		})),
	});
	const operations: EditOperation[] = [];
	rest.forEach((page, index) => {
		const pageId = randomUUID();
		operations.push({
			type: "addPage",
			pageId,
			title: page.title,
			slug: `page-${index + 2}`,
			sourceKey: action.sourceKey,
		});
		for (const { visual, layout } of layoutPage(page.visuals)) {
			operations.push({
				type: "addVisual",
				visualId: randomUUID(),
				pageId,
				visualType: visual.visualType,
				title: visual.title,
				sourceKey: action.sourceKey,
				config: {
					dimensions: visual.dimensions,
					measures: visual.measures,
				},
				layout,
			});
		}
	});
	if (operations.length > 0) {
		await applyToReport(
			created.reportId,
			operations,
			`Pages built for ${source.title}`,
			row.update_id,
		);
	}
	if (row.update_id) {
		await linkChange({
			updateId: row.update_id,
			kind: "report",
			reportId: created.reportId,
			title: report.title,
			message: `Built for ${source.title}, with ${report.pages.map((page) => page.title).join(", ")}.`,
			actor: assistantActor,
		});
	}
	await tellAboutChanges({
		updateId: row.update_id,
		sourceKey: action.sourceKey,
		what: `${report.title} was built for the new source ${source.title}`,
		reportIds: [created.reportId],
	});
	const summary = [
		`Built ${report.title} for ${source.title} with ${report.pages.length} page${report.pages.length === 1 ? "" : "s"}: ${report.pages.map((page) => page.title).join(", ")}.`,
	];
	if (skipped.length > 0) summary.push(`Left out: ${skipped.join("; ")}.`);
	return {
		state: "done",
		summary,
		result: { reportId: created.reportId, slug: created.slug },
	};
}

async function pageAdded(
	row: ActionRow,
	action: Extract<UpkeepAction, { kind: "pageAdded" }>,
): Promise<Outcome> {
	if (!settings().upkeepPageDescriptions)
		return {
			state: "skipped",
			reason: "Description updates are switched off",
		};
	const found = await sql<{ report_id: string; protect_edit: boolean }>(
		`SELECT r.report_id::text, r.protect_edit FROM report_pages p
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE p.page_id::text = $1 AND p.is_active AND r.is_active`,
		[action.pageId],
	);
	if (!found[0]) return waitOrSkip(row, "The page is not on any report yet");
	if (found[0].protect_edit)
		return { state: "skipped", reason: "The report is protected" };
	const report = (
		await sql<{
			title: string;
			description: string | null;
			source_key: string | null;
		}>(
			`SELECT title, description, source_key FROM reports WHERE report_id = $1`,
			[found[0].report_id],
		)
	)[0];
	const pages = await sql<{ title: string; visuals: string[] }>(
		`SELECT p.title, coalesce(array_agg(v.title) FILTER (WHERE v.title IS NOT NULL AND v.is_active), '{}') AS visuals
		 FROM report_pages p LEFT JOIN report_visuals v ON v.page_id = p.page_id
		 WHERE p.report_id = $1 AND p.is_active
		 GROUP BY p.page_id, p.title, p.sort_order ORDER BY p.sort_order`,
		[found[0].report_id],
	);
	let reply: unknown;
	try {
		reply = parseJson(
			await askAsApplication(
				'A page was added to a report. Rewrite the report\'s one-sentence description so it covers every page, in the same plain voice as the current one, with no numbers. Answer with only JSON: {"description": "..."}.',
				{ title: report.title, current: report.description, pages },
				600,
			),
		);
	} catch (error) {
		if (error instanceof ModelUnavailable) {
			return waitOrSkip(
				row,
				"No model is available to rewrite the description",
			);
		}
		throw error;
	}
	const description = withoutFigures(
		String((reply as { description?: unknown })?.description ?? ""),
	).slice(0, 400);
	if (!description || description === report.description) {
		return {
			state: "done",
			summary: [`${report.title}'s description still covers it.`],
		};
	}
	const applied = await applyToReport(
		found[0].report_id,
		[{ type: "updateReport", description }],
		"Description updated for a new page",
		row.update_id,
	);
	if (applied) {
		await tellAboutChanges({
			updateId: row.update_id,
			sourceKey: report.source_key,
			what: `${report.title}'s description was updated for a new page`,
			reportIds: [found[0].report_id],
		});
	}
	return applied
		? {
				state: "done",
				summary: [
					`Updated ${report.title}'s description to cover the new page.`,
				],
			}
		: { state: "skipped", reason: "The description change was refused" };
}

// --- Working through what is due --------------------------------------------

async function carryOut(row: ActionRow): Promise<Outcome> {
	const action = row.action;
	switch (action.kind) {
		case "rename":
			return rename(row, action);
		case "remove":
			return remove(row, action);
		case "newField":
			return newField(row, action);
		case "definition":
			return definition(row, action);
		case "newSource":
			return newSource(row, action);
		case "pageAdded":
			return pageAdded(row, action);
	}
}

async function workDue(): Promise<void> {
	const due = await sql<ActionRow>(
		`SELECT action_key, action, update_id::text, attempts FROM upkeep_actions
		 WHERE state IN ('pending', 'waiting') AND next_try_on <= now()
		 ORDER BY created_on
		 LIMIT $1`,
		[perTick],
	);
	for (const row of due) {
		let outcome: Outcome;
		try {
			outcome = await carryOut(row);
		} catch (error) {
			console.warn(`The assistant's ${row.action_key} failed:`, error);
			outcome = waitOrSkip(
				row,
				error instanceof Error
					? error.message
					: "It could not be carried out",
			);
		}
		if (outcome.state === "waiting") {
			await sql(
				`UPDATE upkeep_actions
				 SET state = 'waiting', attempts = attempts + 1, reason = $2,
				     next_try_on = now() + make_interval(secs => $3)
				 WHERE action_key = $1`,
				[row.action_key, outcome.reason, retryAfterSeconds],
			);
			continue;
		}
		await sql(
			`UPDATE upkeep_actions
			 SET state = $2, attempts = attempts + 1, finished_on = now(),
			     reason = $3, result = $4::jsonb
			 WHERE action_key = $1`,
			[
				row.action_key,
				outcome.state,
				outcome.state === "skipped" ? outcome.reason : null,
				JSON.stringify(
					outcome.state === "done"
						? {
								summary: outcome.summary,
								detail: outcome.result ?? null,
							}
						: null,
				),
			],
		);
		// What it did, written in the update's notes like a person would. A
		// skip is written too, so somebody reading the update knows why nothing
		// changed.
		if (row.update_id) {
			const text =
				outcome.state === "done"
					? outcome.summary.join(" ")
					: `Did not act on ${describeAction(row.action).toLowerCase()}: ${outcome.reason}.`;
			await assistantNote(row.update_id, assistantActor, text).catch(
				(error) => {
					console.warn(
						"The assistant could not write its note:",
						error,
					);
				},
			);
		}
	}
}

// One pass. Safe to call as often as a timer likes: one replica works at a time.
export async function runUpkeep(): Promise<void> {
	if (running) return;
	running = true;
	try {
		await tryAdvisoryLock(upkeepLockKey, async () => {
			await readUpdates();
			await findRemovals();
			if (await routineLooksAllowed()) await watchSchemas();
			await workDue();
			// What readers said about visuals, read once a day. See
			// lib/feedback/review.
			await runFeedbackReview().catch((error) => {
				console.warn("Reader feedback was not reviewed:", error);
			});
			// Requests released by an update, ageing reminders and unused
			// files. See lib/work/releases.
			await runWorkPass();
		});
	} catch (error) {
		console.warn("The assistant's upkeep did not run:", error);
	} finally {
		running = false;
	}
}
