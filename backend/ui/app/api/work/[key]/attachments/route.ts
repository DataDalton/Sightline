import { NextRequest, NextResponse } from "next/server";
import { attach, maxBytes } from "@/lib/work/attachments";
import { tooLargeMessage } from "@/lib/work/attachmentRules";
import { privateJson } from "../../../notifications/guard";
import { failed, workCaller } from "../../shared";

type Context = { params: Promise<{ key: string }> };

// A file for a request, sent as the raw bytes rather than inside JSON, which
// would make every upload a third larger. The name and, for an image, its size
// in pixels come as headers, with X-Pasted set to 1 for a file pasted or
// dropped into a comment or the description.
export async function POST(request: NextRequest, { params }: Context) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > maxBytes) {
		return privateJson({ error: tooLargeMessage }, 413);
	}
	try {
		const bytes = Buffer.from(await request.arrayBuffer());
		const number = (name: string) => {
			const value = Number(request.headers.get(name));
			return Number.isFinite(value) && value > 0
				? Math.round(value)
				: null;
		};
		const attached = await attach(who.actor, (await params).key, {
			bytes,
			fileName: decodeURIComponent(
				request.headers.get("x-file-name") ?? "file",
			),
			contentType: request.headers.get("content-type") ?? "",
			width: number("x-width"),
			height: number("x-height"),
			pasted: request.headers.get("x-pasted") === "1",
		});
		return privateJson({ attachment: attached }, 201);
	} catch (error) {
		return failed(error);
	}
}
