// When an alert is checked next.
//
// Checks land on a whole hour of the owner's clock, never at the minute
// somebody happened to save. A
// warehouse that stops when idle is woken once for every alert due at that
// hour rather than once for each of them, which is most of what an alert
// costs.

export type Frequency = "hourly" | "daily" | "weekdays" | "weekly";

export interface Schedule {
	frequency: Frequency;
	// Hour of the day, 0 to 23, in the owner's time zone. Ignored for hourly.
	hour: number;
	// 0 is Sunday. Only read for weekly.
	weekday: number;
	// An IANA zone such as America/Chicago, taken from the browser that
	// created the alert, so "8 in the morning" means the owner's morning.
	timeZone: string;
}

export const frequencies: Frequency[] = [
	"hourly",
	"daily",
	"weekdays",
	"weekly",
];

export function isFrequency(value: unknown): value is Frequency {
	return frequencies.includes(value as Frequency);
}

// Zones already checked, and whether each was valid. Checking one means
// making a formatter, which is far more costly than looking it up, and every
// request that judges a figure sends one. Bounded, since a zone is text a
// browser sends.
const checkedZones = new Map<string, boolean>();
const maxCheckedZones = 2000;

export function validTimeZone(zone: unknown): string {
	if (typeof zone !== "string" || zone === "" || zone.length > 64)
		return "UTC";
	let valid = checkedZones.get(zone);
	if (valid === undefined) {
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: zone });
			valid = true;
		} catch {
			valid = false;
		}
		if (checkedZones.size >= maxCheckedZones) checkedZones.clear();
		checkedZones.set(zone, valid);
	}
	return valid ? zone : "UTC";
}

export function cleanSchedule(raw: unknown): Schedule {
	const r = (raw ?? {}) as Record<string, unknown>;
	const hour = Number(r.hour);
	const weekday = Number(r.weekday);
	return {
		frequency: isFrequency(r.frequency) ? r.frequency : "daily",
		hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8,
		weekday:
			Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
				? weekday
				: 1,
		timeZone: validTimeZone(r.timeZone),
	};
}

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

// Every zone in use today is offset from UTC by a whole number of quarter
// hours, so a local top of the hour always falls on a UTC quarter hour.
const quarterMs = 15 * minuteMs;

interface WallTime {
	year: number;
	// 1 to 12.
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

// One formatter per zone. Building one parses the zone data, which costs far
// more than formatting with it.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let found = formatters.get(timeZone);
	if (!found) {
		found = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		formatters.set(timeZone, found);
	}
	return found;
}

// The wall clock in a zone at one instant.
function wallTime(at: number, timeZone: string): WallTime {
	const out: WallTime = {
		year: 1970,
		month: 1,
		day: 1,
		hour: 0,
		minute: 0,
		second: 0,
	};
	for (const part of formatterFor(timeZone).formatToParts(at)) {
		if (part.type in out) {
			out[part.type as keyof WallTime] = Number(part.value);
		}
	}
	// Some engines write midnight as hour 24 of the same day under h23.
	if (out.hour === 24) out.hour = 0;
	return out;
}

// How far the zone's clock is ahead of UTC at an instant, in milliseconds.
function offsetAt(at: number, timeZone: string): number {
	const w = wallTime(at, timeZone);
	const asUtc = Date.UTC(
		w.year,
		w.month - 1,
		w.day,
		w.hour,
		w.minute,
		w.second,
	);
	return asUtc - Math.floor(at / 1000) * 1000;
}

