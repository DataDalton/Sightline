// Learning when a table's data usually arrives, and saying when it is late.
//
// Every commit that changed data is an arrival, timed by the commit itself
// rather than by when a check happened to notice it, so a table checked once
// a day is learned as precisely as one checked every minute. The history a
// Delta table keeps goes back weeks, so a table is learned on its first look
// rather than after weeks of watching.
//
// Loads that skip days are the case to get right. Most tables load on
// weekdays and not at weekends, and the gap from Friday to Monday is not a
// late load. So the days of the week loads actually happen on are learned
// first, and time only counts on those days: Friday to Monday is one day of
// counted time, and a weekly Monday load counts only Mondays.
//
// A load often writes several commits a few minutes apart, which are one
// arrival. A stream writes every few minutes all day, which is not one long
// arrival, so a stream is recognised before commits are grouped.
//
// Pure, so every rule here can be tested with dates written out by hand.

import { quantile } from "../stats";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

// How far back arrivals are learned from. Long enough for several weeks of a
// weekly load, short enough that a schedule that changed is relearned.
export const learningWindowMs = 42 * day;

// Commits closer together than this are one load.
const burstGapMs = 30 * minute;

// A table where three commits in four follow the one before within this is a
// stream, loading every few minutes rather than in separate loads.
const streamGapMs = 30 * minute;

export interface ArrivalPattern {
	kind: "learning" | "irregular" | "regular";
	// Loads learned from, after commits of one load are grouped.
	arrivals: number;
	// Days of the week loads land on, 0 for Sunday, in UTC.
	activeDays: number[];
	// The usual gap between loads, counting only active days.
	usualGapMs: number | null;
	// How long without a load, counting only active days, before it is late.
	lateAfterMs: number | null;
	// For a daily load, the UTC minute of the day most loads have landed by.
	usualMinute: number | null;
	stream: boolean;
	// Learned from the history, or set by hand on the source.
	setBy: "learned" | "custom";
}

export type LatenessSetting =
	| { mode: "auto" }
	| { mode: "off" }
	| { mode: "custom"; everyHours: number; weekdaysOnly: boolean };

export function readLatenessSetting(raw: unknown): LatenessSetting {
	const r = (raw ?? {}) as Record<string, unknown>;
	if (r.mode === "off") return { mode: "off" };
	if (r.mode === "custom") {
		const hours = Number(r.everyHours);
		if (Number.isFinite(hours) && hours > 0) {
			return {
				mode: "custom",
				everyHours: Math.min(Math.max(hours, 0.25), 24 * 31),
				weekdaysOnly: r.weekdaysOnly === true,
			};
		}
	}
	return { mode: "auto" };
}

const allDays = [0, 1, 2, 3, 4, 5, 6];

function utcMidnight(t: number): number {
	return Math.floor(t / day) * day;
}

// Time between two moments, counting only the active days of the week.
export function activeElapsed(
	from: number,
	to: number,
	activeDays: number[],
): number {
	if (to <= from) return 0;
	const active = new Set(activeDays.length ? activeDays : allDays);
	let total = 0;
	let t = from;
	for (let guard = 0; t < to && guard < 2000; guard++) {
		const next = Math.min(utcMidnight(t) + day, to);
		if (active.has(new Date(t).getUTCDay())) total += next - t;
		t = next;
	}
	return total;
}

// The moment a given amount of active time has passed after a start.
export function addActive(
	from: number,
	amount: number,
	activeDays: number[],
): number {
	const active = new Set(activeDays.length ? activeDays : allDays);
	let t = from;
	let left = amount;
	for (let guard = 0; guard < 2000; guard++) {
		const next = utcMidnight(t) + day;
		if (active.has(new Date(t).getUTCDay())) {
			if (left <= next - t) return t + left;
			left -= next - t;
		}
		t = next;
	}
	return t;
}

