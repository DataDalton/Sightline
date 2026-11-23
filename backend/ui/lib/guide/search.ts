import { sql } from "../data/lakebase";
import type { SearchTarget } from "../platform/search";
import { guideText, headingsOf, parseGuide } from "./markdown";

// A result for each guide on a report the reader can already open, so
// searching a term a guide explains finds the guide that explains it.
//
// Built from the report results, which have already been through access, so a
// guide is never offered on a report that would then refuse to open.

// How much of a guide's text is matched against. Enough for the terms it
// explains, short enough that the palette's list stays small.
const keywordLength = 3000;

export async function guideTargets(
	reports: SearchTarget[],
): Promise<SearchTarget[]> {
	const byId = new Map(
		reports
			.filter((target) => target.id.startsWith("report:"))
			.map((target) => [target.id.slice("report:".length), target]),
	);
	if (byId.size === 0) return [];
	const rows = await sql<{ report_id: string; guide: string }>(
		`SELECT report_id::text, guide FROM reports
		 WHERE report_id = ANY($1::uuid[]) AND guide IS NOT NULL`,
		[[...byId.keys()]],
	);
	return rows.flatMap((row) => {
		const report = byId.get(row.report_id);
		if (!report) return [];
		const blocks = parseGuide(row.guide);
		const headings = headingsOf(blocks)
			.map((heading) => heading.text)
			.join(" ");
		return [
			{
				id: `guide:${row.report_id}`,
				kind: "guide" as const,
				title: `${report.title} guide`,
				context: report.context,
				href: `${report.href}?guide=1`,
				keywords: `${headings} ${guideText(blocks).slice(0, keywordLength)}`,
			},
		];
	});
}
