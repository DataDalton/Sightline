import { NextRequest, NextResponse } from "next/server";
import { getIdentity, type Identity } from "@/lib/auth/identity";
import { assistantConfigured } from "@/lib/assistant/endpoint";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

// The checks every assistant route makes first: the feature exists in this
// deployment, and somebody is asking. An unconfigured assistant answers as
// though it were never built, from every route alike.
export async function assistantCaller(
	request: NextRequest,
): Promise<Identity | NextResponse> {
	await ensureReadyOrDegrade();
	if (!assistantConfigured()) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}
	return identity;
}
