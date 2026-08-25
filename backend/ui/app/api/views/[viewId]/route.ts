import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { deleteView } from "@/lib/platform/views";
import { checkWriteRateLimit } from "@/lib/rateLimit";

export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ viewId: string }> },
) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	const { viewId } = await params;

	try {
		const removed = await deleteView(identity.email, viewId);
		if (!removed) {
			// Not found and not yours are reported the same way, so the
			// response does not confirm another user's view exists.
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
		return NextResponse.json({ deleted: true });
	} catch (error) {
		console.error("View delete failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
