import { NextRequest, NextResponse } from "next/server";
import { BriefingItemError, readItem } from "@/lib/briefing/read";
import type { WatchItem } from "@/lib/briefing/watch";
import { QueryAccessError } from "@/lib/query/execute";
import { QuerySpecError } from "@/lib/query/spec";
import { caller, privateJson, readJson } from "../../notifications/guard";

// Reads one figure of the caller's briefing. The item names a dataset, a
// measure and fields, and is read like any other query the caller sends, under
// their own access, with every name checked against the dataset.

function text(value: unknown, max = 200): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function itemOf(raw: unknown): WatchItem | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const item: WatchItem = {
		id: text(r.id, 400),
		reportId: text(r.reportId),
		slug: text(r.slug),
		reportTitle: text(r.reportTitle),
		sourceKey: text(r.sourceKey),
		measure: text(r.measure),
		hint: "decimal",
		timeField: text(r.timeField),
		splitBy: Array.isArray(r.splitBy)
			? r.splitBy
					.filter((s): s is string => typeof s === "string")
					.slice(0, 2)
			: [],
		better: null,
		pinned: false,
	};
	return item.sourceKey && item.measure && item.timeField ? item : null;
}

// { item, tz }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = (await readJson(request)) as Record<string, unknown> | null;
	const item = itemOf(body?.item);
	if (!item) return privateJson({ error: "Expected a briefing item." }, 400);
	let timeZone = "UTC";
	try {
		const zone = text(body?.tz, 64);
		if (zone) {
			new Intl.DateTimeFormat("en-US", { timeZone: zone });
			timeZone = zone;
		}
	} catch {
		// An unknown zone reads as UTC.
	}
	try {
		return privateJson({ card: await readItem(identity, item, timeZone) });
	} catch (error) {
		if (error instanceof QueryAccessError)
			return privateJson({ error: error.message }, 403);
		if (
			error instanceof BriefingItemError ||
			error instanceof QuerySpecError
		)
			return privateJson({ error: error.message }, 400);
		console.error("A briefing figure could not be read:", error);
		return privateJson({ error: "This figure could not be read." }, 500);
	}
}
