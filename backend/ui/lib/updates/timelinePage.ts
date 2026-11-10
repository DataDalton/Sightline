import { timelineDate, type Update } from "./model";

// One page of the timeline, searched and filtered over everything the reader can see, so a
// search finds entries that are not loaded yet. Pages follow a cursor rather than an offset,
// so an entry posted while someone scrolls does not shift or repeat what they already have.

export interface TimelineQuery {
	term?: string;
	type?: string;
	impact?: string;
	// The cursor of the last entry already shown, from the previous page's next.
	after?: string | null;
	limit?: number;
}

export interface TimelinePage<T> {
	items: T[];
	// Where the next page starts, or null on the last page.
	next: string | null;
	// How many entries match the search and filters across every page.
	total: number;
}

export const defaultPageSize = 30;
const largestPageSize = 100;

function timeOf(update: Update): number {
	return new Date(timelineDate(update)).getTime();
}

// Newest first, with the id breaking ties so two entries at the same moment keep one order.
function newestFirst(a: Update, b: Update): number {
	return (
		timeOf(b) - timeOf(a) ||
		(a.updateId < b.updateId ? 1 : a.updateId > b.updateId ? -1 : 0)
	);
}

export function cursorOf(update: Update): string {
	return `${timeOf(update)}_${update.updateId}`;
}

// Whether an entry comes after the cursor in timeline order.
function isAfter(update: Update, cursor: string): boolean {
	const split = cursor.indexOf("_");
	const time = Number(cursor.slice(0, split));
	const id = cursor.slice(split + 1);
	if (split < 0 || !Number.isFinite(time)) return true;
	const own = timeOf(update);
	return own < time || (own === time && update.updateId < id);
}

// The text a search looks through. Old names of renamed fields count, since readers still
// know a field by the name it had.
export function matchesTerm(update: Update, term: string): boolean {
	const needle = term.trim().toLowerCase();
	if (!needle) return true;
	return [
		update.title,
		update.body,
		update.reference ?? "",
		update.whatToDo ?? "",
		...update.tags,
		...update.about.flatMap((item) =>
			item.from ? [item.id, item.from] : [item.id],
		),
	]
		.join(" ")
		.toLowerCase()
		.includes(needle);
}

export function timelinePage<T extends Update>(
	updates: T[],
	query: TimelineQuery,
): TimelinePage<T> {
	const limit = Math.min(
		Math.max(1, Math.floor(query.limit ?? defaultPageSize)),
		largestPageSize,
	);
	const matching = updates
		.filter(
			(update) =>
				(!query.type || update.type === query.type) &&
				(!query.impact || update.impact === query.impact) &&
				matchesTerm(update, query.term ?? ""),
		)
		.sort(newestFirst);
	const after = query.after;
	const remaining = after
		? matching.filter((update) => isAfter(update, after))
		: matching;
	const items = remaining.slice(0, limit);
	return {
		items,
		next:
			remaining.length > limit ? cursorOf(items[items.length - 1]) : null,
		total: matching.length,
	};
}
