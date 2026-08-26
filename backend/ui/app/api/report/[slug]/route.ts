import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { reportPayload } from "@/lib/platform/pageData";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { record } from "@/lib/telemetry/usage";

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

	try {
		const policy = await resolvePolicyClass(identity);
		const payload = await reportPayload(identity, policy, slug);

		if (!payload) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
		const report = payload.report as {
			categoryId: string | null;
			reportId: string;
		};

		record({
			occurredOn: new Date().toISOString(),
			userEmail: identity.email,
			policyClass: policy.id,
			eventType: "page_view",
			categoryId: report.categoryId,
			reportId: report.reportId,
			sessionId: request.headers.get("x-session-id"),
		});

		const response = NextResponse.json(payload);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Report load failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
