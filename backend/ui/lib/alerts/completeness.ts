import { groupLabel, toNumber } from "../format";
import { addActive, type ArrivalPattern } from "../freshness/arrivals";
import { median, quantile } from "../stats";
import { periodEnd, type AnomalySettings } from "./anomaly";

// Telling data that has not finished arriving from a figure that is really
// off.
//
// A period whose calendar span has ended may still be short of rows. Two
// questions settle most cases at once:
//
//   - has the load that carries the period landed? The load history the
//     freshness checks record says when each table last loaded and when it
//     usually does. A period whose load has not landed is waiting. It is
//     never judged, and the latest period that has loaded is judged instead.
//   - is the figure off by a way missing rows cannot explain? Missing rows
//     only make a sum or a count smaller. A figure above usual, or any move
//     in a rate or an average, is judged at once.
//
// What is left is a sum or a count, below usual, in a period whose load has
// landed but which is still young. Three things decide whether it is an early
// signal, which may still be filling in, or confirmed:
//
//   - how complete the figure usually is at this age, learned from what each
//     earlier period read as while it was young and where it settled
//   - whether every part of it fell by a similar share, which looks like a
//     load gap, or one part carries the drop, which does not
//   - whether every figure on the same dataset fell together, which is
//     decided where every card of a briefing is known. See lib/briefing/card
//
// Pure, so every rule here can be tested with values written out by hand.

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const allDays = [0, 1, 2, 3, 4, 5, 6];

// --- Time -----------------------------------------------------------------

function keyOf(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

function toTime(key: string): number {
	return Date.parse(`${key}T00:00:00Z`);
}

// How far a time zone's clock is ahead of UTC at a moment.
function offsetAt(time: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(time));
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value ?? 0);
	const local = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour") % 24,
		get("minute"),
		get("second"),
	);
	return local - Math.floor(time / 1000) * 1000;
}

// The moment a day starts in a time zone. A period's dates are read as the
// reader's own days, as "today" is.
export function zoneMidnight(key: string, timeZone: string): number {
	const utc = toTime(key);
	try {
		// Asked twice, so a day that starts on the far side of a clock change
		// lands on the right offset.
		const first = utc - offsetAt(utc, timeZone);
		return utc - offsetAt(first, timeZone);
	} catch {
		return utc;
	}
}

// The moment a period ends, where the reader is.
export function periodEndAt(
	key: string,
	spacing: number,
	timeZone: string,
): number {
	return zoneMidnight(keyOf(periodEnd(key, spacing)), timeZone);
}

// Hours since a period ended. Negative while it is still running.
export function ageOf(
	key: string,
	spacing: number,
	timeZone: string,
	now: number,
): number {
	return (now - periodEndAt(key, spacing, timeZone)) / hour;
}

// --- Has the period loaded --------------------------------------------------

export interface TableLoad {
	table: string;
	// When its newest load landed.
	newest: number | null;
	// What its load history says about when it loads, or null when nothing
	// has been learned.
	pattern: ArrivalPattern | null;
}

export interface LoadEvidence {
	// Whether the dataset's tables are watched for loads. A dataset on a
	// timer has no load history.
	checked: boolean;
	tables: TableLoad[];
}

export interface Waiting {
	// The first period whose load has not landed, and the last one due.
	period: string;
	through: string;
	// When the load that carries it usually lands, when that is known.
	expectedBy: number | null;
}

export interface LoadDecision {
	// The latest period that has loaded, which is the one judged. Null when
	// none of the periods read has.
	judged: string | null;
	waiting: Waiting | null;
	// Whether the load history said anything. False for a dataset on a timer
	// or with no regular loads, which the settling rules alone judge.
	known: boolean;
}

// Whether a table's loads come often enough to carry every period. A table
// loaded weekly says nothing about whether a day has loaded.
function carries(pattern: ArrivalPattern | null, spacing: number): boolean {
	if (!pattern || pattern.kind !== "regular") return false;
	if (pattern.stream) return true;
	return (
		pattern.usualGapMs !== null &&
		pattern.usualGapMs <= Math.max(spacing, 1) * day * 1.5
	);
}

