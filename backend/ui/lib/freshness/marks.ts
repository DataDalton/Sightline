import { sql } from "../data/lakebase";

// What every replica knows about each source's freshness, read from the
// platform tables every few seconds.
//
// The check that notices a change runs on one replica. Every replica holds
// answers of its own in memory, so each needs to learn of the change before
// it next serves one. An answer computed before its source last changed is
// then treated as missing, wherever it is held.

export type FreshnessMode = "checked" | "timer";

interface Mark {
	mode: FreshnessMode;
	changedOn: number;
	checkedOn: number;
}

let marks = new Map<string, Mark>();
let readAt = 0;

export async function refreshMarks(): Promise<void> {
	const rows = await sql<{
		source_key: string;
		freshness_mode: string;
		data_changed_on: string | null;
		checked_on: string | null;
	}>(
		`SELECT source_key, freshness_mode, data_changed_on::text,
		        checked_on::text
		 FROM data_sources WHERE is_active`,
	);
	const next = new Map<string, Mark>();
	for (const row of rows) {
		next.set(row.source_key, {
			mode: row.freshness_mode === "checked" ? "checked" : "timer",
			changedOn: row.data_changed_on ? Date.parse(row.data_changed_on) : 0,
			checkedOn: row.checked_on ? Date.parse(row.checked_on) : 0,
		});
	}
	marks = next;
	readAt = Date.now();
}

export function marksReadAt(): number {
	return readAt;
}

// Whether the source's tables are watched, so its answers can be kept until
// they change rather than until a timer runs out.
export function isChecked(sourceKey: string): boolean {
	return marks.get(sourceKey)?.mode === "checked";
}

// Whether data behind the source changed after an answer was computed.
export function changedSince(sourceKey: string, computedAt: number): boolean {
	const mark = marks.get(sourceKey);
	return Boolean(mark && mark.changedOn > computedAt);
}

// Whether a watched source has gone longer than its interval without a look,
// which happens while the warehouse is stopped and the pass skips it.
export function overdue(sourceKey: string, intervalSeconds: number): boolean {
	const mark = marks.get(sourceKey);
	if (!mark || mark.mode !== "checked") return false;
	return Date.now() - mark.checkedOn > intervalSeconds * 2 * 1000;
}

// Read again every few seconds, so a change found on any replica is honoured
// on this one before long. Started once per module instance: the development
// server keeps startup and request handling in separate instances, and each
// holds its own copy.
let timer: ReturnType<typeof setInterval> | null = null;

export function startMarksPolling(): void {
	if (timer) return;
	void refreshMarks().catch(() => {});
	timer = setInterval(() => {
		void refreshMarks().catch(() => {});
	}, 5_000);
	timer.unref?.();
}

export function stopMarksPolling(): void {
	if (timer) clearInterval(timer);
	timer = null;
}

export interface FreshnessDetail {
	mode: FreshnessMode;
	note: string | null;
	checkedOn: string | null;
	changedOn: string | null;
}

// Each source's standing, for the administration pages.
export async function freshnessDetails(): Promise<
	Map<string, FreshnessDetail>
> {
	const rows = await sql<{
		source_key: string;
		freshness_mode: string;
		freshness_note: string | null;
		checked_on: string | null;
		data_changed_on: string | null;
	}>(
		`SELECT source_key, freshness_mode, freshness_note, checked_on::text,
		        data_changed_on::text
		 FROM data_sources WHERE is_active`,
	);
	return new Map(
		rows.map((r) => [
			r.source_key,
			{
				mode: r.freshness_mode === "checked" ? "checked" : "timer",
				note: r.freshness_note,
				checkedOn: r.checked_on,
				changedOn: r.data_changed_on,
			},
		]),
	);
}
