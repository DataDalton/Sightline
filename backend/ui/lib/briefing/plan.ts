import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { statusOf, type SourceStatus } from "../freshness/status";
import { listInbox, type InboxItem } from "../notify/store";
import { listPersonalPages } from "../platform/personal";
import { listReports } from "../platform/reports";
import { listFavourites } from "../platform/search";
import { reachableSet } from "../platform/sources";
import { cachedDefinition, peekDefinition } from "../platform/definitionCache";
import {
	peerUsage,
	rankByPeers,
	type PeerUsage,
} from "../platform/peerRanking";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import { listChoices, type BriefingChoice } from "./choices";
import { orderReports, type BriefingReport } from "./order";
import {
	watchList,
	type WatchAlert,
	type WatchItem,
	type WatchReport,
} from "./watch";

// What the briefing holds for one reader before any figure is read: the
// figures to read, the sources running late, and the alerts that fired.
// Everything here comes from the platform store in two rounds of questions
// asked together, so it answers quickly and the figures are read behind it.

// Figures shown in one briefing, besides the reader's pins. Every report's
// headline figures are read, and the page chooses these once it knows which
// moved. Each is served from its stored card, and asks the warehouse only when
// its data changed since that card was worked out. See lib/briefing/cards.
export const shownItems = 16;
// How far back fired alerts are shown.
const alertDays = 3;

export type { BriefingReport };

export interface BriefingPlan {
	// Every figure to read, pins first, then in the reader's order of
	// reports.
	items: WatchItem[];
	// How many of the unpinned ones the page shows.
	limit: number;
	late: Pick<
		SourceStatus,
		"sourceKey" | "title" | "state" | "expectedBy" | "lastChanged"
	>[];
	alerts: Pick<
		InboxItem,
		"id" | "title" | "body" | "link" | "createdOn" | "readOn"
	>[];
	reports: BriefingReport[];
	// The reader's pins and hides, so the page can show which is which and
	// offer hidden figures back.
	choices: BriefingChoice[];
}

// How far back opens are counted when deciding what a reader, or people
// with the same access, use most.
const usageDays = 30;

// Reports the reader opened most over the window, by how often.
async function mostOpened(email: string): Promise<string[]> {
	const rows = await sql<{ report_id: string }>(
		`SELECT report_id::text AS report_id
		 FROM usage_events
		 WHERE lower(user_email) = $1
		   AND event_type = 'page_view' AND report_id IS NOT NULL
		   AND occurred_on > now() - make_interval(days => $2)
		 GROUP BY report_id
		 ORDER BY count(*) DESC, max(occurred_on) DESC
		 LIMIT 20`,
		[email, usageDays],
	);
	return rows.map((r) => r.report_id);
}

// Reports most opened by other people resolved to the reader's policy class,
// which is everyone with the same access. Counted by people first, so one
// enthusiast opening a report all day does not outrank one a whole team reads.
//
// The opens per report and reader are the same for everyone in the class, so
// they are read once per class and held briefly. Each reader's own opens are
// taken out in memory.
async function popularWithPeers(
	email: string,
	policyId: string,
): Promise<string[]> {
	const usage = await cachedDefinition<PeerUsage>(
		`briefing:peers:${policyId}`,
		async () => {
			const rows = await sql<{
				report_id: string;
				email: string;
				opens: string;
			}>(
				`SELECT report_id::text AS report_id, lower(user_email) AS email,
				        count(*)::text AS opens
				 FROM usage_events
				 WHERE policy_class = $1
				   AND event_type = 'page_view' AND report_id IS NOT NULL
				   AND occurred_on > now() - make_interval(days => $2)
				 GROUP BY report_id, lower(user_email)`,
				[policyId, usageDays],
			);
			return peerUsage(
				rows.map((r) => ({
					reportId: r.report_id,
					email: r.email,
					opens: Number(r.opens),
				})),
			);
		},
	);
	return rankByPeers(usage, email, 20);
}

// The pages and visuals of one report as the selection reads them, before
// a missing source is filled in from the page or the report.
interface ShapeRow {
	page_id: string;
	page_source: string | null;
	visual_type: string | null;
	visual_source: string | null;
	dimensions: string[] | null;
	measures: string[] | null;
	targets: Record<string, unknown> | null;
}

// What identifies one state of a report. Every save moves the version and the
// modification time, and a move or rename moves the modification time, so a
// held shape under an old stamp is never read again.
interface ReportStamp {
	report_id: string;
	slug: string;
	title: string;
	source_key: string | null;
	version: string;
	modified_on: string;
}

