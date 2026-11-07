import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { insertLog } from "@/lib/activityLog";
import { getReport } from "@/lib/platform/reports";
import { packReport } from "@/lib/platform/reportPackage";
import { caller, privateJson } from "../../../notifications/guard";

// A report as a file, to bring into another environment. Holds its definition and no data,
// and takes the right to change it, since it shows how the report is built.

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report || report.editMode !== "edit") {
			return privateJson({ error: "Not found" }, 404);
		}
		await insertLog({
			recordType: "report",
			recordId: report.reportId,
			action: "export_report_file",
			changedBy: identity.email,
		});
		return new NextResponse(
			JSON.stringify(packReport(report as never), null, 2),
			{
				headers: {
					"Content-Type": "application/json",
					"Content-Disposition": `attachment; filename="${slug}.report.json"`,
					"Cache-Control": "private, no-store",
				},
			},
		);
	} catch (error) {
		console.error("Could not package a report:", error);
		return privateJson({ error: "Could not package this" }, 500);
	}
}
