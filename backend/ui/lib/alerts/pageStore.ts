import type { Identity } from "../auth/identity";
import { resolvePolicyClass, type PolicyClass } from "../auth/policy";
import { insertLog } from "../activityLog";
import { sql } from "../data/lakebase";
import { pageLink } from "../deliveries/store";
import { assertCanEdit, EditForbiddenError } from "../platform/editing";
import { effective, refuse } from "../platform/pageProtection";
import {
	getReport,
	type PageDefinition,
	type ReportDetail,
} from "../platform/reports";
import { confirmableSources, reachableSet } from "../platform/sources";
import { getSource } from "../semantic/registry";
import {
	isMuted,
	muteUntil,
	sameRule,
	scopeMode,
	type MuteChoice,
	type ScopeMode,
} from "./pageRules";
import { restrictableSources } from "./recorded";
import {
	AlertDefinitionError,
	cleanDefinition,
	describeRule,
	type AlertDefinition,
} from "./rule";
import { describeSchedule } from "./schedule";
import {
	checkDefinition,
	deleteAlert,
	getAlert,
	isUuid,
	runsUnattended,
	wordingFor,
} from "./store";

// Page alerts as stored. A page alert is one an editor puts on a report page,
// and readers follow it.
//
// Changing one is held to the same rules as editing the report, with the same
// permission check and the same page locks as applyEdits. Each change is
// written to the activity log against the report rather than as a report
// version. A version is a snapshot that a restore puts back, and a restore that
// brought back or removed an alert would silently change what its subscribers
// are told. Bumping the version would also turn a colleague's unsaved edit of
// the same report into a conflict over something they never touched.
//
// Listing and following one is held to opening the report, and an alert on a
// dataset the reader cannot read is not shown to them at all, since its rule
// alone says something about the data.

export class PageAlertError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

// Past this a page is an alert list rather than a page, and every one of them
// is a warehouse read per scope on its schedule.
export const maxPerPage = 25;

// How long a confirmation that a subscriber can read a dataset stands before a
// visit writes it again, as for personal alerts. See confirmationRefresh in
// lib/alerts/runner.
const confirmationRefresh = "1 hour";

export interface PageAlertRecord {
	id: string;
	reportId: string;
	reportSlug: string;
	reportTitle: string;
	pageId: string;
	pageTitle: string;
	name: string;
	definition: AlertDefinition;
	// Read aloud, for the list.
	summary: string;
	scheduleText: string;
	sourceTitle: string | null;
	// How the dataset is read for subscribers. Once as the app for everyone,
	// once per recorded access, or under each subscriber's own token while
	// they are using the app.
	runs: ScopeMode;
	subscribed: boolean;
	mutedUntil: string | null;
	muted: boolean;
	// How many people follow it. Only for somebody who may edit the page.
	subscribers: number | null;
	lastCheckedOn: string | null;
	modifiedOn: string;
	modifiedBy: string;
	link: string;
}

interface PageAlertRow {
	alert_id: string;
	report_id: string;
	slug: string;
	report_title: string;
	page_id: string;
	page_title: string;
	first_page: boolean;
	name: string;
	source_key: string;
	definition: AlertDefinition;
	last_checked_on: string | null;
	modified_on: string;
	modified_by: string;
	subscribed: boolean;
	muted_until: string | null;
	subscribers: number;
}