function shapeKey(stamp: ReportStamp): string {
	return `briefing:shape:${stamp.report_id}|${stamp.version}|${stamp.modified_on}`;
}

function toWatchReport(stamp: ReportStamp, rows: ShapeRow[]): WatchReport {
	const report: WatchReport = {
		reportId: stamp.report_id,
		slug: stamp.slug,
		title: stamp.title,
		sourceKey: stamp.source_key,
		pages: [],
	};
	const pages = new Map<string, WatchReport["pages"][number]>();
	for (const row of rows) {
		let page = pages.get(row.page_id);
		if (!page) {
			page = {
				sourceKey: row.page_source ?? stamp.source_key,
				visuals: [],
			};
			pages.set(row.page_id, page);
			report.pages.push(page);
		}
		if (!row.visual_type) continue;
		page.visuals.push({
			visualType: row.visual_type,
			sourceKey: row.visual_source ?? page.sourceKey,
			config: {
				dimensions: Array.isArray(row.dimensions)
					? row.dimensions
					: undefined,
				measures: Array.isArray(row.measures)
					? row.measures
					: undefined,
				options: row.targets ? { targets: row.targets } : undefined,
			},
		});
	}
	return report;
}

// The parts of each report the selection reads. A visual with no dataset of
// its own reads its page's, and a page with none reads its report's, as on the
// report itself.
//
// One cheap question for every report's stamp, then the pages and visuals of
// only the reports whose stamp has no shape held for it, in one question for
// all of them. The rest come from memory.
async function reportShapes(reportIds: string[]): Promise<WatchReport[]> {
	if (reportIds.length === 0) return [];
	const stamps = await sql<ReportStamp>(
		`SELECT report_id::text AS report_id, slug, title, source_key,
		        version::text AS version, modified_on::text AS modified_on
		 FROM reports
		 WHERE report_id = ANY($1::uuid[]) AND is_active`,
		[reportIds],
	);

	const held = new Map<string, ShapeRow[]>();
	const missing: string[] = [];
	for (const stamp of stamps) {
		const rows = peekDefinition<ShapeRow[]>(shapeKey(stamp));
		if (rows) held.set(stamp.report_id, rows);
		else missing.push(stamp.report_id);
	}

	if (missing.length > 0) {
		const rows = await sql<ShapeRow & { report_id: string }>(
			`SELECT p.report_id::text AS report_id,
			        p.page_id::text AS page_id, p.source_key AS page_source,
			        v.visual_type, v.source_key AS visual_source,
			        v.config->'dimensions' AS dimensions,
			        v.config->'measures' AS measures,
			        v.config->'options'->'targets' AS targets
			 FROM report_pages p
			 LEFT JOIN report_visuals v ON v.page_id = p.page_id AND v.is_active
			 WHERE p.report_id = ANY($1::uuid[]) AND p.is_active
			 ORDER BY p.report_id, p.sort_order, p.title, v.sort_order`,
			[missing],
		);
		const byReport = new Map<string, ShapeRow[]>(
			missing.map((id) => [id, []]),
		);
		for (const { report_id, ...row } of rows) {
			byReport.get(report_id)?.push(row);
		}
		for (const stamp of stamps) {
			const loaded = byReport.get(stamp.report_id);
			if (!loaded) continue;
			held.set(stamp.report_id, loaded);
			// Kept under the stamp it was read at. A report saved since the
			// stamp was read is held under a stamp nobody asks for again.
			void cachedDefinition(shapeKey(stamp), async () => loaded);
		}
	}

	// In the order asked for, which is the reader's order. A report with no
	// active page has nothing to read, as when the pages were joined in.
	const byId = new Map(stamps.map((s) => [s.report_id, s]));
	const out: WatchReport[] = [];
	for (const id of reportIds) {
		const stamp = byId.get(id);
		const rows = held.get(id);
		if (!stamp || !rows || rows.length === 0) continue;
		out.push(toWatchReport(stamp, rows));
	}
	return out;
}

async function unusualAlerts(reportIds: string[]): Promise<WatchAlert[]> {
	if (reportIds.length === 0) return [];
	const rows = await sql<{
		report_id: string;
		source_key: string;
		measure: string | null;
		time_field: string | null;
	}>(
		`SELECT report_id::text AS report_id, source_key,
		        definition->>'measure' AS measure,
		        definition->'anomaly'->>'timeField' AS time_field
		 FROM page_alerts
		 WHERE is_active AND report_id = ANY($1::uuid[])
		   AND definition->>'condition' = 'unusual'`,
		[reportIds],
	);
	return rows
		.filter((r) => r.measure && r.time_field)
		.map((r) => ({
			reportId: r.report_id,
			sourceKey: r.source_key,
			measure: r.measure as string,
			timeField: r.time_field as string,
		}));
}

