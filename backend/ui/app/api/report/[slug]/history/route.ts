import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { EditForbiddenError } from "@/lib/platform/editing";
import { listHistory, restoreVersion } from "@/lib/platform/history";
import { getReport } from "@/lib/platform/reports";
import { checkWriteRateLimit } from "@/lib/rateLimit";

// The edit history of a report, and putting a version back.
//
// Reading it needs only the right to open the report: knowing who changed what
// is part of trusting a number, and hiding it from readers is how a figure
// changes overnight with nobody able to say why.
export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	const { slug } = await params;

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity.email, slug);
		if (!report) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		return NextResponse.json({
			entries: await listHistory(report.reportId),
			// Restoring is an edit, so the client only offers it to someone
			// who would be allowed to make one.
			canRestore: report.permission !== "view",
		});
	} catch (error) {
		console.error("History read failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}

// Restoring applies an old version as a new one. The version being undone
// stays in the record, so a restore can itself be undone.
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	const { slug } = await params;

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity.email, slug);
		if (!report) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const body = await request.json();
		const version = Number(body?.version);
		if (!Number.isFinite(version) || version < 1) {
			return NextResponse.json({ error: "Unknown version" }, { status: 400 });
		}

		const result = await restoreVersion(
			policy,
			identity.email,
			report.reportId,
			version,
		);
		return NextResponse.json(result);
	} catch (error) {
		if (error instanceof EditForbiddenError) {
			return NextResponse.json({ error: error.message }, { status: 403 });
		}
		console.error("Restore failed:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Restore failed" },
			{ status: 500 },
		);
	}
}
