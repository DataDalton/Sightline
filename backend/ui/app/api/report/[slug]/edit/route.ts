import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	applyEdits,
	EditConflictError,
	EditForbiddenError,
	EditRejectedError,
	type EditOperation,
} from "@/lib/platform/editing";
import { getReport } from "@/lib/platform/reports";
import { checkWriteRateLimit } from "@/lib/rateLimit";

// Applies a batch of edits to a report. Changes publish to everyone: there is
// one definition per report, not one per reader.
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const { slug } = await params;

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const body = await request.json();
		const operations = Array.isArray(body?.operations)
			? (body.operations as EditOperation[])
			: [];

		const result = await applyEdits(policy, identity.email, {
			reportId: report.reportId,
			baseVersion: Number(body?.baseVersion ?? report.version),
			operations,
			originId: body?.originId ? String(body.originId) : undefined,
		});

		return NextResponse.json(result);
	} catch (error) {
		if (error instanceof EditConflictError) {
			// 409 with the current version, so the client can reload and retry
			// rather than guessing what happened.
			return NextResponse.json(
				{ error: error.message, currentVersion: error.currentVersion },
				{ status: 409 },
			);
		}
		if (error instanceof EditForbiddenError) {
			return NextResponse.json({ error: error.message }, { status: 403 });
		}
		if (error instanceof EditRejectedError) {
			// The definition itself is the problem, and the message names what
			// to fix. Carried through rather than flattened into "Edit failed",
			// which would leave an editor with no idea which visual to look at.
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Report edit failed:", error);
		return NextResponse.json({ error: "Edit failed" }, { status: 500 });
	}
}
