import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { statusOf, type SourceStatus } from "../freshness/status";
import { listInbox, type InboxItem } from "../notify/store";
import { listPersonalPages } from "../platform/personal";
import { getReport, listReports } from "../platform/reports";
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
// Everything here comes from the platform store, so it answers quickly and
// the figures are read one by one behind it.

// Figures read for one briefing. Each is a handful of warehouse questions,
// most answered from the shared cache after the first reader of the morning.
export const maxItems = 16;
// How far back fired alerts are shown.
const alertDays = 3;

export type { BriefingReport };

export interface BriefingPlan {
	items: WatchItem[];
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

	const details = await Promise.all(
		reports.map((r) =>
			getReport(policy, identity, r.slug).catch(() => null),
		),
	);
	const sources = new Map<string, SemanticSource>();
	const watchReports: WatchReport[] = [];
	for (const detail of details) {
		if (!detail) continue;
		watchReports.push(detail);
		for (const key of [
			detail.sourceKey,
			...detail.pages.flatMap((p) => [
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

	const alerts = await unusualAlerts(
		watchReports.map((r) => r.reportId),
	).catch(() => [] as WatchAlert[]);
	const items = watchList(watchReports, sources, alerts, maxItems, choices);

	const [status, inbox] = await Promise.all([
		statusOf(reachable ? [...reachable] : null, email, timeZone).catch(
			() => [] as SourceStatus[],
		),
		listInbox(email, { kind: "alert", limit: 20 }).catch(
			() => [] as InboxItem[],
		),
	]);
	const since = Date.now() - alertDays * 86_400_000;

	return {
		items,
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
