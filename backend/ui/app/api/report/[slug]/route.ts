import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { getReport } from "@/lib/platform/reports";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { getSource } from "@/lib/semantic/registry";
import { record } from "@/lib/telemetry/usage";

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

		// Field metadata for every source the report reads, so the client can
		// label and format values without a second round trip per visual.
		const sourceKeys = new Set<string>();
		if (report.sourceKey) sourceKeys.add(report.sourceKey);
		for (const page of report.pages) {
			if (page.sourceKey) sourceKeys.add(page.sourceKey);
			for (const visual of page.visuals) {
				if (visual.sourceKey) sourceKeys.add(visual.sourceKey);
			}
		}

		const sources: Record<string, unknown> = {};
		for (const key of sourceKeys) {
			const source = getSource(key);
			if (!source) continue;
			sources[key] = {
				sourceKey: source.sourceKey,
				title: source.title,
				kind: source.kind,
				defaultTimeField: source.defaultTimeField,
				dimensions: source.dimensions.map((f) => ({
					name: f.name,
					displayName: f.displayName,
					dataType: f.dataType,
					formatHint: f.formatHint,
					description: f.description,
					tags: f.tags,
				})),
				measures: source.measures.map((f) => ({
					name: f.name,
					displayName: f.displayName,
					dataType: f.dataType,
					formatHint: f.formatHint,
					description: f.description,
					tags: f.tags,
				})),
			};
		}

		record({
			occurredOn: new Date().toISOString(),
			userEmail: identity.email,
			policyClass: policy.id,
			eventType: "page_view",
			categoryId: report.categoryId,
			reportId: report.reportId,
			sessionId: request.headers.get("x-session-id"),
		});

		const response = NextResponse.json({ report, sources });
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Report load failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