// Every page alert column a record needs, with the caller's own subscription.
// $1 is always the caller's address.
const selectRows = `SELECT a.alert_id::text AS alert_id,
	        a.report_id::text AS report_id, r.slug, r.title AS report_title,
	        a.page_id::text AS page_id, p.title AS page_title,
	        p.sort_order = (SELECT min(q.sort_order) FROM report_pages q
	                        WHERE q.report_id = a.report_id AND q.is_active)
	          AS first_page,
	        a.name, a.source_key, a.definition,
	        a.last_checked_on::text AS last_checked_on,
	        a.modified_on::text AS modified_on, a.modified_by,
	        s.email IS NOT NULL AS subscribed,
	        s.muted_until::text AS muted_until,
	        (SELECT count(*) FROM page_alert_subscriptions c
	         WHERE c.alert_id = a.alert_id)::int AS subscribers
	 FROM page_alerts a
	 JOIN reports r      ON r.report_id = a.report_id AND r.is_active
	 JOIN report_pages p ON p.page_id = a.page_id AND p.is_active
	 LEFT JOIN page_alert_subscriptions s
	        ON s.alert_id = a.alert_id AND s.email = $1
	 WHERE a.is_active`;

function toRecord(
	row: PageAlertRow,
	restrictable: Set<string>,
	showCount: boolean,
): PageAlertRecord {
	const source = getSource(row.source_key);
	return {
		id: row.alert_id,
		reportId: row.report_id,
		reportSlug: row.slug,
		reportTitle: row.report_title,
		pageId: row.page_id,
		pageTitle: row.page_title,
		name: row.name,
		definition: row.definition,
		summary: describeRule(wordingFor(row.definition)),
		scheduleText: describeSchedule(row.definition.schedule),
		sourceTitle: source?.title ?? null,
		runs: scopeMode(
			runsUnattended(source),
			restrictable.has(row.source_key),
		),
		subscribed: row.subscribed,
		mutedUntil: row.muted_until,
		muted: isMuted(row.muted_until),
		subscribers: showCount ? row.subscribers : null,
		lastCheckedOn: row.last_checked_on,
		modifiedOn: row.modified_on,
		modifiedBy: row.modified_by,
		link: pageLink(row.slug, row.page_title, row.first_page === true),
	};
}

// --- Access ----------------------------------------------------------------

interface OpenedPage {
	report: ReportDetail;
	page: PageDefinition;
}

// The page, opened as the caller. Anything they cannot open reads as not
// found, so asking is not a way to learn a page exists.
async function openPage(
	identity: Identity,
	policy: PolicyClass,
	pageId: string,
): Promise<OpenedPage> {
	const missing = new PageAlertError("Page not found", 404);
	if (!isUuid(pageId)) throw missing;
	const rows = await sql<{ slug: string }>(
		`SELECT r.slug FROM report_pages p
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE p.page_id = $1::uuid AND p.is_active AND r.is_active`,
		[pageId],
	);
	if (!rows[0]) throw missing;
	const report = await getReport(policy, identity, rows[0].slug);
	const page = report?.pages.find(
		(p) => p.pageId.toLowerCase() === pageId.toLowerCase(),
	);
	if (!report || !page) throw missing;
	return { report, page };
}

// Every dataset the page reads, its own and each of its visuals'.
export function pageSources(page: PageDefinition): Set<string> {
	const keys = new Set<string>();
	if (page.sourceKey) keys.add(page.sourceKey);
	for (const visual of page.visuals) {
		if (visual.sourceKey) keys.add(visual.sourceKey);
	}
	return keys;
}

async function mayEdit(
	policy: PolicyClass,
	identity: Identity,
	reportId: string,
): Promise<boolean> {
	try {
		await assertCanEdit(policy, identity.email, reportId);
		return true;
	} catch (error) {
		if (error instanceof EditForbiddenError) return false;
		throw error;
	}
}

// Why the page's locks refuse a change to its alerts, or nothing. A page
// locked against changes keeps its alerts as they are, as it keeps its
// visuals.
function lockReason({ report, page }: OpenedPage): string | null {
	const said = refuse(
		"updatePage",
		effective(
			{
				protectDelete: report.protectDelete,
				protectEdit: report.protectEdit,
			},
			{
				protectDelete: page.protectDelete,
				protectEdit: page.protectEdit,
			},
		),
	);
	return said?.reason ?? null;
}

