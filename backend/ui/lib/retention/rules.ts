// What retention does to one personal item, decided from when it was last
// used, whether anything still reads it, whether its owner kept it, and the
// period an administrator set. No database and no clock of its own, so every
// decision can be checked against a fixed date.
//
// The order is always the same. An item is warned first, removed to the bin no
// sooner than a full warning period after that, and deleted for good once it
// has sat in the bin for the bin period. Using it at any point moves its due
// date, and the warning sent for the old date no longer counts.

export type RetentionKind = "page" | "sheet" | "board" | "exploreView";

export const retentionKinds: RetentionKind[] = [
	"page",
	"sheet",
	"board",
	"exploreView",
];

export function isRetentionKind(value: unknown): value is RetentionKind {
	return retentionKinds.includes(value as RetentionKind);
}

// How long before removal the owner is told, and the least time between that
// warning and the removal it announces.
export const warningLeadDays = 30;

// How long a removed item waits in the bin, restorable by its owner, before it
// is deleted for good.
export const binDays = 30;

const dayMs = 24 * 60 * 60 * 1000;

export function addDays(at: Date, days: number): Date {
	return new Date(at.getTime() + days * dayMs);
}

// Calendar months in UTC. A day past the end of the target month lands on its
// last day, so the last day of January plus one month is the last day of
// February rather than a day in March.
export function addMonths(at: Date, months: number): Date {
	const year = at.getUTCFullYear();
	const month = at.getUTCMonth() + months;
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return new Date(
		Date.UTC(
			year,
			month,
			Math.min(at.getUTCDate(), lastDay),
			at.getUTCHours(),
			at.getUTCMinutes(),
			at.getUTCSeconds(),
			at.getUTCMilliseconds(),
		),
	);
}

// The calendar date a warning is recorded against, so the same due date is
// never announced twice.
export function dayKey(at: Date): string {
	return at.toISOString().slice(0, 10);
}

// The latest of several moments that each count as use, ignoring any that are
// absent or unreadable.
export function latestUse(
	...moments: (Date | string | null | undefined)[]
): Date | null {
	let latest: number | null = null;
	for (const moment of moments) {
		if (moment === null || moment === undefined) continue;
		const time = (
			moment instanceof Date ? moment : new Date(moment)
		).getTime();
		if (Number.isNaN(time)) continue;
		if (latest === null || time > latest) latest = time;
	}
	return latest === null ? null : new Date(latest);
}

export interface RetentionItem {
	// The latest moment anything counted as use. Null only for an item with
	// no recorded moment at all, which is left alone.
	lastUsed: Date | null;
	// Something still reads it, such as a scheduled delivery or a page alert.
	liveReference: boolean;
	// Its owner marked it to be kept.
	keep: boolean;
	// When it went to the bin, or null while it is in use.
	removedOn: Date | null;
	// Warnings already sent for it, by the due date each announced.
	warnings: { dueOn: string; warnedOn: Date }[];
}

export type RetentionDecision =
	| { action: "none" }
	| { action: "warn"; dueOn: string; removeOn: Date }
	| { action: "remove" }
	| { action: "purge" };

const none: RetentionDecision = { action: "none" };

// When an item last used at the given moment falls due.
export function dueDate(lastUsed: Date, months: number): Date {
	return addMonths(lastUsed, months);
}

// When a removed item leaves the bin for good.
export function purgeDate(removedOn: Date): Date {
	return addDays(removedOn, binDays);
}

export function decide(
	item: RetentionItem,
	months: number,
	now: Date,
): RetentionDecision {
	// Retention off leaves everything where it is, the bin included, so
	// turning it off never deletes anything.
	if (!(months > 0)) return none;

	if (item.removedOn) {
		return now.getTime() >= purgeDate(item.removedOn).getTime()
			? { action: "purge" }
			: none;
	}

	if (item.keep || item.liveReference || !item.lastUsed) return none;

	const due = dueDate(item.lastUsed, months);
	if (now.getTime() < addDays(due, -warningLeadDays).getTime()) return none;

	const dueOn = dayKey(due);
	const warning = item.warnings.find((w) => w.dueOn === dueOn);
	if (!warning) {
		// An item already past its date when first seen still gets the full
		// warning period.
		const earliest = addDays(now, warningLeadDays);
		return {
			action: "warn",
			dueOn,
			removeOn: due.getTime() > earliest.getTime() ? due : earliest,
		};
	}

	const removeAt = Math.max(
		due.getTime(),
		addDays(warning.warnedOn, warningLeadDays).getTime(),
	);
	return now.getTime() >= removeAt ? { action: "remove" } : none;
}

// Assistant conversations are removed quietly once unused for the period,
// with no warning and no bin.
export function conversationExpired(
	modifiedOn: Date,
	months: number,
	now: Date,
): boolean {
	return (
		months > 0 && now.getTime() >= addMonths(modifiedOn, months).getTime()
	);
}

// The moment before which a conversation last changed is expired. Null when
// retention is off.
export function conversationCutoff(months: number, now: Date): Date | null {
	return months > 0 ? addMonths(now, -months) : null;
}

// Last use before this moment makes an item worth looking at today. Anything
// used since cannot be due for a warning or a removal yet. A few days wider
// than the exact rule, since months differ in length, and decide makes the
// exact call on what this lets through.
export function candidateCutoff(months: number, now: Date): Date {
	return addDays(addMonths(now, -months), warningLeadDays + 3);
}

// The words for each kind in a notification and in the bin.
export const kindNoun: Record<RetentionKind, string> = {
	page: "page",
	sheet: "sheet",
	board: "board",
	exploreView: "saved exploration",
};

// Where each kind opens.
export function itemLink(
	kind: RetentionKind,
	id: string,
	slug?: string | null,
): string {
	switch (kind) {
		case "page":
			return `/r/${encodeURIComponent(slug ?? "")}/`;
		case "sheet":
			return `/sheets/${encodeURIComponent(id)}/`;
		case "board":
			return `/boards/${encodeURIComponent(id)}/`;
		case "exploreView":
			return `/explore/?view=${encodeURIComponent(id)}`;
	}
}