// Commits of one load grouped, each load timed by its last commit, which is
// when the load was finished.
export function groupLoads(arrivals: number[]): number[] {
	const sorted = [...arrivals].sort((a, b) => a - b);
	const loads: number[] = [];
	for (const t of sorted) {
		if (loads.length && t - loads[loads.length - 1] <= burstGapMs) {
			loads[loads.length - 1] = t;
		} else {
			loads.push(t);
		}
	}
	return loads;
}

// The days of the week loads happen on. A day counts when loads landed on it
// in at least two weeks out of five it was seen, so a missed load or a bank
// holiday does not drop a day, and a one-off load does not add one. Before a
// full week has been seen every day counts, since nothing can be ruled out.
export function learnActiveDays(loads: number[], now: number): number[] {
	if (loads.length === 0) return allDays;
	const first = utcMidnight(loads[0]);
	if (now - first < 7 * day) return allDays;

	const seen = new Array(7).fill(0);
	for (let t = first; t <= now; t += day) seen[new Date(t).getUTCDay()]++;

	const hitDates = new Set(loads.map((t) => utcMidnight(t)));
	const hits = new Array(7).fill(0);
	for (const date of hitDates) hits[new Date(date).getUTCDay()]++;

	const active = allDays.filter(
		(d) => seen[d] > 0 && hits[d] / seen[d] >= 0.4,
	);
	// A monthly load lands on each weekday too rarely for any to count, and
	// then no day is ruled out.
	return active.length ? active : allDays;
}

// The first load of each day, as times turned so the day starts at the
// quietest hour of the loads, so loads either side of midnight fall on one
// day. A table that loads at noon and sometimes again in the evening has its
// data by noon, so the evening loads say nothing about when it arrives.
function firstLoadEachDay(loads: number[]): {
	quietest: number;
	firsts: number[];
} {
	const byHour = new Array(24).fill(0);
	for (const t of loads) byHour[Math.floor((t % day) / hour)]++;
	const quietest = byHour.indexOf(Math.min(...byHour)) * hour;
	const firstOfDay = new Map<number, number>();
	for (const t of loads) {
		const turned = t - quietest;
		const dayIndex = Math.floor(turned / day);
		const held = firstOfDay.get(dayIndex);
		if (held === undefined || turned < held)
			firstOfDay.set(dayIndex, turned);
	}
	return {
		quietest,
		firsts: [...firstOfDay.values()].sort((a, b) => a - b),
	};
}

// Whether the first loads of each day come about a day apart, which makes a
// table daily even when it sometimes loads again later the same day.
function dailyByFirstLoads(loads: number[]): boolean {
	const { firsts } = firstLoadEachDay(loads);
	const gaps = firsts.slice(1).map((t, i) => t - firsts[i]);
	if (gaps.length === 0) return false;
	const middle = quantile(gaps, 0.5);
	return middle >= 20 * hour && middle <= 28 * hour;
}

// The minute of the day most daily loads have landed by, in UTC, from the
// first load of each day.
function usualMinute(loads: number[]): number {
	const { quietest, firsts } = firstLoadEachDay(loads);
	const minutes = firsts
		.map((t) => Math.floor((((t % day) + day) % day) / minute))
		.sort((a, b) => a - b);
	return (quantile(minutes, 0.9) + quietest / minute) % 1440;
}

// How long a stored pattern stands without a new load before it is learned
// again, so loads ageing out of the window and weeks passing without a load
// on some weekday still change it.
export const relearnEveryMs = day;

// Whether a table's stored pattern has to be learned again: it was never
// learned, its newest load in the window is not the one it was learned with,
// or it is older than relearnEveryMs.
export function needsRelearning(
	stored: { newestArrival: number | null; learnedOn: number } | null,
	newestArrival: number | null,
	now: number,
): boolean {
	if (!stored) return true;
	if (stored.newestArrival !== newestArrival) return true;
	return now - stored.learnedOn >= relearnEveryMs;
}

