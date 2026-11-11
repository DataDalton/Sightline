// The rows one person has on one report, as lib/platform/readerReport holds them, and
// how a write changes what is held.

export interface ForecastRecordRow {
	visual_id: string;
	measure: string;
	period: string;
	predicted: number;
	low: number;
	high: number;
	actual: number | null;
}

export interface GoalProgressRow {
	goal_id: string;
	day: string;
	value: number;
}

export interface LastSeenRow {
	page_id: string;
	figures: Record<string, number>;
	seen_on: string;
}

export interface ReaderReport {
	forecasts: ForecastRecordRow[];
	goalProgress: GoalProgressRow[];
	deckSeen: { deck_id: string; epoch: number }[];
	lastSeen: LastSeenRow[];
}

// Forecasts saved for the first time join what is held, and actuals filled in replace the
// ones held for those periods. Kept in period order, as they are read.
export function withForecastChanges(
	held: ReaderReport,
	visualId: string,
	measure: string,
	added: ForecastRecordRow[],
	filled: { period: string; actual: number }[],
): ReaderReport {
	const actualOf = new Map(filled.map((row) => [row.period, row.actual]));
	const known = new Set(
		held.forecasts
			.filter(
				(row) => row.visual_id === visualId && row.measure === measure,
			)
			.map((row) => row.period),
	);
	const forecasts = [
		...held.forecasts,
		...added.filter((row) => !known.has(row.period)),
	]
		.map((row) =>
			row.visual_id === visualId &&
			row.measure === measure &&
			actualOf.has(row.period)
				? { ...row, actual: actualOf.get(row.period) as number }
				: row,
		)
		.sort((a, b) =>
			a.period < b.period ? -1 : a.period > b.period ? 1 : 0,
		);
	return { ...held, forecasts };
}

export function withLastSeen(
	held: ReaderReport,
	seen: LastSeenRow,
): ReaderReport {
	return {
		...held,
		lastSeen: [
			...held.lastSeen.filter((row) => row.page_id !== seen.page_id),
			seen,
		],
	};
}

// The values just written for one day replace whatever was held for those goals that day.
export function withGoalValues(
	held: ReaderReport,
	written: GoalProgressRow[],
): ReaderReport {
	const replaced = new Set(written.map((row) => `${row.goal_id}|${row.day}`));
	return {
		...held,
		goalProgress: [
			...held.goalProgress.filter(
				(row) => !replaced.has(`${row.goal_id}|${row.day}`),
			),
			...written,
		].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
	};
}
