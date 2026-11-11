import { forecastRows, periodKey } from "../visuals/forecast";
// The working behind the insight features. Pure, so each can be tested with figures written
// out by hand. Nothing here says why a figure is what it is. It says where to look, what
// would need to move, and how far a guess can be trusted.

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

// --- Odd one out ---------------------------------------------------------------------

export interface OddOne {
	label: string;
	value: number;
	// How unusual, as a multiple of the normal spread. Higher ranks first.
	score: number;
	reason: string;
}

// Too few points cannot show what usual looks like.
export const minPointsForOdd = 6;
// The conventional line for a modified z score, past which a point is an outlier.
const oddScore = 3.5;
// Scales the median absolute deviation to stand in for a standard deviation.
const madScale = 1.4826;
const neighbours = 3;

// Points standing out from the rest, or on a time axis from those beside them, so a steady
// climb is not called unusual merely for its high end.
export function findOddOnes(
	points: { label: string; value: number }[],
	over: "time" | "category",
	format: (value: number) => string = String,
): OddOne[] {
	const valid = points.filter((point) => Number.isFinite(point.value));
	if (valid.length < minPointsForOdd) return [];

	const usualFor = (index: number): number => {
		if (over === "category") return median(valid.map((p) => p.value));
		const near = valid.filter(
			(_, other) =>
				other !== index && Math.abs(other - index) <= neighbours,
		);
		return median(near.map((p) => p.value));
	};
	const usual = valid.map((_, index) => usualFor(index));
	const gaps = valid.map((point, index) => point.value - usual[index]);
	const spread =
		median(gaps.map((gap) => Math.abs(gap - median(gaps)))) * madScale;
	if (spread === 0) return [];

	return valid
		.flatMap((point, index) => {
			const score = Math.abs(gaps[index]) / spread;
			if (score < oddScore) return [];
			return [
				{
					label: point.label,
					value: point.value,
					score,
					reason: `${format(point.value)}, ${gaps[index] > 0 ? "well above" : "well below"} the usual ${format(usual[index])}`,
				},
			];
		})
		.sort((a, b) => b.score - a.score);
}

// --- What would have to be true --------------------------------------------------------

export interface WouldHaveToBe {
	gap: number;
	// The change every part would need if they all moved by the same share.
	everyonePercent: number | null;
	// What each part would need to do if it closed the gap by itself, closest to doable first.
	singles: {
		label: string;
		current: number;
		needed: number;
		percent: number | null;
	}[];
}

export function wouldHaveToBe(
	current: number,
	target: number,
	parts: { label: string; value: number }[],
): WouldHaveToBe {
	const gap = target - current;
	const percentOf = (base: number) =>
		base === 0 ? null : (gap / Math.abs(base)) * 100;
	return {
		gap,
		everyonePercent: percentOf(current),
		singles: parts
			.map((part) => ({
				label: part.label,
				current: part.value,
				needed: part.value + gap,
				percent: percentOf(part.value),
			}))
			.sort(
				(a, b) =>
					Math.abs(a.percent ?? Infinity) -
					Math.abs(b.percent ?? Infinity),
			),
	};
}

// --- What if ---------------------------------------------------------------------------

export interface Scenario {
	measure: string;
	percent: number;
	// Limits the change to one value, such as only one region.
	field?: string | null;
	value?: string | null;
}

// Rows as they would read if the assumption held. A measure worked out from another is not
// followed, since this changes figures on screen and asks the warehouse nothing.
export function applyScenario<T extends Record<string, unknown>>(
	rows: T[],
	scenario: Scenario | Scenario[] | null,
): T[] {
	const list = toScenarios(scenario);
	if (list.length === 0) return rows;
	return rows.map((row) => {
		let moved: T = row;
		for (const held of list) {
			if (!(held.measure in moved)) continue;
			if (
				held.field &&
				held.value &&
				String(moved[held.field]) !== held.value
			) {
				continue;
			}
			const number = Number(moved[held.measure]);
			if (!Number.isFinite(number)) continue;
			moved = {
				...moved,
				[held.measure]: number * (1 + held.percent / 100),
			};
		}
		return moved;
	});
}

// The assumptions that actually change anything, however they arrived.
function toScenarios(scenario: Scenario | Scenario[] | null): Scenario[] {
	const list = Array.isArray(scenario)
		? scenario
		: scenario
			? [scenario]
			: [];
	return list.filter((held) => held.percent !== 0);
}

// How much one figure moves, given the values it is known to sit within. A figure adding up
// more than the chosen value cannot be split on screen, so it stays as read.
export function scenarioFactor(
	scenario: Scenario | Scenario[] | null,
	measure: string,
	within: Record<string, string>,
): number {
	return toScenarios(scenario).reduce((factor, held) => {
		if (held.measure !== measure) return factor;
		if (held.field && held.value && within[held.field] !== held.value) {
			return factor;
		}
		return factor * (1 + held.percent / 100);
	}, 1);
}

