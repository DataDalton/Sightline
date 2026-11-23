import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { getReport } from "@/lib/platform/reports";
import { guideFileTooLarge, maxGuideFileBytes } from "@/lib/guide/fileRules";
import { addFile, GuideError } from "@/lib/guide/store";
import { caller, privateJson } from "../../../../notifications/guard";

// A file for a report's guide, sent as the raw bytes rather than inside JSON,
// which would make every upload a third larger. The name comes as a header.
// Takes the right to edit the report.

type Params = { params: Promise<{ slug: string }> };

export async function POST(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > maxGuideFileBytes) {
		return privateJson({ error: guideFileTooLarge }, 413);
	}
	const { slug } = await params;
	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report || report.editMode !== "edit") {
			return privateJson({ error: "Not found" }, 404);
		}
		const bytes = Buffer.from(await request.arrayBuffer());
		const file = await addFile(report.reportId, identity.email, {
			bytes,
			fileName: decodeURIComponent(
				request.headers.get("x-file-name") ?? "file",
			),
			contentType: request.headers.get("content-type") ?? "",
		});
		return privateJson({ file }, 201);
	} catch (error) {
		if (error instanceof GuideError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Could not attach the file to the guide:", error);
		return privateJson({ error: "The file could not be attached" }, 500);
	}
}
