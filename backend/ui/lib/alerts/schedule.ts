// When an alert is checked next.
//
// Checks land on the hour, never at the minute somebody happened to save. A
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

export function validTimeZone(zone: unknown): string {
	if (typeof zone !== "string" || zone === "") return "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return zone;
	} catch {
		return "UTC";
	}
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

// The wall clock in a zone at one instant.
function wallClock(at: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		weekday: "short",
		hour: "numeric",
	}).formatToParts(at);
	const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
	const day = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
	const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
		day,
	);
	return { hour: hour === 24 ? 0 : hour, weekday };
}

function matches(schedule: Schedule, at: Date): boolean {
	if (schedule.frequency === "hourly") return true;
	const { hour, weekday } = wallClock(at, schedule.timeZone);
	if (hour !== schedule.hour) return false;
	if (schedule.frequency === "weekdays") return weekday >= 1 && weekday <= 5;
	if (schedule.frequency === "weekly") return weekday === schedule.weekday;
	return true;
}

// The first top of the hour after `from` that the schedule names.
//
// Walked an hour at a time rather than computed, because a zone's offset is
// not a constant: stepping through real instants and asking the zone what
// hour each one is gets daylight saving right without handling it. A week is
// the longest any schedule waits, so the walk is bounded.
export function nextRun(schedule: Schedule, from: Date): Date {
	const hourMs = 60 * 60 * 1000;
	let at = new Date(Math.floor(from.getTime() / hourMs) * hourMs + hourMs);
	for (let i = 0; i < 24 * 8; i++) {
		if (matches(schedule, at)) return at;
		at = new Date(at.getTime() + hourMs);
	}
	return at;
}

const weekdayNames = [
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
