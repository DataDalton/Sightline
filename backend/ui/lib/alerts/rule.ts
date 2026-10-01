import type { Condition } from "../explore/conditions";
import { cleanState } from "../explore/state";
import {
	AnomalySettingsError,
	cleanAnomaly,
	describeComparison,
	describePeriod,
	type AnomalySettings,
} from "./anomaly";
import type { Reason } from "./completeness";
import { describeSpan } from "../freshness/arrivals";
import { cleanSchedule, type Schedule } from "./schedule";

// An alert: one measure, optionally split by a dimension, narrowed by the same
// conditions Explore writes, tested against a condition on a schedule.
//
// Everything in this file is pure. What reads the warehouse and what writes
// the inbox live elsewhere, so the decision of whether to tell somebody can be
// tested on its own.

export type AlertCondition =
	| "unusual"
	| "above"
	| "below"
	| "rises_by"
	| "falls_by"
	| "changes_by"
	| "changes";

export const alertConditions: AlertCondition[] = [
	"unusual",
	"above",
	"below",
	"rises_by",
	"falls_by",
	"changes_by",
	"changes",
];

export const conditionLabel: Record<AlertCondition, string> = {
	unusual: "is unusual",
	above: "is above",
	below: "is below",
	rises_by: "rises by more than",
	falls_by: "falls by more than",
	changes_by: "changes by more than",
	changes: "changes at all",
};

// Whether the threshold is a percentage of the last value rather than a value
// of the measure itself.
export function isRelative(condition: AlertCondition): boolean {
	return (
		condition === "rises_by" ||
		condition === "falls_by" ||
		condition === "changes_by"
	);
}

export function needsThreshold(condition: AlertCondition): boolean {
	return condition !== "changes" && condition !== "unusual";
}

export interface AlertDefinition {
	name: string;
	sourceKey: string;
	measure: string;
	// A dimension to test each value of separately, or null for the one total.
	groupBy: string | null;
	conditions: Condition[];
	condition: AlertCondition;
	threshold: number | null;
	schedule: Schedule;
	// For above and below: also say when the value is back on the right side.
	notifyRecover: boolean;
	// The history an unusual alert is judged against. Null otherwise.
	anomaly: AnomalySettings | null;
}

// The most groups one alert follows. Past this it is a report, not an alert,
// and the query that feeds it is bounded to the same number.
export const maxGroups = 200;
export const maxNameLength = 120;

export class AlertDefinitionError extends Error {}

export function cleanDefinition(raw: unknown): AlertDefinition {
	const r = (raw ?? {}) as Record<string, unknown>;
	const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

	const sourceKey = text(r.sourceKey);
	const measure = text(r.measure);
	if (!sourceKey) throw new AlertDefinitionError("Choose a dataset.");
	if (!measure) throw new AlertDefinitionError("Choose a measure to watch.");

	const condition = alertConditions.includes(r.condition as AlertCondition)
		? (r.condition as AlertCondition)
		: null;
	if (!condition) throw new AlertDefinitionError("Choose a condition.");

	let threshold: number | null = null;
	if (needsThreshold(condition)) {
		const n =
			typeof r.threshold === "number"
				? r.threshold
				: Number(text(r.threshold).replace(/[,$%\s]/g, ""));
		if (!Number.isFinite(n) || text(String(r.threshold ?? "")) === "") {
			throw new AlertDefinitionError(
				isRelative(condition)
					? "Enter the percentage to watch for."
					: "Enter the value to compare against.",
			);
		}
		if (isRelative(condition) && n <= 0) {
			throw new AlertDefinitionError(
				"The percentage has to be more than zero.",
			);
		}
		threshold = n;
	}

	let anomaly: AnomalySettings | null = null;
	if (condition === "unusual") {
		try {
			anomaly = cleanAnomaly(r.anomaly);
		} catch (error) {
			throw new AlertDefinitionError(
				error instanceof AnomalySettingsError
					? error.message
					: "The history to compare with is not set up.",
			);
		}
	}

	// The conditions are Explore's own, so they are checked the way a saved
	// exploration is.
	const state = cleanState({
		sourceKey,
		columns: [],
		conditions: Array.isArray(r.conditions) ? r.conditions : [],
	});

	const groupBy = text(r.groupBy) || null;
	const name =
		text(r.name).slice(0, maxNameLength) ||
		`${measure} ${conditionLabel[condition]}${threshold === null ? "" : ` ${threshold}`}`;

	return {
		name,
		sourceKey,
		measure,
		groupBy,
		conditions: state?.conditions ?? [],
		condition,
		threshold,
		schedule: cleanSchedule(r.schedule),
		notifyRecover: r.notifyRecover === true,
		anomaly,
	};
}

// --- Deciding --------------------------------------------------------------

