import { formatCompact, type FormatHint } from "../format";
import type { ComparePeriod, DateClause } from "../query/compare";
import { isFilterVisual, optionValue } from "./catalog";
import { kpiChange } from "./kpiChange";
import {
	readTargets,
	targetProgress,
	type KpiTarget,
	type ResolvedTarget,
	type TargetDirection,
} from "./kpiTargets";

// The Briefing form of a report page.
//
// The Analysis form is the page as laid out, a grid of visuals that a reader
// has to connect for themselves. The Briefing reads top to bottom instead, one
// section per measure, and each section says what the measure is, whether it
// is where it should be, compared with what, why it moved and what to do. The
// sections are drafted from the page itself, so every page has a Briefing
// without anybody writing one, and an author adjusts what the draft gets wrong.
//
// Kept free of React and of the network, so the drafting and the judging can be
// tested on their own.

// What an author has changed about a page's Briefing, kept in the page's own
// settings under "briefing".
export interface BriefingSettings {
	// Which way is good, per measure. A KPI target's direction wins over this,
	// since the author set it beside the target.
	directions: Record<string, TargetDirection>;
	// What to do when the measure is off, in the author's words.
	notes: Record<string, string>;
	// A headline written by the author in place of the drafted one. It may
	// carry live values in double braces, as live text does.
	headlines: Record<string, string>;
	// Measures left out of the Briefing.
	hidden: string[];
	// The author's order. Empty puts the measures that need attention first.
	order: string[];
}

export const emptyBriefingSettings: BriefingSettings = {
	directions: {},
	notes: {},
	headlines: {},
	hidden: [],
	order: [],
};

function textRecord(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string" && value.trim() !== "")
			out[key] = value.trim();
	}
	return out;
}

function textList(raw: unknown): string[] {
	return Array.isArray(raw)
		? raw.filter((v): v is string => typeof v === "string")
		: [];
}

// The settings a page holds, keeping only entries the Briefing can use.
export function readBriefingSettings(raw: unknown): BriefingSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return emptyBriefingSettings;
	const held = raw as Record<string, unknown>;
	const directions: Record<string, TargetDirection> = {};
	for (const [key, value] of Object.entries(textRecord(held.directions))) {
		if (value === "higher" || value === "lower") directions[key] = value;
	}
	return {
		directions,
		notes: textRecord(held.notes),
		headlines: textRecord(held.headlines),
		hidden: textList(held.hidden),
		order: textList(held.order),
	};
}

// --- Drafting sections ----------------------------------------------------------

export interface PlannedVisual {
	visualId: string;
	visualType: string;
	sourceKey?: string | null;
	config?: {
		dimensions?: unknown;
		measures?: unknown;
		options?: Record<string, unknown>;
	};
}

// One section before any figures are known.
export interface SectionPlan {
	measure: string;
	sourceKey: string;
	// The visual whose filters and settings the section's figures follow. A KPI
	// tile row when the measure has one, otherwise the first chart showing it.
	anchorId: string;
	// Every measure the anchor asks for, so the section's question is the same
	// one the anchor asks and the page answers it once.
	anchorMeasures: string[];
	// The date field the anchor compares on, and the earlier window it names.
	compareField: string | null;
	compareTo: ComparePeriod | null;
	target: KpiTarget | null;
	// Charts on the page that show this measure, drawn beside the figures.
	supporting: string[];
}

// Visuals that are not charts of a measure, so never a section's detail.
const notDetail = new Set(["kpiRow", "group", "textPanel", "paceTile"]);

function names(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];
}

// How many charts sit beside a section's figures. More than this and the
// section stops reading as one point.
export const maxSupporting = 2;

