import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { cleanState } from "@/lib/explore/state";
import { createView, listViews } from "@/lib/explore/views";

// The caller's saved explorations: listed, or one more added.

export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();
	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}
	try {
		const response = NextResponse.json({
			views: await listViews(identity.email),
		});
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Could not list saved views:", error);
		return NextResponse.json(
			{ error: "Could not load your saved views" },
			{ status: 500 },
		);
	}
}

export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();
	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	let name = "";
	let state = null;
	try {
		const body = await request.json();
		name = String(body?.name ?? "");
		state = cleanState(body?.state);
	} catch {
		return NextResponse.json(
			{ error: "Malformed request" },
			{ status: 400 },
		);
	}
	if (!state) {
		return NextResponse.json(
			{ error: "Choose a dataset before saving" },
			{ status: 400 },
		);
	}

	const view = await createView(identity.email, name, state);
	return view
		? NextResponse.json(view)
		: NextResponse.json({ error: "Could not save" }, { status: 500 });
}
