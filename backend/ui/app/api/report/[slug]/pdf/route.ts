import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { refusedUnless } from "@/lib/platform/capabilityGuard";
import { DeckError, recordPrint } from "@/lib/platform/decks";
import { getReport } from "@/lib/platform/reports";
import { caller, privateJson, readJson } from "../../../notifications/guard";

// Permission to print a report, given only once the right to export has been checked
// and the record of it written. The page will not lay itself out for paper without
// this answer, so a report cannot reach paper without the row in Export audit.

// { pageId, search }
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

		const refused = await refusedUnless(
			identity,
			"export.run",
			report.reportId,
		);
		if (refused) return refused;

		await recordPrint(identity, report, {
			pageId: body.pageId ? String(body.pageId) : null,
			search: String(body.search ?? ""),
		});
		return privateJson({ ok: true });
	} catch (error) {
		if (error instanceof DeckError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Could not record a print:", error);
		return privateJson(
			{ error: "This could not be recorded, so it was not printed." },
			500,
		);
	}
}
