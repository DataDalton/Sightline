import {
	defaultAnomaly,
	periodEnd,
	periodKey,
	readAnomalies,
	spacingDays,
	targetPeriod,
	type AnomalySettings,
} from "../alerts/anomaly";
import {
	ageOf,
	defaultSettleHours,
	observedBucket,
	type Settling,
	type Waiting,
} from "../alerts/completeness";
import { toNumber } from "../format";

// One figure as the briefing shows it, worked out from its history.
//
// Pure, so the judgement can be tested with rows written out by hand. The
// figure is the latest period that has finished and loaded, judged as an
// unusual alert judges it, against the same weekday in recent weeks for a
// daily field, and against the months just before for anything coarser. A low
// figure in a period still filling in is an early signal rather than
// unusual. See lib/alerts/completeness.

export interface Point {
	period: string;
	value: number;
	// Not settled yet, or not loaded yet, so it may still change.
	pending?: boolean;
}

export interface Driver {
	dimension: string;
	member: string;
	// The member's own change, and its part of the whole change.
	change: number;
	share: number | null;
}

export interface Card {
	id: string;
	period: string;
	// Whole days between periods, one for a daily field.
	spacing: number;
	value: number;
	usual: number | null;
	low: number | null;
	high: number | null;
	// Confirmed outside its usual range.
	unusual: boolean;
	// Far below where it usually is by now, in a period that may still be
	// filling in. Never set together with unusual.
	early?: boolean;
	// How the judgement was reached, so the card can say why.
	settling?: Settling | null;
	// Later periods whose load has not landed. The card judges the latest
	// period that has.
	waiting?: Waiting | null;
	// Distance from usual as a fraction of usual, signed.
	againstUsual: number | null;
	// The period compared with when finding what moved, and its value.
	previousPeriod: string | null;
	previous: number | null;
	series: Point[];
	driver: Driver | null;
	// The two windows, as filters, for opening the full breakdown.
	window: { gte: string; lt: string };
	previousWindow: { gte: string; lt: string } | null;
	// How much the card asks for attention, for ordering.
	weight: number;
}

const day = 86_400_000;

