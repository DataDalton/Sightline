import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { getReport } from "@/lib/platform/reports";
import {
	addReportHolder,
	describeReportAccess,
	ReportAccessError,
	removeReportHolder,
	setEditPolicy,
	setReportTags,
	takeBackToDraft,
} from "@/lib/platform/reportAccess";
import { caller, privateJson, readJson } from "../../../notifications/guard";

// Who looks after one report and who can edit it. Anybody who can open the report
// can see who to ask. Changing it takes the right to decide, checked per action.

type Params = { params: Promise<{ slug: string }> };

export async function GET(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);
		return privateJson(
			await describeReportAccess(policy, identity, report.reportId),
		);
	} catch (error) {
		console.error("Could not read a report's access:", error);
		return privateJson({ error: "Could not load this" }, 500);
	}
}

export async function POST(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const action = String(body.action ?? "");

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);
		const reportId = report.reportId;

		if (action === "setPolicy") {
			await setEditPolicy(policy, identity, reportId, {
				level: body.level === "category" ? "category" : "report",
				value: body.value,
			});
		} else if (action === "setTags") {
			await setReportTags(policy, identity, reportId, body.tags);
		} else if (action === "add") {
			await addReportHolder(policy, identity, reportId, {
				level:
					body.level === "category"
						? "category"
						: body.level === "page"
							? "page"
							: "report",
				pageId: body.pageId ? String(body.pageId) : null,
				roleId: String(body.roleId ?? ""),
				subjectType: body.subjectType === "group" ? "group" : "user",
				subjectId: String(body.subjectId ?? ""),
				expiresOn: body.expiresOn ? String(body.expiresOn) : null,
			});
		} else if (action === "remove") {
			await removeReportHolder(
				policy,
				identity,
				reportId,
				String(body.assignmentId ?? ""),
			);
		} else if (action === "takeBack") {
			await takeBackToDraft(policy, identity, reportId);
		} else {
			return privateJson({ error: "Unknown action." }, 400);
		}

		return privateJson(
			await describeReportAccess(policy, identity, reportId),
		);
	} catch (error) {
		if (error instanceof ReportAccessError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Could not change a report's access:", error);
		return privateJson({ error: "Could not make that change" }, 500);
	}
}
