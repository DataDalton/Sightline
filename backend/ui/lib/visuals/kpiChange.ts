import type { FormatHint } from "../format";
import { relativeChange } from "../query/compare";

// How a scorecard reads a figure against an earlier one. Shared by the tile and the PDF, so
// paper and screen say the same thing.

// A growth measure carries its own sign, so a tile colours it without anyone
// configuring a rule. Everything else stays neutral: colouring an absolute
// figure implies a judgement the data does not support.
export function isSigned(name: string): boolean {
	const n = name.toLowerCase();
	return n.includes("growth") || n.includes("variance") || n.includes(" vs ");
}

export interface KpiChange {
	// A share of the earlier figure, or percentage points for a percentage.
	change: number;
	inPoints: boolean;
	absolute: number;
}

// A measure already carrying its own sign shows none, since a delta under a delta gives a
// tile two changes and no way to tell which is which.
export function kpiChange(
	name: string,
	hint: FormatHint,
	current: number | null,
	previous: number | null,
): KpiChange | null {
	if (isSigned(name) || current === null || previous === null) return null;
	const absolute = current - previous;
	// A percentage already is a share, so its change is the difference in
	// percentage points. A relative change of a rate reads as a second
	// percentage and is easily taken for the points.
	const inPoints = hint === "percent";
	const change = inPoints ? absolute : relativeChange(current, previous);
	return change === null ? null : { change, inPoints, absolute };
}

export function kpiChangeWords(held: KpiChange): string {
	const { change, inPoints } = held;
	const sign = change > 0 ? "+" : "-";
	if (inPoints) {
		return Math.abs(change) < 0.05
			? "no change"
			: `${sign}${Math.abs(change).toFixed(1)} pts`;
	}
	return Math.abs(change * 100) < 0.05
		? "no change"
		: `${sign}${Math.abs(change * 100).toFixed(1)}%`;
}
