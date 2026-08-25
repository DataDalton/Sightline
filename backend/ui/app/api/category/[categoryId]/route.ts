import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { getCategory } from "@/lib/platform/reports";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ categoryId: string }> },
) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const { categoryId } = await params;

	try {
		const policy = await resolvePolicyClass(identity);
		const category = await getCategory(policy, identity, categoryId);

		// A category the caller cannot open is reported as missing rather than
		// forbidden, so the response does not confirm it exists.
		if (!category) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const response = NextResponse.json(category);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Category load failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
