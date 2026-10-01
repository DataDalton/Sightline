// Reads a Delta table's history and decides whether its data changed.
//
// Every commit raises the table's version, including ones that touch nothing
// a query would read: compacting files, cleaning up old ones, setting a
// property or a comment. Those are named here and ignored. Anything else
// counts as a change, so an operation this list has not heard of refreshes the
// reports built on the table rather than leaving them showing old figures.

// Commits that leave every row as it was.
const leavesDataAlone = new Set([
	"OPTIMIZE",
	"VACUUM START",
	"VACUUM END",
	"SET TBLPROPERTIES",
	"UNSET TBLPROPERTIES",
	"CHANGE COLUMN",
	"ADD COLUMNS",
	"REPLACE COLUMNS",
	"RENAME COLUMN",
	"DROP COLUMNS",
	"ADD CONSTRAINT",
	"DROP CONSTRAINT",
	"SET TAGS",
	"UNSET TAGS",
	"UPGRADE PROTOCOL",
	"FSCK",
	"REORG",
	"CLUSTER BY",
	"COMPUTE STATISTICS",
	"ANALYZE",
	"SET COMMENT",
	"CREATE TABLE",
]);

export function isDataChange(operation: string): boolean {
	return !leavesDataAlone.has(operation.trim().toUpperCase());
}

export interface HistoryEntry {
	version: number;
	operation: string;
	// When the commit was made, in milliseconds. Tells a table replaced by a
	// new one from the same table carrying on.
	timestamp: number | null;
}

export interface SeenVersion {
	version: number;
	timestamp: number | null;
}

// The newest version, and whether the data changed since the version last
// seen. With nothing seen before, nothing is reported as changed: the first
// look only learns where the table stands.
//
// A dropped and recreated table starts its history again, so its versions
// count up from zero. A version lower than the one last seen is therefore a
// different table, and a change. So is the same version made at a different
// time, which is a new table that happened to reach the same number between
// two looks.
export function readHistory(
	entries: HistoryEntry[],
	lastSeen: SeenVersion | null,
): { latest: SeenVersion | null; changed: boolean } {
	if (entries.length === 0) return { latest: lastSeen, changed: false };
	const newest = entries.reduce((a, b) => (b.version > a.version ? b : a));
	const latest = { version: newest.version, timestamp: newest.timestamp };
	if (lastSeen === null) return { latest, changed: false };

	if (newest.version < lastSeen.version) return { latest, changed: true };
	if (newest.version === lastSeen.version) {
		const replaced =
			lastSeen.timestamp !== null &&
			newest.timestamp !== null &&
			newest.timestamp !== lastSeen.timestamp;
		return { latest, changed: replaced };
	}
	// History is read a page at a time. When more commits landed since the
	// last look than the page holds, the ones between were not seen, and one
	// of them may have changed data.
	const oldest = Math.min(...entries.map((e) => e.version));
	if (oldest > lastSeen.version + 1) return { latest, changed: true };

	const changed = entries.some(
		(e) => e.version > lastSeen.version && isDataChange(e.operation),
	);
	return { latest, changed };
}

// How many commits to read for the page to reach back to the version last
// seen, when the page read fell short of it. Null when it did reach it. A
// load followed by many housekeeping commits, such as a comment set on every
// column, pushes the load itself out of the page, and without reading back
// to it the load is noticed as a change but never timed.
export function commitsSinceSeen(
	entries: HistoryEntry[],
	lastSeen: SeenVersion | null,
): number | null {
	if (entries.length === 0 || lastSeen === null) return null;
	const newest = Math.max(...entries.map((e) => e.version));
	const oldest = Math.min(...entries.map((e) => e.version));
	if (newest <= lastSeen.version || oldest <= lastSeen.version + 1)
		return null;
	return newest - lastSeen.version;
}

// Rows from DESCRIBE HISTORY, in whatever types the warehouse returned them.
export function toHistory(rows: Record<string, unknown>[]): HistoryEntry[] {
	return rows
		.map((row) => {
			const at = row.timestamp ? Date.parse(String(row.timestamp)) : NaN;
			return {
				version: Number(row.version),
				operation: String(row.operation ?? ""),
				timestamp: Number.isFinite(at) ? at : null,
			};
		})
		.filter((e) => Number.isFinite(e.version));
}

// The choices a source offers for how often it is looked at, in seconds. Live
// is a flag of its own, since its interval is a platform setting.
export const checkIntervals = [
	{ seconds: 1800, label: "Every 30 minutes" },
	{ seconds: 3600, label: "Every hour" },
	{ seconds: 6 * 3600, label: "Every 6 hours" },
	{ seconds: 12 * 3600, label: "Every 12 hours" },
	{ seconds: 24 * 3600, label: "Every 24 hours" },
	{ seconds: 7 * 24 * 3600, label: "Weekly" },
];

export const minCheckSeconds = 60;
export const maxCheckSeconds = 7 * 24 * 3600;

export function clampCheckSeconds(seconds: number): number {
	if (!Number.isFinite(seconds) || seconds <= 0) return 0;
	return Math.min(
		Math.max(Math.floor(seconds), minCheckSeconds),
		maxCheckSeconds,
	);
}

// An interval said the way somebody thinks about it.
export function describeInterval(seconds: number): string {
	const preset = checkIntervals.find((c) => c.seconds === seconds);
	if (preset) return preset.label;
	if (seconds % 86400 === 0) {
		const days = seconds / 86400;
		return `Every ${days} day${days === 1 ? "" : "s"}`;
	}
	if (seconds % 3600 === 0) {
		const hours = seconds / 3600;
		return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
	}
	const minutes = Math.round(seconds / 60);
	return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