// What a reader's plan is built from that changes only when something about
// it changes: the figures, the order of their reports and their choices.
interface PlanCore {
	items: WatchItem[];
	reports: BriefingReport[];
	choices: BriefingChoice[];
	reachable: string[] | null;
}

// The core is held per reader and class until something it was built from
// changes, and every such change drops it on every instance: a pin, hide or
// reorder, a report marked or unmarked, a change of access, a report or
// personal page edited, published or removed, a page alert set or removed.
// See lib/platform/changes. How often the reader and their colleagues open
// each report also orders it, and that drifts too slowly to announce, so the
// core is built again after this long regardless.
const coreLifetimeMs = 3 * 60 * 60 * 1000;

// Sources running late and alerts that fired change on their own schedule, so
// they are read on every visit. Each is one indexed question.
export async function briefingPlan(
	identity: Identity,
	policy: PolicyClass,
	timeZone: string,
): Promise<BriefingPlan> {
	const email = identity.email.toLowerCase();
	const core = await cachedDefinition(
		`briefing-plan:${email}|${policy.id}`,
		() => buildCore(identity, policy),
		coreLifetimeMs,
	);
	const [status, inbox] = await Promise.all([
		statusOf(core.reachable, email, timeZone).catch(
			() => [] as SourceStatus[],
		),
		listInbox(email, { kind: "alert", limit: 20 }).catch(
			() => [] as InboxItem[],
		),
	]);
	const since = Date.now() - alertDays * 86_400_000;
	return {
		items: core.items,
		limit: shownItems,
		late: status
			.filter((s) => s.state === "late" || s.state === "overdue")
			.map(({ sourceKey, title, state, expectedBy, lastChanged }) => ({
				sourceKey,
				title,
				state,
				expectedBy,
				lastChanged,
			})),
		alerts: inbox
			.filter((a) => Date.parse(a.createdOn) >= since)
			.map(({ id, title, body, link, createdOn, readOn }) => ({
				id,
				title,
				body,
				link,
				createdOn,
				readOn,
			})),
		reports: core.reports,
		choices: core.choices,
	};
}

async function buildCore(
	identity: Identity,
	policy: PolicyClass,
): Promise<PlanCore> {
	const email = identity.email.toLowerCase();
	const none = () => [] as string[];
	const [
		visible,
		personal,
		favourites,
		frequent,
		popular,
		choices,
		reachable,
	] = await Promise.all([
		listReports(policy, identity),
		listPersonalPages(identity, policy).catch(() => null),
		listFavourites(email),
		mostOpened(email).catch(none),
		popularWithPeers(email, policy.id).catch(none),
		listChoices(email).catch(() => [] as BriefingChoice[]),
		reachableSet(identity),
	]);
	const own = personal?.mine ?? [];
	const reports = orderReports(
		[
			...visible.map((r) => ({
				reportId: r.reportId,
				slug: r.slug,
				title: r.title,
				categoryId: r.categoryId,
			})),
			...own.map((r) => ({
				reportId: r.reportId,
				slug: r.slug,
				title: r.title,
				categoryId: null,
			})),
		],
		{
			favourites,
			// Pages the reader built for themselves. A curated report they
			// authored is for everyone else, and is ranked by use like any
			// other, or someone who builds reports would see every one of
			// them ahead of what they actually read.
			yours: own.map((r) => r.reportId),
			frequent,
			popular,
		},
	);

	// Only reports already found readable above are asked about.
	const reportIds = reports.map((r) => r.reportId);
	const [watchReports, alerts] = await Promise.all([
		reportShapes(reportIds),
		unusualAlerts(reportIds).catch(() => [] as WatchAlert[]),
	]);
	const sources = new Map<string, SemanticSource>();
	for (const report of watchReports) {
		for (const key of [
			report.sourceKey,
			...report.pages.flatMap((p) => [
				p.sourceKey,
				...p.visuals.map((v) => v.sourceKey),
			]),
		]) {
			if (!key || sources.has(key)) continue;
			if (reachable && !reachable.has(key)) continue;
			const source = getSource(key);
			if (source) sources.set(key, source);
		}
	}
	const items = watchList(
		watchReports,
		sources,
		alerts,
		Number.MAX_SAFE_INTEGER,
		choices,
	);

	return {
		items,
		reports,
		choices,
		reachable: reachable ? [...reachable] : null,
	};
}