async function assertEditable(
	policy: PolicyClass,
	identity: Identity,
	opened: OpenedPage,
): Promise<void> {
	if (!(await mayEdit(policy, identity, opened.report.reportId))) {
		throw new PageAlertError(
			"You do not have permission to change the alerts on this page.",
			403,
		);
	}
	const locked = lockReason(opened);
	if (locked) throw new PageAlertError(locked, 409);
}

// The caller's readable datasets, or null where every one is.
async function readableFilter(
	identity: Identity,
): Promise<(sourceKey: string) => boolean> {
	const reachable = await reachableSet(identity);
	return (sourceKey) => !reachable || reachable.has(sourceKey);
}

async function loadRows(
	email: string,
	where: string,
	params: unknown[],
): Promise<PageAlertRow[]> {
	return sql<PageAlertRow>(
		`${selectRows} ${where} ORDER BY p.sort_order, a.created_on`,
		[email.toLowerCase(), ...params],
	);
}

async function loadOne(
	identity: Identity,
	id: string,
	showCount: boolean,
): Promise<PageAlertRecord | null> {
	const rows = await loadRows(identity.email, "AND a.alert_id = $2::uuid", [
		id,
	]);
	if (!rows[0]) return null;
	const restrictable = new Set((await restrictableSources()).keys());
	return toRecord(rows[0], restrictable, showCount);
}

// The page a stored alert sits on, opened as the caller, with the alert
// itself. An alert on a dataset the caller cannot read reads as not found.
async function openAlert(
	identity: Identity,
	policy: PolicyClass,
	id: string,
): Promise<{ opened: OpenedPage; row: PageAlertRow }> {
	const missing = new PageAlertError("Alert not found", 404);
	if (!isUuid(id)) throw missing;
	const rows = await loadRows(identity.email, "AND a.alert_id = $2::uuid", [
		id,
	]);
	const row = rows[0];
	if (!row) throw missing;
	const readable = await readableFilter(identity);
	if (!readable(row.source_key)) throw missing;
	const opened = await openPage(identity, policy, row.page_id).catch(() => {
		throw missing;
	});
	return { opened, row };
}

// --- Listing ---------------------------------------------------------------

export interface PageAlertList {
	alerts: PageAlertRecord[];
	// Whether the caller may add and change alerts here, and why not when a
	// lock is what stops them.
	canEdit: boolean;
	locked: string | null;
	// The datasets an alert on this page may watch, the page's own first.
	sourceKeys: string[];
	pageSourceKey: string | null;
}

export async function listPageAlerts(
	identity: Identity,
	policy: PolicyClass,
	pageId: string,
): Promise<PageAlertList> {
	const opened = await openPage(identity, policy, pageId);
	const canEdit = await mayEdit(policy, identity, opened.report.reportId);
	const readable = await readableFilter(identity);
	const [rows, restrictable] = await Promise.all([
		loadRows(identity.email, "AND a.page_id = $2::uuid", [
			opened.page.pageId,
		]),
		restrictableSources(),
	]);
	const keys = new Set(restrictable.keys());
	const sources = [...pageSources(opened.page)].filter(readable);
	const own = opened.page.sourceKey;
	return {
		alerts: rows
			.filter((row) => readable(row.source_key))
			.map((row) => toRecord(row, keys, canEdit)),
		canEdit,
		locked: canEdit ? lockReason(opened) : null,
		sourceKeys:
			own && sources.includes(own)
				? [own, ...sources.filter((k) => k !== own)]
				: sources,
		pageSourceKey: own && readable(own) ? own : null,
	};
}

// Everything the caller follows, for the inbox.
export async function listSubscriptions(
	identity: Identity,
): Promise<PageAlertRecord[]> {
	const readable = await readableFilter(identity);
	const [rows, restrictable] = await Promise.all([
		loadRows(identity.email, "AND s.email IS NOT NULL", []),
		restrictableSources(),
	]);
	const keys = new Set(restrictable.keys());
	return rows
		.filter((row) => readable(row.source_key))
		.map((row) => toRecord(row, keys, false));
}

