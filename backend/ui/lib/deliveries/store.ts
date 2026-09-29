import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { getReport } from "../platform/reports";
import {
	cleanSchedule,
	describeSchedule,
	nextRun,
	type Schedule,
} from "../alerts/schedule";
import { slug } from "../visuals/shareState";

// A page somebody asked to be sent on a schedule.
//
// What arrives is the page's headline figures, its KPI tiles, worked out under
// the owner's access as the page would show them on opening, with how each
// moved since the last one and a link to the page. See lib/deliveries/runner
// for when and under whose authority they are worked out.

export class DeliveryError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

// A page is sent at most daily. Every hour would be an alert's job, and would
// turn the inbox into a feed of the same page.
export const deliveryFrequencies = ["daily", "weekdays", "weekly"] as const;

// How many pages one person may have sent. Each is a set of warehouse
// queries on its schedule.
const maxPerPerson = 25;

export interface DeliveryRecord {
	id: string;
	reportId: string;
	reportSlug: string;
	reportTitle: string;
	pageId: string;
	pageTitle: string;
	schedule: Schedule;
	scheduleText: string;
	enabled: boolean;
	lastRunOn: string | null;
	lastStatus: string;
	lastError: string | null;
	nextRunOn: string;
}

interface DeliveryListRow {
	delivery_id: string;
	report_id: string;
	slug: string;
	report_title: string;
	page_id: string;
	page_title: string;
	schedule: Schedule;
	enabled: boolean;
	last_run_on: string | null;
	last_status: string;
	last_error: string | null;
	next_run_on: string;
}

function toRecord(row: DeliveryListRow): DeliveryRecord {
	return {
		id: row.delivery_id,
		reportId: row.report_id,
		reportSlug: row.slug,
		reportTitle: row.report_title,
		pageId: row.page_id,
		pageTitle: row.page_title,
		schedule: row.schedule,
		scheduleText: describeSchedule(row.schedule),
		enabled: row.enabled,
		lastRunOn: row.last_run_on,
		lastStatus: row.last_status,
		lastError: row.last_error,
		nextRunOn: row.next_run_on,
	};
}

export async function listDeliveries(
	ownerEmail: string,
): Promise<DeliveryRecord[]> {
	const rows = await sql<DeliveryListRow>(
		`SELECT d.delivery_id::text, d.report_id::text, r.slug,
		        r.title AS report_title, d.page_id::text, p.title AS page_title,
		        d.schedule, d.enabled, d.last_run_on::text, d.last_status,
		        d.last_error, d.next_run_on::text
		 FROM deliveries d
		 JOIN reports r ON r.report_id = d.report_id AND r.is_active
		 JOIN report_pages p ON p.page_id = d.page_id AND p.is_active
		 WHERE d.owner_email = $1
		 ORDER BY r.title, p.sort_order`,
		[ownerEmail.toLowerCase()],
	);
	return rows.map(toRecord);
}

// Starts sending a page, or changes when an existing one is sent. The report
// is opened as the owner first, so nobody can ask to be sent a page they
// cannot read.
export async function subscribe(
	identity: Identity,
	policy: PolicyClass,
	input: { reportSlug: string; pageId: string; schedule: unknown },
): Promise<DeliveryRecord> {
	const report = await getReport(policy, identity, input.reportSlug);
	if (!report) throw new DeliveryError("Report not found", 404);
	const page = report.pages.find((p) => p.pageId === input.pageId);
	if (!page) throw new DeliveryError("Page not found", 404);

	const schedule = cleanSchedule(input.schedule);
	if (!(deliveryFrequencies as readonly string[]).includes(schedule.frequency)) {
		schedule.frequency = "daily";
	}

	const email = identity.email.toLowerCase();
	const count = await sql<{ n: string }>(
		`SELECT count(*)::text AS n FROM deliveries
		 WHERE owner_email = $1 AND page_id <> $2::uuid`,
		[email, page.pageId],
	);
	if (Number(count[0]?.n ?? 0) >= maxPerPerson) {
		throw new DeliveryError(
			`You have ${maxPerPerson} scheduled pages, the most one person can keep.`,
		);
	}

	const figureSource =
		page.visuals.find((v) => v.visualType === "kpiRow")?.sourceKey ??
		page.sourceKey ??
		report.sourceKey;

	await sql(
		`INSERT INTO deliveries
		   (owner_email, report_id, page_id, source_key, schedule, next_run_on,
		    access_confirmed_on)
		 VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, now())
		 ON CONFLICT (owner_email, page_id) DO UPDATE SET
		   schedule = EXCLUDED.schedule,
		   next_run_on = EXCLUDED.next_run_on,
		   source_key = EXCLUDED.source_key,
		   access_confirmed_on = now(),
		   enabled = TRUE`,
		[
			email,
			report.reportId,
			page.pageId,
			figureSource,
			JSON.stringify(schedule),
			nextRun(schedule, new Date()).toISOString(),
		],
	);

	const all = await listDeliveries(email);
	const saved = all.find((d) => d.pageId === page.pageId);
	if (!saved) throw new DeliveryError("The page could not be scheduled.", 500);
	return saved;
}

export async function unsubscribe(
	ownerEmail: string,
	id: string,
): Promise<boolean> {
	const rows = await sql(
		`DELETE FROM deliveries
		 WHERE delivery_id::text = $1 AND owner_email = $2
		 RETURNING delivery_id`,
		[id, ownerEmail.toLowerCase()],
	);
	return rows.length > 0;
}

// Where a delivery's link goes. The report on its first page, or on the named
// page, in the form the report page reads.
export function pageLink(
	reportSlug: string,
	pageTitle: string,
	isFirstPage: boolean,
): string {
	const base = `/r/${encodeURIComponent(reportSlug)}/`;
	return isFirstPage ? base : `${base}?page=${slug(pageTitle)}`;
}