export interface Reading {
	// The group's value as text, or null for the one total.
	group: string | null;
	value: number | null;
	// For an unusual alert, the period read, its usual figure and range, and whether
	// the value sits outside that range, confirmed.
	period?: string;
	usual?: number | null;
	low?: number | null;
	high?: number | null;
	unusual?: boolean;
	// Far below where it usually is by now, in a period that may still be
	// filling in, and why it reads that way. See lib/alerts/completeness.
	early?: boolean;
	reason?: Reason | null;
	// Hours since the period ended.
	ageHours?: number;
	// A period an earlier check saw as an early signal and did not report,
	// judged again now that more of it may have arrived.
	again?: boolean;
}

export interface GroupState {
	value: number | null;
	met: boolean;
	// For an unusual alert, the period last reported, so one period is
	// reported once however often the alert is checked, and once only when
	// an early signal is later confirmed.
	period?: string;
	// For an unusual alert, periods seen as an early signal and not reported,
	// which the next check judges again until each is confirmed or clears.
	pending?: string[];
}

// Periods one group keeps to judge again.
export const maxPending = 3;

// What was seen at the last check, by group. The total is stored under "".
export type AlertState = Record<string, GroupState>;

export interface Firing {
	group: string | null;
	value: number | null;
	previous: number | null;
	// Percentage change from the last check, for the relative conditions.
	change: number | null;
	kind: "fired" | "recovered";
	// For an unusual alert, the period and what was usual for it.
	period?: string;
	usual?: number | null;
	low?: number | null;
	high?: number | null;
	// For an unusual alert, sent on an early signal, or confirmed for a
	// period an earlier check saw only as one, and why.
	early?: boolean;
	again?: boolean;
	reason?: Reason | null;
	ageHours?: number;
}

function groupKey(group: string | null): string {
	return group ?? "";
}

function percentChange(value: number, previous: number): number | null {
	if (previous === 0) return null;
	return ((value - previous) / Math.abs(previous)) * 100;
}

// Compares this check with the last one and says what to tell the owner.
//
// A threshold fires when the value crosses it, not on every check it stays
// across: "Revenue is above target" once, rather than every morning until it
// is not. The first check counts as a crossing, so an alert saved while the
// condition already holds says so straight away.
//
// A change condition compares consecutive checks, so it fires on every check
// that moved far enough, and never on the first one, which has nothing to
// compare with. A group that has just appeared is treated the same way.
export function evaluate(
	definition: Pick<
		AlertDefinition,
		"condition" | "threshold" | "notifyRecover"
	> & { anomaly?: AnomalySettings | null },
	readings: Reading[],
	previous: AlertState,
): { state: AlertState; firings: Firing[] } {
	const state: AlertState = {};
	const firings: Firing[] = [];
	const t = definition.threshold ?? 0;
	const earlySignals = definition.anomaly?.earlySignals === true;

	for (const reading of readings) {
		const key = groupKey(reading.group);
		const before = previous[key];
		const value = reading.value;
		const last = before?.value ?? null;

		// Judged against its own history rather than the last check. Reported
		// once per period, since an hourly check reads the same finished day
		// all day. A period judged again comes before the latest one, so the
		// latest one's value is what is kept.
		if (definition.condition === "unusual") {
			// Periods waiting to be judged again are carried only by the
			// readings that judged them again, so one that can no longer be
			// read is let go.
			const held: GroupState = state[key] ?? {
				value: last,
				met: before?.met ?? false,
				period: before?.period,
			};
			const early = reading.early === true;
			const met = reading.unusual === true || (early && earlySignals);
			let period = held.period;
			if (met && held.period !== reading.period) {
				period = reading.period;
				firings.push({
					group: reading.group,
					value,
					previous: last,
					change:
						value !== null && reading.usual
							? ((value - reading.usual) /
									Math.abs(reading.usual)) *
								100
							: null,
					kind: "fired",
					period: reading.period,
					usual: reading.usual ?? null,
					low: reading.low ?? null,
					high: reading.high ?? null,
					early: reading.unusual !== true,
					again: reading.again === true,
					reason: reading.reason ?? null,
					ageHours: reading.ageHours,
				});
			}
			// An early signal not sent is judged again on the next check, so
			// it is sent once it is confirmed. One judged again and no longer
			// early is done with.
			let pending = (held.pending ?? []).filter(
				(p) => p !== reading.period,
			);
			if (early && !met && reading.period && reading.period !== period)
				pending = [...pending, reading.period].slice(-maxPending);
			state[key] = {
				value: reading.again ? held.value : value,
				met: reading.again ? held.met : met,
				...(period !== undefined ? { period } : {}),
				...(pending.length ? { pending } : {}),
			};
			continue;
		}

		let met = false;
		let change: number | null = null;
		switch (definition.condition) {
			case "above":
				met = value !== null && value > t;
				break;
			case "below":
				met = value !== null && value < t;
				break;
			case "rises_by":
			case "falls_by":
			case "changes_by":
				if (value !== null && last !== null) {
					change = percentChange(value, last);
					if (change !== null) {
						met =
							definition.condition === "rises_by"
								? change > t
								: definition.condition === "falls_by"
									? change < -t
									: Math.abs(change) > t;
					}
				}
				break;
			case "changes":
				met = before !== undefined && value !== last;
				break;
		}

		state[key] = { value, met };

		const threshold =
			definition.condition === "above" ||
			definition.condition === "below";
		if (threshold) {
			if (met && !before?.met) {
				firings.push({
					group: reading.group,
					value,
					previous: last,
					change: null,
					kind: "fired",
				});
			} else if (!met && before?.met && definition.notifyRecover) {
				firings.push({
					group: reading.group,
					value,
					previous: last,
					change: null,
					kind: "recovered",
				});
			}
		} else if (met) {
			firings.push({
				group: reading.group,
				value,
				previous: last,
				change,
				kind: "fired",
			});
		}
	}

	return { state, firings };
}

