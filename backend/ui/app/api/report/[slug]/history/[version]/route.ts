import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	VersionNotFoundError,
	versionComparison,
} from "@/lib/platform/history";
import { getReport } from "@/lib/platform/reports";

// One version of a report against another, property by property.
//
// Separate from the history list because the list is a summary and this is the
// whole definition twice over. Nobody reading a history wants sixty of those,
// and everybody who opens one wants exactly one.
//
// Reading it needs only the right to open the report, the same bar the list
// sets. Knowing what a number used to be is part of trusting the number.
export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string; version: string }> },
) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const { slug, version } = await params;
	const wanted = Number(version);
	if (!Number.isFinite(wanted) || wanted < 1) {
		return NextResponse.json({ error: "Unknown version" }, { status: 400 });
	}

	// Absent means the version before this one. Present names the other end of
	// the comparison, so two saves a week apart can be read against each other.
	const asked = request.nextUrl.searchParams.get("from");
	const against = asked === null ? undefined : Number(asked);
	if (against !== undefined && (!Number.isFinite(against) || against < 1)) {
		return NextResponse.json({ error: "Unknown version" }, { status: 400 });
	}

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		return NextResponse.json(
			await versionComparison(report.reportId, wanted, against),
		);
	} catch (error) {
		if (error instanceof VersionNotFoundError) {
			return NextResponse.json({ error: error.message }, { status: 404 });
		}
		console.error("Version comparison failed:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Could not compare those versions",
			},
			{ status: 500 },
		);
	}
}
