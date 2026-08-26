import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { addFavourite, removeFavourite } from "@/lib/platform/search";
import { getAccessContext, resolveReportAccess } from "@/lib/platform/access";
import { sql } from "@/lib/data/lakebase";

interface Body {
	reportId?: unknown;
	favourite?: unknown;
}

// Marking a report, and unmarking it.
//
// Checked against the resolver before writing. A favourite is only a shortcut,
// but it is a shortcut stored under somebody's name and read back into their
// navigation, so it may only point at something they can actually open.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		return NextResponse.json({ error: "Invalid body" }, { status: 400 });
	}

	const reportId = typeof body.reportId === "string" ? body.reportId : null;
	if (!reportId) {
		return NextResponse.json(
			{ error: "A report is required." },
			{ status: 400 },
		);
	}

	try {
		const policy = await resolvePolicyClass(identity);
		const context = await getAccessContext(policy, identity);

		const rows = await sql<{
			category_id: string | null;
			is_personal: boolean;
			owner_email: string | null;
		}>(
			`SELECT category_id, is_personal, owner_email
			 FROM reports
			 WHERE report_id = $1 AND is_active = TRUE`,
			[reportId],
		);
		const report = rows[0];
		if (!report) {
			return NextResponse.json(
				{ error: "That report does not exist." },
				{ status: 404 },
			);
		}

		const check = resolveReportAccess(
			context.grants,
			{
				reportId,
				categoryId: report.category_id,
				isPersonal: report.is_personal,
				ownerEmail: report.owner_email,
			},
			context.email,
			"view",
			context.baseline,
		);
		if (!check.allowed) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		if (body.favourite === false) {
			await removeFavourite(identity.email, reportId);
		} else {
			await addFavourite(identity.email, reportId);
		}

		return NextResponse.json({ ok: true });
	} catch (error) {
		console.error("Favourite failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