function keyOf(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

export function settingsFor(
	timeField: string,
	spacing: number,
): AnomalySettings {
	return spacing <= 1
		? defaultAnomaly(timeField)
		: { ...defaultAnomaly(timeField), compareTo: "recent", periods: 6 };
}

// How many points the sparkline shows.
export function pointsFor(spacing: number): number {
	return spacing <= 1 ? 42 : 13;
}

// How far back the history is read, as a date, so the sparkline and the
// usual range both have enough behind them.
export function historyStart(target: string, spacing: number): string {
	const span = spacing <= 1 ? 8 * 7 : (pointsFor(spacing) + 2) * spacing;
	return keyOf(Date.parse(`${target}T00:00:00Z`) - span * day);
}

// The latest finished period among these keys, and their spacing.
export function latestFinished(
	keys: string[],
	today: string,
): { target: string; spacing: number } | null {
	const spacing = spacingDays(keys);
	const target = targetPeriod(keys, spacing, today);
	return target ? { target, spacing } : null;
}

// The window one period covers, from its first day to the first day after.
export function windowOf(
	key: string,
	spacing: number,
): { gte: string; lt: string } {
	return { gte: key, lt: keyOf(periodEnd(key, spacing)) };
}

// The period a movement is measured against, which is the same weekday a week before
// for a daily field, the period before for anything coarser.
export function previousOf(
	target: string,
	spacing: number,
	keys: string[],
): string | null {
	if (spacing <= 1) return keyOf(Date.parse(`${target}T00:00:00Z`) - 7 * day);
	const earlier = [...new Set(keys)].filter((k) => k < target).sort();
	return earlier.length ? earlier[earlier.length - 1] : null;
}

// How much a card asks for attention. Confirmed outside usual counts most,
// then an early signal, then how far from usual, so a large move that is
// still within the normal swing ranks under a small one that is not.
export function weightOf(
	card: Pick<Card, "unusual" | "early" | "againstUsual">,
): number {
	const far = Math.min(Math.abs(card.againstUsual ?? 0) * 10, 9);
	if (card.unusual) return 10 + far;
	if (card.early) return 5 + far / 2;
	return far;
}

export function buildCard(
	id: string,
	rows: Record<string, unknown>[],
	options: {
		timeField: string;
		measure: string;
		target: string;
		spacing: number;
		today: string;
		// The last period the sparkline draws, when later periods are read
		// but still waiting for their load.
		through?: string;
	},
): Card | null {
	const { timeField, measure, target, spacing, today } = options;
	const through =
		options.through && options.through > target ? options.through : target;
	const settings = settingsFor(timeField, spacing);
	// Only the judged period and those before it, so a later period still
	// waiting for its load is never judged.
	const judged = rows.filter((row) => {
		const key = periodKey(row[timeField]);
		return key !== null && key <= target;
	});
	const { readings } = readAnomalies(judged, {
		timeField,
		groupBy: null,
		measure,
		settings,
		today,
	});
	const reading = readings[0];
	if (!reading || reading.value === null) return null;

	const byPeriod = new Map<string, number>();
	for (const row of rows) {
		const key = periodKey(row[timeField]);
		const value = toNumber(row[measure]);
		if (key && value !== null && key <= through) byPeriod.set(key, value);
	}
	const series: Point[] = [...byPeriod.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.slice(-pointsFor(spacing))
		.map(([period, value]) =>
			period > target
				? { period, value, pending: true }
				: { period, value },
		);

	const previousPeriod = previousOf(
		target,
		spacing,
		[...byPeriod.keys()].filter((k) => k <= target),
	);
	const previous =
		previousPeriod !== null ? (byPeriod.get(previousPeriod) ?? null) : null;

	const againstUsual =
		reading.usual !== null && reading.usual !== 0
			? (reading.value - reading.usual) / Math.abs(reading.usual)
			: null;

	return {
		id,
		period: target,
		spacing,
		value: reading.value,
		usual: reading.usual,
		low: reading.low,
		high: reading.high,
		unusual: reading.unusual,
		early: false,
		settling: null,
		waiting: null,
		againstUsual,
		previousPeriod,
		previous,
		series,
		driver: null,
		window: windowOf(target, spacing),
		previousWindow:
			previousPeriod !== null ? windowOf(previousPeriod, spacing) : null,
		weight: weightOf({ unusual: reading.unusual, againstUsual }),
	};
}

// The card once it is known whether its period has settled. Points younger
// than the time a period takes to settle are drawn as still changing, along
// with any period waiting for its load.
export function settleCard(
	card: Card,
	judgement: {
		settling: Settling;
		waiting: Waiting | null;
		// Hours after which a period counts as settled.
		settleHours: number;
		timeZone: string;
		now: number;
	},
): Card {
	const { settling, waiting, settleHours, timeZone, now } = judgement;
	const unusual = settling.level === "confirmed";
	const early = settling.level === "early";
	return {
		...card,
		unusual,
		early,
		settling,
		waiting,
		weight: weightOf({ unusual, early, againstUsual: card.againstUsual }),
		series: card.series.map((point) =>
			point.pending ||
			ageOf(point.period, card.spacing, timeZone, now) < settleHours
				? { ...point, pending: true }
				: { period: point.period, value: point.value },
		),
	};
}

// Whether time alone has overtaken a stored card's judgement. Its period has
// grown past the age it was young until, or the load it was waiting for was
// due to have landed.
export function outgrown(card: Card, timeZone: string, now: number): boolean {
	const settling = card.settling;
	if (settling?.young) {
		const limit = settling.settleHours ?? defaultSettleHours(card.spacing);
		if (ageOf(card.period, card.spacing, timeZone, now) >= limit)
			return true;
	}
	const expectedBy = card.waiting?.expectedBy;
	return typeof expectedBy === "number" && now >= expectedBy;
}

// What a card read for each recent period, to learn from how a period fills
// in. Only periods that have ended, and only the latest few, which are the
// ones still changing.
export const observedPoints = 8;

export function observationsOf(
	card: Card,
	computedAt: number,
	timeZone: string,
): { period: string; observedAt: number; ageHours: number; value: number }[] {
	return card.series
		.slice(-observedPoints)
		.map((point) => {
			const ageHours = ageOf(
				point.period,
				card.spacing,
				timeZone,
				computedAt,
			);
			return {
				period: point.period,
				observedAt: observedBucket(computedAt, ageHours),
				ageHours,
				value: point.value,
			};
		})
		.filter((o) => o.ageHours >= 0 && Number.isFinite(o.value));
}

// Whether a card moved enough to be worth saying what moved it. Asked before
// the settling judgement, so it reads what usual alone says.
export function worthExplaining(card: Card): boolean {
	return card.unusual || Math.abs(card.againstUsual ?? 0) >= 0.1;
}

// What one read of the latest periods, newest first, gives a card.
//
// The same read answers which period finished last, how far apart periods
// are, and in nearly every case the whole history the card is drawn from, so
// a card costs one question rather than two. "short" means the read stopped
// before reaching back far enough and the history has to be asked for on its
// own.
export type ProbeReading =
	| { kind: "none" }
	| { kind: "short"; target: string; spacing: number }
	| {
			kind: "ready";
			target: string;
			spacing: number;
			rows: Record<string, unknown>[];
	  };

export function readProbe(
	rows: Record<string, unknown>[],
	timeField: string,
	today: string,
	limit: number,
): ProbeReading {
	const keyed = rows
		.map((row) => ({ row, key: periodKey(row[timeField]) }))
		.filter((r): r is { row: Record<string, unknown>; key: string } =>
			Boolean(r.key),
		);
	const latest = latestFinished(
		keyed.map((r) => r.key),
		today,
	);
	if (!latest) return { kind: "none" };
	const start = historyStart(latest.target, latest.spacing);
	// A read that came back under its limit holds every period there is. One
	// that filled it reached as far back as its oldest row and no further.
	const complete = rows.length < limit;
	const oldest = keyed.reduce(
		(min, r) => (r.key < min ? r.key : min),
		latest.target,
	);
	if (!complete && oldest > start)
		return {
			kind: "short",
			target: latest.target,
			spacing: latest.spacing,
		};
	return {
		kind: "ready",
		target: latest.target,
		spacing: latest.spacing,
		rows: keyed
			.filter((r) => r.key >= start && r.key <= latest.target)
			.map((r) => r.row)
			.reverse(),
	};
}

type Window = { gte: string; lt: string };

// One breakdown read across both windows, grouped by member and period, split
// back into the two windows. Only exact when each window holds one period,
// because a measure such as a rate or a distinct count cannot be added up
// across periods. Anything else answers null and the windows are asked for
// one at a time.
export function splitWindows(
	rows: Record<string, unknown>[],
	timeField: string,
	dimension: string,
	measure: string,
	current: Window,
	previous: Window,
): {
	current: Record<string, unknown>[];
	previous: Record<string, unknown>[];
} | null {
	const sides = {
		current: {
			window: current,
			keys: new Set<string>(),
			rows: [] as Record<string, unknown>[],
		},
		previous: {
			window: previous,
			keys: new Set<string>(),
			rows: [] as Record<string, unknown>[],
		},
	};
	for (const row of rows) {
		const key = periodKey(row[timeField]);
		if (!key) continue;
		for (const side of [sides.current, sides.previous]) {
			if (key < side.window.gte || key >= side.window.lt) continue;
			side.keys.add(key);
			side.rows.push({
				[dimension]: row[dimension],
				[measure]: row[measure],
			});
		}
	}
	if (sides.current.keys.size > 1 || sides.previous.keys.size > 1)
		return null;
	return { current: sides.current.rows, previous: sides.previous.rows };
}

// A figure moving this far from usual counts as on the move.
export const movingAt = 0.1;

export type Standing = "unusual" | "early" | "moving" | "steady";

export function standingOf(card: Card): Standing {
	if (card.unusual) return "unusual";
	if (card.early) return "early";
	// Low only as far as a period this young usually is.
	if (card.settling?.reason === "fillingIn") return "steady";
	return Math.abs(card.againstUsual ?? 0) >= movingAt ? "moving" : "steady";
}

// Which figures the page has room for, chosen once they have been read.
// Anything confirmed outside its usual range comes first, then early signals,
// then anything on the move, each by how much it asks for attention, then
// steady figures in the order given, which is the reader's order of reports.
// So a figure far from usual is shown however rarely its report is opened.
// Answers the chosen entries in the order given.
export function chooseShown<T extends { card: Card }>(
	entries: T[],
	limit: number,
): T[] {
	const rank = (standing: Standing) =>
		entries
			.filter((e) => standingOf(e.card) === standing)
			.sort((a, b) =>
				standing === "steady" ? 0 : b.card.weight - a.card.weight,
			);
	const chosen = new Set(
		[
			...rank("unusual"),
			...rank("early"),
			...rank("moving"),
			...rank("steady"),
		].slice(0, limit),
	);
	return entries.filter((e) => chosen.has(e));
}

// Cards read again knowing every other card in the briefing. When every
// figure that adds up on one dataset fell below its usual range in the same
// young period, a load gap is the likelier reading, so a card confirmed only
// because its load had landed becomes an early signal. A card that one part
// of the figure carries, or one that has settled, keeps its judgement.
// Answers the entries in the order given.
export function alongside<T extends { sourceKey: string; card: Card }>(
	entries: T[],
): T[] {
	const groups = new Map<string, T[]>();
	for (const entry of entries) {
		const s = entry.card.settling;
		if (!s?.additive || !s.young) continue;
		const key = `${entry.sourceKey}|${entry.card.period}`;
		groups.set(key, [...(groups.get(key) ?? []), entry]);
	}
	const together = new Set<T>();
	for (const group of groups.values()) {
		const fell = group.every(
			(e) => e.card.low !== null && e.card.value < e.card.low,
		);
		if (group.length >= 2 && fell) for (const e of group) together.add(e);
	}
	if (together.size === 0) return entries;
	return entries.map((entry) => {
		const s = entry.card.settling;
		if (!together.has(entry) || !s) return entry;
		const softened =
			(s.level === "confirmed" && s.reason === "landed") ||
			(s.level === "early" && s.reason === "noHistory");
		if (!softened) return entry;
		const card: Card = {
			...entry.card,
			unusual: false,
			early: true,
			settling: { ...s, level: "early", reason: "together" },
		};
		return { ...entry, card: { ...card, weight: weightOf(card) } };
	});
}
