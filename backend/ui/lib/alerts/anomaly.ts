import { groupLabel, toNumber } from "../format";
import { median } from "../stats";

// Whether a figure is unusual, judged against its own history.
//
// Rather than a line somebody has to choose, an unusual alert asks the data
// what normal looks like. It reads the measure for each period of a date
// field, takes the latest period that is over, and compares it with the same
// weekday in recent weeks, or with the periods just before it. Usual is the
// middle of those, and how far from it counts as unusual is how much the
// figure normally moves, or a percentage somebody sets.
//
// The period judged is the latest one that has finished. Today is still
// filling up, and half a day's orders against whole days would read as a
// collapse every morning.
//
// Pure, so every rule here can be tested with rows written out by hand.

export type CompareTo = "same_weekday" | "recent";
export type Sensitivity = "low" | "medium" | "high" | "percent";
export type Direction = "up" | "down" | "either";

export interface AnomalySettings {
	// The date field the history is read across.
	timeField: string;
	compareTo: CompareTo;
	// How many earlier periods make up usual.
	periods: number;
	sensitivity: Sensitivity;
	// When sensitivity is percent, how far from usual counts, as a percentage.
	percent: number | null;
	direction: Direction;
	// A group whose usual figure is smaller than this is left alone, since a
	// handful of orders swinging by half is not news.
	minimum: number | null;
}

export class AnomalySettingsError extends Error {}

export const minPeriods = 3;
export const maxPeriods = 26;

export function defaultAnomaly(timeField: string): AnomalySettings {
	return {
		timeField,
		compareTo: "same_weekday",
		periods: 8,
		sensitivity: "medium",
		percent: null,
		direction: "either",
		minimum: null,
	};
}

export function cleanAnomaly(raw: unknown): AnomalySettings {
	const r = (raw ?? {}) as Record<string, unknown>;
	const timeField = typeof r.timeField === "string" ? r.timeField.trim() : "";
	if (!timeField) {
		throw new AnomalySettingsError(
			"Choose the date field to read its history across.",
		);
	}
	const periods = Math.round(Number(r.periods));
	const percent = Number(r.percent);
	const minimum = Number(r.minimum);
	const sensitivity: Sensitivity =
		r.sensitivity === "low" ||
		r.sensitivity === "high" ||
		r.sensitivity === "percent"
			? r.sensitivity
			: "medium";
	if (
		sensitivity === "percent" &&
		!(Number.isFinite(percent) && percent > 0)
	) {
		throw new AnomalySettingsError(
			"Enter how far from usual counts, as a percentage.",
		);
	}
	return {
		timeField: timeField.slice(0, 200),
		compareTo: r.compareTo === "recent" ? "recent" : "same_weekday",
		periods: Number.isFinite(periods)
			? Math.min(Math.max(periods, minPeriods), maxPeriods)
			: 8,
		sensitivity,
		percent: sensitivity === "percent" ? Math.min(percent, 1000) : null,
		direction:
			r.direction === "up" || r.direction === "down"
				? r.direction
				: "either",
		minimum:
			r.minimum === null || r.minimum === undefined || r.minimum === ""
				? null
				: Number.isFinite(minimum) && minimum > 0
					? minimum
					: null,
	};
}

// --- Periods -------------------------------------------------------------------

const day = 24 * 60 * 60 * 1000;

// A date field's value as a day, or null for anything that is not a date.
export function periodKey(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) {
		return Number.isNaN(value.getTime())
			? null
			: value.toISOString().slice(0, 10);
	}
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
	return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function toTime(key: string): number {
	return Date.parse(`${key}T00:00:00Z`);
}

function fromTime(t: number): string {
	return new Date(t).toISOString().slice(0, 10);
}

// How many days one period of the field spans: one for a daily date, seven
// for a weekly one, about thirty for a month. The usual step between the
// values present.
export function spacingDays(keys: string[]): number {
	const sorted = [...new Set(keys)].sort();
	const steps = sorted
		.slice(1)
		.map((k, i) => Math.round((toTime(k) - toTime(sorted[i])) / day))
		.filter((d) => d > 0)
		.sort((a, b) => a - b);
	if (steps.length === 0) return 1;
	return steps[Math.floor(steps.length / 2)];
}

// The latest period that has finished by today, which is the one judged.
export function targetPeriod(
	keys: string[],
	spacing: number,
	today: string,
): string | null {
	const todayTime = toTime(today);
	const done = [...new Set(keys)]
		.filter((k) => toTime(k) + spacing * day <= todayTime)
		.sort();
	return done.length ? done[done.length - 1] : null;
}

// Whether comparing with the same weekday means anything for this field. It
// does for a daily field, where Mondays and Saturdays differ, and not for a
// weekly or monthly one.
export function comparesWeekdays(
	settings: AnomalySettings,
	spacing: number,
): boolean {
	return settings.compareTo === "same_weekday" && spacing === 1;
}

// The first day the history has to reach back to.
export function windowStart(
	settings: AnomalySettings,
	spacing: number,
	target: string,
): string {
	const back = comparesWeekdays(settings, spacing)
		? settings.periods * 7
		: (settings.periods + 2) * spacing;
	return fromTime(toTime(target) - back * day);
}

// The periods usual is taken from, for one target.
export function baselineKeys(
	target: string,
	available: string[],
	settings: AnomalySettings,
	spacing: number,
): string[] {
	const present = new Set(available);
	if (comparesWeekdays(settings, spacing)) {
		const keys: string[] = [];
		for (let k = 1; k <= settings.periods; k++) {
			const key = fromTime(toTime(target) - k * 7 * day);
			if (present.has(key)) keys.push(key);
		}
		return keys;
	}
	return [...present]
		.filter((k) => k < target)
		.sort()
		.slice(-settings.periods);
}