// A schedule set by hand, which needs no history beyond how many loads the
// learning window holds.
export function customPattern(
	setting: Extract<LatenessSetting, { mode: "custom" }>,
	arrivals: number,
): ArrivalPattern {
	const gap = setting.everyHours * hour;
	return {
		kind: "regular",
		arrivals,
		activeDays: setting.weekdaysOnly ? [1, 2, 3, 4, 5] : allDays,
		usualGapMs: gap,
		lateAfterMs: gap,
		usualMinute: null,
		stream: false,
		setBy: "custom",
	};
}

// Loads in the window that show a rhythm whatever days they fell on.
const denseLoads = 24;

export function learnPattern(
	arrivals: number[],
	now: number,
	setting: LatenessSetting = { mode: "auto" },
): ArrivalPattern {
	const recent = arrivals.filter(
		(t) => t > now - learningWindowMs && t <= now,
	);

	if (setting.mode === "custom") return customPattern(setting, recent.length);

	const learning = (count: number): ArrivalPattern => ({
		kind: "learning",
		arrivals: count,
		activeDays: allDays,
		usualGapMs: null,
		lateAfterMs: null,
		usualMinute: null,
		stream: false,
		setBy: "learned",
	});

	const sorted = [...recent].sort((a, b) => a - b);

	// A stream first, on the commits as they are, since grouping them would
	// make a day of commits one load.
	const raw = sorted
		.slice(1)
		.map((t, i) => t - sorted[i])
		.sort((a, b) => a - b);
	const streaming = raw.length >= 20 && quantile(raw, 0.75) < streamGapMs;

	const loads = streaming ? sorted : groupLoads(sorted);
	const activeDays = learnActiveDays(loads, now);
	const gaps = loads
		.slice(1)
		.map((t, i) => activeElapsed(loads[i], t, activeDays))
		.filter((g) => g > 0)
		.sort((a, b) => a - b);

	const usual = quantile(gaps, 0.5);
	// Loads on only a day or two of the week, or days apart, arrive slowly, and
	// a few of them show the pattern as clearly as five daily ones.
	const needed = activeDays.length <= 2 || usual >= 3 * day ? 4 : 5;
	if (loads.length < needed || gaps.length < needed - 1) {
		return learning(loads.length);
	}
	// Enough loads, but they have to have landed on enough separate days too.
	// A table being built is often run by hand several times in a day or two,
	// and those runs look like a load every few hours that then never comes
	// again. Many loads in a short span, such as an hourly table's first day,
	// show their rhythm without waiting for more days.
	const loadDays = new Set(loads.map((t) => Math.floor(t / day))).size;
	if (!streaming && loadDays < needed && loads.length < denseLoads) {
		return learning(loads.length);
	}

	const long = quantile(gaps, 0.9);
	// Loads that land on days the pattern says are quiet are not explained by
	// it. A weekday table has none, a table loaded by hand has plenty.
	const active = new Set(activeDays);
	const offDays =
		loads.filter((t) => !active.has(new Date(t).getUTCDay())).length /
		loads.length;
	// Gaps all over the place, or loads on days the pattern cannot account
	// for, such as a table loaded by hand now and then. Calling one late would
	// be a guess, so it never is.
	if (!streaming && (long > 4 * usual || offDays > 0.2)) {
		return {
			...learning(loads.length),
			kind: "irregular",
			activeDays,
			usualGapMs: usual,
		};
	}

	// Late once it has gone past the longest usual gap by a margin: an hour at
	// least, a tenth of the usual gap for slower loads, and for a stream three
	// of its usual gaps, since a stream that pauses briefly has not stopped.
	const margin = streaming
		? Math.max(30 * minute, 3 * long)
		: Math.max(hour, 0.1 * usual);
	// A daily table with an occasional second load has a usual gap a little
	// under a day. One loading several times a day, hourly or twice daily, is
	// not daily and keeps no usual time.
	const daily =
		!streaming &&
		((usual >= 20 * hour && usual <= 28 * hour) ||
			(usual >= 16 * hour && dailyByFirstLoads(loads)));

	return {
		kind: "regular",
		arrivals: loads.length,
		activeDays,
		usualGapMs: usual,
		lateAfterMs: long + margin,
		usualMinute: daily ? usualMinute(loads) : null,
		stream: streaming,
		setBy: "learned",
	};
}

