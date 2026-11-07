import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { timeVisualsCold, type TimedVisualInput } from "@/lib/query/coldTiming";
import { getReport } from "@/lib/platform/reports";
import { caller, privateJson, readJson } from "../../../notifications/guard";

// Times the visuals of the page being edited, from the warehouse, as the person
// asking. See lib/query/coldTiming.

// { visuals, pageSourceKey, pageConfig }
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);
		if (!report.editMode) {
			return privateJson({ error: "Not found" }, 404);
		}

		const visuals = Array.isArray(body.visuals)
			? (body.visuals as TimedVisualInput[])
			: [];
		const timings = await timeVisualsCold(identity, {
			visuals,
			pageSourceKey:
				typeof body.pageSourceKey === "string"
					? body.pageSourceKey
					: null,
			pageConfig: (body.pageConfig ?? null) as never,
			today: new Date(),
		});
		return privateJson({ timings });
	} catch (error) {
		console.error("Timing a page failed:", error);
		return privateJson({ error: "Could not time this page" }, 500);
	}
}