// When the next load after a moment usually lands. A daily load lands at its
// usual time on its next active day. A load every few hours lands one usual
// gap after the last. A stream is always about to.
export function nextLoadAfter(
	pattern: ArrivalPattern,
	from: number,
	newest: number | null,
): number | null {
	if (pattern.stream) return null;
	if (pattern.usualMinute !== null) {
		const active = new Set(
			pattern.activeDays.length ? pattern.activeDays : allDays,
		);
		let t = Math.floor(from / day) * day + pattern.usualMinute * minute;
		for (let i = 0; i < 15; i++, t += day) {
			if (t >= from && active.has(new Date(t).getUTCDay())) return t;
		}
		return null;
	}
	if (
		pattern.usualGapMs !== null &&
		pattern.usualGapMs > 0 &&
		newest !== null
	) {
		let t = addActive(newest, pattern.usualGapMs, pattern.activeDays);
		for (let i = 0; t < from && i < 1000; i++)
			t = addActive(t, pattern.usualGapMs, pattern.activeDays);
		return t;
	}
	return null;
}

// Periods after the latest one read whose span has ended by today, which a
// load could carry although no row of them has been seen.
export function dueAfter(
	target: string,
	spacing: number,
	today: string,
): string[] {
	const out: string[] = [];
	const todayTime = toTime(today);
	let key = keyOf(periodEnd(target, spacing));
	for (let i = 0; i < 62 && periodEnd(key, spacing) <= todayTime; i++) {
		out.push(key);
		key = keyOf(periodEnd(key, spacing));
	}
	return out;
}

// Which period to judge, and which are still waiting for their load.
//
// A period has loaded once every table that loads often enough to carry it
// has landed a load after the period ended. Tables loaded more rarely, by
// hand, or not yet learned say nothing, and a dataset with no table that
// says anything is left to the settling rules.
export function decideLoad(
	evidence: LoadEvidence | null,
	keys: string[],
	target: string,
	spacing: number,
	timeZone: string,
	today: string,
): LoadDecision {
	const unknown: LoadDecision = {
		judged: target,
		waiting: null,
		known: false,
	};
	if (!evidence?.checked) return unknown;
	const carrying = evidence.tables.filter((t) => carries(t.pattern, spacing));
	if (carrying.length === 0) return unknown;

	const through = Math.min(
		...carrying.map((t) => t.newest ?? Number.NEGATIVE_INFINITY),
	);
	const loaded = (key: string) =>
		periodEndAt(key, spacing, timeZone) <= through;

	const present = [...new Set(keys)].filter((k) => k <= target).sort();
	const judged = [...present].reverse().find(loaded) ?? null;
	const unloaded = [...present, ...dueAfter(target, spacing, today)]
		.filter((k) => (judged === null || k > judged) && !loaded(k))
		.sort();
	if (unloaded.length === 0) return { judged, waiting: null, known: true };

	// The load that carries the first waiting period, from whichever table is
	// furthest behind.
	const endsAt = periodEndAt(unloaded[0], spacing, timeZone);
	const expected = carrying
		.filter((t) => (t.newest ?? Number.NEGATIVE_INFINITY) < endsAt)
		.map((t) =>
			nextLoadAfter(t.pattern as ArrivalPattern, endsAt, t.newest),
		);
	const expectedBy =
		expected.length > 0 && expected.every((t) => t !== null)
			? Math.max(...(expected as number[]))
			: null;
	return {
		judged,
		waiting: {
			period: unloaded[0],
			through: unloaded[unloaded.length - 1],
			expectedBy,
		},
		known: true,
	};
}

// --- How complete a period usually is at an age -----------------------------

export interface Observation {
	period: string;
	// Hours after the period ended that the value was read.
	ageHours: number;
	value: number;
}

export interface LearnedSettling {
	// Periods learned from.
	periods: number;
	// The age after which a period stays within settleTolerance of where it
	// settles.
	settleHours: number | null;
	// Each period's readings as shares of where it settled, youngest first.
	curves: { ageHours: number; share: number }[][];
}

// How close to its settled value a reading has to be to count as settled.
export const settleTolerance = 0.02;
// Periods needed before anything is learned.
const minLearned = 3;
// A period counts once it has been read this long after it ended, and a day
// past the point it stopped changing, so its last reading is where it
// settled rather than another step on the way.
const minFinalHours = 48;
const finalMarginHours = 24;