// The instant a zone's clock first reads the given date and time.
//
// A wall time can occur twice, when clocks go back, and then the earlier one
// is returned, so a schedule runs once in the repeated hour. It can also not
// occur at all, when clocks go forward over it, and then the instant the
// clocks jump is returned, which is the first moment after the gap.
//
// Every offset the zone uses within a day either side is tried, since the
// instant wanted lies between those two and a zone moves at most once or
// twice in that span.
export function zonedInstant(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string,
): number {
	const local = Date.UTC(year, month - 1, day, hour, minute);
	const before = offsetAt(local - dayMs, timeZone);
	const after = offsetAt(local + dayMs, timeZone);
	const offsets = new Set([before, offsetAt(local, timeZone), after]);

	const matching = [...offsets]
		.map((offset) => local - offset)
		.filter((at) => offsetAt(at, timeZone) === local - at)
		.sort((a, b) => a - b);
	if (matching.length > 0) return matching[0];

	// Skipped by a jump forward. Reading the wall time with the offset from
	// after the jump gives an instant before it, and with the offset from
	// before the jump an instant after it. The jump lies between, and is
	// found by halving to the second.
	let lo = Math.min(local - before, local - after);
	let hi = Math.max(local - before, local - after);
	const startOffset = offsetAt(lo, timeZone);
	if (offsetAt(hi, timeZone) === startOffset) return local - before;
	while (hi - lo > 1000) {
		const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
		if (offsetAt(mid, timeZone) === startOffset) lo = mid;
		else hi = mid;
	}
	return hi;
}

function dayMatches(schedule: Schedule, weekday: number): boolean {
	if (schedule.frequency === "weekdays") return weekday >= 1 && weekday <= 5;
	if (schedule.frequency === "weekly") return weekday === schedule.weekday;
	return true;
}

// The first instant after `after` at which the zone's clock reads a whole
// hour. Stepped a quarter hour at a time, which lands on every local top of
// the hour in zones offset by a half or three quarters of an hour as well.
function nextLocalHour(after: number, timeZone: string): number {
	let at = Math.floor(after / quarterMs) * quarterMs + quarterMs;
	// A day and a bit of quarter hours, far more than any zone needs.
	for (let i = 0; i < 4 * 26; i++) {
		const w = wallTime(at, timeZone);
		if (w.minute === 0 && w.second === 0) return at;
		at += quarterMs;
	}
	return Math.floor(after / hourMs) * hourMs + hourMs;
}

// The next time after `from` that the schedule names, in the owner's zone.
//
// Hourly runs at every real hour that starts on a whole hour of the owner's
// clock, so an owner half an hour off UTC is checked at half past in UTC.
// The rest run at their hour on each day that qualifies, worked out one local
// date at a time. When clocks go back and the hour happens twice, only the
// first counts, and when clocks go forward over it the run happens as the
// clocks jump. A week is the longest any schedule waits, so a little over a
// week of dates is looked at.
export function nextRun(schedule: Schedule, from: Date): Date {
	const after = from.getTime();
	const zone = schedule.timeZone;
	if (schedule.frequency === "hourly") {
		return new Date(nextLocalHour(after, zone));
	}
	const today = wallTime(after, zone);
	for (let k = 0; k <= 8; k++) {
		const date = new Date(
			Date.UTC(today.year, today.month - 1, today.day + k),
		);
		if (!dayMatches(schedule, date.getUTCDay())) continue;
		const at = zonedInstant(
			date.getUTCFullYear(),
			date.getUTCMonth() + 1,
			date.getUTCDate(),
			schedule.hour,
			0,
			zone,
		);
		if (at > after) return new Date(at);
	}
	return new Date(Math.floor(after / hourMs) * hourMs + hourMs);
}

export const weekdayNames = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

function clockHour(hour: number): string {
	const suffix = hour < 12 ? "AM" : "PM";
	const twelve = hour % 12 === 0 ? 12 : hour % 12;
	return `${twelve}:00 ${suffix}`;
}

export function describeSchedule(schedule: Schedule): string {
	switch (schedule.frequency) {
		case "hourly":
			return "Every hour";
		case "daily":
			return `Every day at ${clockHour(schedule.hour)}`;
		case "weekdays":
			return `Weekdays at ${clockHour(schedule.hour)}`;
		case "weekly":
			return `${weekdayNames[schedule.weekday]}s at ${clockHour(schedule.hour)}`;
	}
}