// --- Changing --------------------------------------------------------------

// Checks a definition an editor puts on this page. It has to be valid, on a
// dataset they can read, and on one the page itself reads.
async function checkForPage(
	identity: Identity,
	page: PageDefinition,
	raw: unknown,
): Promise<AlertDefinition> {
	const { definition } = await checkDefinition(identity, raw);
	if (!pageSources(page).has(definition.sourceKey)) {
		throw new AlertDefinitionError(
			"Choose a dataset this page shows. A page alert watches what its readers see there.",
		);
	}
	return definition;
}

function logChange(
	email: string,
	reportId: string,
	action: string,
	alertId: string,
	before: AlertDefinition | null,
	after: AlertDefinition | null,
): void {
	void insertLog({
		recordType: "report",
		recordId: reportId,
		action,
		fieldName: `page_alert:${alertId}`,
		oldValue: before ? JSON.stringify(before) : null,
		newValue: after ? JSON.stringify(after) : null,
		changedBy: email,
	});
}

export async function createPageAlert(
	identity: Identity,
	policy: PolicyClass,
	pageId: string,
	raw: unknown,
): Promise<PageAlertRecord> {
	const opened = await openPage(identity, policy, pageId);
	await assertEditable(policy, identity, opened);
	const definition = await checkForPage(identity, opened.page, raw);

	const count = await sql<{ n: number }>(
		`SELECT count(*)::int AS n FROM page_alerts
		 WHERE page_id = $1::uuid AND is_active`,
		[opened.page.pageId],
	);
	if ((count[0]?.n ?? 0) >= maxPerPage) {
		throw new PageAlertError(
			`This page has ${maxPerPage} alerts, the most one page can hold. Delete one to add another.`,
		);
	}

	const email = identity.email.toLowerCase();
	// Due at once, so the first subscriber hears straight away whether the
	// condition already holds.
	const inserted = await sql<{ alert_id: string }>(
		`INSERT INTO page_alerts
		   (report_id, page_id, name, source_key, definition, created_by,
		    modified_by)
		 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $6)
		 RETURNING alert_id::text AS alert_id`,
		[
			opened.report.reportId,
			opened.page.pageId,
			definition.name,
			definition.sourceKey,
			JSON.stringify(definition),
			email,
		],
	);
	const id = inserted[0].alert_id;
	logChange(
		email,
		opened.report.reportId,
		"page_alert_create",
		id,
		null,
		definition,
	);
	const record = await loadOne(identity, id, true);
	if (!record) throw new PageAlertError("The alert could not be saved.", 500);
	return record;
}

