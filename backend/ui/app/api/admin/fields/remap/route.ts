import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { canDo } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { RemapError, remapField } from "@/lib/semantic/remap";

// Points every item naming a missing field at the field that replaced it. See
// lib/semantic/remap.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const policy = await resolvePolicyClass(identity);
	if (!(await canDo(policy, identity, "semantic.sync"))) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
	}

	const text = (value: unknown) =>
		typeof value === "string" ? value.trim().slice(0, 500) : "";

	try {
		const result = await remapField(
			identity.email,
			text(body.sourceKey),
			text(body.from),
			text(body.to),
		);
		return NextResponse.json(result);
	} catch (error) {
		if (error instanceof RemapError) {
			return NextResponse.json(
				{ error: error.message },
				{ status: error.status },
			);
		}
		console.error("Field remap failed:", error);
		return NextResponse.json(
			{ error: "The remap failed and nothing was changed." },
			{ status: 500 },
		);
	}
}
