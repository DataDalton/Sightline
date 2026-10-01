import type { FormatHint } from "../format";
import type { SemanticSource } from "../semantic/types";

// What the briefing keeps an eye on for one person.
//
// Each item is one headline figure from a report the person reads, taken from the first
// measures of the report's scorecard row, judged across the date field its
// alerts already use. Nothing here reads data. It decides what is worth
// reading, and lib/briefing/read does the reading.

export interface WatchItem {
	id: string;
	reportId: string;
	slug: string;
	reportTitle: string;
	sourceKey: string;
	measure: string;
	hint: FormatHint;
	timeField: string;
	// Breakdowns the report itself charts, which is how a movement is
	// described: "mostly Joint Replacement". The report's author chose them as
	// the ways this figure is worth splitting.
	splitBy: string[];
	// Which way is good news, from the report's own target where it sets one.
	better: "higher" | "lower" | null;
	// Pinned by the reader, so kept whatever else is chosen.
	pinned: boolean;
}

// The parts of a report the selection reads.
export interface WatchReport {
	reportId: string;
	slug: string;
	title: string;
	sourceKey: string | null;
	pages: {
		sourceKey: string | null;
		visuals: {
			visualType: string;
			sourceKey: string | null;
			config: {
				dimensions?: string[];
				measures?: string[];
				options?: Record<string, unknown>;
			};
		}[];
	}[];
}

// An unusual alert on a report, which names the date field its figures are
// read across.
export interface WatchAlert {
	reportId: string;
	sourceKey: string;
	measure: string;
	timeField: string;
}

// Headline figures taken from one report.
export const perReport = 2;
// Breakdowns tried when a figure moved.
export const maxSplits = 2;

// Fields a pipeline stamps on its rows. They say when a load ran, not when
// anything happened, so a figure read across one describes the pipeline.
const technical = /^(databricks|update_date|_)/i;

// Placeholders a page resolves from its own controls.
const placeholder = /^<.*>$/;

function isDateField(source: SemanticSource, name: string): boolean {
	const field = source.dimensions.find((f) => f.name === name);
	if (!field || technical.test(name)) return false;
	return (
		field.formatHint === "date" ||
		/date|timestamp/i.test(field.dataType ?? "")
	);
}

// The date field a figure is read across. An unusual alert on the same report
// and measure says it best, then one on the same dataset, then the dataset's
// own time field when it is a real date. A dataset without one is a snapshot,
// such as rolling one year figures, which has no history to judge against.
export function timeFieldFor(
	source: SemanticSource,
	measure: string,
	reportId: string,
	alerts: WatchAlert[],
): string | null {
	const onSource = alerts.filter(
		(a) =>
			a.sourceKey === source.sourceKey &&
			isDateField(source, a.timeField),
	);
	const exact = onSource.find(
		(a) => a.reportId === reportId && a.measure === measure,
	);
	if (exact) return exact.timeField;
	const sameReport = onSource.find((a) => a.reportId === reportId);
	if (sameReport) return sameReport.timeField;
	if (onSource[0]) return onSource[0].timeField;
	if (source.defaultTimeField && isDateField(source, source.defaultTimeField))
		return source.defaultTimeField;
	return null;
}

function targetDirection(
	options: Record<string, unknown> | undefined,
	measure: string,
): "higher" | "lower" | null {
	const targets = options?.targets;
	if (!targets || typeof targets !== "object") return null;
	const entry = (targets as Record<string, unknown>)[measure];
	if (!entry || typeof entry !== "object") return null;
	const direction = (entry as Record<string, unknown>).direction;
	return direction === "lower"
		? "lower"
		: direction === "higher"
			? "higher"
			: null;
}

interface PageReading {
	source: SemanticSource;
	splitBy: string[];
	scorecard: WatchReport["pages"][number]["visuals"][number] | undefined;
	// Every measure the page shows on this dataset, scorecard first.
	measures: string[];
	options: Record<string, unknown> | undefined;
}

