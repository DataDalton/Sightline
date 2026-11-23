import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { getReport } from "@/lib/platform/reports";
import { readFile } from "@/lib/guide/store";
import { caller } from "../../../../../notifications/guard";

// One file of a report's guide, named by the hash of its bytes. Anyone who can
// open the report can open its files. The address never points at different
// bytes, so the browser keeps it for good, privately to this reader.

type Params = { params: Promise<{ slug: string; hash: string }> };

// Shown in the browser rather than downloaded. Everything else downloads.
function opensInline(contentType: string): boolean {
	return (
		contentType.startsWith("image/") ||
		contentType === "application/pdf" ||
		contentType === "text/plain" ||
		contentType === "text/markdown" ||
		contentType === "text/csv"
	);
}

export async function GET(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug, hash } = await params;
	const policy = await resolvePolicyClass(identity);
	const report = await getReport(policy, identity, slug);
	if (!report)
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	const file = await readFile(report.reportId, hash);
	if (!file)
		return NextResponse.json({ error: "Not found" }, { status: 404 });

	const tag = `"${hash}"`;
	if (request.headers.get("if-none-match") === tag) {
		return new NextResponse(null, { status: 304, headers: { ETag: tag } });
	}
	// Text is sent as plain text whatever its kind, so a file a reader opens
	// can never run as a page of this app.
	const type = file.contentType.startsWith("text/")
		? "text/plain; charset=utf-8"
		: file.contentType;
	return new NextResponse(new Uint8Array(file.bytes), {
		headers: {
			"Content-Type": type,
			"Content-Length": String(file.bytes.length),
			"Cache-Control": "private, max-age=31536000, immutable",
			ETag: tag,
			"Content-Disposition": `${opensInline(file.contentType) ? "inline" : "attachment"}; filename="${encodeURIComponent(file.fileName)}"`,
			"X-Content-Type-Options": "nosniff",
		},
	});
}
