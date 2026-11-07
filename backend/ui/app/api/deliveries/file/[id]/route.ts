import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { sql } from "@/lib/data/lakebase";
import { canDoOnReport } from "@/lib/platform/access";
import { reportSubject } from "@/lib/platform/curated";
import { caller, privateJson } from "../../../notifications/guard";

// A scheduled PDF, for the person it was drawn for and only while they keep the right to
// export the report it came from. It holds what they could see when it was drawn.

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	const rows = await sql<{
		filename: string;
		bytes: Buffer;
		report_id: string;
	}>(
		`SELECT filename, bytes, report_id::text AS report_id
		 FROM delivery_files
		 WHERE file_id::text = $1 AND owner_email = $2 AND expires_on > now()`,
		[id, identity.email.toLowerCase()],
	);
	const file = rows[0];
	if (!file) return privateJson({ error: "Not found" }, 404);

	const subject = await reportSubject(file.report_id);
	const policy = await resolvePolicyClass(identity);
	if (
		!subject ||
		!(await canDoOnReport(policy, identity, "export.run", {
			reportId: file.report_id,
			categoryId: subject.category_id,
			tags: subject.tags,
		}))
	) {
		return privateJson({ error: "Not found" }, 404);
	}

	return new NextResponse(new Uint8Array(file.bytes), {
		headers: {
			"Content-Type": "application/pdf",
			"Content-Disposition": `attachment; filename="${file.filename}"`,
			"Cache-Control": "private, no-store",
		},
	});
}
