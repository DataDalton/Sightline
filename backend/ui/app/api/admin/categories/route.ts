import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { canDo } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { sql } from "@/lib/data/lakebase";

// Every category, with how many reports each holds.
//
// Unfiltered, unlike navigation. This answers "what exists" for somebody
// arranging the structure, where navigation answers "what can I open" for
// somebody reading. A category with nothing in it is invisible to every reader
// and still has to be manageable, so filtering here would hide the ones most in
// need of attention.
//
// Writes go to /api/authoring, which is where creating a report and creating a
// page live too.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const policy = await resolvePolicyClass(identity);
	const canManage = await canDo(policy, identity, "category.manage");
	const canCreate = await canDo(policy, identity, "category.create");
	if (!canManage && !canCreate) {
		// Not found rather than forbidden, so an admin surface does not confirm
		// its own existence to somebody who cannot use it.
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	const rows = await sql<{
		category_id: string;
		name: string;
		description: string | null;
		icon: string | null;
		sort_order: number;
		report_count: string;
	}>(
		`SELECT c.category_id, c.name, c.description, c.icon, c.sort_order,
		        count(r.report_id)::text AS report_count
		 FROM categories c
		 LEFT JOIN reports r
		   ON r.category_id = c.category_id AND r.is_active = TRUE
		 WHERE c.is_active = TRUE
		 GROUP BY c.category_id
		 ORDER BY c.sort_order, c.name`,
	);

	// The reports themselves, for the screen that places them. Asked for
	// explicitly rather than always returned, because the categories list is
	// read by the navigation editor too and that one needs none of this.
	//
	// Personal pages are excluded. They belong to a person rather than to the
	// structure, and moving one into a category is publishing it, which has its
	// own path and its own capability.
	const reports = request.nextUrl.searchParams.has("reports")
		? (
				await sql<{
					report_id: string;
					title: string;
					slug: string;
					category_id: string | null;
					sort_order: number;
				}>(
					`SELECT report_id::text AS report_id, title, slug,
					        category_id, sort_order
					 FROM reports
					 WHERE is_active = TRUE AND is_personal = FALSE
					 ORDER BY sort_order, title`,
				)
			).map((row) => ({
				reportId: row.report_id,
				title: row.title,
				slug: row.slug,
				categoryId: row.category_id,
				sortOrder: row.sort_order,
			}))
		: undefined;

	const response = NextResponse.json({
		reports,
		categories: rows.map((row) => ({
			categoryId: row.category_id,
			name: row.name,
			description: row.description,
			icon: row.icon,
			sortOrder: row.sort_order,
			reportCount: Number(row.report_count),
		})),
		canCreate,
		canManage,
	});
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}
