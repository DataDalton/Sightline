import { sql } from "../data/lakebase";

// What every replica knows about each source's freshness and protection, read
// from the platform tables every few seconds.
//
// The check that notices a change runs on one replica. Every replica holds
// answers of its own in memory, so each needs to learn of the change before
// it next serves one. An answer computed before its source last changed is
// then treated as missing, wherever it is held.
//
// Most reads ask only for what moved since the last one. A trigger stamps a
// source's row whenever anything read here changes on it, and each look at a
// table stamps that table's row in source_checks. Every so often everything
// is read again regardless, which also drops sources that were removed.

export type FreshnessMode = "checked" | "timer";

interface Mark {
	mode: FreshnessMode;
	changedOn: number;
	hasRowFilter: boolean;
	// The tables the source reads, whose looks say when it was last looked at.
	tables: string[];
}

interface SourceRow {
	source_key: string;
	is_active: boolean;
	freshness_mode: string;
	data_changed_on: string | null;
	has_row_filter: boolean;
	kind: string;
	catalog_name: string;
	schema_name: string;
	object_name: string;
	base_tables: string[] | null;
}

const sourceColumns = `source_key, is_active, freshness_mode,
	data_changed_on::text AS data_changed_on, has_row_filter, kind,
	catalog_name, schema_name, object_name, base_tables`;

let marks = new Map<string, Mark>();
// When each table was last looked at.
let looks = new Map<string, number>();
let readAt = 0;
let fullReadAt = 0;
// The platform store's own clock at the last read, which the next read asks
// for changes after.
let readSince: string | null = null;
// Whether the trigger that stamps changed sources is in place. Without it
// every read is a full one.
let stamped = false;

const fullReadEveryMs = 60_000;

// How far back each read reaches before the last one. A write stamped just
// before that read but committed just after it is still picked up.
const readOverlap = "2 minutes";

function tablesOf(row: SourceRow): string[] {
	if (row.kind === "metric_view") {
		return Array.isArray(row.base_tables) ? row.base_tables : [];
	}
	return [`${row.catalog_name}.${row.schema_name}.${row.object_name}`];
}

function toMark(row: SourceRow): Mark {
	return {
		mode: row.freshness_mode === "checked" ? "checked" : "timer",
		changedOn: row.data_changed_on ? Date.parse(row.data_changed_on) : 0,
		hasRowFilter: row.has_row_filter,
		tables: tablesOf(row),
	};
}

// Called after every read, so what depends on these marks learns of a change
// on the same read that brought it.
const listeners = new Set<() => void>();

export function onMarksRead(listener: () => void): void {
	listeners.add(listener);
}

async function readMarks(): Promise<void> {
	const full =
		!stamped ||
		readSince === null ||
		Date.now() - fullReadAt >= fullReadEveryMs;
	const since = full ? null : readSince;

	const [sources, checks, trigger] = await Promise.all([
		full
			? sql<SourceRow>(
					`SELECT ${sourceColumns} FROM data_sources WHERE is_active`,
				)
			: sql<SourceRow>(
					`SELECT ${sourceColumns} FROM data_sources
					 WHERE marks_changed_on
					       > $1::timestamptz - interval '${readOverlap}'`,
					[since],
				),
		// Always one row, so the store's clock comes back even when no
		// table was looked at.
		sql<{
			read_on: string;
			table_name: string | null;
			checked_on: string | null;
		}>(
			`SELECT now()::text AS read_on, c.table_name,
			        c.checked_on::text AS checked_on
			 FROM (SELECT 1) AS one
			 LEFT JOIN source_checks c
			   ON c.checked_on IS NOT NULL
			  AND ($1::timestamptz IS NULL
			       OR c.checked_on > $1::timestamptz - interval '${readOverlap}')`,
			[since],
		),
		full
			? sql<{ kept: boolean }>(
					`SELECT EXISTS (
					   SELECT 1 FROM pg_trigger
					   WHERE tgname = 'data_sources_marks_stamp'
					     AND tgrelid = 'data_sources'::regclass
					 ) AS kept`,
				).catch(() => [{ kept: false }])
			: Promise.resolve(null),
	]);

	if (full) {
		const next = new Map<string, Mark>();
		for (const row of sources) next.set(row.source_key, toMark(row));
		marks = next;
		looks = new Map();
	} else {
		for (const row of sources) {
			if (row.is_active) marks.set(row.source_key, toMark(row));
			else marks.delete(row.source_key);
		}
	}
	for (const row of checks) {
		if (row.table_name && row.checked_on) {
			looks.set(row.table_name, Date.parse(row.checked_on));
		}
	}

	if (trigger) stamped = trigger[0]?.kept === true;
	if (full) fullReadAt = Date.now();
	readSince = checks[0]?.read_on ?? null;
	readAt = Date.now();
	for (const listener of listeners) {
		try {
			listener();
		} catch (error) {
			console.warn("A freshness mark listener failed:", error);
		}
	}
}

// One read at a time. A caller arriving during a read gets one more after it,
// since the read under way may have started before the caller's own write.
let reading: Promise<void> | null = null;
let queuedRead: Promise<void> | null = null;

export function refreshMarks(): Promise<void> {
	if (!reading) {
		reading = readMarks().finally(() => {
			reading = null;
		});
		return reading;
	}
	queuedRead ??= reading
		.catch(() => undefined)
		.then(() => {
			queuedRead = null;
			return refreshMarks();
		});
	return queuedRead;
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

// The sources recorded as carrying a row filter or column mask.
export function protectedSources(): string[] {
	const keys: string[] = [];
	for (const [key, mark] of marks) if (mark.hasRowFilter) keys.push(key);
	return keys;
}

// When the least recently looked at table behind the source was looked at, or
// zero when any of them has never been.
function lookedOn(mark: Mark): number {
	if (mark.tables.length === 0) return 0;
	let oldest = Number.POSITIVE_INFINITY;
	for (const table of mark.tables) {
		const at = looks.get(table);
		if (at === undefined) return 0;
		oldest = Math.min(oldest, at);
	}
	return oldest;
}

// Whether a watched source has gone longer than its interval without a look,
// which happens while the warehouse is stopped and the pass skips it.
export function overdue(sourceKey: string, intervalSeconds: number): boolean {
	const mark = marks.get(sourceKey);
	if (!mark || mark.mode !== "checked") return false;
	return Date.now() - lookedOn(mark) > intervalSeconds * 2 * 1000;
}

// When a source was last looked at, as one SQL expression over a data_sources
// row. That is the oldest look at any table it reads, or null when any has
// never been looked at.
export function lookedOnSql(alias: string): string {
	return `(SELECT CASE WHEN bool_and(c.checked_on IS NOT NULL)
	                     THEN min(c.checked_on) END
	 FROM jsonb_array_elements_text(
	        CASE WHEN ${alias}.kind = 'metric_view'
	             THEN coalesce(${alias}.base_tables, '[]'::jsonb)
	             ELSE jsonb_build_array(${alias}.catalog_name || '.' ||
	                                    ${alias}.schema_name || '.' ||
	                                    ${alias}.object_name)
	        END) AS t(name)
	 LEFT JOIN source_checks c ON c.table_name = t.name)`;
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
		`SELECT d.source_key, d.freshness_mode, d.freshness_note,
		        ${lookedOnSql("d")}::text AS checked_on,
		        d.data_changed_on::text AS data_changed_on
		 FROM data_sources d WHERE d.is_active`,
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
