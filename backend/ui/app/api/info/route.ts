import { NextResponse } from "next/server";
import { infoPayload } from "@/lib/platform/pageData";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

// The shell is rendered with this already in it, so on a first load this route
// is a revalidation. It still has to exist: renaming the installation or
// changing its mark takes effect without a reload, and that is this being
// asked again.
export async function GET() {
	await ensureReadyOrDegrade();
	return NextResponse.json(infoPayload());
}
