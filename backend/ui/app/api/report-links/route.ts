import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { sql } from "@/lib/data/lakebase";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { cachedDefinition } from "@/lib/platform/definitionCache";
import { listReports } from "@/lib/platform/reports";
import { filterWidgetsOf } from "@/lib/visuals/filterWidgets";
import type { LinkTarget } from "@/lib/visuals/reportLinks";

// The reports this reader can go to, with the filters each page can receive.
//
// The same list answers two questions: which reports an author can link to, and
// whether a reader may be offered a link an author has already made. Filtering
// through listReports means a report the reader cannot open never appears, so a
// link to it is simply not offered.

interface Row {
	report_id: string;
	page_id: string;
	page_title: string;
	visual_id: string | null;
	visual_type: string | null;
	config: { dimensions?: unknown; measures?: unknown } | null;
}

// Every page's filter fields, the same for all readers and held until a report
// changes. See invalidateReport.
function pagesByReport() {
	return cachedDefinition("report-links:pages", async () => {
		const rows = await sql<Row>(
			`SELECT p.report_id::text AS report_id, p.page_id::text AS page_id,
			        p.title AS page_title, v.visual_id::text AS visual_id,
			        v.visual_type, v.config
			 FROM report_pages p
			 LEFT JOIN report_visuals v
			   ON v.page_id = p.page_id AND v.is_active = TRUE
			 WHERE p.is_active = TRUE
			 ORDER BY p.report_id, p.sort_order, p.page_id`,
		);

		const pages = new Map<
			string,
			Map<string, { title: string; rows: Row[] }>
		>();
		for (const row of rows) {
			const held = pages.get(row.report_id) ?? new Map();
			const page = held.get(row.page_id) ?? {
				title: row.page_title,
				rows: [],
			};
			page.rows.push(row);
			held.set(row.page_id, page);
			pages.set(row.report_id, held);
		}

		const out: Record<string, LinkTarget["pages"]> = {};
		for (const [reportId, held] of pages) {
			out[reportId] = [...held.values()].map((page) => ({
				title: page.title,
				filterFields: filterWidgetsOf(
					page.rows
						.filter((r) => r.visual_id && r.visual_type)
						.map((r) => ({
							visualId: r.visual_id as string,
							visualType: r.visual_type as string,
							config: r.config ?? undefined,
						})),
				).map((widget) => widget.field),
			}));
		}
		return out;
	});
}

export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	try {
		const policy = await resolvePolicyClass(identity);
		const [reports, pages] = await Promise.all([
			listReports(policy, identity),
			pagesByReport(),
		]);
		const targets: LinkTarget[] = reports.map((report) => ({
			slug: report.slug,
			title: report.title,
			pages: pages[report.reportId] ?? [],
		}));
		return NextResponse.json({ targets });
	} catch (error) {
		console.error("Report links failed:", error);
		return NextResponse.json(
			{ error: "Could not read the reports" },
			{ status: 500 },
		);
	}
}
