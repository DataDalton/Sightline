import { NextRequest, NextResponse } from "next/server";
import { validTimeZone } from "@/lib/alerts/schedule";
import { getIdentity } from "@/lib/auth/identity";
import { requestCheck } from "@/lib/freshness/checker";
import { setLateSubscription, statusOf } from "@/lib/freshness/status";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { reachableSet } from "@/lib/platform/sources";
import { getSource } from "@/lib/semantic/registry";

// Where the data behind every source a reader can see stands, and their
// choice to be told when one of them is late.

function zoneOf(raw: string | null): string {
	return validTimeZone(raw);
}

export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const reachable = await reachableSet(identity);
	const sources = await statusOf(
		reachable ? [...reachable] : null,
		identity.email,
		zoneOf(request.nextUrl.searchParams.get("tz")),
	);
	// Past due and not looked at since. Somebody reading this is reason
	// enough to settle it.
	for (const source of sources) {
		if (source.state === "overdue") requestCheck(source.sourceKey);
	}
	return NextResponse.json({ sources });
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

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
	}

	const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : "";
	const reachable = await reachableSet(identity);
	if (!getSource(sourceKey) || (reachable && !reachable.has(sourceKey))) {
		return NextResponse.json(
			{ error: "That dataset is not one you can read." },
			{ status: 403 },
		);
	}

	await setLateSubscription(
		identity.email,
		sourceKey,
		body.subscribed === true,
	);
	return NextResponse.json({ ok: true });
}
