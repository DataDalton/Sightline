import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	baselinePermission,
	getGrants,
	resolveCategoryAccess,
	resolveReportAccess,
} from "@/lib/platform/access";
import { sql } from "@/lib/data/lakebase";
import { cachedDefinition } from "@/lib/platform/definitionCache";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

interface CategoryRow {
	category_id: string;
	name: string;
	icon: string | null;
	sort_order: number;
}

interface ReportRow {
	report_id: string;
	category_id: string | null;
}

// Categories the caller can actually open. A category they hold no grant for
// never reaches the client, so navigation cannot advertise a report that would
// then refuse to load.
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
		const grants = await getGrants(policy, identity);
		const baseline = baselinePermission(policy);

		// The same list for everybody. What differs per reader is which of
		// these survives the filter below, so the query is shared and the
		// decision is not.
		// Ids rather than a count, because the count is per reader and the list
		// is not. Counting in SQL gave everybody the total, so a category read
		// "Sales (12)" and opened on the three reports that reader holds.
		const [rows, reportRows] = await cachedDefinition(
			"navigation:categories",
			async () =>
				await Promise.all([
					sql<CategoryRow>(
						`SELECT category_id, name, icon, sort_order
						 FROM categories
						 WHERE is_active = TRUE
						 ORDER BY sort_order, name`,
					),
					sql<ReportRow>(
						`SELECT report_id, category_id
						 FROM reports
						 WHERE is_active = TRUE`,
					),
				]),
		);

		const visiblePerCategory = new Map<string, number>();
		for (const report of reportRows) {
			if (!report.category_id) continue;
			const allowed = resolveReportAccess(
				grants,
				report.report_id,
				report.category_id,
				"view",
				baseline,
			).allowed;
			if (!allowed) continue;
			visiblePerCategory.set(
				report.category_id,
				(visiblePerCategory.get(report.category_id) ?? 0) + 1,
			);
		}

		const categories = rows
			.filter(
				(row) =>
					resolveCategoryAccess(
						grants,
						row.category_id,
						"view",
						baseline,
					).allowed,
			)
			.map((row) => ({
				categoryId: row.category_id,
				name: row.name,
				icon: row.icon,
				reportCount: visiblePerCategory.get(row.category_id) ?? 0,
			}));

		const response = NextResponse.json({
			categories,
			degraded: policy.degraded,
		});
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Navigation load failed:", error);
		// An empty navigation is a safe answer: it shows nothing rather than
		// showing something the caller may not be entitled to.
		return NextResponse.json({ categories: [], degraded: true });
	}
}
