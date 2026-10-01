import type { Identity } from "../auth/identity";
import { addsUp, breakdown, rankBreakdowns } from "../explain/drivers";
import { toNumber } from "../format";
import { executeQuery } from "../query/execute";
import { maxLimit, parseQuerySpec } from "../query/spec";
import { getSource } from "../semantic/registry";
import {
	buildCard,
	historyStart,
	readProbe,
	splitWindows,
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
//
// A card is one question for its history, then one per breakdown when it
// moved enough to say why, asked together.

// Periods read for the latest one, how far apart periods are, and the
// history behind it. Enough for the history a daily field is judged against,
// with room for the unfinished days at the end. A read that falls short asks
// for the history on its own.
const probePeriods = 64;
// Values read per breakdown. More than this is an identifier rather than a
// way of splitting.
const maxValues = 300;
const day = 86_400_000;

export class BriefingItemError extends Error {}

type Filter = { field: string; op: string; value: string };

// A card, and when the oldest answer it was built from was computed. A card
// is only as fresh as that answer, which may have come from the cache.
export interface ComputedCard {
	card: Card | null;
	computedAt: number;
}

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
	sort: { field: string; direction: "asc" | "desc" }[],
) {
	return executeQuery(
		identity,
		parseQuerySpec({
			sourceKey: item.sourceKey,
			dimensions,
			measures: [item.measure],
			filters,
			sort,
			limit,
			offset: 0,
			transforms: [],
		}),
	);
}

// Checks the item against the dataset as it is now, and drops breakdowns it
// no longer has.
export function checkItem(item: WatchItem): WatchItem {
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
	return {
		...item,
		splitBy: item.splitBy.filter((name) =>
			source.dimensions.some((f) => f.name === name),
		),
	};
}

// Both windows of one breakdown. Asked as one question grouped by member and
// period where each window is one period, which is the usual case, and as two
// otherwise.
async function readSplit(
	identity: Identity,
	item: WatchItem,
	dimension: string,
	card: Card,
	stamps: number[],
): Promise<{
	dimension: string;
	current: Record<string, unknown>[];
	previous: Record<string, unknown>[];
} | null> {
	const now = card.window;
	const before = card.previousWindow as { gte: string; lt: string };
	const spanDays =
		(Date.parse(`${now.lt}T00:00:00Z`) -
			Date.parse(`${before.gte}T00:00:00Z`)) /
		day;
	const periods = Math.ceil(spanDays / Math.max(card.spacing, 1)) + 1;
	const limit = Math.min(maxLimit, (maxValues + 1) * periods);
	const both = await ask(
		identity,
		item,
		[dimension, item.timeField],
		[
			{ field: item.timeField, op: "gte", value: before.gte },
			{ field: item.timeField, op: "lt", value: now.lt },
		],
		limit,
		[{ field: dimension, direction: "asc" }],
	);
	stamps.push(both.computedAt);
	if (both.rows.length >= limit) return null;
	const split = splitWindows(
		both.rows,
		item.timeField,
		dimension,
		item.measure,
		now,
		before,
	);
	if (split) {
		if (
			split.current.length > maxValues ||
			split.previous.length > maxValues
		)
			return null;
		return { dimension, ...split };
	}

	const [current, previous] = await Promise.all(
		[now, before].map((window) =>
			ask(
				identity,
				item,
				[dimension],
				windowFilters(item.timeField, window),
				maxValues + 1,
				[{ field: item.measure, direction: "desc" }],
			),
		),
	);
	stamps.push(current.computedAt, previous.computedAt);
	if (current.rows.length > maxValues || previous.rows.length > maxValues)
		return null;
	return { dimension, current: current.rows, previous: previous.rows };
}

// What moved the figure between the two windows, from the breakdowns the
// report charts. The split that concentrates the change in one member wins.
async function findDriver(
	identity: Identity,
	item: WatchItem,
	card: Card,
	stamps: number[],
): Promise<Driver | null> {
	if (!card.previousWindow || card.previous === null) return null;
	const change = card.value - card.previous;
	if (change === 0) return null;

	const splits = await Promise.all(
		item.splitBy.slice(0, maxSplits).map((dimension) =>
			readSplit(identity, item, dimension, card, stamps).catch(
				// A breakdown the warehouse would not answer leaves the others.
				() => null,
			),
		),
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

// Works out one card for the day given. The item has been through checkItem.
export async function computeCard(
	identity: Identity,
	item: WatchItem,
	today: string,
): Promise<ComputedCard> {
	const stamps: number[] = [];
	const stamp = () => (stamps.length ? Math.min(...stamps) : Date.now());

	const probe = await ask(
		identity,
		item,
		[item.timeField],
		[{ field: item.timeField, op: "lte", value: today }],
		probePeriods,
		[{ field: item.timeField, direction: "desc" }],
	);
	stamps.push(probe.computedAt);
	const reading = readProbe(probe.rows, item.timeField, today, probePeriods);
	if (reading.kind === "none") return { card: null, computedAt: stamp() };

	let rows: Record<string, unknown>[];
	if (reading.kind === "ready") {
		rows = reading.rows;
	} else {
		const history = await ask(
			identity,
			item,
			[item.timeField],
			[
				{
					field: item.timeField,
					op: "gte",
					value: historyStart(reading.target, reading.spacing),
				},
				{ field: item.timeField, op: "lte", value: reading.target },
			],
			maxLimit,
			[{ field: item.timeField, direction: "asc" }],
		);
		stamps.push(history.computedAt);
		rows = history.rows;
	}
	// Kept numeric, since a figure the warehouse returns as text would read
	// as missing.
	rows = rows.map((row) => ({
		...row,
		[item.measure]: toNumber(row[item.measure]),
	}));

	const card = buildCard(item.id, rows, {
		timeField: item.timeField,
		measure: item.measure,
		target: reading.target,
		spacing: reading.spacing,
		today,
	});
	if (!card) return { card: null, computedAt: stamp() };
	if (worthExplaining(card))
		card.driver = await findDriver(identity, item, card, stamps);
	return { card, computedAt: stamp() };
}