export async function updatePageAlert(
	identity: Identity,
	policy: PolicyClass,
	id: string,
	raw: unknown,
): Promise<PageAlertRecord> {
	const { opened, row } = await openAlert(identity, policy, id);
	await assertEditable(policy, identity, opened);
	const definition = await checkForPage(identity, opened.page, raw);

	// What the alert watches changed, so what each scope last saw says
	// nothing about it any more.
	const watched = (d: AlertDefinition) =>
		JSON.stringify([
			d.sourceKey,
			d.measure,
			d.groupBy,
			d.conditions,
			d.condition,
			d.anomaly,
		]);
	const reset = watched(row.definition) !== watched(definition);
	const rescheduled =
		JSON.stringify(row.definition.schedule) !==
		JSON.stringify(definition.schedule);

	// Each follower's confirmation was of the dataset the alert used to read.
	// On a new one it says nothing, and the timer would otherwise read the
	// new dataset for followers who cannot see it until the confirmation ran
	// out. Each is confirmed again on their next visit, and the editor, who
	// was just checked against it, straight away.
	const sourceChanged = row.definition.sourceKey !== definition.sourceKey;
	const editorConfirmable = sourceChanged
		? await confirmableSources(identity)
		: null;
	const editorConfirmed =
		!editorConfirmable || editorConfirmable.has(definition.sourceKey);

	const email = identity.email.toLowerCase();
	await sql(
		`WITH cleared AS (
		   DELETE FROM page_alert_state WHERE alert_id = $1::uuid AND $5
		 ),
		 unconfirmed AS (
		   UPDATE page_alert_subscriptions SET access_confirmed_on =
		     CASE WHEN email = $7 AND $9 THEN now() END
		   WHERE alert_id = $1::uuid AND $8
		 ),
		 -- A new schedule applies to every scope from now, so each is due
		 -- straight away rather than at the slot the old schedule set.
		 moved AS (
		   UPDATE page_alert_state SET next_check_on = now()
		   WHERE alert_id = $1::uuid AND $6 AND NOT $5
		 )
		 UPDATE page_alerts SET
		   name = $2, source_key = $3, definition = $4,
		   next_check_on = CASE WHEN $5 OR $6 THEN now() ELSE next_check_on END,
		   modified_by = $7, modified_on = now()
		 WHERE alert_id = $1::uuid`,
		[
			row.alert_id,
			definition.name,
			definition.sourceKey,
			JSON.stringify(definition),
			reset,
			rescheduled,
			email,
			sourceChanged,
			editorConfirmed,
		],
	);
	logChange(
		email,
		opened.report.reportId,
		"page_alert_update",
		row.alert_id,
		row.definition,
		definition,
	);
	const record = await loadOne(identity, row.alert_id, true);
	if (!record) throw new PageAlertError("Alert not found", 404);
	return record;
}

// Deleted outright, with its subscriptions, state and history. Messages it
// already sent stay in each subscriber's inbox, and the definition stays in
// the activity log.
export async function deletePageAlert(
	identity: Identity,
	policy: PolicyClass,
	id: string,
): Promise<void> {
	const { opened, row } = await openAlert(identity, policy, id);
	await assertEditable(policy, identity, opened);
	await sql(`DELETE FROM page_alerts WHERE alert_id = $1::uuid`, [
		row.alert_id,
	]);
	logChange(
		identity.email.toLowerCase(),
		opened.report.reportId,
		"page_alert_delete",
		row.alert_id,
		row.definition,
		null,
	);
}

// --- Following -------------------------------------------------------------

// Writes or refreshes subscriptions. The confirmation of access is taken from
// the caller's own grant on each dataset, as a personal alert's is, and a mute
// is only changed when one is given.
async function upsertSubscriptions(
	identity: Identity,
	rows: { alertId: string; sourceKey: string }[],
	mute: MuteChoice | undefined,
): Promise<void> {
	if (rows.length === 0) return;
	const email = identity.email.toLowerCase();
	const confirmable = await confirmableSources(identity);
	for (const { alertId, sourceKey } of rows) {
		await sql(
			`INSERT INTO page_alert_subscriptions
			   (alert_id, email, muted_until, access_confirmed_on)
			 VALUES ($1::uuid, $2, $3::timestamptz,
			         CASE WHEN $4 THEN now() END)
			 ON CONFLICT (alert_id, email) DO UPDATE SET
			   muted_until = CASE WHEN $5
			                      THEN EXCLUDED.muted_until
			                      ELSE page_alert_subscriptions.muted_until END,
			   access_confirmed_on = EXCLUDED.access_confirmed_on`,
			[
				alertId,
				email,
				mute ? muteUntil(mute) : null,
				!confirmable || confirmable.has(sourceKey),
				mute !== undefined,
			],
		);
	}
}