// --- Saying it -------------------------------------------------------------

export interface Wording {
	measure: string;
	groupBy: string | null;
	condition: AlertCondition;
	threshold: number | null;
	// Formats a value of the measure the way a report would show it.
	format: (value: number | null) => string;
	anomaly?: AnomalySettings | null;
}

function thresholdText(w: Wording): string {
	if (w.threshold === null) return "";
	return isRelative(w.condition)
		? `${Math.abs(w.threshold)}%`
		: w.format(w.threshold);
}

// The rule in one sentence, as the alert list shows it.
export function describeRule(w: Wording): string {
	const who = w.groupBy ? `${w.measure} for any ${w.groupBy}` : w.measure;
	if (w.condition === "unusual") {
		return `${who} is unusual${w.anomaly ? `, ${describeComparison(w.anomaly)}` : ""}`;
	}
	const t = thresholdText(w);
	return `${who} ${conditionLabel[w.condition]}${t ? ` ${t}` : ""}`;
}

// Why an unusual alert reads a period the way it does, when that is more than
// usual alone. An early signal says it may still be loading and why, and a
// figure confirmed early in its period says what rules loading out.
export function settlingNote(
	w: Pick<Wording, "groupBy">,
	f: Pick<Firing, "early" | "again" | "reason" | "ageHours">,
): string {
	if (f.early) {
		const why =
			f.reason === "evenDrop"
				? `Every ${w.groupBy ? `${w.groupBy} value` : "part of it"} fell by a similar share.`
				: f.reason === "noHistory" && f.ageHours !== undefined
					? `The period ended ${describeSpan(Math.max(f.ageHours, 0) * 3_600_000)} ago.`
					: "It is far below where it usually is by now.";
		return `Early signal. ${why} Data may still be loading.`;
	}
	if (f.again) return "Confirmed now that more of its data has arrived.";
	if (f.reason === "ledByOne")
		return w.groupBy
			? `It fell on its own while other ${w.groupBy} values held, so it is not data still loading.`
			: "One part of it carries the drop, so it is not data still loading.";
	return "";
}

function firingLine(w: Wording, f: Firing): string {
	const subject = f.group !== null ? `${f.group}: ` : "";
	const now = w.format(f.value);
	if (f.kind === "recovered") {
		return `${subject}${w.measure} is ${now}, back ${w.condition === "above" ? "at or below" : "at or above"} ${thresholdText(w)}`;
	}
	switch (w.condition) {
		case "unusual": {
			const when = f.period ? ` on ${describePeriod(f.period)}` : "";
			const pct =
				f.change === null
					? ""
					: ` (${f.change > 0 ? "+" : ""}${f.change.toFixed(0)}%)`;
			const note = settlingNote(w, f);
			return `${subject}${w.measure} was ${now}${when}, usually ${w.format(f.low ?? null)} to ${w.format(f.high ?? null)}${pct}${note ? `. ${note}` : ""}`;
		}
		case "above":
		case "below":
			return `${subject}${w.measure} is ${now}, ${w.condition} ${thresholdText(w)}`;
		case "changes":
			return `${subject}${w.measure} changed from ${w.format(f.previous)} to ${now}`;
		default: {
			const pct =
				f.change === null
					? ""
					: ` (${f.change > 0 ? "+" : ""}${f.change.toFixed(1)}%)`;
			return `${subject}${w.measure} went from ${w.format(f.previous)} to ${now}${pct}`;
		}
	}
}

// How many lines one message lists before summing up the rest.
const listedFirings = 5;

// One message per check, however many groups crossed. Ten notifications from
// one alert at once is noise, and the inbox entry lists them all anyway.
export function describeFirings(
	name: string,
	w: Wording,
	firings: Firing[],
): { title: string; body: string } | null {
	if (firings.length === 0) return null;

	const lines = firings.slice(0, listedFirings).map((f) => firingLine(w, f));
	const more = firings.length - listedFirings;
	if (more > 0) lines.push(`and ${more} more`);

	const allRecovered = firings.every((f) => f.kind === "recovered");
	const title =
		firings.length === 1
			? name
			: allRecovered
				? `${name}: ${firings.length} back to normal`
				: `${name}: ${firings.length} ${w.groupBy ? `${w.groupBy} values` : "changes"}`;

	return { title, body: lines.join("\n") };
}