// The sections a page drafts, in page order. Each measure on the page's KPI
// tiles is one section. A page with no KPI tiles takes the first measure of
// each chart instead, so it still gets a Briefing.
export function planSections(
	visuals: PlannedVisual[],
	pageSourceKey: string | null,
): SectionPlan[] {
	const sourceOf = (v: PlannedVisual) => v.sourceKey || pageSourceKey || "";
	const charts = visuals.filter(
		(v) =>
			!notDetail.has(v.visualType) &&
			!isFilterVisual(v.visualType) &&
			names(v.config?.measures).length > 0,
	);
	const plans: SectionPlan[] = [];
	const seen = new Set<string>();
	const add = (
		anchor: PlannedVisual,
		measure: string,
		anchorMeasures: string[],
	) => {
		const sourceKey = sourceOf(anchor);
		const key = `${sourceKey}|${measure}`;
		if (!sourceKey || seen.has(key)) return;
		seen.add(key);
		const isKpi = anchor.visualType === "kpiRow";
		const compareField = isKpi
			? (optionValue<string>("kpiRow", anchor.config, "compareField") ??
				null)
			: null;
		const compareTo = isKpi
			? (optionValue<ComparePeriod>(
					"kpiRow",
					anchor.config,
					"compareTo",
				) ?? null)
			: null;
		const targets = isKpi
			? readTargets(optionValue("kpiRow", anchor.config, "targets"))
			: {};
		plans.push({
			measure,
			sourceKey,
			anchorId: anchor.visualId,
			anchorMeasures,
			compareField: compareField || null,
			compareTo: compareTo || null,
			target: targets[measure] ?? null,
			supporting: charts
				.filter(
					(c) =>
						sourceOf(c) === sourceKey &&
						names(c.config?.measures).includes(measure),
				)
				.slice(0, maxSupporting)
				.map((c) => c.visualId),
		});
	};

	const kpis = visuals.filter((v) => v.visualType === "kpiRow");
	for (const kpi of kpis) {
		const measures = names(kpi.config?.measures);
		for (const measure of measures) add(kpi, measure, measures);
	}
	if (plans.length === 0) {
		for (const chart of charts) {
			const measures = names(chart.config?.measures);
			add(chart, measures[0], [measures[0]]);
		}
	}
	return plans;
}

// --- The window a section is judged over ----------------------------------------

// The date field a set of filters bounds on both ends, if any.
export function windowField(filters: DateClause[]): string | null {
	for (const clause of filters) {
		if (clause.op !== "gte" && clause.op !== "gt") continue;
		const closes = filters.some(
			(c) =>
				c.field === clause.field && (c.op === "lt" || c.op === "lte"),
		);
		if (closes && clause.value) return clause.field;
	}
	return null;
}