export type LateState =
	| "off"
	| "learning"
	| "irregular"
	| "on_time"
	// Past when it was expected, but nothing has looked since, so whether it
	// arrived is not known yet.
	| "overdue"
	| "late";

export interface Judgement {
	state: LateState;
	expectedBy: number | null;
}

// Whether a table is late now. Late only once a look after the expected time
// found nothing new. Until then the load may well have landed unseen, since
// the warehouse that would have seen it may have been stopped.
export function judge(
	pattern: ArrivalPattern,
	lastArrival: number | null,
	lastChecked: number | null,
	now: number,
	setting: LatenessSetting = { mode: "auto" },
): Judgement {
	if (setting.mode === "off") return { state: "off", expectedBy: null };
	if (pattern.kind !== "regular" || pattern.lateAfterMs === null) {
		return {
			state: pattern.kind === "irregular" ? "irregular" : "learning",
			expectedBy: null,
		};
	}
	if (lastArrival === null) return { state: "learning", expectedBy: null };

	const expectedBy = addActive(
		lastArrival,
		pattern.lateAfterMs,
		pattern.activeDays,
	);
	if (now < expectedBy) return { state: "on_time", expectedBy };
	if (lastChecked !== null && lastChecked >= expectedBy) {
		return { state: "late", expectedBy };
	}
	return { state: "overdue", expectedBy };
}

// --- Saying it ---------------------------------------------------------------

const dayNames = [
	"Sundays",
	"Mondays",
	"Tuesdays",
	"Wednesdays",
	"Thursdays",
	"Fridays",
	"Saturdays",
];

function daysText(activeDays: number[]): string {
	const set = [...new Set(activeDays)].sort();
	if (set.length === 7) return "";
	if (set.join() === "1,2,3,4,5") return "on weekdays";
	if (set.join() === "0,6") return "at weekends";
	const names = set.map((d) => dayNames[d]);
	return `on ${
		names.length === 1
			? names[0]
			: `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
	}`;
}

export function describeSpan(ms: number): string {
	const minutes = Math.round(ms / minute);
	if (minutes < 60)
		return `${Math.max(1, minutes)} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(ms / hour);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	const days = Math.round(ms / day);
	return `${days} day${days === 1 ? "" : "s"}`;
}

// Today's date is used for the conversion, so the clock change between summer
// and winter time is the one in force now.
function timeOfDay(utcMinute: number, timeZone: string): string {
	const now = new Date();
	const at = new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate(),
			0,
			utcMinute,
		),
	);
	try {
		return at.toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "2-digit",
			timeZone,
		});
	} catch {
		return at.toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "2-digit",
			timeZone: "UTC",
		});
	}
}

// When the data usually arrives, in a sentence.
export function describePattern(
	pattern: ArrivalPattern,
	timeZone = "UTC",
): string {
	if (pattern.kind === "learning") {
		return pattern.arrivals === 0
			? "No loads seen yet, so when it updates is not known."
			: `Still learning when it updates, from ${pattern.arrivals} load${pattern.arrivals === 1 ? "" : "s"} so far.`;
	}
	if (pattern.kind === "irregular") {
		return "Updates at irregular times, so it is never called late.";
	}
	const days = daysText(pattern.activeDays);
	const prefix =
		pattern.setBy === "custom" ? "Expected to update" : "Usually updates";
	if (pattern.usualMinute !== null) {
		return `${prefix} ${days ? `${days} ` : "daily "}by about ${timeOfDay(pattern.usualMinute, timeZone)}.`;
	}
	const gap = describeSpan(pattern.usualGapMs ?? 0);
	return `${prefix} ${days ? `${days}, ` : ""}about every ${gap}.`;
}
