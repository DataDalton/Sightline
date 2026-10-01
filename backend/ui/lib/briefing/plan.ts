import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { statusOf, type SourceStatus } from "../freshness/status";
import { listInbox, type InboxItem } from "../notify/store";
import { listPersonalPages } from "../platform/personal";
import { listReports } from "../platform/reports";
import { listFavourites } from "../platform/search";
import { reachableSet } from "../platform/sources";
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
async function popularWithPeers(
	email: string,
	policyId: string,
): Promise<string[]> {
	const rows = await sql<{ report_id: string }>(
		`SELECT report_id::text AS report_id
		 FROM usage_events
		 WHERE policy_class = $2 AND lower(user_email) <> $1
		   AND event_type = 'page_view' AND report_id IS NOT NULL
		   AND occurred_on > now() - make_interval(days => $3)
		 GROUP BY report_id
		 ORDER BY count(DISTINCT lower(user_email)) DESC, count(*) DESC
		 LIMIT 20`,
		[email, policyId, usageDays],
	);
	return rows.map((r) => r.report_id);
}

// The parts of each report the selection reads, for every report at once.
// One question for all of them rather than several per report. A visual with no dataset of its own reads its page's, and a page
// with none reads its report's, as on the report itself.
async function reportShapes(reportIds: string[]): Promise<WatchReport[]> {
	if (reportIds.length === 0) return [];
	const rows = await sql<{
		report_id: string;
		slug: string;
		title: string;
		report_source: string | null;
		page_id: string;
		page_source: string | null;
		visual_type: string | null;
		visual_source: string | null;
		dimensions: string[] | null;
		measures: string[] | null;
		targets: Record<string, unknown> | null;
	}>(
		`SELECT r.report_id::text AS report_id, r.slug, r.title,
		        r.source_key AS report_source,
		        p.page_id::text AS page_id, p.source_key AS page_source,
		        v.visual_type, v.source_key AS visual_source,
		        v.config->'dimensions' AS dimensions,
		        v.config->'measures' AS measures,
		        v.config->'options'->'targets' AS targets
		 FROM reports r
		 JOIN report_pages p ON p.report_id = r.report_id AND p.is_active
		 LEFT JOIN report_visuals v ON v.page_id = p.page_id AND v.is_active
		 WHERE r.report_id = ANY($1::uuid[]) AND r.is_active
		 ORDER BY r.report_id, p.sort_order, p.title, v.sort_order`,
		[reportIds],
	);
	const reports = new Map<string, WatchReport>();
	const pages = new Map<string, WatchReport["pages"][number]>();
	for (const row of rows) {
		let report = reports.get(row.report_id);
		if (!report) {
			report = {
				reportId: row.report_id,
				slug: row.slug,
				title: row.title,
				sourceKey: row.report_source,
				pages: [],
			};
			reports.set(row.report_id, report);
		}
		let page = pages.get(row.page_id);
		if (!page) {
			page = {
				sourceKey: row.page_source ?? row.report_source,
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
	// In the order asked for, which is the reader's order.
	return reportIds
		.map((id) => reports.get(id))
		.filter((r): r is WatchReport => r !== undefined);
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

export async function briefingPlan(
	identity: Identity,
	policy: PolicyClass,
	timeZone: string,
): Promise<BriefingPlan> {
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
		inbox,
	] = await Promise.all([
		listReports(policy, identity),
		listPersonalPages(identity, policy).catch(() => null),
		listFavourites(email),
		mostOpened(email).catch(none),
		popularWithPeers(email, policy.id).catch(none),
		listChoices(email).catch(() => [] as BriefingChoice[]),
		reachableSet(identity),
		listInbox(email, { kind: "alert", limit: 20 }).catch(
			() => [] as InboxItem[],
		),
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
	const [watchReports, alerts, status] = await Promise.all([
		reportShapes(reportIds),
		unusualAlerts(reportIds).catch(() => [] as WatchAlert[]),
		statusOf(reachable ? [...reachable] : null, email, timeZone).catch(
			() => [] as SourceStatus[],
		),
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

	const since = Date.now() - alertDays * 86_400_000;

	return {
		items,
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
		reports,
		choices,
	};
}
