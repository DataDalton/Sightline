import { NextRequest, NextResponse } from "next/server";
import { settings } from "@/lib/settings";
import { binDays, isRetentionKind } from "@/lib/retention/rules";
import { noteExploreViewOpened } from "@/lib/retention/opened";
import { isItemId, listBin, restoreItem, setKeep } from "@/lib/retention/store";
import { caller, privateJson, readJson } from "../notifications/guard";

// Retention for the caller's own items: what is in their bin, marking an item
// Keep, restoring one, and recording that a saved exploration was opened.
// Every change names the caller as owner, so somebody else's id answers as one
// that does not exist.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	try {
		return privateJson({
			months: settings().retentionMonths,
			binDays,
			items: await listBin(identity.email),
		});
	} catch (error) {
		console.error("Could not list removed items:", error);
		return privateJson(
			{ error: "Could not load recently removed items" },
			500,
		);
	}
}

const notFound = () => privateJson({ error: "Not found" }, 404);

// { action: "keep", kind, id, keep }
// { action: "restore", kind, id }
// { action: "opened", kind: "exploreView", id }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = (await readJson(request)) as {
		action?: unknown;
		kind?: unknown;
		id?: unknown;
		keep?: unknown;
	} | null;
	const kind = body?.kind;
	const id = body?.id;
	if (!isRetentionKind(kind) || !isItemId(id)) {
		return privateJson({ error: "Malformed request" }, 400);
	}

	try {
		switch (body?.action) {
			case "keep": {
				const keep = body.keep !== false;
				return (await setKeep(identity.email, kind, id, keep))
					? privateJson({ keep })
					: notFound();
			}
			case "restore": {
				const restored = await restoreItem(identity.email, kind, id);
				return restored ? privateJson(restored) : notFound();
			}
			case "opened": {
				if (kind !== "exploreView") {
					return privateJson({ error: "Malformed request" }, 400);
				}
				return (await noteExploreViewOpened(identity.email, id))
					? privateJson({ opened: true })
					: notFound();
			}
			default:
				return privateJson({ error: "Malformed request" }, 400);
		}
	} catch (error) {
		console.error("Retention change failed:", error);
		return privateJson({ error: "Could not make that change" }, 500);
	}
}
