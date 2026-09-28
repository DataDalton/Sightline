import { NextRequest, NextResponse } from "next/server";
import { getIdentity, type Identity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

// Every inbox and alert route is about the caller's own things, so each one
// starts the same way: the platform is up and somebody is signed in.
export async function caller(
	request: NextRequest,
): Promise<Identity | NextResponse> {
	await ensureReadyOrDegrade();
	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}
	return identity;
}

// Nothing here is the same for two people or worth keeping.
export function privateJson(body: unknown, status = 200): NextResponse {
	const response = NextResponse.json(body, { status });
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export async function readJson(request: NextRequest): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return null;
	}
}
