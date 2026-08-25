import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	baselinePermission,
	getGrants,
	resolveCategoryAccess,
} from "@/lib/platform/access";
import { sql } from "@/lib/data/lakebase";
import { cachedDefinition } from "@/lib/platform/definitionCache";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

interface CategoryRow {
	category_id: string;
	name: string;
	icon: string | null;
	sort_order: number;
	report_count: string;
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
		const rows = await cachedDefinition("navigation:categories", () =>
			sql<CategoryRow>(
				`SELECT c.category_id, c.name, c.icon, c.sort_order,
				        COUNT(r.report_id) AS report_count
				 FROM categories c
				 LEFT JOIN reports r
				   ON r.category_id = c.category_id AND r.is_active = TRUE
				 WHERE c.is_active = TRUE
				 GROUP BY c.category_id, c.name, c.icon, c.sort_order
				 ORDER BY c.sort_order, c.name`,
			),
		);

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
				reportCount: Number(row.report_count) || 0,
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
