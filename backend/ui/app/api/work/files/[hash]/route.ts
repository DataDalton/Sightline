import { NextRequest, NextResponse } from "next/server";
import { readAttachment } from "@/lib/work/attachments";
import { workCaller } from "../../shared";

type Context = { params: Promise<{ hash: string }> };

// One attached file, named by the hash of its bytes. The address can never point
// at different bytes, so the browser keeps it for good. It is private to this
// reader, and every fetch checks that they can see a request it is attached to.
export async function GET(request: NextRequest, { params }: Context) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	const { hash } = await params;
	const file = await readAttachment(who.actor, hash);
	if (!file) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	const tag = `"${hash}"`;
	if (request.headers.get("if-none-match") === tag) {
		return new NextResponse(null, { status: 304, headers: { ETag: tag } });
	}
	const inline =
		file.contentType.startsWith("image/") ||
		file.contentType === "application/pdf";
	return new NextResponse(new Uint8Array(file.bytes), {
		headers: {
			"Content-Type": file.contentType,
			"Content-Length": String(file.bytes.length),
			"Cache-Control": "private, max-age=31536000, immutable",
			ETag: tag,
			"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.fileName)}"`,
			"X-Content-Type-Options": "nosniff",
		},
	});
}
