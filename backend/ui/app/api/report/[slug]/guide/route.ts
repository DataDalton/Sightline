import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	applyAssistantEdits,
	applyEdits,
	EditConflictError,
	EditForbiddenError,
} from "@/lib/platform/editing";
import { refusedUnless } from "@/lib/platform/capabilityGuard";
import { getReport } from "@/lib/platform/reports";
import { draftGuide } from "@/lib/guide/assistant";
import { maxGuideLength } from "@/lib/guide/markdown";
import {
	guideRow,
	markReviewed,
	readGuide,
	removeFile,
} from "@/lib/guide/store";
import { assistantActor } from "@/lib/upkeep/actor";
import { caller, privateJson, readJson } from "../../../notifications/guard";

// A report's guide. Anyone who can open the report reads it. Changing it, its
// files or its reviewed date takes the right to edit the report, and a change
// to the text is an edit like any other, saved as a version of the report.

type Params = { params: Promise<{ slug: string }> };

export async function GET(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);
		return privateJson(await readGuide(report, policy, identity));
	} catch (error) {
		console.error("Could not read the guide:", error);
		return privateJson({ error: "The guide could not be loaded" }, 500);
	}
}

// { action: "save", guide, startedFrom }
// { action: "reviewed" }
// { action: "draft" }
// { action: "removeFile", fileId }
export async function POST(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);
		// A reader who cannot edit the report is told it is not there, as the
		// edit route does, rather than that it is refused.
		if (report.editMode !== "edit") {
			return privateJson({ error: "Not found" }, 404);
		}

		if (body.action === "save") {
			const guide = typeof body.guide === "string" ? body.guide : null;
			// The text the editor started from, so a change somebody else saved
			// meanwhile is caught rather than written over.
			const startedFrom =
				typeof body.startedFrom === "string" ? body.startedFrom : null;
			if (guide === null || startedFrom === null) {
				return privateJson({ error: "Nothing to save" }, 400);
			}
			if (guide.length > maxGuideLength) {
				return privateJson(
					{ error: "The guide is longer than a guide can be." },
					413,
				);
			}
			const current = await guideRow(report.reportId);
			if (!current) return privateJson({ error: "Not found" }, 404);
			if ((current.guide ?? "") !== startedFrom) {
				return privateJson(
					{
						error: "The guide was changed while it was being edited.",
						changed: {
							guide: current.guide ?? "",
							editedBy: current.editedBy,
							editedOn: current.editedOn,
						},
					},
					409,
				);
			}
			// Against the version read with the text, so only a change to the
			// report saved after this check, not one made earlier to its charts,
			// stops the save.
			const result = await applyEdits(policy, identity.email, {
				reportId: report.reportId,
				baseVersion: current.version,
				operations: [{ type: "updateReport", guide }],
			});
			// Saving it is confirming it is current.
			await markReviewed(report.reportId, identity.email);
			return privateJson({ version: result.version });
		}

		if (body.action === "reviewed") {
			await markReviewed(report.reportId, identity.email);
			return privateJson({ ok: true });
		}

		if (body.action === "draft") {
			const refused = await refusedUnless(identity, "assistant.use");
			if (refused) return refused;
			if ((await guideRow(report.reportId))?.guide) {
				return privateJson(
					{ error: "This report already has a guide." },
					409,
				);
			}
			const guide = await draftGuide(identity.userToken, report);
			// Written as the assistant, with a label naming who asked, so the
			// history shows where the text came from.
			const result = await applyAssistantEdits(
				assistantActor,
				{
					reportId: report.reportId,
					baseVersion: report.version,
					operations: [{ type: "updateReport", guide }],
				},
				`Wrote a first guide when ${identity.email} asked`,
			);
			return privateJson({ version: result.version });
		}

		if (body.action === "removeFile") {
			const fileId = typeof body.fileId === "string" ? body.fileId : "";
			const removed = await removeFile(report.reportId, fileId);
			return removed
				? privateJson({ ok: true })
				: privateJson({ error: "Not found" }, 404);
		}

		return privateJson({ error: "Unknown action" }, 400);
	} catch (error) {
		if (error instanceof EditConflictError) {
			return privateJson(
				{
					error: "The report changed while the guide was open. Reload to see the latest guide.",
				},
				409,
			);
		}
		if (error instanceof EditForbiddenError) {
			return privateJson({ error: "Not found" }, 404);
		}
		console.error("Could not change the guide:", error);
		return privateJson({ error: "The guide could not be changed" }, 500);
	}
}