// --- Visuals built on forecasts, for the page and for paper ------------------------------

export function paceFromRows(
	rows: Record<string, unknown>[],
	periodField: string,
	measure: string,
	target: number,
	today: string,
): { pace: Pace; year: string; forecasted: boolean } {
	const year = today.slice(0, 4);
	const forecast = forecastRows(rows, periodField, [measure], {
		horizon: 12,
		today,
		additive: { [measure]: true },
	});
	const actuals = rows.flatMap((row) => {
		const period = periodKey(row[periodField]);
		const value = Number(row[measure]);
		return period?.startsWith(year) &&
			Number.isFinite(value) &&
			(!forecast || period <= forecast.anchorPeriod)
			? [value]
			: [];
	});
	const remaining = forecast
		? forecast.periods.flatMap((period, index) =>
				period.startsWith(year)
					? [forecast.series[0].values[index]]
					: [],
			)
		: [];
	return {
		pace: paceToTarget(actuals, remaining, target),
		year,
		forecasted: Boolean(forecast),
	};
}

export interface RankedForecast {
	group: string;
	next: number;
	low: number;
	high: number;
	trend: string | null | undefined;
}

export function rankForecasts(
	rows: Record<string, unknown>[],
	groupField: string,
	periodField: string,
	measure: string,
	today: string,
): RankedForecast[] {
	const groups = new Map<string, Record<string, unknown>[]>();
	for (const row of rows) {
		const key = String(row[groupField] ?? "(blank)");
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	return [...groups.entries()]
		.flatMap(([group, members]) => {
			const forecast = forecastRows(members, periodField, [measure], {
				horizon: 1,
				today,
				additive: { [measure]: true },
			});
			const series = forecast?.series[0];
			if (!forecast || !series) return [];
			const last = series.values.length - 1;
			return [
				{
					group,
					next: series.values[last],
					low: series.lower[last],
					high: series.upper[last],
					trend: series.trend,
				},
			];
		})
		.sort((a, b) => b.next - a.next);
}

// --- Living narrative --------------------------------------------------------------------

export type NarrativeToken =
	| { kind: "value"; text: string; measure: string }
	| {
			kind: "extreme";
			text: string;
			which: "top" | "bottom";
			dimension: string;
			measure: string;
	  };

const tokenPattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
const extremePattern = /^(top|bottom)\s+(.+?)\s+by\s+(.+)$/i;

// {{Revenue}}, {{top Region by Revenue}} and {{bottom Region by Revenue}}.
export function parseNarrative(html: string): NarrativeToken[] {
	const seen = new Map<string, NarrativeToken>();
	for (const match of html.matchAll(tokenPattern)) {
		const body = match[1].replace(/&nbsp;/g, " ").replace(/<[^>]*>/g, "");
		const extreme = body.match(extremePattern);
		seen.set(
			match[0],
			extreme
				? {
						kind: "extreme",
						text: match[0],
						which: extreme[1].toLowerCase() as "top" | "bottom",
						dimension: extreme[2].trim(),
						measure: extreme[3].trim(),
					}
				: { kind: "value", text: match[0], measure: body.trim() },
		);
	}
	return [...seen.values()];
}

export function escapeForHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// The text with each token's answer in place. Answers are escaped, since a value in the
// data has no business being read as markup.
export function fillNarrative(
	html: string,
	answers: Map<string, string>,
): string {
	return html.replace(tokenPattern, (whole) =>
		escapeForHtml(answers.get(whole) ?? "-"),
	);
}

// What the assistant is told when asked for a first draft of live text. Field names only,
// never a figure, so nothing it writes can go stale. The numbers come from the placeholders.
export function narrativeDraftPrompt(input: {
	sourceTitle: string;
	dimensions: string[];
	measures: string[];
	about: string;
}): { system: string; user: string } {
	return {
		system: [
			"You write a short live summary for a report page, in two to four plain sentences.",
			"Numbers appear only through placeholders, which the page fills in from live data.",
			"{{Measure}} gives a measure's value. {{top Dimension by Measure}} and {{bottom Dimension by Measure}} give the name with the highest or lowest value.",
			"Use only the field names given, spelled exactly. Never write a figure, a percentage, a trend, a date or a claim that a number went up or down, since you are not given any data.",
			"Answer with only the sentences.",
		].join(" "),
		user: JSON.stringify({
			source: input.sourceTitle,
			about: input.about,
			dimensions: input.dimensions,
			measures: input.measures,
		}),
	};
}

// Keeps sentences whose placeholders are all real and which state no figure of their own, so
// a made up field or a remembered number never reaches the page.
export function cleanNarrativeDraft(
	answer: string,
	fields: { dimensions: string[]; measures: string[] },
): string {
	const measures = new Set(fields.measures);
	const dimensions = new Set(fields.dimensions);
	const sentences = answer
		.replace(/\s+/g, " ")
		.trim()
		.match(/[^.!?]+(?:[.!?]+|$)/g);
	const kept = (sentences ?? []).filter((sentence) => {
		const tokens = parseNarrative(sentence);
		const real = tokens.every((token) =>
			token.kind === "value"
				? measures.has(token.measure)
				: measures.has(token.measure) &&
					dimensions.has(token.dimension),
		);
		const bare = sentence.replace(tokenPattern, "");
		return real && tokens.length > 0 && !/\d/.test(bare);
	});
	if (kept.length === 0) return "";
	return `<p>${escapeForHtml(kept.map((s) => s.trim()).join(" "))}</p>`;
}

// --- Forecasts --------------------------------------------------------------------------

export interface ForecastRecord {
	period: string;
	predicted: number;
	low: number;
	high: number;
	actual: number | null;
}

export interface ForecastScore {
	scored: number;
	withinRange: number;
	// Typical miss, as a share of the actual, in percentage points. Null with nothing to score.
	typicalMissPercent: number | null;
}

export function scoreForecasts(records: ForecastRecord[]): ForecastScore {
	const scored = records.filter((record) => record.actual !== null);
	const misses = scored
		.filter((record) => record.actual !== 0)
		.map(
			(record) =>
				(Math.abs((record.actual as number) - record.predicted) /
					Math.abs(record.actual as number)) *
				100,
		);
	return {
		scored: scored.length,
		withinRange: scored.filter(
			(record) =>
				(record.actual as number) >= record.low &&
				(record.actual as number) <= record.high,
		).length,
		typicalMissPercent: misses.length > 0 ? median(misses) : null,
	};
}

// What a forecast card has to save, against what is already kept. A period with a record
// keeps its first forecast, so only periods without one are sent, and an actual is sent only
// where a record exists and holds a different value. Empty lists mean nothing to save.
export function forecastChanges(
	records: ForecastRecord[],
	forecasts: {
		period: string;
		predicted: number;
		low: number;
		high: number;
	}[],
	actuals: { period: string; value: number }[],
): {
	forecasts: {
		period: string;
		predicted: number;
		low: number;
		high: number;
	}[];
	actuals: { period: string; value: number }[];
} {
	const held = new Map(records.map((record) => [record.period, record]));
	return {
		forecasts: forecasts.filter((forecast) => !held.has(forecast.period)),
		actuals: actuals.filter((actual) => {
			const record = held.get(actual.period);
			return record !== undefined && record.actual !== actual.value;
		}),
	};
}

export interface Pace {
	expected: number;
	target: number;
	percent: number;
	onPace: boolean;
}

// Where a figure that adds up is heading by the end of the year, against its target. What has
// happened plus what is forecast for the rest.
export function paceToTarget(
	actuals: number[],
	forecasts: number[],
	target: number,
): Pace {
	const expected =
		actuals.reduce((sum, value) => sum + value, 0) +
		forecasts.reduce((sum, value) => sum + value, 0);
	return {
		expected,
		target,
		percent: target === 0 ? 0 : (expected / target) * 100,
		onPace: expected >= target,
	};
}

// --- Goals --------------------------------------------------------------------------------

// Percentage points a goal can trail a steady line before it counts as behind.
const behindLeeway = 5;

export interface GoalStatus {
	percent: number;
	// Where a steady line from start to target says it should be by now.
	expectedPercent: number | null;
	state: "done" | "onTrack" | "behind" | "late";
}

// Measured from where it started, so reaching for a lower number works like a higher one.
export function goalStatus(input: {
	start: number;
	current: number;
	target: number;
	startedOn: string;
	dueOn: string | null;
	now: number;
}): GoalStatus {
	const { start, current, target } = input;
	const span = target - start;
	const percent =
		span === 0
			? current === target
				? 100
				: 0
			: ((current - start) / span) * 100;
	const done = span >= 0 ? current >= target : current <= target;
	if (done) return { percent, expectedPercent: null, state: "done" };
	if (!input.dueOn)
		return { percent, expectedPercent: null, state: "onTrack" };

	const begin = new Date(input.startedOn).getTime();
	const end = new Date(input.dueOn).getTime();
	if (input.now > end)
		return { percent, expectedPercent: 100, state: "late" };
	const expectedPercent =
		end > begin ? ((input.now - begin) / (end - begin)) * 100 : 100;
	return {
		percent,
		expectedPercent,
		// A little leeway, so a goal set this morning is not behind by this afternoon.
		state: percent + behindLeeway >= expectedPercent ? "onTrack" : "behind",
	};
}
