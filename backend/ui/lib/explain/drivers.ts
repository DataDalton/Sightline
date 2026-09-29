import { toNumber } from "../format";

// Where a change in a figure came from.
//
// A figure moved between two periods. Split both periods by one dimension and
// the change splits with them: Europe went from 3.4M to 3.0M, Online from 5.1M
// to 4.8M. For a figure that adds up, such as revenue or orders, the moves of
// the parts add up to the move of the whole, so each part's share of the
// change is exact, and the dimension whose single biggest mover moved most is
// the one that says the most about where the change sits.
//
// A rate or an average does not add up across its parts, so a part's move is
// its own figure changing, and the parts' moves say which parts changed
// without summing to the whole. Which kind a figure is, is read from the data
// rather than from its name. If the parts of one period sum to the whole, it
// adds up.
//
// Nothing here says why. It says where, which is the question that comes
// before why and the one the data can answer.
//
// Pure, so every rule here can be tested with rows written out by hand.

export interface MemberChange {
	value: string;
	current: number | null;
	previous: number | null;
	change: number;
	// The part of the whole's change, as a fraction, for a figure that adds up.
	share: number | null;
}

export interface Breakdown {
	dimension: string;
	// The biggest movers, largest first.
	members: MemberChange[];
	// How many other values there were, and what they moved together.
	othersCount: number;
	othersChange: number;
	// How much of the whole's change the biggest single mover accounts for,
	// used to rank one dimension against another.
	strength: number;
}

// Parts shown for each dimension before the rest are summed up.
export const shownMembers = 5;

function label(value: unknown): string {
	return value === null || value === undefined || value === ""
		? "(blank)"
		: String(value);
}

function byValue(
	rows: Record<string, unknown>[],
	dimension: string,
	measure: string,
): Map<string, number | null> {
	const out = new Map<string, number | null>();
	for (const row of rows) {
		out.set(label(row[dimension]), toNumber(row[measure]));
	}
	return out;
}

// Whether a figure adds up, meaning its parts in one period sum to its whole, within
// rounding.
export function addsUp(
	total: number | null,
	rows: Record<string, unknown>[],
	measure: string,
): boolean {
	if (total === null) return false;
	const sum = rows.reduce(
		(acc, row) => acc + (toNumber(row[measure]) ?? 0),
		0,
	);
	const tolerance = Math.max(Math.abs(total) * 0.005, 1e-9);
	return Math.abs(sum - total) <= tolerance;
}

export function breakdown(
	dimension: string,
	currentRows: Record<string, unknown>[],
	previousRows: Record<string, unknown>[],
	measure: string,
	totalChange: number,
	additive: boolean,
): Breakdown {
	const now = byValue(currentRows, dimension, measure);
	const before = byValue(previousRows, dimension, measure);
	const values = new Set([...now.keys(), ...before.keys()]);

	const members: MemberChange[] = [];
	for (const value of values) {
		const current = now.get(value) ?? null;
		const previous = before.get(value) ?? null;
		// A part that is new or gone moved from or to nothing, when the figure
		// adds up. For a rate there is no before or after to compare.
		if (!additive && (current === null || previous === null)) continue;
		const change = (current ?? 0) - (previous ?? 0);
		members.push({
			value,
			current,
			previous,
			change,
			share: additive && totalChange !== 0 ? change / totalChange : null,
		});
	}
	members.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

	const shown = members.slice(0, shownMembers);
	const rest = members.slice(shownMembers);
	const top = Math.abs(shown[0]?.change ?? 0);
	const scale = additive
		? Math.abs(totalChange)
		: Math.max(...members.map((m) => Math.abs(m.change)), 0);

	return {
		dimension,
		members: shown,
		othersCount: rest.length,
		othersChange: rest.reduce((acc, m) => acc + m.change, 0),
		strength: scale > 0 ? Math.min(top / scale, 1) : 0,
	};
}

// The dimensions that say most about the change first. A dimension where one
// value moved by most of the change beats one where every value moved a
// little, and a dimension with a single value says nothing at all.
export function rankBreakdowns(breakdowns: Breakdown[]): Breakdown[] {
	return breakdowns
		.filter((b) => b.members.length + b.othersCount > 1)
		.sort((a, b) => b.strength - a.strength);
}