// Follows, stops following, or mutes one page alert. Muting follows it too,
// since a mute on something not followed would mean nothing.
export async function setSubscription(
	identity: Identity,
	policy: PolicyClass,
	id: string,
	change: { subscribed?: boolean; mute?: MuteChoice },
): Promise<PageAlertRecord> {
	const { row } = await openAlert(identity, policy, id);
	const email = identity.email.toLowerCase();

	if (change.subscribed === false) {
		await sql(
			`DELETE FROM page_alert_subscriptions
			 WHERE alert_id = $1::uuid AND email = $2`,
			[row.alert_id, email],
		);
	} else {
		await upsertSubscriptions(
			identity,
			[{ alertId: row.alert_id, sourceKey: row.source_key }],
			change.mute,
		);
	}
	const record = await loadOne(identity, row.alert_id, false);
	if (!record) throw new PageAlertError("Alert not found", 404);
	return record;
}

// Follows every alert on the page the caller can see and does not follow
// yet. Mutes already set are left as they are.
export async function subscribeAll(
	identity: Identity,
	policy: PolicyClass,
	pageId: string,
): Promise<PageAlertList> {
	const list = await listPageAlerts(identity, policy, pageId);
	const missing = list.alerts.filter((a) => !a.subscribed);
	await upsertSubscriptions(
		identity,
		missing.map((a) => ({
			alertId: a.id,
			sourceKey: a.definition.sourceKey,
		})),
		undefined,
	);
	return listPageAlerts(identity, policy, pageId);
}

// --- Duplicates ------------------------------------------------------------

// Page alerts the caller can open that already watch what a definition
// watches, the current page's first. Returns nothing for a definition not
// complete enough to compare.
export async function findMatches(
	identity: Identity,
	policy: PolicyClass,
	raw: unknown,
	currentPageId: string | null,
): Promise<PageAlertRecord[]> {
	let definition: AlertDefinition;
	try {
		definition = cleanDefinition(raw);
	} catch {
		return [];
	}
	const readable = await readableFilter(identity);
	if (!readable(definition.sourceKey)) return [];

	const rows = await loadRows(
		identity.email,
		`AND a.source_key = $2 AND a.definition->>'measure' = $3`,
		[definition.sourceKey, definition.measure],
	);
	const matching = rows
		.filter((row) => sameRule(row.definition, definition))
		.slice(0, 50);

	// Opened once per report, as the caller, so a page they cannot open is
	// never named to them.
	const open = new Map<string, boolean>();
	const out: PageAlertRow[] = [];
	for (const row of matching) {
		if (!open.has(row.slug)) {
			open.set(
				row.slug,
				(await getReport(policy, identity, row.slug)) !== null,
			);
		}
		if (open.get(row.slug)) out.push(row);
	}
	const here = currentPageId?.toLowerCase() ?? null;
	out.sort(
		(a, b) =>
			Number(b.page_id.toLowerCase() === here) -
			Number(a.page_id.toLowerCase() === here),
	);
	const keys = new Set((await restrictableSources()).keys());
	return out.slice(0, 5).map((row) => toRecord(row, keys, false));
}

// --- Promoting -------------------------------------------------------------

export interface PromoteTarget {
	pageId: string;
	pageTitle: string;
	reportTitle: string;
	reportSlug: string;
}