function addDays(iso: string, days: number): string {
	const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

// The window cut off at today when it runs past it.
//
// A month in progress holds half a month of data. Compared with whole earlier
// months it always reads as low, which is the clock rather than the business.
// Cut at today, every earlier window shifted from it is cut the same way, so
// the comparison is like with like. Null when the window does not run past
// today, which leaves the filters as they are.
export function settledWindow(
	filters: DateClause[],
	field: string,
	today: string,
): DateClause[] | null {
	const end = filters.find(
		(c) => c.field === field && (c.op === "lt" || c.op === "lte"),
	);
	const start = filters.find(
		(c) => c.field === field && (c.op === "gte" || c.op === "gt"),
	);
	if (!end?.value || !start?.value) return null;
	const tomorrow = addDays(today, 1);
	const endsAfter =
		end.op === "lt"
			? end.value.slice(0, 10) > tomorrow
			: end.value.slice(0, 10) > today;
	if (!endsAfter || start.value.slice(0, 10) > today) return null;
	return filters.map((c) =>
		c === end ? { ...c, op: "lt", value: tomorrow } : c,
	);
}

// How many earlier windows make the usual range. Enough for a median to mean
// something, few enough to stay recent.
export const usualWindows = 6;

function monthStart(iso: string, back: number): string {
	const date = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
	date.setUTCMonth(date.getUTCMonth() - back);
	return date.toISOString().slice(0, 10);
}

// The last full month as a window on a date field, for a page that shows all
// dates. A total over all time has nothing to be compared with, while the
// latest month against the months before it is what a reader wants to know.
// The month in progress is left out, since half a month always reads as low.
export function lastFullMonth(
	filters: DateClause[],
	field: string,
	today: string,
): DateClause[] {
	return [
		...filters,
		{ field, op: "gte", value: monthStart(today, 1) },
		{ field, op: "lt", value: monthStart(today, 0) },
	];
}

// A month window's name, such as "October 2026".
export function monthName(filters: DateClause[], field: string): string | null {
	const from = filters.find((c) => c.field === field && c.op === "gte");
	if (!from?.value) return null;
	return new Date(
		`${from.value.slice(0, 7)}-01T00:00:00Z`,
	).toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}

// --- Judging --------------------------------------------------------------------

export type SectionTone = "bad" | "warn" | "good" | "neutral";

export interface Verdict {
	tone: SectionTone;
	// A few words for the status label.
	label: string;
	// The drafted headline, a whole sentence about the measure.
	sentence: string;
	// What it was compared with, in words.
	comparedWith: string;
	// What it was judged against.
	basis: "target" | "usual" | "previous" | "none";
	// Worth explaining and worth putting first. A figure outside its usual
	// range is off even when nobody has said which way is good.
	off: boolean;
}

export interface JudgeInput {
	label: string;
	hint: FormatHint;
	value: number | null;
	target: ResolvedTarget | null;
	// Where a relative target came from, such as "last year +10%".
	targetBasis: string | null;
	// The figures for the same window over earlier periods, oldest first.
	earlier: number[];
	// The comparison the anchor makes, and what to call it.
	previous: number | null;
	previousLabel: string | null;
	// What one window is called when it is a calendar unit, such as
	// "month", so the usual range reads as "a usual month".
	periodNoun?: string | null;
	direction: TargetDirection | null;
}

// How far a figure is from another, in words, such as "12% above" or
// "3.1 pts below". A percentage measure is in points, so its gap is points.
function gapWords(
	value: number,
	from: number,
	hint: FormatHint,
): { amount: string; above: boolean; words: string; size: number } | null {
	if (hint === "percent") {
		const points = value - from;
		if (Math.abs(points) < 0.05) return null;
		const amount = `${Math.abs(points).toFixed(1)} pts`;
		return {
			amount,
			above: points > 0,
			words: `${amount} ${points > 0 ? "above" : "below"}`,
			size: Math.abs(points) / 100,
		};
	}
	if (from === 0) return null;
	const share = (value - from) / Math.abs(from);
	const percent = Math.round(Math.abs(share) * 100);
	if (percent === 0) return null;
	return {
		amount: `${percent}%`,
		above: share > 0,
		words: `${percent}% ${share > 0 ? "above" : "below"}`,
		size: Math.abs(share),
	};
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

// How many earlier windows the usual range needs before it says anything.
export const minUsualWindows = 3;

// The usual figure and the range around it, from earlier windows. The range is
// the middle of what those windows came to, widened a little so ordinary
// wobble does not read as news.
export function usualRange(
	earlier: number[],
): { usual: number; low: number; high: number } | null {
	if (earlier.length < minUsualWindows) return null;
	const usual = median(earlier);
	const spread = 1.4826 * median(earlier.map((v) => Math.abs(v - usual)));
	const half = Math.max(1.5 * spread, 0.05 * Math.abs(usual));
	const low = earlier.every((v) => v >= 0)
		? Math.max(0, usual - half)
		: usual - half;
	return { usual, low, high: usual + half };
}

// A move this large on the comparison alone counts as worth explaining, when
// there is no target and too little history for a usual range.
export const notablePreviousShare = 0.1;

export function judge(input: JudgeInput): Verdict {
	const { label, hint, value, direction } = input;
	const show = (n: number) => formatCompact(n, hint);
	if (value === null || !Number.isFinite(value)) {
		return {
			tone: "neutral",
			label: "No figure",
			sentence: `${label} has no figure for this period.`,
			comparedWith: "There is nothing to compare yet.",
			basis: "none",
			off: false,
		};
	}

	// Against a target, which an author set and which says which way is good.
	if (input.target) {
		const progress = targetProgress(value, input.target, hint);
		if (progress) {
			const higher = input.target.direction === "higher";
			const gap = gapWords(value, input.target.value, hint);
			const tone: SectionTone =
				progress.status === "good"
					? "good"
					: progress.status === "warn"
						? "warn"
						: "bad";
			const where = gap
				? `${gap.words} its target of ${show(input.target.value)}`
				: `on its target of ${show(input.target.value)}`;
			return {
				tone,
				label:
					tone === "good"
						? "On track"
						: tone === "warn"
							? "Close to target"
							: higher
								? "Behind target"
								: "Over target",
				sentence: `${label} is ${show(value)}, ${where}.`,
				comparedWith: `Its target is ${show(input.target.value)}${
					input.targetBasis ? ` (${input.targetBasis})` : ""
				}, and ${higher ? "higher" : "lower"} is better.`,
				basis: "target",
				off: tone !== "good",
			};
		}
	}

	// Against what the same window usually comes to.
	const range = usualRange(input.earlier);
	if (range) {
		const above = value > range.high;
		const below = value < range.low;
		const gap = gapWords(value, range.usual, hint);
		const goodWay =
			direction === "higher"
				? above
				: direction === "lower"
					? below
					: null;
		const badWay =
			direction === "higher"
				? below
				: direction === "lower"
					? above
					: null;
		const tone: SectionTone = goodWay ? "good" : badWay ? "bad" : "neutral";
		const noun = input.periodNoun;
		const comparedWith = noun
			? `Usually ${show(range.usual)} a ${noun}, normally between ${show(range.low)} and ${show(range.high)}, from the ${input.earlier.length} ${noun}s before.`
			: `Usually ${show(range.usual)} for a period this long, normally between ${show(range.low)} and ${show(range.high)}, from the ${input.earlier.length} periods before.`;
		if (!above && !below) {
			return {
				tone: direction ? "good" : "neutral",
				label: "As usual",
				sentence: `${label} is ${show(value)}, within its usual range.`,
				comparedWith,
				basis: "usual",
				off: false,
			};
		}
		return {
			tone,
			label: above ? "Higher than usual" : "Lower than usual",
			sentence: `${label} is ${show(value)}, ${gap ? `${gap.words} usual` : above ? "above usual" : "below usual"}.`,
			comparedWith:
				direction === null
					? `${comparedWith} Nobody has said yet whether higher is better.`
					: comparedWith,
			basis: "usual",
			off: true,
		};
	}

	// Against the earlier window the anchor names.
	if (input.previous !== null && input.previousLabel) {
		// A measure carrying its own sign, such as a growth rate, has no
		// change of its own to report, as on its tile.
		const comparable =
			kpiChange(label, hint, value, input.previous) !== null;
		const gap = comparable ? gapWords(value, input.previous, hint) : null;
		const notable = (gap?.size ?? 0) >= notablePreviousShare;
		const tone: SectionTone =
			!gap || direction === null
				? "neutral"
				: (direction === "higher") === gap.above
					? "good"
					: "bad";
		const period = input.previousLabel;
		return {
			tone,
			label: !gap ? "Unchanged" : gap.above ? "Up" : "Down",
			sentence: gap
				? `${label} is ${show(value)}, ${gap.above ? "up" : "down"} ${gap.amount} on ${period}.`
				: `${label} is ${show(value)}, about the same as ${period}.`,
			comparedWith: `${period[0].toUpperCase()}${period.slice(1)} came to ${show(input.previous)}.`,
			basis: "previous",
			off: notable && tone !== "good",
		};
	}

	return {
		tone: "neutral",
		label: "Not compared",
		sentence: `${label} is ${show(value)}.`,
		comparedWith:
			"There is no target, and no date range to compare with an earlier period.",
		basis: "none",
		off: false,
	};
}

// --- Order and folding ----------------------------------------------------------

const toneRank: Record<SectionTone, number> = {
	bad: 0,
	warn: 1,
	neutral: 2,
	good: 3,
};

// Sections in the order they read. The author's order when there is one, with
// anything new after it. Otherwise what needs attention first, then what is
// unusual without a known direction, then the rest, keeping page order within
// each.
export function orderSections<T extends { measure: string; verdict: Verdict }>(
	sections: T[],
	order: string[],
): T[] {
	if (order.length > 0) {
		const at = (m: string) => {
			const i = order.indexOf(m);
			return i === -1 ? order.length : i;
		};
		return sections
			.map((s, i) => ({ s, i }))
			.sort((a, b) => at(a.s.measure) - at(b.s.measure) || a.i - b.i)
			.map(({ s }) => s);
	}
	const rank = (v: Verdict) =>
		v.tone === "neutral" && v.off ? 1.5 : toneRank[v.tone];
	return sections
		.map((s, i) => ({ s, i }))
		.sort((a, b) => rank(a.s.verdict) - rank(b.s.verdict) || a.i - b.i)
		.map(({ s }) => s);
}

// Whether a section starts folded to its headline. Anything worth a look stays
// open, and what is fine says so in one line.
export function startsFolded(verdict: Verdict): boolean {
	// With nothing to compare, the figure and its charts are all there is,
	// so they stay in view rather than folding behind "Not compared".
	if (verdict.basis === "none") return false;
	return !verdict.off && verdict.tone !== "bad" && verdict.tone !== "warn";
}

// --- Why ------------------------------------------------------------------------

export interface DriverMember {
	value: unknown;
	change: number;
	share: number | null;
}

// The one line that says what moved a figure, from the largest member of the
// strongest breakdown, such as "Mostly West (Region), up 1.2M, 70% of the
// change".
export function whyLine(
	dimensionLabel: string,
	member: DriverMember,
	hint: FormatHint,
): string {
	const amount = formatCompact(Math.abs(member.change), hint);
	const share =
		member.share !== null && Number.isFinite(member.share)
			? `, ${Math.round(Math.abs(member.share) * 100)}% of the change`
			: "";
	return `Mostly ${String(member.value)} (${dimensionLabel}), ${member.change >= 0 ? "up" : "down"} ${amount}${share}.`;
}
