import { formatCompact, formatDelta, type FormatHint } from "../format";

// Targets on KPI tiles, and how far each figure is from its own.
//
// An author sets a target per measure along with which way is good, because a
// cost under budget and a revenue under plan are opposite answers to the same
// comparison. The tile shows how far along the figure is as a thin bar and as
// words, and colours both by whether the figure is on track. The words always
// carry the direction, so the tile reads the same without the colour.

export type TargetDirection = "higher" | "lower";

// Periods a target can be taken from, the same moves the comparison makes.
export type TargetPeriod = "year" | "quarter" | "month" | "previous";

export const targetPeriods: TargetPeriod[] = [
	"year",
	"quarter",
	"month",
	"previous",
];

// What a target is measured from. A fixed figure, the same measure over an
// earlier window of the page's date range, or another measure on the same
// source such as a budget.
export type TargetBasis =
	| { kind: "fixed"; value: number }
	| { kind: "period"; period: TargetPeriod }
	| { kind: "measure"; measure: string };

// A target as stored. The change moves a relative basis up or down, either as
// a percentage of it or as an amount in the measure's own units. A fixed
// target carries no change.
export interface KpiTarget {
	basis: TargetBasis;
	change: number;
	changeUnit: "percent" | "amount";
	direction: TargetDirection;
}

// A target once its basis has a figure, which is what progress is judged by.
export interface ResolvedTarget {
	value: number;
	direction: TargetDirection;
}

// Keyed by measure name.
export type KpiTargets = Record<string, KpiTarget>;

export type TargetStatus = "good" | "warn" | "bad";

// How close to the target, as a share of the target, still counts as close
// rather than off track.
export const nearTargetShare = 0.1;

export const targetStatusLabels: Record<TargetStatus, string> = {
	good: "On track",
	warn: "Close to target",
	bad: "Off target",
};

function toFinite(raw: unknown): number {
	if (typeof raw === "number") return raw;
	if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
	return NaN;
}

// The targets an option holds, keeping only entries a tile can use. A stored
// value is whatever was last saved, so a hand-edited or half-filled entry is
// dropped here rather than drawn as a bar against nothing. An entry with a
// figure and no kind is a fixed target.
export function readTargets(raw: unknown): KpiTargets {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: KpiTargets = {};
	for (const [measure, entry] of Object.entries(
		raw as Record<string, unknown>,
	)) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const direction: TargetDirection =
			record.direction === "lower" ? "lower" : "higher";
		const change = toFinite(record.change);
		const changeUnit =
			record.changeUnit === "amount" ? "amount" : "percent";
		const kind = record.kind ?? "fixed";

		let basis: TargetBasis | null = null;
		if (kind === "fixed") {
			const value = toFinite(record.value);
			if (Number.isFinite(value)) basis = { kind: "fixed", value };
		} else if (
			kind === "period" &&
			targetPeriods.includes(record.period as TargetPeriod)
		) {
			basis = { kind: "period", period: record.period as TargetPeriod };
		} else if (
			kind === "measure" &&
			typeof record.measure === "string" &&
			record.measure.trim() !== ""
		) {
			basis = { kind: "measure", measure: record.measure };
		}
		if (!basis) continue;

		out[measure] = {
			basis,
			change:
				basis.kind === "fixed" || !Number.isFinite(change) ? 0 : change,
			changeUnit,
			direction,
		};
	}
	return out;
}

// The figure a target stands at, from the figure its basis came to. Null
// while that figure is not known, so no bar is drawn against a guess.
export function resolveTarget(
	target: KpiTarget,
	base: number | null,
): ResolvedTarget | null {
	if (target.basis.kind === "fixed") {
		return { value: target.basis.value, direction: target.direction };
	}
	if (base === null || !Number.isFinite(base)) return null;
	const value =
		target.changeUnit === "amount"
			? base + target.change
			: base * (1 + target.change / 100);
	return { value, direction: target.direction };
}

const periodWords: Record<TargetPeriod, string> = {
	year: "last year",
	quarter: "last quarter",
	month: "last month",
	previous: "the period before",
};

// Where a target comes from in words, such as "last year +10%" or "Budget".
// Null for a fixed target, whose figure says it all.
export function describeBasis(
	target: KpiTarget,
	hint: FormatHint,
): string | null {
	if (target.basis.kind === "fixed") return null;
	const base =
		target.basis.kind === "period"
			? periodWords[target.basis.period]
			: target.basis.measure;
	if (target.change === 0) return base;
	const sign = target.change > 0 ? "+" : "-";
	const size = Math.abs(target.change);
	const amount =
		target.changeUnit === "percent"
			? `${size}%`
			: hint === "percent"
				? `${size} pts`
				: formatCompact(size, hint);
	return `${base} ${sign}${amount}`;
}

export interface TargetProgress {
	status: TargetStatus;
	// How much of the bar to fill, from zero to one.
	fill: number;
	// The distance from the target in words, such as "82% of target".
	text: string;
	// The target itself and which way is good, for a tooltip.
	title: string;
}

function clamp(value: number): number {
	return Math.min(1, Math.max(0, value));
}

// How far a figure is from its target.
//
// A percentage measure holds percentage points, so its distance is the gap in
// points rather than a percentage of a percentage, which reads as the points
// and is not. Anything else with a positive target is described as a share of
// it. A target of zero or below, or a negative figure, has no meaningful
// share, so those fall back to the signed gap in the measure's own units.
export function targetProgress(
	actual: number | null,
	target: ResolvedTarget,
	hint: FormatHint,
): TargetProgress | null {
	if (actual === null || !Number.isFinite(actual)) return null;
	if (!Number.isFinite(target.value)) return null;

	const higher = target.direction === "higher";
	const gap = actual - target.value;
	// Positive when the figure is on the wrong side of the target.
	const shortfall = higher ? -gap : gap;
	const band = Math.abs(target.value) * nearTargetShare;
	const judged: TargetStatus =
		shortfall <= 0 ? "good" : shortfall <= band ? "warn" : "bad";
	// A figure the words call on target is coloured as on target, so the
	// colour never disagrees with the text beside it.
	const statusFor = (text: string): TargetStatus =>
		text === "On target" ? "good" : judged;

	const title = `Target ${formatCompact(target.value, hint)}, ${
		higher ? "higher" : "lower"
	} is better`;

	if (hint === "percent") {
		const points = Math.abs(gap);
		const text =
			points < 0.05
				? "On target"
				: `${gap > 0 ? "+" : "-"}${points.toFixed(1)} pts vs target`;
		const status = statusFor(text);
		const fill =
			target.value > 0
				? clamp(actual / target.value)
				: status === "good"
					? 1
					: 0;
		return { status, fill, text, title };
	}

	if (target.value > 0 && actual >= 0) {
		const ratio = actual / target.value;
		let text: string;
		if (ratio >= 1) {
			const over = Math.round((ratio - 1) * 100);
			text = over === 0 ? "On target" : `${over}% over target`;
		} else {
			// Rounded down, so a figure just short is never reported as
			// having reached the target.
			text = `${Math.floor(ratio * 100)}% of target`;
		}
		return { status: statusFor(text), fill: clamp(ratio), text, title };
	}

	const text =
		gap === 0 ? "On target" : `${formatDelta(gap, hint)} vs target`;
	const status = statusFor(text);
	return { status, fill: status === "good" ? 1 : 0, text, title };
}
