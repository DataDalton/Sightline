import {
	defaultAnomaly,
	periodEnd,
	periodKey,
	readAnomalies,
	spacingDays,
	targetPeriod,
	type AnomalySettings,
} from "../alerts/anomaly";
import { toNumber } from "../format";

// One figure as the briefing shows it, worked out from its history.
//
// Pure, so the judgement can be tested with rows written out by hand. The
// figure is the latest period that has finished, judged as an unusual alert
// judges it, against the same weekday in recent weeks for a daily field, and
// against the months just before for anything coarser.

export interface Point {
	period: string;
	value: number;
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
	unusual: boolean;
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

export function buildCard(
	id: string,
	rows: Record<string, unknown>[],
	options: {
		timeField: string;
		measure: string;
		target: string;
		spacing: number;
		today: string;
	},
): Card | null {
	const { timeField, measure, target, spacing, today } = options;
	const settings = settingsFor(timeField, spacing);
	const { readings } = readAnomalies(rows, {
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
		if (key && value !== null && key <= target) byPeriod.set(key, value);
	}
	const series = [...byPeriod.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.slice(-pointsFor(spacing))
		.map(([period, value]) => ({ period, value }));

	const previousPeriod = previousOf(target, spacing, [...byPeriod.keys()]);
	const previous =
		previousPeriod !== null ? (byPeriod.get(previousPeriod) ?? null) : null;

	const againstUsual =
		reading.usual !== null && reading.usual !== 0
			? (reading.value - reading.usual) / Math.abs(reading.usual)
			: null;

	// Outside usual counts most, then how far from usual, so a large move
	// that is still within the normal swing ranks under a small one that is
	// not.
	const weight =
		(reading.unusual ? 10 : 0) +
		Math.min(Math.abs(againstUsual ?? 0) * 10, 9);

	return {
		id,
		period: target,
		spacing,
		value: reading.value,
		usual: reading.usual,
		low: reading.low,
		high: reading.high,
		unusual: reading.unusual,
		againstUsual,
		previousPeriod,
		previous,
		series,
		driver: null,
		window: windowOf(target, spacing),
		previousWindow:
			previousPeriod !== null ? windowOf(previousPeriod, spacing) : null,
		weight,
	};
}

// Whether a card moved enough to be worth saying what moved it.
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

export type Standing = "unusual" | "moving" | "steady";

export function standingOf(card: Card): Standing {
	if (card.unusual) return "unusual";
	return Math.abs(card.againstUsual ?? 0) >= movingAt ? "moving" : "steady";
}

// Which figures the page has room for, chosen once they have been read.
// Anything outside its usual range comes first, then anything on the move,
// each by how much it asks for attention, then steady figures in the order
// given, which is the reader's order of reports. So a figure far from usual
// is shown however rarely its report is opened. Answers the chosen entries in
// the order given.
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
		[...rank("unusual"), ...rank("moving"), ...rank("steady")].slice(
			0,
			limit,
		),
	);
	return entries.filter((e) => chosen.has(e));
}
