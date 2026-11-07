import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { EditRejectedError, type EditOperation } from "@/lib/platform/editing";
import { getReport } from "@/lib/platform/reports";
import {
	createSuggestion,
	suggestionsToDecide,
	suggestionComparison,
	RequestError,
} from "@/lib/platform/requests";
import { caller, privateJson, readJson } from "../../../notifications/guard";

// Changes proposed to one report. Reading them is for whoever decides, and anybody
// who can open the report and may suggest can add one.

type Params = { params: Promise<{ slug: string }> };

export async function GET(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);
		const suggestions = await suggestionsToDecide(policy, identity, report);
		const preview = request.nextUrl.searchParams.get("preview");
		if (preview) {
			if (!suggestions.some((held) => held.suggestionId === preview)) {
				return privateJson({ error: "Not found" }, 404);
			}
			const comparison = await suggestionComparison(
				report.reportId,
				preview,
			);
			return comparison
				? privateJson(comparison)
				: privateJson({ error: "Not found" }, 404);
		}
		return privateJson({
			canReview: suggestions.length > 0,
			suggestions,
		});
	} catch (error) {
		console.error("Could not list suggestions:", error);
		return privateJson({ error: "Could not load suggestions" }, 500);
	}
}

// { baseVersion, operations, note? }
export async function POST(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);
		const suggestionId = await createSuggestion(
			policy,
			identity,
			report.reportId,
			{
				baseVersion: Number(body.baseVersion ?? report.version),
				operations: Array.isArray(body.operations)
					? (body.operations as EditOperation[])
					: [],
				note: body.note,
			},
		);
		return privateJson({ suggestionId });
	} catch (error) {
		if (error instanceof RequestError) {
			return privateJson({ error: error.message }, error.status);
		}
		if (error instanceof EditRejectedError) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("Could not save a suggestion:", error);
		return privateJson({ error: "Could not save that suggestion" }, 500);
	}
}
