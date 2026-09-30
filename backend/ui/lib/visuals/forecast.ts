// Forecasting a chart's measures a few periods past its last date.
//
// Worked out in the browser from the rows the chart already holds, so a
// forecast costs no query and moves with every filter the reader changes.
// Several candidate models are fitted to each measure and the one that did
// best at predicting stretches of recent history as long as the forecast
// itself is kept. A series with growth and a yearly shape gets a regression on
// its trend and calendar, a steady climb gets a trend, and a short repeating
// cycle gets a seasonal forecast, without the author having to know which is
// which.
//
// Everything here is a pure function of its inputs and never throws. A series
// too short, too irregular or too gappy to forecast is left out rather than
// guessed at.

export type PeriodUnit = "day" | "week" | "month" | "quarter" | "year";

// How far apart a chart's periods sit. A monthly series whose dates are the
// last day of each month keeps landing on month ends, which a fixed day of
// the month cannot do once a short month has clamped it.
export interface Spacing {
	unit: PeriodUnit;
	monthEnd: boolean;
}

export type ForecastModel =
	| "flat"
	| "seasonalNaive"
	| "holt"
	| "holtWinters"
	| "seasonalRegression";

export type TrendDirection = "up" | "down" | "flat";

export interface SeriesForecast {
	measure: string;
	model: ForecastModel;
	// The last value the model was fitted on, where the drawn forecast line
	// starts so it continues from the history rather than floating free.
	anchor: number;
	// One entry per forecast period, in order.
	values: number[];
	// The range four in five outcomes are expected to fall in.
	lower: number[];
	upper: number[];
	// The chosen model's typical miss on a single period when it was tested
	// against recent history, as a fraction of the value. Null where the
	// values sit near zero and a percentage would say nothing useful.
	typicalError: number | null;
	// The typical miss on the total, or the average, over a stretch as long as
	// the forecast. Single periods are dominated by noise that cancels out
	// over the stretch, so this is the figure a reader planning ahead needs.
	totalError: number | null;
	// Whether the measure adds up across periods, such as revenue, so the
	// accuracy note speaks of the period total rather than its average.
	additive: boolean;
	// Which way the underlying level moves over the forecast. Null for a
	// model that carries no trend.
	trend: TrendDirection | null;
	// Whether the forecast follows a pattern across the year, and the busiest
	// stretch of it as a month index, or the first and last of two or three
	// months in a row. Null when the dates are not known.
	yearly: boolean;
	yearlyPeak: number[] | null;
	// Whether the forecast follows a pattern across the week, and its busiest
	// day with Sunday as zero.
	weekly: boolean;
	weeklyPeak: number | null;
	// The periods a repeating model looks back, such as seven for last week.
	lag: number | null;
}

export interface ForecastResult {
	spacing: Spacing;
	// The last finished period, which every forecast continues from.
	anchorPeriod: string;
	// The periods forecast, as plain dates. Periods already on the chart but
	// not yet finished come first, then the ones past the chart's end.
	periods: string[];
	// How many periods past the chart's last date are forecast.
	horizon: number;
	series: SeriesForecast[];
}

// The most periods ahead a forecast reaches, whatever the author asks for.
// Much past these the range is wide enough to say nothing.
export const maxHorizonByUnit: Record<PeriodUnit, number> = {
	day: 180,
	week: 104,
	month: 36,
	quarter: 12,
	year: 5,
};

// More series than this draw a tangle of dashed lines and bands, so the
// forecast is left off rather than drawn unreadably.
export const maxForecastSeries = 6;

// The fewest finished periods a series needs before any model is fitted.
export const minHistory = 8;

// Two sided coverage of roughly four in five for a normal error.
const bandZ = 1.28;

// A more complex model has to beat a simpler one by more than this share of
// the simpler one's error, so a difference that is noise goes to the simpler.
const tieTolerance = 0.02;

// Longest grid the history is laid out on. A series irregular enough to need
// more slots than this is not a series the models below can read.
const maxGrid = 5000;

const dayMs = 86_400_000;

// The repeating cycle the smoothing models carry, per unit. Daily data
// repeats by the week, and the longer units by the year.
const seasonByUnit: Record<PeriodUnit, number | null> = {
	day: 7,
	week: 52,
	month: 12,
	quarter: 4,
	year: null,
};

// The same period one year earlier, in periods.
const yearLagByUnit: Record<PeriodUnit, number | null> = {
	day: 365,
	week: 52,
	month: 12,
	quarter: 4,
	year: null,
};

// --- Periods ---------------------------------------------------------------

const leadingDate =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?)?$/;

// A value as a plain date, or null when it is not a date at midnight. A
// timestamp with a time of day is a finer grain than a period and is refused.
export function periodKey(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const match = leadingDate.exec(String(value).trim());
	if (!match) return null;
	const [, y, m, d] = match;
	const month = Number(m);
	const day = Number(d);
	if (month < 1 || month > 12 || day < 1) return null;
	if (day > daysInMonth(Number(y), month - 1)) return null;
	return `${y}-${m}-${d}`;
}