// What one page offers: its dataset, its headline measures and the
// breakdowns it charts.
function readPage(
	report: WatchReport,
	page: WatchReport["pages"][number],
	sources: Map<string, SemanticSource>,
): PageReading | null {
	const pageSource = page.sourceKey ?? report.sourceKey;
	const scorecard =
		page.visuals.find((v) => v.visualType === "kpiRow") ??
		page.visuals.find(
			(v) =>
				/line|area|combo/i.test(v.visualType) &&
				(v.config.measures?.length ?? 0) > 0,
		);
	const sourceKey = (scorecard?.sourceKey ?? pageSource) || null;
	const source = sourceKey ? sources.get(sourceKey) : undefined;
	if (!source) return null;

	// The breakdowns the page charts on this dataset, most used first.
	const counts = new Map<string, number>();
	const measures: string[] = [...(scorecard?.config.measures ?? [])];
	for (const visual of page.visuals) {
		if ((visual.sourceKey ?? pageSource) !== source.sourceKey) continue;
		for (const name of visual.config.measures ?? []) {
			if (!measures.includes(name)) measures.push(name);
		}
		if (visual.visualType === "table") continue;
		for (const name of visual.config.dimensions ?? []) {
			if (placeholder.test(name) || isDateField(source, name)) continue;
			if (!source.dimensions.some((f) => f.name === name)) continue;
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	const splitBy = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, maxSplits)
		.map(([name]) => name);
	return {
		source,
		splitBy,
		scorecard,
		measures,
		options: scorecard?.config.options,
	};
}

function makeItem(
	report: WatchReport,
	reading: PageReading,
	measure: string,
	alerts: WatchAlert[],
	pinned: boolean,
): WatchItem | null {
	const field = reading.source.measures.find((f) => f.name === measure);
	if (!field) return null;
	const timeField = timeFieldFor(
		reading.source,
		measure,
		report.reportId,
		alerts,
	);
	if (!timeField) return null;
	return {
		id: `${report.reportId}:${measure}`,
		reportId: report.reportId,
		slug: report.slug,
		reportTitle: report.title,
		sourceKey: reading.source.sourceKey,
		measure,
		hint: field.formatHint ?? "decimal",
		timeField,
		splitBy: reading.splitBy,
		better: targetDirection(reading.options, measure),
		pinned,
	};
}

// Headline figures and breakdowns for one report, taken from the first measures of its
// scorecard that can be judged against a history.
export function itemsForReport(
	report: WatchReport,
	sources: Map<string, SemanticSource>,
	alerts: WatchAlert[],
	skip: Set<string> = new Set(),
): WatchItem[] {
	const items: WatchItem[] = [];
	for (const page of report.pages) {
		const reading = readPage(report, page, sources);
		if (!reading?.scorecard) continue;
		for (const measure of reading.scorecard.config.measures ?? []) {
			if (items.length >= perReport) break;
			if (skip.has(`${report.reportId}:${measure}`)) continue;
			const item = makeItem(report, reading, measure, alerts, false);
			if (item) items.push(item);
		}
		if (items.length >= perReport) break;
	}
	return items;
}

// A figure the reader pinned. Any measure the report shows can be pinned, not
// only its headline ones.
export function pinnedItem(
	report: WatchReport,
	measure: string,
	sources: Map<string, SemanticSource>,
	alerts: WatchAlert[],
): WatchItem | null {
	for (const page of report.pages) {
		const reading = readPage(report, page, sources);
		if (!reading || !reading.measures.includes(measure)) continue;
		const item = makeItem(report, reading, measure, alerts, true);
		if (item) return item;
	}
	return null;
}

// The whole list, with pinned figures first, then headline figures from the
// reports in the order given, with hidden ones left out and the same figure
// on the same dataset kept once. Two reports showing net sales by order date
// would otherwise read and describe it twice. Every pin is kept whatever
// the limit.
export function watchList(
	reports: WatchReport[],
	sources: Map<string, SemanticSource>,
	alerts: WatchAlert[],
	limit: number,
	choices: {
		reportId: string;
		measure: string;
		choice: "pin" | "hide";
	}[] = [],
): WatchItem[] {
	const byId = new Map(reports.map((r) => [r.reportId, r]));
	const hidden = new Set(
		choices
			.filter((c) => c.choice === "hide")
			.map((c) => `${c.reportId}:${c.measure}`),
	);
	const seen = new Set<string>();
	const out: WatchItem[] = [];
	const keep = (item: WatchItem) => {
		const key = `${item.sourceKey}|${item.measure}|${item.timeField}`;
		if (seen.has(key)) return false;
		seen.add(key);
		out.push(item);
		return true;
	};
	for (const choice of choices) {
		if (choice.choice !== "pin") continue;
		const report = byId.get(choice.reportId);
		const item =
			report && pinnedItem(report, choice.measure, sources, alerts);
		if (item) keep(item);
	}
	// Chosen as though nothing were pinned, so pinning a figure moves that
	// one figure and leaves the rest of the selection as it was. A pinned
	// figure that would have been chosen anyway still takes its slot.
	const pinnedKeys = new Set(
		out.map((i) => `${i.sourceKey}|${i.measure}|${i.timeField}`),
	);
	let chosen = 0;
	for (const report of reports) {
		for (const item of itemsForReport(report, sources, alerts, hidden)) {
			if (chosen >= limit) return out;
			const key = `${item.sourceKey}|${item.measure}|${item.timeField}`;
			if (pinnedKeys.has(key)) {
				pinnedKeys.delete(key);
				chosen++;
			} else if (keep(item)) chosen++;
		}
	}
	return out;
}