// --- Usual -----------------------------------------------------------------

// How many typical movements away counts as unusual, and the least distance
// that does, as a share of usual. The least distance stops a figure that has
// barely moved in weeks from alerting on the first small change.
const reach: Record<Exclude<Sensitivity, "percent">, number> = {
	low: 4,
	medium: 3,
	high: 2,
};
const floorShare: Record<Exclude<Sensitivity, "percent">, number> = {
	low: 0.15,
	medium: 0.1,
	high: 0.05,
};

export interface Band {
	usual: number;
	low: number;
	high: number;
}

// Usual and the range around it, or null when there are too few earlier
// periods to say what usual is.
export function usualBand(
	values: number[],
	settings: AnomalySettings,
): Band | null {
	if (values.length < minPeriods) return null;
	const usual = median(values);
	let half: number;
	if (settings.sensitivity === "percent") {
		half = Math.abs(usual) * ((settings.percent ?? 0) / 100);
	} else {
		// The median distance from usual, scaled so it reads like a standard
		// deviation, and unmoved by the one odd week a mean would chase.
		const spread = 1.4826 * median(values.map((v) => Math.abs(v - usual)));
		half = Math.max(
			reach[settings.sensitivity] * spread,
			floorShare[settings.sensitivity] * Math.abs(usual),
		);
	}
	// A figure that has never been below zero, such as revenue or a count,
	// cannot usually be, so the range stops at zero rather than reading as
	// though a negative figure would be normal.
	const low = values.every((v) => v >= 0)
		? Math.max(0, usual - half)
		: usual - half;
	return { usual, low, high: usual + half };
}

export function isUnusual(
	value: number,
	band: Band,
	direction: Direction,
): boolean {
	const above = value > band.high;
	const below = value < band.low;
	return direction === "up"
		? above
		: direction === "down"
			? below
			: above || below;
}

// --- Reading ---------------------------------------------------------------------

export interface AnomalyReading {
	group: string | null;
	period: string;
	value: number | null;
	usual: number | null;
	low: number | null;
	high: number | null;
	unusual: boolean;
}

// Every group's latest finished period against its usual. A group missing
// from that period is left out rather than read as zero. For a total that
// would be right, and for an average or a rate it would be nonsense.
export function readAnomalies(
	rows: Record<string, unknown>[],
	options: {
		timeField: string;
		groupBy: string | null;
		measure: string;
		settings: AnomalySettings;
		today: string;
	},
): { period: string | null; readings: AnomalyReading[] } {
	const { timeField, groupBy, measure, settings, today } = options;
	const series = new Map<string | null, Map<string, number>>();
	const keys: string[] = [];
	for (const row of rows) {
		const key = periodKey(row[timeField]);
		const value = toNumber(row[measure]);
		if (!key || value === null) continue;
		keys.push(key);
		const group = groupBy ? groupLabel(row[groupBy]) : null;
		const byPeriod = series.get(group) ?? new Map<string, number>();
		byPeriod.set(key, value);
		series.set(group, byPeriod);
	}

	const spacing = spacingDays(keys);
	const target = targetPeriod(keys, spacing, today);
	if (!target) return { period: null, readings: [] };

	const readings: AnomalyReading[] = [];
	for (const [group, byPeriod] of series) {
		const value = byPeriod.get(target);
		if (value === undefined) continue;
		const baseline = baselineKeys(
			target,
			[...byPeriod.keys()],
			settings,
			spacing,
		).map((k) => byPeriod.get(k) as number);
		const band = usualBand(baseline, settings);
		const small =
			band !== null &&
			settings.minimum !== null &&
			Math.abs(band.usual) < settings.minimum;
		readings.push({
			group,
			period: target,
			value,
			usual: band?.usual ?? null,
			low: band?.low ?? null,
			high: band?.high ?? null,
			unusual:
				band !== null &&
				!small &&
				isUnusual(value, band, settings.direction),
		});
	}
	// The most unusual first, by how far outside usual they sit.
	const distance = (r: AnomalyReading) =>
		r.usual === null || r.value === null || r.usual === 0
			? 0
			: Math.abs((r.value - r.usual) / r.usual);
	readings.sort(
		(a, b) =>
			Number(b.unusual) - Number(a.unusual) || distance(b) - distance(a),
	);
	return { period: target, readings };
}

// What the history is compared with, in words.
export function describeComparison(settings: AnomalySettings): string {
	const sensitivity =
		settings.sensitivity === "percent"
			? `more than ${settings.percent}% off`
			: settings.sensitivity === "low"
				? "only big swings"
				: settings.sensitivity === "high"
					? "small swings too"
					: "clear swings";
	const against =
		settings.compareTo === "same_weekday"
			? `the same weekday over the last ${settings.periods} weeks`
			: `the ${settings.periods} periods before`;
	const way =
		settings.direction === "up"
			? ", upward only"
			: settings.direction === "down"
				? ", downward only"
				: "";
	return `against ${against}, ${sensitivity}${way}`;
}

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthNames = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

// A period in words, such as "Mon 28 Sep". Built by hand rather than by the
// locale, which spells September differently from one machine to the next.
export function describePeriod(key: string): string {
	const at = new Date(`${key}T00:00:00Z`);
	if (Number.isNaN(at.getTime())) return key;
	return `${weekdayNames[at.getUTCDay()]} ${at.getUTCDate()} ${monthNames[at.getUTCMonth()]}`;
}

// Today's date where the alert's owner is, since "the latest finished day"
// depends on whose day it is.
export function todayIn(timeZone: string, now = new Date()): string {
	try {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(now);
	} catch {
		return now.toISOString().slice(0, 10);
	}
}