// Pages the caller may add an alert to that show each of the given datasets.
export async function promoteTargets(
	identity: Identity,
	policy: PolicyClass,
	sourceKeys: string[],
): Promise<Record<string, PromoteTarget[]>> {
	const readable = await readableFilter(identity);
	const wanted = [...new Set(sourceKeys)].filter(readable).slice(0, 50);
	if (wanted.length === 0) return {};

	const rows = await sql<{
		page_id: string;
		page_title: string;
		report_id: string;
		slug: string;
		report_title: string;
		locked: boolean;
		source_keys: string[];
	}>(
		`SELECT p.page_id::text AS page_id, p.title AS page_title,
		        r.report_id::text AS report_id, r.slug,
		        r.title AS report_title,
		        (p.protect_edit OR r.protect_edit) AS locked,
		        ARRAY(
		          SELECT DISTINCT coalesce(v.source_key, p.source_key, r.source_key)
		          FROM report_visuals v
		          WHERE v.page_id = p.page_id AND v.is_active
		        ) || ARRAY[coalesce(p.source_key, r.source_key)] AS source_keys
		 FROM report_pages p
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE p.is_active AND r.is_active
		   AND (coalesce(p.source_key, r.source_key) = ANY($1::text[])
		        OR EXISTS (
		          SELECT 1 FROM report_visuals v
		          WHERE v.page_id = p.page_id AND v.is_active
		            AND coalesce(v.source_key, p.source_key, r.source_key)
		                = ANY($1::text[])))
		 ORDER BY r.title, p.sort_order
		 LIMIT 300`,
		[wanted],
	);

	const editable = new Map<string, boolean>();
	const out: Record<string, PromoteTarget[]> = {};
	for (const row of rows) {
		if (row.locked) continue;
		if (!editable.has(row.report_id)) {
			editable.set(
				row.report_id,
				await mayEdit(policy, identity, row.report_id),
			);
		}
		if (!editable.get(row.report_id)) continue;
		for (const key of new Set(row.source_keys)) {
			if (!key || !wanted.includes(key)) continue;
			(out[key] ??= []).push({
				pageId: row.page_id,
				pageTitle: row.page_title,
				reportTitle: row.report_title,
				reportSlug: row.slug,
			});
		}
	}
	return out;
}

// Turns one of the caller's own alerts into an alert on a page, follows it,
// and deletes the personal one, so the caller keeps hearing about the same
// thing once rather than twice.
export async function promote(
	identity: Identity,
	policy: PolicyClass,
	personalId: string,
	pageId: string,
): Promise<PageAlertRecord> {
	if (!isUuid(personalId)) throw new PageAlertError("Alert not found", 404);
	const personal = await getAlert(identity.email, personalId);
	if (!personal) throw new PageAlertError("Alert not found", 404);

	const created = await createPageAlert(
		identity,
		policy,
		pageId,
		personal.definition,
	);
	const followed = await setSubscription(identity, policy, created.id, {
		subscribed: true,
		mute: personal.enabled ? undefined : "forever",
	});
	await deleteAlert(identity.email, personalId);
	return { ...followed, subscribers: created.subscribers };
}

// --- Keeping access current ------------------------------------------------

// Renews the caller's confirmation on each page alert they follow, when it is
// old enough to need it and they can still open the report and read the
// dataset. Called from the pass that runs while they use the app. A
// subscription that is not renewed lapses, and the timer stops reading for it.
export async function confirmSubscriptions(
	identity: Identity,
	confirmable: Set<string> | null,
): Promise<void> {
	const email = identity.email.toLowerCase();
	const stale = await sql<{
		alert_id: string;
		source_key: string;
		slug: string;
	}>(
		`SELECT s.alert_id::text AS alert_id, a.source_key, r.slug
		 FROM page_alert_subscriptions s
		 JOIN page_alerts a ON a.alert_id = s.alert_id AND a.is_active
		 JOIN reports r ON r.report_id = a.report_id AND r.is_active
		 WHERE s.email = $1
		   AND (s.access_confirmed_on IS NULL
		        OR s.access_confirmed_on < now() - interval '${confirmationRefresh}')`,
		[email],
	);
	if (stale.length === 0) return;

	const policy = await resolvePolicyClass(identity);
	const opens = new Map<string, boolean>();
	const renewed: string[] = [];
	for (const row of stale) {
		if (confirmable && !confirmable.has(row.source_key)) continue;
		if (!opens.has(row.slug)) {
			opens.set(
				row.slug,
				(await getReport(policy, identity, row.slug)) !== null,
			);
		}
		if (opens.get(row.slug)) renewed.push(row.alert_id);
	}
	if (renewed.length === 0) return;
	await sql(
		`UPDATE page_alert_subscriptions SET access_confirmed_on = now()
		 WHERE email = $1 AND alert_id::text = ANY($2::text[])`,
		[email, renewed],
	);
}
