import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { noteReportUse, UsageError } from "@/lib/platform/reportUsage";
import { checkUsageRateLimit } from "@/lib/rateLimit";

// A page shown, or a visual used, sent by the page as it happens. Answered with
// nothing, since the page does not wait on it.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const limited = checkUsageRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) return new NextResponse(null, { status: 401 });

	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object") {
		return new NextResponse(null, { status: 400 });
	}

	try {
		const policy = await resolvePolicyClass(identity);
		await noteReportUse(identity, policy, {
			reportId: String(body.reportId ?? ""),
			pageId: String(body.pageId ?? ""),
			visualId: body.visualId ? String(body.visualId) : null,
			action: body.action ? String(body.action) : null,
			sessionId: request.headers.get("x-session-id"),
		});
		return new NextResponse(null, { status: 204 });
	} catch (error) {
		if (error instanceof UsageError) {
			return new NextResponse(null, { status: error.status });
		}
		console.error("Recording report use failed:", error);
		return new NextResponse(null, { status: 500 });
	}
}
