import { sql } from "../data/lakebase";
import { settings } from "../settings";

// Usage telemetry: who viewed what, when, and what it cost.
//
// Every page view and every query produces an event, so at 20k users this is a
// high volume append path. Events buffer in memory and flush in batches rather
// than inserting one row at a time.
//
// They land in Lakebase, not Delta. Delta commits a file per write, which does
// not suit this rate; Databricks can mirror the table into Delta with a synced
// table when the history is wanted for long-term analysis.
//
// Telemetry never blocks a user request and never fails one. A full buffer
// drops events, and a failed flush is logged rather than retried forever:
// losing observability is bad, failing a query because of it is worse.

export type UsageEventType =
	| "page_view"
	| "query"
	| "export"
	| "edit"
	| "error";

export interface UsageEvent {
	occurredOn: string;
	userEmail: string;
	policyClass: string;
	eventType: UsageEventType;
	categoryId?: string | null;
	reportId?: string | null;
	pageId?: string | null;
	visualId?: string | null;
	sourceKey?: string | null;
	durationMs?: number | null;
	queryMs?: number | null;
	rowCount?: number | null;
	cacheHit?: boolean | null;
	errorMessage?: string | null;
	sessionId?: string | null;
	clientInfo?: string | null;
}

let buffer: UsageEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let dropped = 0;
let flushed = 0;
let flushFailures = 0;

export function record(event: UsageEvent): void {
	if (!settings().telemetryEnabled) return;

	if (buffer.length >= settings().telemetryMaxBuffer) {
		dropped++;
		return;
	}
	buffer.push(event);

	// Flush early when the batch is already full rather than waiting out the
	// interval, so a traffic spike does not sit in memory.
	if (buffer.length >= settings().telemetryMaxBatch) {
		void flush();
	}
}

export async function flush(): Promise<void> {
	if (buffer.length === 0) return;

	const batch = buffer.splice(0, settings().telemetryMaxBatch);

	try {
		// One multi-row INSERT per flush. Values bind positionally because
		// Postgres caps a statement at 65535 parameters and this keeps the
		// count predictable at 16 per event.
		const columns = [
			"occurred_on", "user_email", "policy_class", "event_type",
			"category_id", "report_id", "page_id", "visual_id", "source_key",
			"duration_ms", "query_ms", "row_count", "cache_hit",
			"error_message", "session_id", "client_info",
		];
		const params: unknown[] = [];
		const tuples = batch.map((event, i) => {
			const base = i * columns.length;
			params.push(
				event.occurredOn,
				event.userEmail,
				event.policyClass,
				event.eventType,
				event.categoryId ?? null,
				event.reportId ?? null,
				event.pageId ?? null,
				event.visualId ?? null,
				event.sourceKey ?? null,
				event.durationMs ?? null,
				event.queryMs ?? null,
				event.rowCount ?? null,
				event.cacheHit ?? null,
				event.errorMessage ?? null,
				event.sessionId ?? null,
				event.clientInfo ?? null,
			);
			const markers = columns.map((_, c) => `$${base + c + 1}`);
			return `(${markers.join(",")})`;
		});

		await sql(
			`INSERT INTO usage_events (${columns.join(",")}) VALUES ${tuples.join(",")}`,
			params,
		);

		flushed += batch.length;
	} catch (error) {
		flushFailures++;
		console.warn(`Telemetry flush failed (${batch.length} events):`, error);
	}
}

export function startTelemetryFlushing(): void {
	if (flushTimer) return;
	flushTimer = setInterval(() => {
		void flush();
	}, settings().telemetryFlushIntervalMs);
	flushTimer.unref?.();
}

export async function stopTelemetryFlushing(): Promise<void> {
	if (flushTimer) {
		clearInterval(flushTimer);
		flushTimer = null;
	}
	// Drain what is left so a graceful shutdown does not lose the tail.
	await flush();
}

export interface TelemetryStats {
	buffered: number;
	flushed: number;
	dropped: number;
	flushFailures: number;
}

export function telemetryStats(): TelemetryStats {
	return { buffered: buffer.length, flushed, dropped, flushFailures };
}
