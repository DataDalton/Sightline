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
	| "error"
	// A page of a report shown to a reader, and something a reader did with
	// one visual on it. See lib/platform/reportUsage.
	| "page_open"
	| "visual_action";

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
	// For a visual action, which one, such as expanding it.
	action?: string | null;
}

const columns = [
	"occurred_on",
	"user_email",
	"policy_class",
	"event_type",
	"category_id",
	"report_id",
	"page_id",
	"visual_id",
	"source_key",
	"duration_ms",
	"query_ms",
	"row_count",
	"cache_hit",
	"error_message",
	"session_id",
	"client_info",
	"action",
];

// Postgres binds at most this many parameters in one statement.
const maxParams = 65535;

// Events per insert. The setting is stored as free text, so it is held
// between one and the most whose parameters fit one statement. A value past
// that would fail every flush and lose every event, and zero would never
// drain the buffer.
export function batchSize(setting: number): number {
	const most = Math.floor(maxParams / columns.length);
	if (!Number.isFinite(setting)) return most;
	return Math.min(Math.max(Math.floor(setting), 1), most);
}

// Milliseconds between flushes, held to at least a second so a zero or an
// unreadable setting cannot spin the timer.
export function flushInterval(setting: number): number {
	return Number.isFinite(setting) ? Math.max(setting, 1000) : 15_000;
}

let buffer: UsageEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
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
	if (buffer.length >= batchSize(settings().telemetryMaxBatch)) {
		void flush();
	}
}

export async function flush(): Promise<void> {
	if (buffer.length === 0) return;

	const batch = buffer.splice(0, batchSize(settings().telemetryMaxBatch));

	try {
		// One multi-row INSERT per flush. Values bind positionally because
		// Postgres caps a statement at 65535 parameters and this keeps the
		// count predictable at one per column per event.
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
				event.action ?? null,
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

// The interval is read on each tick rather than captured once, so an
// administrator changing it takes effect at the next flush instead of at the
// next restart. Rescheduled with a timeout chain for the same reason.
export function startTelemetryFlushing(): void {
	if (flushTimer) return;

	const tick = () => {
		void flush().finally(() => {
			if (flushTimer === null) return;
			flushTimer = setTimeout(
				tick,
				flushInterval(settings().telemetryFlushIntervalMs),
			);
			flushTimer.unref?.();
		});
	};

	flushTimer = setTimeout(
		tick,
		flushInterval(settings().telemetryFlushIntervalMs),
	);
	flushTimer.unref?.();
}

export async function stopTelemetryFlushing(): Promise<void> {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	// Drain what is left so a graceful shutdown does not lose the tail. One
	// flush takes one batch, so it repeats until the buffer is empty. It stops
	// at the first failed flush, since the store is then most likely gone.
	for (let guard = 0; buffer.length > 0 && guard < 1000; guard++) {
		const failuresBefore = flushFailures;
		await flush();
		if (flushFailures > failuresBefore) break;
	}
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
