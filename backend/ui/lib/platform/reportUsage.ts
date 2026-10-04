import { displayNameFromEmail } from "../auth/names";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { record } from "../telemetry/usage";
import { isPageControl } from "../visuals/catalog";
import { getReport, reportById } from "./reports";

// How a report is read, for the people who maintain it.
//
// A report open is recorded when the report loads. Which page was shown, and
// what was done with a visual on it, are recorded by the page as they happen,
// so a maintainer can see which pages are read and which visuals nobody
// touches. Only someone who may edit the report can read this back, since it
// names who opened it.

// What a reader can do with a visual that shows they looked at it closely.
export const visualActions = ["expand", "figures", "notes", "select"] as const;
export type VisualAction = (typeof visualActions)[number];

export class UsageError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

// Records that a page was shown, or that a visual on it was used. Refused for
// a report the reader cannot open and for a page or visual not on it, so the
// figures cannot be padded with things that are not there.
export async function noteReportUse(
	identity: Identity,
	policy: PolicyClass,
	input: {
		reportId: string;
		pageId: string;
		visualId?: string | null;
		action?: string | null;
		sessionId?: string | null;
	},
): Promise<void> {
	const report = await reportById(policy, identity, input.reportId);
	if (!report) throw new UsageError("Not found", 404);
	const page = report.pages.find((p) => p.pageId === input.pageId);
	if (!page) throw new UsageError("Not found", 404);

	const base = {
		occurredOn: new Date().toISOString(),
		userEmail: identity.email,
		policyClass: policy.id,
		categoryId: report.categoryId,
		reportId: report.reportId,
		pageId: page.pageId,
		sessionId: input.sessionId ?? null,
	};

	if (!input.visualId) {
		record({ ...base, eventType: "page_open" });
		return;
	}

	const visual = page.visuals.find((v) => v.visualId === input.visualId);
	if (!visual) throw new UsageError("Not found", 404);
	if (!visualActions.includes(input.action as VisualAction)) {
		throw new UsageError("Unknown action", 400);
	}
	record({
		...base,
		eventType: "visual_action",
		visualId: visual.visualId,
		action: input.action,
	});
}

export interface ReportUsage {
	days: number;
	opens: number;
	readers: number;
	byDay: { day: string; opens: number; readers: number }[];
	people: { email: string; name: string; opens: number; lastOn: string }[];
	pages: { pageId: string; title: string; opens: number; readers: number }[];
	visuals: {
		visualId: string;
		pageTitle: string;
		title: string | null;
		visualType: string;
		actions: number;
		readers: number;
	}[];
}

// Everything a maintainer is shown for one report over the last few days.
// Pages and visuals are listed whether or not anyone used them, since the ones
// nobody used are the point.
export async function reportUsage(
	identity: Identity,
	policy: PolicyClass,
	slug: string,
	days: number,
): Promise<ReportUsage> {
	const report = await getReport(policy, identity, slug);
	if (!report) throw new UsageError("Not found", 404);
	if (report.permission === "view") {
		throw new UsageError(
			"Only the people who maintain a report see this.",
			403,
		);
	}

	const window = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
	const params = [report.reportId, window];
	// The same calendar days the daily bars cover, so the totals are the sum
	// of the bars. A rolling window reaches into one more day than the bars
	// show.
	const since = `occurred_on >= current_date - ($2::int - 1)`;

	const [totals, byDay, people, pages, visuals] = await Promise.all([
		sql<{ opens: string; readers: string }>(
			`SELECT count(*)::text AS opens,
			        count(DISTINCT user_email)::text AS readers
			 FROM usage_events
			 WHERE report_id = $1::uuid AND event_type = 'page_view' AND ${since}`,
			params,
		),
		// Every day in the window, with the empty ones as zero, so the bars
		// sit on a true timeline rather than closing up around quiet days.
		sql<{ day: string; opens: string; readers: string }>(
			`SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
			        count(e.event_id)::text AS opens,
			        count(DISTINCT e.user_email)::text AS readers
			 FROM generate_series(
			        current_date - ($2::int - 1), current_date, interval '1 day'
			      ) AS d(day)
			 LEFT JOIN usage_events e
			   ON e.report_id = $1::uuid AND e.event_type = 'page_view'
			  AND e.occurred_on >= d.day AND e.occurred_on < d.day + interval '1 day'
			 GROUP BY d.day ORDER BY d.day`,
			params,
		),
		sql<{ email: string; opens: string; last_on: string }>(
			`SELECT user_email AS email, count(*)::text AS opens,
			        max(occurred_on)::text AS last_on
			 FROM usage_events
			 WHERE report_id = $1::uuid AND event_type = 'page_view' AND ${since}
			 GROUP BY user_email ORDER BY count(*) DESC, max(occurred_on) DESC
			 LIMIT 50`,
			params,
		),
		sql<{ page_id: string; opens: string; readers: string }>(
			`SELECT page_id::text, count(*)::text AS opens,
			        count(DISTINCT user_email)::text AS readers
			 FROM usage_events
			 WHERE report_id = $1::uuid AND event_type = 'page_open' AND ${since}
			 GROUP BY page_id`,
			params,
		),
		sql<{ visual_id: string; actions: string; readers: string }>(
			`SELECT visual_id::text, count(*)::text AS actions,
			        count(DISTINCT user_email)::text AS readers
			 FROM usage_events
			 WHERE report_id = $1::uuid AND event_type = 'visual_action' AND ${since}
			 GROUP BY visual_id`,
			params,
		),
	]);

	const pageUse = new Map(pages.map((p) => [p.page_id, p]));
	const visualUse = new Map(visuals.map((v) => [v.visual_id, v]));

	return {
		days: window,
		opens: Number(totals[0]?.opens ?? 0),
		readers: Number(totals[0]?.readers ?? 0),
		byDay: byDay.map((d) => ({
			day: d.day,
			opens: Number(d.opens),
			readers: Number(d.readers),
		})),
		people: people.map((p) => ({
			email: p.email,
			name: displayNameFromEmail(p.email),
			opens: Number(p.opens),
			lastOn: p.last_on,
		})),
		pages: report.pages.map((page) => ({
			pageId: page.pageId,
			title: page.title,
			opens: Number(pageUse.get(page.pageId)?.opens ?? 0),
			readers: Number(pageUse.get(page.pageId)?.readers ?? 0),
		})),
		visuals: report.pages.flatMap((page) =>
			page.visuals
				// Filters and switches steer a page rather than show anything,
				// so they are not listed among visuals a maintainer might retire.
				.filter((v) => !isPageControl(v.visualType))
				.map((v) => ({
					visualId: v.visualId,
					pageTitle: page.title,
					title: v.title,
					visualType: v.visualType,
					actions: Number(visualUse.get(v.visualId)?.actions ?? 0),
					readers: Number(visualUse.get(v.visualId)?.readers ?? 0),
				})),
		),
	};
}