export function learnSettling(
	observations: Observation[],
): LearnedSettling | null {
	const byPeriod = new Map<string, Map<number, number>>();
	for (const o of observations) {
		if (!Number.isFinite(o.value) || !Number.isFinite(o.ageHours)) continue;
		if (o.ageHours < 0) continue;
		const readings = byPeriod.get(o.period) ?? new Map<number, number>();
		readings.set(o.ageHours, o.value);
		byPeriod.set(o.period, readings);
	}

	const curves: { ageHours: number; share: number }[][] = [];
	const settles: number[] = [];
	for (const readings of byPeriod.values()) {
		const sorted = [...readings.entries()].sort((a, b) => a[0] - b[0]);
		const [finalAge, final] = sorted[sorted.length - 1];
		// A period that settled at nothing gives no shares.
		if (final === 0) continue;
		const tolerance = Math.abs(final) * settleTolerance;
		let settle = finalAge;
		for (let i = sorted.length - 1; i >= 0; i--) {
			if (Math.abs(sorted[i][1] - final) > tolerance) break;
			settle = sorted[i][0];
		}
		if (finalAge < Math.max(minFinalHours, settle + finalMarginHours))
			continue;
		settles.push(settle);
		curves.push(
			sorted.map(([ageHours, value]) => ({
				ageHours,
				share: value / final,
			})),
		);
	}
	if (curves.length < minLearned) return null;
	return {
		periods: curves.length,
		settleHours: quantile(
			settles.sort((a, b) => a - b),
			0.8,
		),
		curves,
	};
}

// The share of its settled value a period usually holds at an age, or null
// when too few periods were read near that age. Each period counts by its
// latest reading at or before the age, and only when that reading is close
// to it, so a period first read days later says nothing about its first
// hours.
export function expectedShare(
	learned: LearnedSettling,
	ageHours: number,
): number | null {
	if (learned.settleHours !== null && ageHours >= learned.settleHours)
		return 1;
	const reach = Math.max(6, ageHours * 0.25);
	const shares: number[] = [];
	for (const curve of learned.curves) {
		let at: { ageHours: number; share: number } | null = null;
		for (const point of curve) {
			if (point.ageHours <= ageHours) at = point;
			else break;
		}
		if (at && ageHours - at.ageHours <= reach) shares.push(at.share);
	}
	if (shares.length < minLearned) return null;
	return Math.min(Math.max(median(shares), 0), 1);
}

// How long a period is treated as young when nothing has been learned. A day
// for a daily figure, three for anything coarser.
export function defaultSettleHours(spacing: number): number {
	return spacing <= 1 ? 24 : 72;
}

// The moment a reading is stored under. Readings in a period's first two
// days are kept by the hour and later ones by the day, which is as fine as
// the learning needs.
export function observedBucket(observedAt: number, ageHours: number): number {
	const step = ageHours < 48 ? hour : day;
	return Math.floor(observedAt / step) * step;
}

// --- Did everything fall together -------------------------------------------

export interface Evenness {
	// One when every part moved by the same share, falling towards zero as
	// the change gathers in fewer parts.
	score: number;
	kind: "even" | "led" | "mixed";
	// The part that moved most the way the whole did, and its share of the
	// whole change.
	top: string | null;
	topShare: number;
}

// Whether a change spread evenly across the parts of a figure or sits in one.
// Each part is compared with what it would have done had it moved by the
// same share as the whole. Only meaningful for a figure that adds up.
export function evenness(
	current: Map<string, number>,
	previous: Map<string, number>,
): Evenness | null {
	const members = new Set([...current.keys(), ...previous.keys()]);
	if (members.size < 2) return null;
	let now = 0;
	let before = 0;
	for (const m of members) {
		now += current.get(m) ?? 0;
		before += previous.get(m) ?? 0;
	}
	const change = now - before;
	if (before === 0 || change === 0) return null;
	const ratio = now / before;

	let deviation = 0;
	let moved = 0;
	let top: string | null = null;
	let topChange = 0;
	for (const m of members) {
		const was = previous.get(m) ?? 0;
		const moveBy = (current.get(m) ?? 0) - was;
		deviation += Math.abs(moveBy - (was * ratio - was));
		moved += Math.abs(moveBy);
		if (
			Math.sign(moveBy) === Math.sign(change) &&
			Math.abs(moveBy) > Math.abs(topChange)
		) {
			top = m;
			topChange = moveBy;
		}
	}
	const score =
		moved > 0 ? Math.min(Math.max(1 - deviation / moved, 0), 1) : 0;
	const topShare = Math.min(Math.abs(topChange) / Math.abs(change), 1);
	const kind =
		score >= 0.7
			? "even"
			: topShare >= 0.6 && score < 0.5
				? "led"
				: "mixed";
	return { score, kind, top, topShare };
}

