import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { listViews, saveView } from "@/lib/platform/views";
import { checkWriteRateLimit } from "@/lib/rateLimit";

export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	const pageId = request.nextUrl.searchParams.get("pageId");
	if (!pageId) {
		return NextResponse.json({ error: "pageId is required" }, { status: 400 });
	}

	try {
		const policy = await resolvePolicyClass(identity);
		const views = await listViews(identity.email, policy.grants, pageId);
		const response = NextResponse.json({ views });
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("View list failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}

export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	try {
		const body = await request.json();
		const name = String(body?.name ?? "").trim();
		const pageId = String(body?.pageId ?? "").trim();

		if (!name || !pageId) {
			return NextResponse.json(
				{ error: "name and pageId are required" },
				{ status: 400 },
			);
		}

		const view = await saveView(identity.email, {
			viewId: body.viewId ? String(body.viewId) : undefined,
			reportId: body.reportId ? String(body.reportId) : null,
			pageId,
			name: name.slice(0, 120),
			config: body.config ?? {},
			isDefault: Boolean(body.isDefault),
			isShared: Boolean(body.isShared),
			sharedWith: Array.isArray(body.sharedWith)
				? body.sharedWith.map(String)
				: [],
		});

		return NextResponse.json({ view });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Could not save the view";
		// A failed ownership check is the caller's, not a server fault.
		const status = message.includes("do not own") ? 403 : 500;
		if (status === 500) console.error("View save failed:", error);
		return NextResponse.json({ error: message }, { status });
	}
}