function daysInMonth(year: number, monthIndex: number): number {
	return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function parts(key: string): [number, number, number] {
	return [
		Number(key.slice(0, 4)),
		Number(key.slice(5, 7)) - 1,
		Number(key.slice(8, 10)),
	];
}

function format(year: number, monthIndex: number, day: number): string {
	const y = String(year).padStart(4, "0");
	const m = String(monthIndex + 1).padStart(2, "0");
	const d = String(day).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function dayNumber(key: string): number {
	const [y, m, d] = parts(key);
	return Math.round(Date.UTC(y, m, d) / dayMs);
}

const monthsByUnit: Partial<Record<PeriodUnit, number>> = {
	month: 1,
	quarter: 3,
	year: 12,
};

// The period a whole number of steps from a start. Calendar units count
// months, so a quarter after the first of January is the first of April
// whatever the month lengths between.
export function shiftPeriod(
	start: string,
	spacing: Spacing,
	count: number,
): string {
	const [y, m, d] = parts(start);
	const months = monthsByUnit[spacing.unit];
	if (months === undefined) {
		const days = spacing.unit === "week" ? 7 : 1;
		const at = new Date(Date.UTC(y, m, d) + count * days * dayMs);
		return format(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
	}
	const total = y * 12 + m + count * months;
	const year = Math.floor(total / 12);
	const monthIndex = total - year * 12;
	const last = daysInMonth(year, monthIndex);
	return format(
		year,
		monthIndex,
		spacing.monthEnd ? last : Math.min(d, last),
	);
}

// The spacing of a sorted list of plain dates, read from the typical gap
// between neighbours so one missing period does not change the answer. Null
// when the gap is not one of the units a forecast is offered for.
export function inferSpacing(periods: string[]): Spacing | null {
	if (periods.length < 2) return null;
	const gaps: number[] = [];
	for (let i = 1; i < periods.length; i++) {
		gaps.push(dayNumber(periods[i]) - dayNumber(periods[i - 1]));
	}
	gaps.sort((a, b) => a - b);
	const gap = gaps[Math.floor(gaps.length / 2)];

	let unit: PeriodUnit | null = null;
	if (gap === 1) unit = "day";
	else if (gap === 7) unit = "week";
	else if (gap >= 28 && gap <= 31) unit = "month";
	else if (gap >= 89 && gap <= 92) unit = "quarter";
	else if (gap >= 365 && gap <= 366) unit = "year";
	if (!unit) return null;

	// Month ends only when every date is one and at least one falls on a day
	// no short month has, so dates on the 28th stay on the 28th.
	let monthEnd = false;
	if (monthsByUnit[unit] !== undefined) {
		monthEnd = periods.every((p) => {
			const [y, m, d] = parts(p);
			return d === daysInMonth(y, m);
		});
		monthEnd = monthEnd && periods.some((p) => parts(p)[2] >= 30);
	}
	return { unit, monthEnd };
}

// A period is finished once the period after it has started by today. The
// current month on the first of the month has only just begun, and its total
// so far would drag any forecast down.
export function isFinished(
	period: string,
	spacing: Spacing,
	today: string,
): boolean {
	return shiftPeriod(period, spacing, 1) <= today;
}

// Periods ahead when the author has not said. A season's worth where the
// history is long enough to show one, such as a quarter of days or a year of
// months, and about a fifth of what the chart shows otherwise. Never more
// periods than the chart shows, so the forecast reads as a continuation
// rather than the main event.
export function defaultHorizon(unit: PeriodUnit, shown: number): number {
	let periods: number;
	switch (unit) {
		case "day":
			periods = shown >= 365 ? 90 : shown / 5;
			break;
		case "week":
			periods = 13;
			break;
		case "month":
			periods = shown >= 24 ? 12 : 6;
			break;
		case "quarter":
			periods = 4;
			break;
		default:
			periods = shown / 5;
	}
	return clampHorizon(unit, Math.min(periods, shown));
}

function clampHorizon(unit: PeriodUnit, value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(maxHorizonByUnit[unit], Math.max(1, Math.round(value)));
}

// Today as a plain date in the reader's own time zone, which is the calendar
// a reader means by "this month".
export function localToday(now: Date = new Date()): string {
	return format(now.getFullYear(), now.getMonth(), now.getDate());
}

// --- Smoothing models --------------------------------------------------------

interface Params {
	alpha: number;
	beta: number;
	gamma: number;
	phi: number;
}

// Smoothing state. The seasonal terms live in a ring indexed by the position
// of the observation modulo the season.
interface State {
	level: number;
	trend: number;
	seasonal: Float64Array | null;
	// Index of the next observation the state has not seen.
	t: number;
}

interface Grid {
	alphas: number[];
	betas: number[];
	gammas: number[];
	phis: number[];
}

// Parameter grids. A fit tries every combination once, one pass over the
// history each, so the grid sizes multiplied together bound the cost of a
// fit. A damping factor of one is an undamped trend, so damping is chosen
// only where it fits better. The coarse grids serve the backtest, which fits
// once per origin, and the full ones the final fit.
const holtGrid: Grid = {
	alphas: [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9],
	betas: [0.01, 0.05, 0.1, 0.2, 0.3],
	gammas: [0],
	phis: [0.8, 0.9, 0.95, 0.98, 1],
};
const holtCoarse: Grid = {
	alphas: [0.1, 0.3, 0.6, 0.9],
	betas: [0.01, 0.1, 0.3],
	gammas: [0],
	phis: [0.9, 0.98, 1],
};
const hwGrid: Grid = {
	alphas: [0.05, 0.1, 0.2, 0.4, 0.7],
	betas: [0.01, 0.05, 0.15, 0.3],
	gammas: [0.05, 0.1, 0.3, 0.5],
	phis: [0.85, 0.92, 0.98, 1],
};
const hwCoarse: Grid = {
	alphas: [0.1, 0.3, 0.6],
	betas: [0.01, 0.1],
	gammas: [0.05, 0.2, 0.5],
	phis: [0.9, 1],
};

type Smoothing = "holt" | "holtWinters";

// Sum of phi^1 through phi^h, the share of the trend a damped model still
// carries h periods out.
function dampedSum(phi: number, h: number): number {
	if (phi === 1) return h;
	let sum = 0;
	let power = 1;
	for (let i = 1; i <= h; i++) {
		power *= phi;
		sum += power;
	}
	return sum;
}

// The starting state from the first observations. Holt starts at the first
// value with the average early slope. Holt-Winters starts at the first
// season's mean, with a trend from the change to the second season when the
// history has one, and a seasonal term per position taken off that line.
function initialState(
	model: Smoothing,
	y: Float64Array,
	season: number,
	upto: number,
	ring: Float64Array | null,
): State {
	if (model === "holt") {
		const k = Math.min(upto - 1, 3);
		return {
			level: y[0],
			trend: k > 0 ? (y[k] - y[0]) / k : 0,
			seasonal: null,
			t: 1,
		};
	}
	const m = season;
	let first = 0;
	for (let i = 0; i < m; i++) first += y[i];
	first /= m;
	let trend = 0;
	if (upto >= 2 * m) {
		let second = 0;
		for (let i = m; i < 2 * m; i++) second += y[i];
		trend = (second / m - first) / m;
	}
	const seasonal = ring ?? new Float64Array(m);
	const centre = (m - 1) / 2;
	for (let i = 0; i < m; i++) {
		seasonal[i] = y[i] - (first + trend * (i - centre));
	}
	return { level: first + trend * centre, trend, seasonal, t: m };
}

function project(state: State, p: Params, season: number, h: number): number {
	const base = state.level + dampedSum(p.phi, h) * state.trend;
	if (!state.seasonal) return base;
	return base + state.seasonal[(state.t + h - 1) % season];
}

function update(state: State, p: Params, season: number, value: number): void {
	const previous = state.level;
	const damped = p.phi * state.trend;
	if (state.seasonal) {
		const slot = state.t % season;
		const s = state.seasonal[slot];
		state.level =
			p.alpha * (value - s) + (1 - p.alpha) * (previous + damped);
		state.trend = p.beta * (state.level - previous) + (1 - p.beta) * damped;
		state.seasonal[slot] =
			p.gamma * (value - state.level) + (1 - p.gamma) * s;
	} else {
		state.level = p.alpha * value + (1 - p.alpha) * (previous + damped);
		state.trend = p.beta * (state.level - previous) + (1 - p.beta) * damped;
	}
	state.t++;
}

// Sum of squared one step errors over y[start..upto) for one parameter set.
function oneStepSse(
	model: Smoothing,
	p: Params,
	y: Float64Array,
	season: number,
	upto: number,
	ring: Float64Array | null,
): number {
	const state = initialState(model, y, season, upto, ring);
	let sse = 0;
	for (let t = state.t; t < upto; t++) {
		const error = y[t] - project(state, p, season, 1);
		sse += error * error;
		update(state, p, season, y[t]);
	}
	return sse;
}

// The grid point with the lowest one step squared error on y[0..upto).
function fitParams(
	model: Smoothing,
	y: Float64Array,
	season: number,
	upto: number,
	grid: Grid,
): Params {
	const ring = model === "holtWinters" ? new Float64Array(season) : null;
	let best: Params = { alpha: 0.3, beta: 0.05, gamma: 0, phi: 0.9 };
	let bestSse = Infinity;
	for (const alpha of grid.alphas) {
		for (const beta of grid.betas) {
			for (const gamma of grid.gammas) {
				for (const phi of grid.phis) {
					const p = { alpha, beta, gamma, phi };
					const sse = oneStepSse(model, p, y, season, upto, ring);
					if (sse < bestSse) {
						bestSse = sse;
						best = p;
					}
				}
			}
		}
	}
	return best;
}

// The smoothing model fitted to y[0..upto), with its state after the last
// observation and its one step residual spread.
function runSmoothing(
	model: Smoothing,
	y: Float64Array,
	season: number,
	upto: number,
	grid: Grid,
): { p: Params; state: State; sigma: number } {
	const p = fitParams(model, y, season, upto, grid);
	const state = initialState(model, y, season, upto, null);
	let sq = 0;
	let count = 0;
	for (let t = state.t; t < upto; t++) {
		const e = y[t] - project(state, p, season, 1);
		sq += e * e;
		count++;
		update(state, p, season, y[t]);
	}
	return { p, state, sigma: Math.sqrt(sq / Math.max(1, count)) };
}

// --- Seasonal regression -------------------------------------------------------
//
// Least squares on a trend in time, optionally bending once, a smooth yearly
// cycle made of sine and cosine pairs of the time of year, and one level per
// day of the week. Fitted to the values themselves, or to their logarithms
// where every value is above zero, which makes growth and the seasonal swing
// proportional to the level. The columns are laid out once for the whole
// history and the forecast, and the cross products are summed once, with a
// copy taken at each backtest origin, so every candidate at every origin is a
// small solve rather than another pass over the rows.

// Share of each penalised column's own sum of squares added to its diagonal,
// which keeps a harmonic or a bend the data barely supports near zero.
const ridge = 0.01;

// Where the trend may bend, as shares of the history, all in its later
// part where a change of pace matters to the forecast.
const bendShares = [0.45, 0.6, 0.75];

// Harmonics tried for the yearly cycle, per unit. Monthly data has twelve
// positions, so six harmonics give each month its own level. Quarterly data
// likewise with two.
const harmonicsByUnit: Record<PeriodUnit, number[]> = {
	day: [3, 6, 10],
	week: [3, 6, 10],
	month: [2, 3, 5, 6],
	quarter: [1, 2],
	year: [],
};

// Positions in a year for the units read at whole positions, where the
// harmonic at half the count has no sine term.
const positionsByUnit: Partial<Record<PeriodUnit, number>> = {
	month: 12,
	quarter: 4,
};

// The shortest history a yearly cycle is forecast from, about a year and a
// quarter so each part of the year has been seen at least once and the
// cycle can be told apart from the trend.
const yearlyMinByUnit: Record<PeriodUnit, number> = {
	day: 456,
	week: 65,
	month: 15,
	quarter: 6,
	year: Infinity,
};

// Periods in a year. A backtest origin needs one whole year behind it to
// test a yearly cycle, which lets the earliest origin sit a year back and
// judge the cycle on last year's busy season.
const yearLengthByUnit: Record<PeriodUnit, number | null> = {
	day: 365,
	week: 52,
	month: 12,
	quarter: 4,
	year: null,
};

// The training a yearly cycle of k harmonics needs at a backtest origin.
// Harmonic counts that give every position its own level need several full
// years before they are trusted.
function harmonicMin(unit: PeriodUnit, k: number): number {
	const positions = positionsByUnit[unit];
	if (positions !== undefined && 2 * k >= positions) return 3 * positions;
	return yearLengthByUnit[unit] ?? Infinity;
}

// Days of the week are fitted once the history holds this many.
const weeklyMin = 56;

// Days before the fifteenth of each month in a year without a leap day, the
// point in the year a month's seasonal level is read at.
const monthMidDays = [14, 45, 73, 104, 134, 165, 195, 226, 257, 287, 318, 348];

// Where each slot falls in the calendar, for the history and the forecast.
interface CalendarSlots {
	// Share of the year elapsed at the slot, from zero to one.
	phase: Float64Array;
	// Day of the week with Sunday as zero.
	dow: Int8Array;
	// Whether the slots come from real dates, so a month or a day can be
	// named. Without dates the positions are counted from the first slot.
	named: boolean;
}

export interface SeriesCalendar {
	// The date of the first value.
	start: string;
	spacing: Spacing;
}

function calendarSlots(
	unit: PeriodUnit,
	total: number,
	calendar: SeriesCalendar | undefined,
): CalendarSlots {
	const phase = new Float64Array(total);
	const dow = new Int8Array(total);
	for (let t = 0; t < total; t++) {
		if (calendar) {
			const key = shiftPeriod(calendar.start, calendar.spacing, t);
			const [year, month] = parts(key);
			const day = dayNumber(key);
			dow[t] = (((day + 4) % 7) + 7) % 7;
			if (unit === "month") phase[t] = month / 12;
			else if (unit === "quarter") phase[t] = Math.floor(month / 3) / 4;
			else {
				const jan1 = Math.round(Date.UTC(year, 0, 1) / dayMs);
				const length =
					Math.round(Date.UTC(year + 1, 0, 1) / dayMs) - jan1;
				phase[t] = (day - jan1) / length;
			}
		} else {
			dow[t] = t % 7;
			const perYear =
				unit === "day"
					? 365.25
					: unit === "week"
						? 365.25 / 7
						: unit === "month"
							? 12
							: 4;
			phase[t] = (t % perYear) / perYear;
		}
	}
	return { phase, dow, named: calendar !== undefined };
}

// The columns laid out for the history and the forecast.
interface Design {
	cols: number;
	// Row major, one row per slot of history and forecast.
	x: Float64Array;
	penalised: Uint8Array;
	// Slots the trend may bend at, and the column of each bend.
	bends: number[];
	bendStart: number;
	// Columns used by the first k harmonics, indexed by k.
	fourierStart: number;
	fourierCols: number[];
	// First of the six day of week columns, or -1 when there are none.
	dowStart: number;
}

function buildDesign(
	unit: PeriodUnit,
	slots: CalendarSlots,
	n: number,
	total: number,
): Design {
	const bends =
		n >= 20 ? [...new Set(bendShares.map((s) => Math.round(n * s)))] : [];
	const positions = positionsByUnit[unit];
	const harmonics =
		n >= yearlyMinByUnit[unit] ? Math.max(0, ...harmonicsByUnit[unit]) : 0;
	const fourierCols = [0];
	for (let k = 1; k <= harmonics; k++) {
		const hasSine = positions === undefined || 2 * k < positions;
		fourierCols.push(fourierCols[k - 1] + (hasSine ? 2 : 1));
	}
	const weekly = unit === "day" && n >= weeklyMin;

	const bendStart = 2;
	const fourierStart = bendStart + bends.length;
	const dowStart = weekly ? fourierStart + fourierCols[harmonics] : -1;
	const cols = fourierStart + fourierCols[harmonics] + (weekly ? 6 : 0);

	const x = new Float64Array(total * cols);
	const penalised = new Uint8Array(cols);
	for (let c = bendStart; c < cols; c++) penalised[c] = 1;
	for (let t = 0; t < total; t++) {
		const row = t * cols;
		x[row] = 1;
		x[row + 1] = t / n;
		for (let b = 0; b < bends.length; b++) {
			x[row + bendStart + b] = Math.max(0, t - bends[b]) / n;
		}
		let c = row + fourierStart;
		for (let k = 1; k <= harmonics; k++) {
			const angle = 2 * Math.PI * k * slots.phase[t];
			x[c++] = Math.cos(angle);
			if (fourierCols[k] - fourierCols[k - 1] === 2) {
				x[c++] = Math.sin(angle);
			}
		}
		if (weekly && slots.dow[t] > 0) {
			x[row + dowStart + slots.dow[t] - 1] = 1;
		}
	}
	return {
		cols,
		x,
		penalised,
		bends,
		bendStart,
		fourierStart,
		fourierCols,
		dowStart,
	};
}

// Cross products of the columns with themselves and with the values, summed
// over the rows before a cut.
interface Moments {
	a: Float64Array;
	byRaw: Float64Array;
	byLog: Float64Array;
	yyRaw: number;
	yyLog: number;
	rows: number;
}

// One pass over the history, with a copy of the running sums taken at each
// cut, in ascending order.
function accumulate(
	design: Design,
	y: Float64Array,
	logY: Float64Array | null,
	cuts: number[],
): Moments[] {
	const P = design.cols;
	const a = new Float64Array(P * P);
	const byRaw = new Float64Array(P);
	const byLog = new Float64Array(P);
	let yyRaw = 0;
	let yyLog = 0;
	const out: Moments[] = [];
	let next = 0;
	const last = cuts[cuts.length - 1];
	for (let t = 0; t < last; t++) {
		const row = t * P;
		const v = y[t];
		const lv = logY ? logY[t] : 0;
		yyRaw += v * v;
		yyLog += lv * lv;
		for (let i = 0; i < P; i++) {
			const xi = design.x[row + i];
			if (xi === 0) continue;
			byRaw[i] += xi * v;
			byLog[i] += xi * lv;
			const base = i * P;
			for (let j = i; j < P; j++) a[base + j] += xi * design.x[row + j];
		}
		while (next < cuts.length && cuts[next] === t + 1) {
			out.push({
				a: a.slice(),
				byRaw: byRaw.slice(),
				byLog: byLog.slice(),
				yyRaw,
				yyLog,
				rows: t + 1,
			});
			next++;
		}
	}
	return out;
}

interface RegressionSpec {
	// Index into the design's bends, or -1 for a straight trend.
	bend: number;
	harmonics: number;
	weekly: boolean;
	log: boolean;
	columns: number[];
	minTrain: number;
}

interface RegressionFit {
	beta: Float64Array;
	// Lower triangle of the Cholesky factor of the penalised cross products.
	chol: Float64Array;
	// Residual variance on the scale the model was fitted on.
	variance: number;
}

// The penalised least squares fit of one candidate to the rows before a cut.
// Null when the columns are too close to one another to solve.
function solveRegression(
	design: Design,
	moments: Moments,
	spec: RegressionSpec,
): RegressionFit | null {
	const P = design.cols;
	const cols = spec.columns;
	const p = cols.length;
	const m = new Float64Array(p * p);
	const b = new Float64Array(p);
	const by = spec.log ? moments.byLog : moments.byRaw;
	for (let i = 0; i < p; i++) {
		const ci = cols[i];
		b[i] = by[ci];
		for (let j = 0; j < p; j++) {
			const cj = cols[j];
			m[i * p + j] =
				ci <= cj ? moments.a[ci * P + cj] : moments.a[cj * P + ci];
		}
	}

	const l = new Float64Array(p * p);
	for (let i = 0; i < p; i++) {
		for (let j = 0; j <= i; j++) {
			let sum = m[i * p + j];
			if (i === j) {
				const diag = m[i * p + i];
				sum +=
					(design.penalised[cols[i]] ? ridge * diag : 0) +
					1e-9 * (diag + 1);
			}
			for (let k = 0; k < j; k++) sum -= l[i * p + k] * l[j * p + k];
			if (i === j) {
				if (!(sum > 0)) return null;
				l[i * p + i] = Math.sqrt(sum);
			} else {
				l[i * p + j] = sum / l[j * p + j];
			}
		}
	}

	const z = forwardSolve(l, b, p);
	const beta = new Float64Array(p);
	for (let i = p - 1; i >= 0; i--) {
		let sum = z[i];
		for (let k = i + 1; k < p; k++) sum -= l[k * p + i] * beta[k];
		beta[i] = sum / l[i * p + i];
	}

	// The residual sum of squares from the sums alone, without another pass
	// over the rows.
	let fitted = 0;
	let cross = 0;
	for (let i = 0; i < p; i++) {
		cross += beta[i] * b[i];
		let row = 0;
		for (let j = 0; j < p; j++) row += m[i * p + j] * beta[j];
		fitted += beta[i] * row;
	}
	const yy = spec.log ? moments.yyLog : moments.yyRaw;
	const sse = Math.max(0, yy - 2 * cross + fitted);
	return {
		beta,
		chol: l,
		variance: sse / Math.max(1, moments.rows - p),
	};
}

function forwardSolve(l: Float64Array, b: Float64Array, p: number) {
	const z = new Float64Array(p);
	for (let i = 0; i < p; i++) {
		let sum = b[i];
		for (let k = 0; k < i; k++) sum -= l[i * p + k] * z[k];
		z[i] = sum / l[i * p + i];
	}
	return z;
}

// The fitted value at one slot, on the scale the model was fitted on.
function predictAt(
	design: Design,
	spec: RegressionSpec,
	fit: RegressionFit,
	t: number,
): number {
	const row = t * design.cols;
	let sum = 0;
	for (let i = 0; i < spec.columns.length; i++) {
		sum += fit.beta[i] * design.x[row + spec.columns[i]];
	}
	return sum;
}

// How far a slot's columns sit from the ones the fit was made on, which
// widens the range where the trend is carried past the history.
function leverageAt(
	design: Design,
	spec: RegressionSpec,
	fit: RegressionFit,
	t: number,
): number {
	const p = spec.columns.length;
	const row = t * design.cols;
	const v = new Float64Array(p);
	for (let i = 0; i < p; i++) v[i] = design.x[row + spec.columns[i]];
	const z = forwardSolve(fit.chol, v, p);
	let sum = 0;
	for (let i = 0; i < p; i++) sum += z[i] * z[i];
	return sum;
}

function specFor(
	unit: PeriodUnit,
	design: Design,
	bend: number,
	harmonics: number,
	weekly: boolean,
	log: boolean,
): RegressionSpec {
	const columns = [0, 1];
	if (bend >= 0) columns.push(design.bendStart + bend);
	for (let c = 0; c < design.fourierCols[harmonics]; c++) {
		columns.push(design.fourierStart + c);
	}
	if (weekly) {
		for (let c = 0; c < 6; c++) columns.push(design.dowStart + c);
	}
	const p = columns.length;
	let minTrain = Math.max(2 * p, p + 8);
	// A bend needs some history after it before it can be fitted.
	if (bend >= 0) {
		const at = design.bends[bend];
		minTrain = Math.max(minTrain, at + Math.max(6, Math.round(at * 0.1)));
	}
	if (harmonics > 0) {
		minTrain = Math.max(minTrain, harmonicMin(unit, harmonics));
	}
	if (weekly) minTrain = Math.max(minTrain, weeklyMin);
	return { bend, harmonics, weekly, log, columns, minTrain };
}

// How many harmonics the yearly cycle takes, chosen on the whole history by
// the Akaike information criterion, which tracks leaving each point out in
// turn. The backtest stretches rarely cover the busiest weeks of the year,
// so they can tell whether a yearly cycle helps but not how sharp it is,
// which the fit across every year can.
function chooseHarmonics(
	unit: PeriodUnit,
	design: Design,
	whole: Moments,
	log: boolean,
): number {
	let best = 0;
	let bestScore = Infinity;
	const maxK = design.fourierCols.length - 1;
	for (const k of harmonicsByUnit[unit]) {
		if (k > maxK || harmonicMin(unit, k) > whole.rows) continue;
		const spec = specFor(unit, design, -1, k, false, log);
		const p = spec.columns.length;
		if (whole.rows <= p + 2) continue;
		const fit = solveRegression(design, whole, spec);
		if (!fit) continue;
		const meanSquare = (fit.variance * (whole.rows - p)) / whole.rows;
		const score =
			whole.rows * Math.log(Math.max(meanSquare, 1e-300)) + 2 * p;
		if (score < bestScore) {
			bestScore = score;
			best = k;
		}
	}
	return best;
}

// Every combination of trend, yearly cycle, weekly levels and scale the
// history allows, fewest columns first.
function regressionSpecs(
	unit: PeriodUnit,
	design: Design,
	whole: Moments,
	positive: boolean,
): RegressionSpec[] {
	const out: RegressionSpec[] = [];
	const bends = [-1, ...design.bends.map((_, i) => i)];
	const weeklies = design.dowStart >= 0 ? [false, true] : [false];
	const logs = positive ? [false, true] : [false];
	for (const log of logs) {
		const k = chooseHarmonics(unit, design, whole, log);
		for (const bend of bends) {
			for (const harmonics of k > 0 ? [0, k] : [0]) {
				for (const weekly of weeklies) {
					out.push(
						specFor(unit, design, bend, harmonics, weekly, log),
					);
				}
			}
		}
	}
	return out.sort((a, b) => a.columns.length - b.columns.length);
}

// --- Backtest ----------------------------------------------------------------

type Candidate =
	| { kind: "seasonalNaive"; lag: number; minTrain: number }
	| { kind: "holt"; minTrain: number }
	| { kind: "holtWinters"; season: number; minTrain: number }
	| { kind: "seasonalRegression"; spec: RegressionSpec; minTrain: number };

// How one candidate did from one origin.
interface OriginScore {
	// Mean absolute error over the stretch, scaled by the typical change from
	// one period to the next, so scores read the same at any size.
	mase: number;
	// Mean absolute error of single periods as a share of the value, or null
	// when some value sits too near zero for a share to mean anything.
	pct: number | null;
	// Miss on the stretch's total as a share of the actual total.
	total: number | null;
	// Mean squared miss against the fit's own residual variance, on the scale
	// it was fitted on. Above one means the fit's residuals understate how
	// far out the forecast lands.
	ratio: number | null;
}

// Where the backtest forecasts from, oldest first. Up to three origins, each
// followed by a stretch as long as the forecast and never starting before
// four tenths of the history. The stretches overlap by at most a quarter, and
// spread across the last year where they are short, so between them they
// see the busy and the quiet parts of it.
function backtestOrigins(
	n: number,
	stretch: number,
	yearLength: number | null,
): number[] {
	const out: number[] = [];
	const earliest = Math.max(4, Math.ceil(n * 0.4));
	const gap = Math.max(
		1,
		Math.ceil(stretch * 0.75),
		yearLength === null ? 0 : Math.floor((yearLength - stretch) / 2),
	);
	for (let k = 0; k < 3; k++) {
		const origin = n - stretch - k * gap;
		if (origin < earliest) break;
		out.push(origin);
	}
	return out.reverse();
}

function scoreStretch(
	predicted: Float64Array,
	y: Float64Array,
	origin: number,
	scale: number,
	nearZero: number,
): OriginScore {
	let abs = 0;
	let pct = 0;
	let pctValid = true;
	let predictedTotal = 0;
	let actualTotal = 0;
	const count = predicted.length;
	for (let i = 0; i < count; i++) {
		const actual = y[origin + i];
		const miss = Math.abs(actual - predicted[i]);
		abs += miss;
		if (Math.abs(actual) <= nearZero) pctValid = false;
		else pct += miss / Math.abs(actual);
		predictedTotal += predicted[i];
		actualTotal += actual;
	}
	return {
		mase: abs / count / scale,
		pct: pctValid ? pct / count : null,
		total:
			Math.abs(actualTotal) > nearZero * count
				? Math.abs(predictedTotal - actualTotal) / Math.abs(actualTotal)
				: null,
		ratio: null,
	};
}

function mean(values: number[]): number {
	let sum = 0;
	for (const v of values) sum += v;
	return sum / values.length;
}

// Every candidate the history supports, simplest first.
function listCandidates(
	unit: PeriodUnit,
	n: number,
	design: Design | null,
	whole: Moments | null,
	positive: boolean,
): Candidate[] {
	const out: Candidate[] = [];
	const season = seasonByUnit[unit];
	const yearLag = yearLagByUnit[unit];
	if (season !== null && season !== yearLag) {
		out.push({ kind: "seasonalNaive", lag: season, minTrain: 2 * season });
	}
	if (yearLag !== null) {
		// Monthly and quarterly data have always repeated last year. The
		// finer units need two whole years before a year ago says much.
		const needsTwo = unit === "day" || unit === "week";
		if (!needsTwo || n >= 2 * yearLag) {
			out.push({
				kind: "seasonalNaive",
				lag: yearLag,
				minTrain: yearLag,
			});
		}
	}
	out.push({ kind: "holt", minTrain: 4 });
	if (season !== null && n >= 2 * season) {
		out.push({ kind: "holtWinters", season, minTrain: season + 3 });
	}
	if (design && whole) {
		for (const spec of regressionSpecs(unit, design, whole, positive)) {
			out.push({
				kind: "seasonalRegression",
				spec,
				minTrain: spec.minTrain,
			});
		}
	}
	return out;
}

// --- Fitting a series ----------------------------------------------------------

// Missing values filled so the models see an unbroken series. Interior gaps
// are joined by a straight line between the known values either side, and
// the ends take the nearest known value.
function filled(values: (number | null)[]): Float64Array | null {
	const n = values.length;
	const out = new Float64Array(n);
	let known = 0;
	let last = -1;
	for (let i = 0; i < n; i++) {
		const v = values[i];
		if (v === null) continue;
		known++;
		out[i] = v;
		if (last === -1) {
			for (let j = 0; j < i; j++) out[j] = v;
		} else {
			for (let j = last + 1; j < i; j++) {
				out[j] =
					out[last] + ((v - out[last]) * (j - last)) / (i - last);
			}
		}
		last = i;
	}
	if (known < minHistory || known * 2 < n) return null;
	for (let j = last + 1; j < n; j++) out[j] = out[last];
	return out;
}

// A change in the level over the forecast smaller than this share of it
// reads as steady.
const steadyShare = 0.01;

function direction(change: number): TrendDirection {
	if (change > steadyShare) return "up";
	if (change < -steadyShare) return "down";
	return "flat";
}

// The busiest stretch of the year from the fitted cycle. The top month, and
// the month beside it when that is nearly as busy, as a first and last
// month. Quarterly data names the whole top quarter.
function yearlyPeak(
	unit: PeriodUnit,
	design: Design,
	spec: RegressionSpec,
	fit: RegressionFit,
): number[] {
	const level = (phase: number) => {
		let sum = 0;
		for (let i = 0; i < spec.columns.length; i++) {
			const c = spec.columns[i] - design.fourierStart;
			if (c < 0 || c >= design.fourierCols[spec.harmonics]) continue;
			// Columns run cosine then sine per harmonic, with the last
			// harmonic of the monthly and quarterly layouts cosine only.
			let k = 1;
			while (design.fourierCols[k] <= c) k++;
			const angle = 2 * Math.PI * k * phase;
			const isSine = c - design.fourierCols[k - 1] === 1;
			sum += fit.beta[i] * (isSine ? Math.sin(angle) : Math.cos(angle));
		}
		return sum;
	};
	if (unit === "quarter") {
		let best = 0;
		let bestLevel = -Infinity;
		for (let q = 0; q < 4; q++) {
			const v = level(q / 4);
			if (v > bestLevel) {
				bestLevel = v;
				best = q;
			}
		}
		return [best * 3, best * 3 + 2];
	}
	const months = monthMidDays.map((day, m) =>
		level(unit === "month" ? m / 12 : day / 365),
	);
	let top = 0;
	for (let m = 1; m < 12; m++) if (months[m] > months[top]) top = m;
	const low = Math.min(...months);
	const before = (top + 11) % 12;
	const after = (top + 1) % 12;
	const beside = months[before] >= months[after] ? before : after;
	if (months[top] - months[beside] > 0.2 * (months[top] - low)) {
		return [top];
	}
	return beside === before ? [before, top] : [top, after];
}

// The busiest day of the week from the fitted day levels, Sunday being the
// level the others are measured from.
function weeklyPeak(
	design: Design,
	spec: RegressionSpec,
	fit: RegressionFit,
): number {
	let best = 0;
	let bestLevel = 0;
	for (let i = 0; i < spec.columns.length; i++) {
		const c = spec.columns[i] - design.dowStart;
		if (c < 0 || c >= 6) continue;
		if (fit.beta[i] > bestLevel) {
			bestLevel = fit.beta[i];
			best = c + 1;
		}
	}
	return best;
}

// One measure's forecast, or null when its history is too short. The values
// are the finished periods on an even grid, with null for a period that has
// no value. The calendar, when given, lets the yearly and weekly cycles line
// up with real dates and be named.
export function forecastSeries(
	values: (number | null)[],
	unit: PeriodUnit,
	steps: number,
	calendar?: SeriesCalendar,
): Omit<SeriesForecast, "measure" | "additive"> | null {
	const y = filled(values);
	if (!y || steps < 1) return null;
	const n = y.length;

	let min = Infinity;
	let max = -Infinity;
	let meanAbs = 0;
	for (let i = 0; i < n; i++) {
		min = Math.min(min, y[i]);
		max = Math.max(max, y[i]);
		meanAbs += Math.abs(y[i]);
	}
	meanAbs /= n;
	const anchor = y[n - 1];
	const plain = {
		trend: null,
		yearly: false,
		yearlyPeak: null,
		weekly: false,
		weeklyPeak: null,
		lag: null,
	};

	// Nothing moves, so there is nothing to model and no error to band.
	if (max - min <= 1e-9 * Math.max(1, meanAbs)) {
		const flat = new Array<number>(steps).fill(anchor);
		return {
			model: "flat",
			anchor,
			values: flat,
			lower: [...flat],
			upper: [...flat],
			typicalError: null,
			totalError: null,
			...plain,
		};
	}

	const stretch = Math.max(1, Math.min(steps, Math.floor(n / 3)));
	const origins = backtestOrigins(n, stretch, yearLengthByUnit[unit]);
	if (origins.length === 0) return null;
	const cuts = [...origins, n];

	const positive = min > 0;
	const clampAtZero = min >= 0;
	// A percentage error against a value this close to zero is dominated by
	// the smallness of the value rather than the size of the miss.
	const nearZero = meanAbs * 0.05;
	let scale = 0;
	for (let t = 1; t < n; t++) scale += Math.abs(y[t] - y[t - 1]);
	scale /= n - 1;
	if (!(scale > 0)) scale = 1;

	let logY: Float64Array | null = null;
	if (positive) {
		logY = new Float64Array(n);
		for (let t = 0; t < n; t++) logY[t] = Math.log(y[t]);
	}

	const slots = calendarSlots(unit, n + steps, calendar);
	const design =
		unit === "year" ? null : buildDesign(unit, slots, n, n + steps);
	const moments = design ? accumulate(design, y, logY, cuts) : [];

	const floorAt = (v: number) => (clampAtZero ? Math.max(0, v) : v);
	const predicted = new Float64Array(stretch);

	// Each candidate's score from each origin it has enough history for.
	const candidates = listCandidates(
		unit,
		n,
		design,
		moments[moments.length - 1] ?? null,
		positive,
	);
	const scores: (OriginScore | null)[][] = candidates.map((candidate) =>
		origins.map((origin, index) => {
			if (origin < candidate.minTrain) return null;
			switch (candidate.kind) {
				case "seasonalNaive": {
					const lag = candidate.lag;
					for (let i = 0; i < stretch; i++) {
						predicted[i] = y[origin - lag + (i % lag)];
					}
					break;
				}
				case "holt":
				case "holtWinters": {
					const season =
						candidate.kind === "holtWinters" ? candidate.season : 1;
					const grid =
						candidate.kind === "holt" ? holtCoarse : hwCoarse;
					const run = runSmoothing(
						candidate.kind,
						y,
						season,
						origin,
						grid,
					);
					for (let i = 0; i < stretch; i++) {
						predicted[i] = floorAt(
							project(run.state, run.p, season, i + 1),
						);
					}
					break;
				}
				case "seasonalRegression": {
					if (!design) return null;
					const spec = candidate.spec;
					const fit = solveRegression(design, moments[index], spec);
					if (!fit) return null;
					let squared = 0;
					for (let i = 0; i < stretch; i++) {
						const at = predictAt(design, spec, fit, origin + i);
						const actual =
							spec.log && logY ? logY[origin + i] : y[origin + i];
						squared += (actual - at) * (actual - at);
						predicted[i] = floorAt(
							spec.log ? Math.exp(at + fit.variance / 2) : at,
						);
					}
					const score = scoreStretch(
						predicted,
						y,
						origin,
						scale,
						nearZero,
					);
					const tiny = 1e-12 * (spec.log ? 1 : meanAbs * meanAbs + 1);
					score.ratio =
						fit.variance > tiny
							? squared / stretch / fit.variance
							: null;
					return score;
				}
			}
			return scoreStretch(predicted, y, origin, scale, nearZero);
		}),
	);

	// Simplest first. A later candidate replaces the one held only by beating
	// it clearly on the origins both were tested from.
	let chosen = -1;
	for (let c = 0; c < candidates.length; c++) {
		if (!scores[c].some((s) => s !== null)) continue;
		if (chosen < 0) {
			chosen = c;
			continue;
		}
		const mine: number[] = [];
		const held: number[] = [];
		for (let o = 0; o < origins.length; o++) {
			const a = scores[c][o];
			const b = scores[chosen][o];
			if (a && b) {
				mine.push(a.mase);
				held.push(b.mase);
			}
		}
		if (mine.length === 0) continue;
		if (mean(mine) < mean(held) * (1 - tieTolerance)) chosen = c;
	}
	if (chosen < 0) return null;
	const candidate = candidates[chosen];
	const tested = scores[chosen].filter((s): s is OriginScore => s !== null);

	// The forecast from the chosen model fitted to the whole history, with
	// the spread of its error at each step on the scale it was fitted on.
	const ahead: number[] = [];
	const spread: number[] = [];
	let logScale = false;
	let described: Pick<
		SeriesForecast,
		"trend" | "yearly" | "yearlyPeak" | "weekly" | "weeklyPeak" | "lag"
	> = { ...plain };

	if (candidate.kind === "seasonalNaive") {
		// Repeats the last cycle, so its error grows once per cycle passed.
		const lag = candidate.lag;
		let sq = 0;
		for (let t = lag; t < n; t++) {
			const e = y[t] - y[t - lag];
			sq += e * e;
		}
		const sigma = Math.sqrt(sq / Math.max(1, n - lag));
		for (let h = 1; h <= steps; h++) {
			ahead.push(y[n - lag + ((h - 1) % lag)]);
			spread.push(sigma * Math.sqrt(Math.floor((h - 1) / lag) + 1));
		}
		described = { ...plain, lag };
	} else if (candidate.kind === "holt" || candidate.kind === "holtWinters") {
		// The variance h periods out is the one step variance times one plus
		// the sum of squared weights c_j, where
		// c_j = alpha * (1 + beta * (phi + ... + phi^j)) plus gamma on each
		// whole season, the standard result for additive damped models.
		const season = candidate.kind === "holtWinters" ? candidate.season : 1;
		const grid = candidate.kind === "holt" ? holtGrid : hwGrid;
		const { p, state, sigma } = runSmoothing(
			candidate.kind,
			y,
			season,
			n,
			grid,
		);
		let weights = 0;
		for (let h = 1; h <= steps; h++) {
			ahead.push(project(state, p, season, h));
			spread.push(sigma * Math.sqrt(1 + weights));
			const c =
				p.alpha * (1 + p.beta * dampedSum(p.phi, h)) +
				(candidate.kind === "holtWinters" && h % season === 0
					? p.gamma
					: 0);
			weights += c * c;
		}
		const level = Math.max(Math.abs(state.level), nearZero, 1e-12);
		described = {
			...plain,
			trend: direction((state.trend * dampedSum(p.phi, steps)) / level),
		};
	} else if (design) {
		const spec = candidate.spec;
		const fit = solveRegression(design, moments[moments.length - 1], spec);
		if (!fit) return null;
		logScale = spec.log;
		// The fit's residuals understate the miss when the backtest missed by
		// more, so the range is widened by the backtest's shortfall.
		const ratios = tested
			.map((s) => s.ratio)
			.filter((r): r is number => r !== null);
		const widen = ratios.length > 0 ? Math.max(1, mean(ratios)) : 1;
		for (let h = 1; h <= steps; h++) {
			const t = n - 1 + h;
			const at = predictAt(design, spec, fit, t);
			ahead.push(spec.log ? Math.exp(at + fit.variance / 2) : at);
			spread.push(
				Math.sqrt(
					fit.variance *
						widen *
						(1 + leverageAt(design, spec, fit, t)),
				),
			);
		}

		// The trend alone at the last value and at the end of the forecast.
		const trendAt = (t: number) => {
			let sum = fit.beta[0] + fit.beta[1] * (t / n);
			if (spec.bend >= 0) {
				sum +=
					fit.beta[2] *
					(Math.max(0, t - design.bends[spec.bend]) / n);
			}
			return sum;
		};
		const change = trendAt(n - 1 + steps) - trendAt(n - 1);
		let level = 0;
		for (const v of ahead) level += Math.abs(v);
		level = Math.max(level / steps, nearZero, 1e-12);
		described = {
			...plain,
			trend: direction(spec.log ? Math.expm1(change) : change / level),
			yearly: spec.harmonics > 0,
			yearlyPeak:
				spec.harmonics > 0 && slots.named
					? yearlyPeak(unit, design, spec, fit)
					: null,
			weekly: spec.weekly,
			weeklyPeak:
				spec.weekly && slots.named
					? weeklyPeak(design, spec, fit)
					: null,
		};
	} else {
		return null;
	}

	// The range never narrows further out, since nothing learned later in
	// the forecast can make a later period more certain.
	for (let h = 1; h < steps; h++)
		spread[h] = Math.max(spread[h], spread[h - 1]);

	const lower: number[] = [];
	const upper: number[] = [];
	// Each period's spread as a value rather than on the log scale, which is
	// what adds up into the spread of the total.
	let totalVariance = 0;
	let total = 0;
	for (let h = 0; h < steps; h++) {
		const point = floorAt(ahead[h]);
		const half = bandZ * spread[h];
		ahead[h] = point;
		if (logScale) {
			const centre = Math.log(Math.max(point, 1e-300));
			lower.push(floorAt(Math.exp(centre - half)));
			upper.push(Math.exp(centre + half));
			totalVariance += (point * spread[h]) ** 2;
		} else {
			lower.push(floorAt(point - half));
			upper.push(floorAt(point + half));
			totalVariance += spread[h] ** 2;
		}
		total += point;
	}

	const pcts = tested.map((s) => s.pct);
	const typicalError = pcts.every((p): p is number => p !== null)
		? mean(pcts as number[])
		: null;
	// The backtest's miss on the total, never less than the miss the model's
	// own range implies, since two or three origins can land close by luck.
	const totals = tested.map((s) => s.total);
	let totalError: number | null = null;
	if (
		totals.every((p): p is number => p !== null) &&
		Math.abs(total) > nearZero * steps
	) {
		const implied = (0.8 * Math.sqrt(totalVariance)) / Math.abs(total);
		totalError = Math.max(mean(totals as number[]), implied);
	}

	return {
		model: candidate.kind,
		anchor,
		values: ahead,
		lower,
		upper,
		typicalError:
			typicalError !== null && Number.isFinite(typicalError)
				? typicalError
				: null,
		totalError:
			totalError !== null && Number.isFinite(totalError)
				? totalError
				: null,
		...described,
	};
}

// --- Rows ------------------------------------------------------------------

function numeric(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : null;
}

// Words in a measure's name that mean it is an average, a share or a score,
// whose periods do not add up to anything.
const notAdditiveName =
	/\b(avg|average|mean|median|rate|ratio|pct|percent|percentage|share|score|margin|index|per)\b|%/i;

// Words in a measure's name that mean it counts or sums something.
const additiveName =
	/\b(count|total|sum|revenue|sales|orders|sessions|visits|units|quantity|amount|spend|cost|hires|exits|signups|tickets|shipments)\b/i;

// Whether a measure reads as adding up across periods, from its name and its
// format. An average when unsure, since a total claimed for an average is
// the worse mistake.
export function looksAdditive(
	name: string,
	formatHint: string | null | undefined,
): boolean {
	const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
	if (notAdditiveName.test(words)) return false;
	if (formatHint === "percent") return false;
	if (formatHint === "currency" || formatHint === "integer") return true;
	return additiveName.test(words);
}

export interface ForecastOptions {
	// Periods past the chart's last date. The default depends on the unit and
	// on how much history the chart shows.
	horizon?: number | null;
	// A plain date. Periods not finished by it are left out of the fit.
	today: string;
	// Whether each measure adds up across periods. A measure left out is
	// judged by its name.
	additive?: Record<string, boolean>;
}

// Forecasts for each measure of a chart drawn across dates, from its rows.
// Null when the dates are not an even run of one of the supported units, when
// one date appears twice, which means a second dimension splits the rows, or
// when no measure has enough history.
export function forecastRows(
	rows: Record<string, unknown>[],
	periodField: string,
	measures: string[],
	options: ForecastOptions,
): ForecastResult | null {
	try {
		if (measures.length === 0 || measures.length > maxForecastSeries) {
			return null;
		}
		const byPeriod = new Map<string, Record<string, unknown>>();
		for (const row of rows) {
			const key = periodKey(row[periodField]);
			if (!key || byPeriod.has(key)) return null;
			byPeriod.set(key, row);
		}
		const periods = [...byPeriod.keys()].sort();
		const spacing = inferSpacing(periods);
		if (!spacing) return null;

		// Unfinished periods at the end are dropped from the fit and
		// forecast instead.
		let finished = periods.length;
		while (
			finished > 0 &&
			!isFinished(periods[finished - 1], spacing, options.today)
		) {
			finished--;
		}
		if (finished < minHistory) return null;
		const dropped = periods.length - finished;

		// The finished periods laid on an even grid from the first, so a
		// missing period is a gap rather than two periods run together.
		const first = periods[0];
		const lastFinished = periods[finished - 1];
		const slot = new Map<string, number>();
		let size = 0;
		for (; size < maxGrid; size++) {
			const key = shiftPeriod(first, spacing, size);
			slot.set(key, size);
			if (key >= lastFinished) break;
		}
		size++;
		for (let i = 0; i < finished; i++) {
			if (!slot.has(periods[i])) return null;
		}

		const horizon =
			options.horizon === null || options.horizon === undefined
				? defaultHorizon(spacing.unit, periods.length)
				: clampHorizon(spacing.unit, options.horizon);
		const steps = dropped + horizon;

		const series: SeriesForecast[] = [];
		for (const measure of measures) {
			const values = new Array<number | null>(size).fill(null);
			for (let i = 0; i < finished; i++) {
				const at = slot.get(periods[i]) as number;
				values[at] = numeric(byPeriod.get(periods[i])?.[measure]);
			}
			const fit = forecastSeries(values, spacing.unit, steps, {
				start: first,
				spacing,
			});
			if (fit) {
				series.push({
					measure,
					...fit,
					additive:
						options.additive?.[measure] ??
						looksAdditive(measure, null),
				});
			}
		}
		if (series.length === 0) return null;

		const future: string[] = [];
		for (let h = 1; h <= steps; h++) {
			future.push(shiftPeriod(first, spacing, size - 1 + h));
		}
		return {
			spacing,
			anchorPeriod: shiftPeriod(first, spacing, size - 1),
			periods: future,
			horizon,
			series,
		};
	} catch {
		return null;
	}
}

// Where the forecast sits on a chart's category axis. The anchor is the
// category of the last finished period, each forecast period either matches a
// category already drawn after it or is appended, and the appended ones copy
// the time suffix the chart's own categories carry. Null when the categories
// are not an increasing run of dates that lines up with the forecast.
export function placeForecast(
	categories: string[],
	result: ForecastResult,
): { anchorIndex: number; indices: number[]; appended: string[] } | null {
	const keys = categories.map(periodKey);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (!key || (i > 0 && key <= (keys[i - 1] as string))) return null;
	}
	const anchorIndex = keys.indexOf(result.anchorPeriod);
	if (anchorIndex < 0) return null;
	const last = categories[categories.length - 1] ?? "";
	const suffix = last.slice(10);
	const indices: number[] = [];
	const appended: string[] = [];
	for (let i = 0; i < result.periods.length; i++) {
		const at = anchorIndex + 1 + i;
		if (at < keys.length) {
			if (keys[at] !== result.periods[i]) return null;
		} else {
			appended.push(result.periods[i] + suffix);
		}
		indices.push(at);
	}
	return { anchorIndex, indices, appended };
}

// --- Words -----------------------------------------------------------------

export const unitWords: Record<PeriodUnit, [string, string]> = {
	day: ["day", "days"],
	week: ["week", "weeks"],
	month: ["month", "months"],
	quarter: ["quarter", "quarters"],
	year: ["year", "years"],
};

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

const dayNames = [
	"Sundays",
	"Mondays",
	"Tuesdays",
	"Wednesdays",
	"Thursdays",
	"Fridays",
	"Saturdays",
];

// How one measure was forecast, in plain words, such as "from the growth
// trend and yearly pattern (busiest Nov to Dec)".
function methodWords(s: SeriesForecast, unit: PeriodUnit): string {
	switch (s.model) {
		case "flat":
			return "by holding the last value";
		case "seasonalNaive":
			if (s.lag === yearLagByUnit[unit]) {
				return "by repeating the same period last year";
			}
			return unit === "day" && s.lag === 7
				? "by repeating last week"
				: "by repeating the last cycle";
		case "holt":
			return s.trend === "up"
				? "from the recent growth trend"
				: s.trend === "down"
					? "from the recent downward trend"
					: "from the recent level";
		case "holtWinters":
			return `from the recent trend and ${unit === "day" ? "weekly" : "yearly"} pattern`;
		case "seasonalRegression": {
			const trend =
				s.trend === "up"
					? "the growth trend"
					: s.trend === "down"
						? "the downward trend"
						: "a steady level";
			const kinds: string[] = [];
			const peaks: string[] = [];
			if (s.yearly) {
				kinds.push("yearly");
				if (s.yearlyPeak) {
					const [from, to] = s.yearlyPeak;
					peaks.push(
						to === undefined
							? `busiest ${monthNames[from]}`
							: `busiest ${monthNames[from]} to ${monthNames[to]}`,
					);
				}
			}
			if (s.weekly) {
				kinds.push("weekly");
				if (s.weeklyPeak !== null) {
					peaks.push(
						`${peaks.length > 0 ? "and" : "busiest"} on ${dayNames[s.weeklyPeak]}`,
					);
				}
			}
			if (kinds.length === 0) return `from ${trend}`;
			const pattern = `${kinds.join(" and ")} pattern${
				peaks.length > 0 ? ` (${peaks.join(", ")})` : ""
			}`;
			return s.trend === "flat" || s.trend === null
				? `from a steady level with a ${pattern}`
				: `from ${trend} and ${pattern}`;
		}
	}
}

// The sentence under a forecast chart, such as "Forecast 3 months ahead from
// the growth trend and yearly pattern (busiest Nov to Dec), typically within
// ±12% for the period total." The error is the widest of the measures' so
// the sentence does not promise more than the weakest forecast delivers, and
// it is left off when any measure has none.
export function describeForecast(result: ForecastResult): string {
	const unit = result.spacing.unit;
	const [one, many] = unitWords[unit];
	const ahead = `${result.horizon} ${result.horizon === 1 ? one : many} ahead`;
	const methods = new Set(result.series.map((s) => methodWords(s, unit)));
	const how =
		methods.size === 1
			? [...methods][0]
			: "from the best fit for each measure";
	const errors = result.series.map((s) => s.totalError);
	const known = errors.every((e): e is number => e !== null);
	const totalWord = result.series.every((s) => s.additive)
		? "total"
		: "average";
	const note =
		known && errors.length > 0
			? `, typically within ±${Math.max(1, Math.round(Math.max(...errors) * 100))}% for the period ${totalWord}`
			: "";
	return `Forecast ${ahead} ${how}${note}.`;
}
