import { todayIn } from "../alerts/anomaly";
import type { Identity } from "../auth/identity";
import { addsUp, breakdown, rankBreakdowns } from "../explain/drivers";
import { toNumber } from "../format";
import { executeQuery } from "../query/execute";
import { maxLimit, parseQuerySpec } from "../query/spec";
import { getSource } from "../semantic/registry";
import {
	buildCard,
	historyStart,
	latestFinished,
	worthExplaining,
	type Card,
	type Driver,
} from "./card";
import { maxSplits, type WatchItem } from "./watch";

// Reads one watched figure under the reader's own access.
//
// Every question goes through the executor a report uses, so the figure is
// the one this reader would see on the report, row filters included, and a
// second reader in the same policy class is answered from the shared cache.

// Periods read to find the latest one and how far apart periods are.
const probePeriods = 60;
// Values read per breakdown. More than this is an identifier rather than a
// way of splitting.
const maxValues = 300;

export class BriefingItemError extends Error {}

type Filter = { field: string; op: string; value: string };

function windowFilters(
	timeField: string,
	window: { gte: string; lt: string },
): Filter[] {
	return [
		{ field: timeField, op: "gte", value: window.gte },
		{ field: timeField, op: "lt", value: window.lt },
	];
}

async function ask(
	identity: Identity,
	item: WatchItem,
	dimensions: string[],
	filters: Filter[],
	limit: number,
	sortField: string,
	direction: "asc" | "desc",
) {
	const result = await executeQuery(
		identity,
		parseQuerySpec({
			sourceKey: item.sourceKey,
			dimensions,
			measures: [item.measure],
			filters,
			sort: [{ field: sortField, direction }],
			limit,
			offset: 0,
			transforms: [],
		}),
	);
	return result.rows;
}

// What moved the figure between the two windows, from the breakdowns the
// report charts. The split that concentrates the change in one member wins.
async function findDriver(
	identity: Identity,
	item: WatchItem,
	card: Card,
): Promise<Driver | null> {
	if (!card.previousWindow || card.previous === null) return null;
	const now = windowFilters(item.timeField, card.window);
	const before = windowFilters(item.timeField, card.previousWindow);
	const change = card.value - card.previous;
	if (change === 0) return null;

	const splits = await Promise.all(
		item.splitBy.slice(0, maxSplits).map(async (dimension) => {
			try {
				const [current, previous] = await Promise.all([
					ask(
						identity,
						item,
						[dimension],
						now,
						maxValues + 1,
						item.measure,
						"desc",
					),
					ask(
						identity,
						item,
						[dimension],
						before,
						maxValues + 1,
						item.measure,
						"desc",
					),
				]);
				if (current.length > maxValues || previous.length > maxValues)
					return null;
				return { dimension, current, previous };
			} catch {
				// A breakdown the warehouse would not answer leaves the others.
				return null;
			}
		}),
	);
	const usable = splits.filter((s) => s !== null);
	if (usable.length === 0) return null;
	const additive = addsUp(card.value, usable[0].current, item.measure);
	const ranked = rankBreakdowns(
		usable.map((s) =>
			breakdown(
				s.dimension,
				s.current,
				s.previous,
				item.measure,
				change,
				additive,
			),
		),
	);
	const top = ranked[0]?.members[0];
	if (!ranked[0] || !top || top.change === 0) return null;
	// A member moving against the whole is not what moved it.
	if (Math.sign(top.change) !== Math.sign(change)) return null;
	return {
		dimension: ranked[0].dimension,
		member: top.value,
		change: top.change,
		share: top.share,
	};
}

export async function readItem(
	identity: Identity,
	item: WatchItem,
	timeZone: string,
): Promise<Card | null> {
	const source = getSource(item.sourceKey);
	if (!source) throw new BriefingItemError("That dataset is not registered.");
	if (!source.measures.some((f) => f.name === item.measure))
		throw new BriefingItemError(
			`${item.measure} is not on ${source.title}.`,
		);
	if (!source.dimensions.some((f) => f.name === item.timeField))
		throw new BriefingItemError(
			`${item.timeField} is not on ${source.title}.`,
		);
	item = {
		...item,
		splitBy: item.splitBy.filter((name) =>
			source.dimensions.some((f) => f.name === name),
		),
	};

	const today = todayIn(timeZone);
	const probe = await ask(
		identity,
		item,
		[item.timeField],
		[{ field: item.timeField, op: "lte", value: today }],
		probePeriods,
		item.timeField,
		"desc",
	);
	const keys = probe
		.map((row) => String(row[item.timeField] ?? "").slice(0, 10))
		.filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
	const latest = latestFinished(keys, today);
	if (!latest) return null;

	const rows = await ask(
		identity,
		item,
		[item.timeField],
		[
			{
				field: item.timeField,
				op: "gte",
				value: historyStart(latest.target, latest.spacing),
			},
			{ field: item.timeField, op: "lte", value: latest.target },
		],
		maxLimit,
		item.timeField,
		"asc",
	);
	// Kept numeric, since a figure the warehouse returns as text would read
	// as missing.
	for (const row of rows) row[item.measure] = toNumber(row[item.measure]);

	const card = buildCard(item.id, rows, {
		timeField: item.timeField,
		measure: item.measure,
		target: latest.target,
		spacing: latest.spacing,
		today,
	});
	if (!card) return null;
	if (worthExplaining(card))
		card.driver = await findDriver(identity, item, card);
	return card;
}
