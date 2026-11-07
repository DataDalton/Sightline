import { evaluate, type AlertCondition, type AlertState } from "./rule";
import { findOddOnes } from "../insight/insight";

// How often an alert would have gone off over a stretch of past readings, before anybody
// has to live with it. Pure, so it runs the same judgement the real check does.

export interface Backtest {
	checked: number;
	fired: number;
	firstOn: string | null;
	lastOn: string | null;
	// Roughly how often, for a person deciding if they can stand it.
	perMonth: number;
}

export function backtest(
	definition: {
		condition: AlertCondition;
		threshold: number | null;
		notifyRecover: boolean;
	},
	series: { period: string; group: string | null; value: number | null }[],
): Backtest {
	const firedOn: string[] = [];
	const periods = [...new Set(series.map((point) => point.period))].sort();

	if (definition.condition === "unusual") {
		const groups = [...new Set(series.map((point) => point.group))];
		for (const group of groups) {
			const odd = findOddOnes(
				series
					.filter(
						(point) =>
							point.group === group && point.value !== null,
					)
					.sort((a, b) => a.period.localeCompare(b.period))
					.map((point) => ({
						label: point.period,
						value: point.value as number,
					})),
				"time",
			);
			firedOn.push(...odd.map((item) => item.label));
		}
	} else {
		let state: AlertState = {};
		for (const period of periods) {
			const readings = series
				.filter((point) => point.period === period)
				.map((point) => ({ group: point.group, value: point.value }));
			const outcome = evaluate(
				{ ...definition, anomaly: null },
				readings,
				state,
			);
			state = outcome.state;
			if (outcome.firings.length > 0) firedOn.push(period);
		}
	}

	firedOn.sort();
	const spanDays =
		periods.length > 1
			? (new Date(periods[periods.length - 1]).getTime() -
					new Date(periods[0]).getTime()) /
				86_400_000
			: 0;
	return {
		checked: periods.length,
		fired: firedOn.length,
		firstOn: firedOn[0] ?? null,
		lastOn: firedOn[firedOn.length - 1] ?? null,
		perMonth: spanDays > 0 ? (firedOn.length / spanDays) * 30 : 0,
	};
}

// How an alert has fared, so someone can tell if it is worth keeping.
export interface Aftermath {
	fired: number;
	recovered: number;
	// Halfway point of how long it took, in days.
	typicalDaysToRecover: number | null;
	verdict: "quiet" | "useful" | "noisy";
}

// Fired this often, an alert probably needs a tighter line.
const noisyAfter = 20;

export function aftermathOf(
	events: {
		firedOn: string;
		recoveredOn: string | null;
	}[],
): Aftermath {
	const days = events
		.filter((event) => event.recoveredOn)
		.map(
			(event) =>
				(new Date(event.recoveredOn as string).getTime() -
					new Date(event.firedOn).getTime()) /
				86_400_000,
		)
		.sort((a, b) => a - b);
	const fired = events.length;
	return {
		fired,
		recovered: days.length,
		typicalDaysToRecover:
			days.length > 0 ? days[Math.floor(days.length / 2)] : null,
		verdict:
			fired === 0 ? "quiet" : fired >= noisyAfter ? "noisy" : "useful",
	};
}
