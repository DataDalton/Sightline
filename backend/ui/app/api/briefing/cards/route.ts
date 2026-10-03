import { NextRequest, NextResponse } from "next/server";
import { validTimeZone } from "@/lib/alerts/schedule";
import { briefingCards } from "@/lib/briefing/cards";
import type { WatchItem } from "@/lib/briefing/watch";
import { caller, privateJson, readJson } from "../../notifications/guard";

// The cards of the caller's briefing, one line of JSON each, written as each
// becomes known. Stored cards come first, then each one worked out afresh.
// Every item names a dataset, a measure and fields, and is read like any other
// query the caller sends, under their own access, with every name checked
// against the dataset. See lib/briefing/cards.

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
	return item.id && item.sourceKey && item.measure && item.timeField
		? item
		: null;
}

function zoneOf(raw: unknown): string {
	return validTimeZone(text(raw, 64));
}

// { items, tz }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = (await readJson(request)) as Record<string, unknown> | null;
	const items = Array.isArray(body?.items)
		? body.items
				.map(itemOf)
				.filter((item): item is WatchItem => item !== null)
		: null;
	if (!items) return privateJson({ error: "Expected briefing items." }, 400);
	const timeZone = zoneOf(body?.tz);

	const encoder = new TextEncoder();
	// Aborted when the request ends or a write fails, so no new card is
	// started for a reader who has left.
	const closed = new AbortController();
	const leave = () => closed.abort();
	if (request.signal.aborted) leave();
	else request.signal.addEventListener("abort", leave, { once: true });
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let open = true;
			const emit = (event: unknown) => {
				if (!open) return;
				try {
					controller.enqueue(
						encoder.encode(`${JSON.stringify(event)}\n`),
					);
				} catch {
					// The reader left. Work already started still finishes
					// and is stored for the next visit.
					open = false;
					leave();
				}
			};
			try {
				await briefingCards(
					identity,
					items,
					timeZone,
					emit,
					closed.signal,
				);
			} catch (error) {
				console.error("The briefing cards could not be read:", error);
			}
			request.signal.removeEventListener("abort", leave);
			if (open) {
				try {
					controller.close();
				} catch {
					// The stream was cancelled by the reader.
				}
			}
		},
		cancel() {
			leave();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "application/x-ndjson",
			"Cache-Control": "private, no-store",
		},
	});
}
