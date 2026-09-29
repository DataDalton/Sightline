import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { reportUsage, UsageError } from "@/lib/platform/reportUsage";

// How a report is read, for whoever may edit it. See lib/platform/reportUsage.
export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const { slug } = await params;
	const days = Number(request.nextUrl.searchParams.get("days") ?? 30);

	try {
		const policy = await resolvePolicyClass(identity);
		const usage = await reportUsage(identity, policy, slug, days);
		const response = NextResponse.json(usage);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		if (error instanceof UsageError) {
			// Refused as not found to someone who may not read it, so asking
			// is not a way to learn a report exists.
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
		console.error("Report usage failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