// The same from rows of a breakdown, one per part.
export function evennessOf(
	currentRows: Record<string, unknown>[],
	previousRows: Record<string, unknown>[],
	dimension: string,
	measure: string,
): Evenness | null {
	const toMap = (rows: Record<string, unknown>[]) => {
		const out = new Map<string, number>();
		for (const row of rows) {
			const value = toNumber(row[measure]);
			if (value !== null) out.set(groupLabel(row[dimension]), value);
		}
		return out;
	};
	return evenness(toMap(currentRows), toMap(previousRows));
}

// --- The judgement ----------------------------------------------------------

export type Level = "confirmed" | "early";

export type Reason =
	// Confirmed
	| "settled"
	| "rose"
	| "notAdditive"
	| "ledByOne"
	| "landed"
	// Early
	| "belowExpected"
	| "evenDrop"
	| "together"
	| "noHistory"
	// Neither, though usual alone would have said unusual
	| "fillingIn";

export interface Settling {
	level: Level | null;
	reason: Reason | null;
	ageHours: number;
	// Still inside the time a period usually takes to settle.
	young: boolean;
	additive: boolean;
	// The share of its settled value the period usually holds by now.
	expectedShare: number | null;
	settleHours: number | null;
}

export interface SettlingInput {
	value: number;
	usual: number | null;
	low: number | null;
	// What usual alone says.
	unusual: boolean;
	additive: boolean;
	ageHours: number;
	spacing: number;
	// Whether the load history showed the load carrying the period landed.
	landed: boolean;
	learned: LearnedSettling | null;
	evenness: Evenness | null;
	settings?: Pick<AnomalySettings, "direction" | "minimum">;
}

export function judgeSettling(input: SettlingInput): Settling {
	const {
		value,
		usual,
		low,
		unusual,
		additive,
		ageHours,
		spacing,
		landed,
		learned,
	} = input;
	const settleHours = learned?.settleHours ?? null;
	const young = ageHours < (settleHours ?? defaultSettleHours(spacing));
	const verdict = (
		level: Level | null,
		reason: Reason | null,
		share: number | null = null,
	): Settling => ({
		level,
		reason,
		ageHours,
		young,
		additive,
		expectedShare: share,
		settleHours,
	});

	// Missing rows cannot explain these, so usual decides at once.
	if (!additive)
		return verdict(
			unusual ? "confirmed" : null,
			unusual ? "notAdditive" : null,
		);
	if (usual === null || low === null || value >= usual)
		return verdict(unusual ? "confirmed" : null, unusual ? "rose" : null);
	if (!young)
		return verdict(
			unusual ? "confirmed" : null,
			unusual ? "settled" : null,
		);

	// Below usual in a young period. A drop the settings would never call
	// unusual is left alone.
	const settings = input.settings;
	if (
		settings?.direction === "up" ||
		(typeof settings?.minimum === "number" &&
			Math.abs(usual) < settings.minimum)
	)
		return verdict(null, null);
	const led = input.evenness?.kind === "led";
	const even = input.evenness?.kind === "even";

	const share = learned ? expectedShare(learned, ageHours) : null;
	if (share !== null) {
		// Judged against usual scaled to how complete a period is by now.
		if (value >= low * share)
			return verdict(null, unusual ? "fillingIn" : null, share);
		if (led) return verdict("confirmed", "ledByOne", share);
		return verdict("early", even ? "evenDrop" : "belowExpected", share);
	}

	if (!unusual) return verdict(null, null);
	if (led) return verdict("confirmed", "ledByOne");
	if (even) return verdict("early", "evenDrop");
	if (landed) return verdict("confirmed", "landed");
	return verdict("early", "noHistory");
}
