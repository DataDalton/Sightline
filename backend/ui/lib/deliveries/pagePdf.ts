import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChartContext } from "../../app/visuals/chartOptions";
import type { ThemeColors } from "../../app/visuals/colors";
import { worldMapName } from "../../app/visuals/worldMapName";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { failingFor, rulesFailing } from "../dataRules/store";
import { restrictionFor } from "../alerts/recorded";
import type { BatchReads } from "../alerts/reads";
import { runsUnattended } from "../alerts/store";
import {
	assertFieldsPresent,
	compileQuery,
	type RowRestriction,
} from "../query/builder";
import { pagedSpec, sliceWindow } from "../query/paging";
import { applyTransforms } from "../query/transform";
import { plainDates } from "../format";
import { reportForScheduledRun } from "../platform/reports";
import { writePrintRecord } from "../platform/decks";
import type { SemanticSource } from "../semantic/types";
import { sql } from "../data/lakebase";
import {
	formatCompact,
	formatValue,
	toNumber,
	type FormatHint,
} from "../format";
import {
	fillNarrative,
	paceFromRows,
	parseNarrative,
	rankForecasts,
} from "../insight/insight";
import { canDoOnReport } from "../platform/access";
import { recordPrint } from "../platform/decks";
import { getReport, type VisualDefinition } from "../platform/reports";
import { nativeChartFor } from "../pptx/nativeChart";
import { useEmbeddedFonts } from "../pdf/document";
import {
	drawReportPage,
	layoutWidth,
	type PdfBody,
	type PdfFigure,
	type PdfVisual,
	type Tone,
} from "../pdf/reportPdf";
import { TrueTypeFont } from "../pdf/truetype";
import {
	shiftDateFilters,
	type ComparePeriod,
	type DateClause,
} from "../query/compare";
import { executeQuery } from "../query/execute";
import { parseQuerySpec } from "../query/spec";
import {
	chartTypes,
	initialQueryForVisual,
	matrixLevelRows,
	queryForVisual,
	recordTypes,
	seriesRows,
} from "../query/visualSpec";
import { getSource } from "../semantic/registry";
import { settings } from "../settings";
import { isPageControl, optionValue } from "../visuals/catalog";
import { knownCountries } from "../visuals/countryNames";
import { withoutDateLineJumps } from "../visuals/worldGeo";
import { requiredFields, waitingFor } from "../visuals/filterGate";
import {
	describeForecast,
	forecastRows,
	localToday,
	looksAdditive,
} from "../visuals/forecast";
import { isSigned, kpiChange, kpiChangeWords } from "../visuals/kpiChange";
import { resolveKpiGroups, type KpiGroup } from "../visuals/kpiGroups";
import {
	describeBasis,
	readTargets,
	resolveTarget,
	targetProgress,
	type TargetStatus,
} from "../visuals/kpiTargets";
import {
	gridColumns,
	measureCanvas,
	rectToPixels,
	type CanvasMetrics,
} from "../visuals/layout";
import { openingFilters } from "../visuals/pageDefaults";
import {
	evaluateConditions,
	styleForMeasure,
	type VisualStyle,
} from "../visuals/style";
import { allThemes, parseCustomThemes, themeTokens } from "../visuals/themes";

// A report page drawn on the server for a schedule, read as the person it is for.
//
// Their own token is the only way anything is read here, so what is on paper is what they
// would see opening the page. A PDF therefore waits until they are next in the app, since
// their token exists only then. The record of it is written before anything is read, the
// same as printing it themselves.

export class PagePdfRefused extends Error {}

// Chart types the page can carry a forecast on.
const forecastTypes = new Set([
	"barChart",
	"lineChart",
	"areaChart",
	"comboChart",
]);

// How long a drawn file is kept for its owner to fetch.
export const pdfKeptDays = 30;

// How far inside a group its contents sit, and how much of its top its title takes.
const groupPadding = 12;
const groupTitle = 32;

interface Placed {
	visual: VisualDefinition;
	box: PdfVisual["box"];
}

// Where each visual lands in the page's own pixels, with what a group holds moved out of the
// group, since paper has no group to open.
type ReportDefinition = NonNullable<Awaited<ReturnType<typeof getReport>>>;

function place(visuals: VisualDefinition[]): Placed[] {
	const out: Placed[] = [];
	const inGroup = new Map<string, VisualDefinition[]>();
	const byId = new Map(visuals.map((v) => [v.visualId, v]));
	const top: VisualDefinition[] = [];
	for (const visual of visuals) {
		const parent = (visual.config as { parentId?: string }).parentId;
		if (parent && byId.get(parent)?.visualType === "group") {
			inGroup.set(parent, [...(inGroup.get(parent) ?? []), visual]);
		} else {
			top.push(visual);
		}
	}
	const walk = (
		list: VisualDefinition[],
		metrics: CanvasMetrics,
		offsetLeft: number,
		offsetTop: number,
	) => {
		for (const visual of list) {
			const rect = visual.layout ?? { x: 0, y: 0, w: gridColumns, h: 4 };
			const pixels = rectToPixels(rect, metrics);
			const left = pixels.left + offsetLeft;
			const topAt = pixels.top + offsetTop;
			if (visual.visualType === "group") {
				walk(
					inGroup.get(visual.visualId) ?? [],
					measureCanvas(
						Math.max(
							pixels.width - groupPadding * 2,
							gridColumns * 2,
						),
					),
					left + groupPadding,
					topAt + groupTitle,
				);
				continue;
			}
			out.push({
				visual,
				box: {
					left,
					top: topAt,
					width: pixels.width,
					height: pixels.height,
				},
			});
		}
	};
	walk(top, measureCanvas(layoutWidth), 0, 0);
	return out;
}

function clauseWords(clause: {
	field?: unknown;
	op?: unknown;
	value?: unknown;
	values?: unknown;
}): string {
	const values = Array.isArray(clause.values)
		? clause.values.join(", ")
		: String(clause.value ?? "");
	const words: Record<string, string> = {
		eq: "is",
		in: "is",
		gte: "from",
		lte: "to",
		gt: "after",
		lt: "before",
	};
	return `${clause.field} ${words[String(clause.op)] ?? clause.op} ${values}`.trim();
}

const textOfHtml = (html: string) =>
	html
		.split(/<\/(?:p|div|h[1-6]|li|blockquote)>|<br\s*\/?>/i)
		.map((part) =>
			part
				.replace(/<[^>]*>/g, " ")
				.replace(/&nbsp;/g, " ")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")
				.replace(/&amp;/g, "&")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter(Boolean);

// The app's own file, wherever the process was started from in the app's folder.
function appFile(...parts: string[]): string {
	return join(/*turbopackIgnore: true*/ process.cwd(), ...parts);
}

let fontsLoading: Promise<void> | null = null;

// Read once, on the first PDF, since the fonts are large and most servers never need them.
function readyFonts(): Promise<void> {
	fontsLoading ??= (async () => {
		const load = async (name: string) =>
			new TrueTypeFont(
				await readFile(appFile("lib", "pdf", "fonts", name)),
			);
		const [regular, bold, chinese, korean] = await Promise.all([
			load("NotoSans-Regular.ttf"),
			load("NotoSans-Bold.ttf"),
			load("DroidSansFallbackFull.ttf"),
			load("NanumGothic-Regular.ttf"),
		]);
		useEmbeddedFonts([
			{ font: bold, boldOnly: true },
			{ font: regular },
			{ font: chinese },
			{ font: korean },
		]);
	})().catch((error) => {
		// Held off rather than remembered, so a passing failure can be tried again. Until
		// then those letters print as question marks, and the rest of the page is right.
		fontsLoading = null;
		console.warn("The PDF fonts could not be read:", error);
	});
	return fontsLoading;
}

let worldNames: Map<string, string> | null = null;

// The same boundaries the page loads, read from where they are served.
async function readyWorldMap(echarts: {
	registerMap: (name: string, geo: never) => void;
}): Promise<Map<string, string>> {
	if (worldNames) return worldNames;
	const geo = JSON.parse(
		await readFile(
			appFile("public", "geo", "world-countries.json"),
			"utf-8",
		),
	) as { features?: { properties?: { name?: unknown } }[] };
	echarts.registerMap(
		worldMapName,
		withoutDateLineJumps(geo as never) as never,
	);
	worldNames = knownCountries(
		(geo.features ?? [])
			.map((feature) => feature.properties?.name)
			.filter((name): name is string => typeof name === "string"),
	);
	return worldNames;
}

async function chartSvg(
	visualType: string,
	context: ChartContext,
	width: number,
	height: number,
): Promise<string | null> {
	const [{ buildChoropleth, buildForType }, echarts] = await Promise.all([
		import("../../app/visuals/chartOptions"),
		import("echarts"),
	]);
	const option =
		visualType === "choroplethChart"
			? buildChoropleth(context, await readyWorldMap(echarts)).option
			: buildForType(visualType, context);
	if (!option) return null;
	const chart = echarts.init(null, null, {
		renderer: "svg",
		ssr: true,
		width,
		height,
	});
	try {
		const held = option as Record<string, unknown>;
		// A legend that scrolls on screen shows everything on paper, which has no arrows.
		const plainLegend = (legend: unknown) =>
			legend && typeof legend === "object"
				? { ...legend, type: "plain" }
				: legend;
		chart.setOption({
			...held,
			...(held.legend
				? {
						legend: Array.isArray(held.legend)
							? held.legend.map(plainLegend)
							: plainLegend(held.legend),
					}
				: {}),
			animation: false,
		});
		return chart.renderToSVGString();
	} finally {
		chart.dispose();
	}
}

type ReadRows = (query: unknown) => Promise<Record<string, unknown>[]>;

const toneOf = (status: TargetStatus): Tone =>
	status === "good" ? "good" : status === "warn" ? "warn" : "bad";

// A row of tiles with what the page shows on each, from the queries the page asks.
async function kpiFigures(input: {
	sourceKey: string;
	measures: string[];
	filters: unknown[];
	style: VisualStyle | undefined;
	groups: KpiGroup[] | undefined;
	compareTo: ComparePeriod | null;
	compareField: string | null;
	sparkline: string | null;
	targets: unknown;
	read: ReadRows;
	hintFor: (field: string) => FormatHint;
	colors: ThemeColors;
	withAlpha: (color: string, alpha: number) => string;
}): Promise<PdfFigure[]> {
	const { sourceKey, measures, filters, compareField, read, colors } = input;
	const one = async (over: unknown[], names: string[] = measures) =>
		(
			await read(
				queryForVisual("kpiRow", {
					sourceKey,
					dimensions: [],
					measures: names,
					filters: over,
				}),
			)
		)[0] ?? {};
	const shifted = (period: ComparePeriod) =>
		compareField
			? shiftDateFilters(filters as DateClause[], compareField, period)
			: null;

	const row = await one(filters);
	const comparisonFilters = input.compareTo ? shifted(input.compareTo) : null;
	const earlier = comparisonFilters ? await one(comparisonFilters) : null;
	const trend = input.sparkline
		? await read(
				queryForVisual("lineChart", {
					sourceKey,
					dimensions: [input.sparkline],
					measures,
					filters,
				}),
			)
		: [];

	const targets = readTargets(input.targets);
	const bases = new Map<string, Record<string, unknown>>();
	const measureBases = [
		...new Set(
			Object.values(targets).flatMap((target) =>
				target.basis.kind === "measure" &&
				!measures.includes(target.basis.measure)
					? [target.basis.measure]
					: [],
			),
		),
	];
	const otherMeasures =
		measureBases.length > 0 ? await one(filters, measureBases) : {};
	for (const target of Object.values(targets)) {
		if (target.basis.kind !== "period") continue;
		const period = target.basis.period;
		if (bases.has(period)) continue;
		const moved = shifted(period);
		bases.set(period, moved ? await one(moved) : {});
	}

	const rules = input.style?.conditions ?? [];
	const bands = resolveKpiGroups(measures, input.groups);
	return bands.flatMap((band) =>
		band.measures.map((name) => {
			const hint = input.hintFor(name);
			const numeric = toNumber(row[name]);
			const match = evaluateConditions(rules, row, name);
			const chosen = styleForMeasure(
				input.style,
				name,
				measures.indexOf(name),
			).color;
			const signed = isSigned(name);
			const moved = kpiChange(
				name,
				hint,
				numeric,
				earlier ? toNumber(earlier[name]) : null,
			);
			const target = targets[name];
			const base =
				!target || target.basis.kind === "fixed"
					? null
					: target.basis.kind === "period"
						? toNumber(bases.get(target.basis.period)?.[name])
						: toNumber(
								(measures.includes(target.basis.measure)
									? row
									: otherMeasures)[target.basis.measure],
							);
			const resolved = target ? resolveTarget(target, base) : null;
			const progress = resolved
				? targetProgress(numeric, resolved, hint)
				: null;
			const basisWords = target ? describeBasis(target, hint) : null;
			return {
				label: name,
				band: band.label,
				text: `${match?.marker ? `${match.marker} ` : ""}${
					signed && numeric !== null && numeric > 0 ? "+" : ""
				}${formatCompact(row[name], hint)}`,
				color:
					match?.textColor || chosen
						? colors.resolve(
								match?.textColor ?? chosen,
								colors.text,
							)
						: signed && numeric !== null && numeric !== 0
							? numeric > 0
								? colors.positive
								: colors.negative
							: null,
				background: match?.background
					? input.withAlpha(
							colors.resolve(match.background, colors.series[0]),
							0.14,
						)
					: null,
				change: moved
					? {
							text: kpiChangeWords(moved),
							tone:
								moved.change > 0
									? ("good" as const)
									: moved.change < 0
										? ("bad" as const)
										: null,
						}
					: null,
				target: progress
					? {
							text: basisWords
								? `${progress.text}, ${basisWords}`
								: progress.text,
							tone: toneOf(progress.status),
						}
					: null,
				trend: trend.map((point) => toNumber(point[name])),
			};
		}),
	);
}

// A matrix as it opens, at its top level, with its pivoted columns and totals. A total is
// read rather than added up, since adding is wrong for an average or a percentage.
async function matrixBody(input: {
	sourceKey: string;
	namedDimensions: string[];
	measures: string[];
	pivot: string | null;
	showTotals: boolean;
	filters: unknown[];
	read: ReadRows;
	hintFor: (field: string) => FormatHint;
}): Promise<PdfBody> {
	const { sourceKey, measures, pivot, filters, read, hintFor } = input;
	const first = input.namedDimensions.find((name) => name !== pivot);
	if (!first) return { kind: "note", text: "This visual has no fields yet." };
	const query = (dimensions: string[], limit: number) =>
		read({
			sourceKey,
			dimensions,
			measures,
			filters,
			sort: dimensions.map((field) => ({ field, direction: "asc" })),
			limit,
		});

	const cell = (value: unknown, measure: string) =>
		formatValue(value, hintFor(measure));
	const [rows, overall] = await Promise.all([
		query(pivot ? [first, pivot] : [first], matrixLevelRows),
		input.showTotals ? query([], 1) : Promise.resolve([]),
	]);

	if (!pivot) {
		return {
			kind: "table",
			columns: [
				{ name: first, numeric: false },
				...measures.map((name) => ({ name, numeric: true })),
			],
			rows: [
				...rows.map((row) => [
					String(row[first] ?? ""),
					...measures.map((measure) => cell(row[measure], measure)),
				]),
				...(input.showTotals && overall[0]
					? [
							[
								"Total",
								...measures.map((measure) =>
									cell(overall[0][measure], measure),
								),
							],
						]
					: []),
			],
			more: rows.length >= matrixLevelRows,
		};
	}

	const groups = [...new Set(rows.map((row) => String(row[pivot] ?? "")))];
	const [rowTotals, columnTotals] = input.showTotals
		? await Promise.all([
				query([first], matrixLevelRows),
				query([pivot], matrixLevelRows),
			])
		: [[], []];
	const label = (group: string, measure: string) =>
		measures.length > 1 ? `${group} ${measure}` : group;
	const byRow = new Map<string, Map<string, Record<string, unknown>>>();
	for (const row of rows) {
		const key = String(row[first] ?? "");
		const held = byRow.get(key) ?? new Map();
		held.set(String(row[pivot] ?? ""), row);
		byRow.set(key, held);
	}
	const totalOf = new Map(
		rowTotals.map((row) => [String(row[first] ?? ""), row]),
	);
	const columnOf = new Map(
		columnTotals.map((row) => [String(row[pivot] ?? ""), row]),
	);
	return {
		kind: "table",
		columns: [
			{ name: first, numeric: false },
			...groups.flatMap((group) =>
				measures.map((measure) => ({
					name: label(group, measure),
					numeric: true,
				})),
			),
			...(input.showTotals
				? measures.map((measure) => ({
						name: label("Total", measure),
						numeric: true,
					}))
				: []),
		],
		rows: [
			...[...byRow].map(([key, cells]) => [
				key,
				...groups.flatMap((group) =>
					measures.map((measure) =>
						cell(cells.get(group)?.[measure], measure),
					),
				),
				...(input.showTotals
					? measures.map((measure) =>
							cell(totalOf.get(key)?.[measure], measure),
						)
					: []),
			]),
			...(input.showTotals
				? [
						[
							"Total",
							...groups.flatMap((group) =>
								measures.map((measure) =>
									cell(
										columnOf.get(group)?.[measure],
										measure,
									),
								),
							),
							...measures.map((measure) =>
								cell(overall[0]?.[measure], measure),
							),
						],
					]
				: []),
		],
		more: rows.length >= matrixLevelRows,
	};
}

// One small line per value on one scale, largest overall first, as the page orders them.
export function multiplesBody(
	rows: Record<string, unknown>[],
	split: string,
	axis: string,
	measure: string,
): PdfBody {
	const periods = [...new Set(rows.map((row) => String(row[axis] ?? "")))];
	const panels = new Map<string, Map<string, number | null>>();
	for (const row of rows) {
		const key = String(row[split] ?? "");
		const held = panels.get(key) ?? new Map();
		held.set(String(row[axis] ?? ""), toNumber(row[measure]));
		panels.set(key, held);
	}
	const values = rows
		.map((row) => toNumber(row[measure]))
		.filter((value): value is number => value !== null);
	if (values.length === 0) {
		return { kind: "note", text: "No rows match these filters." };
	}
	const total = (held: Map<string, number | null>) =>
		[...held.values()].reduce<number>(
			(sum, value) => sum + (value ?? 0),
			0,
		);
	return {
		kind: "multiples",
		// Zero included, since a set of panels is read for level as well as shape.
		min: Math.min(0, ...values),
		max: Math.max(0, ...values),
		panels: [...panels]
			.sort((a, b) => total(b[1]) - total(a[1]))
			.map(([label, held]) => ({
				label,
				values: periods.map((period) => held.get(period) ?? null),
			})),
	};
}

export interface ReadPage {
	visuals: PdfVisual[];
	filterWords: string[];
	accent: string | null;
	colors: string[];
}

// Where a page's figures come from. As a person under their own token while they are here,
// or as the app limited to what its owner was seen reading while they are away.
export interface PageReads {
	rows: (query: unknown) => Promise<Record<string, unknown>[]>;
	quality: (
		sourceKey: string,
	) => Promise<Awaited<ReturnType<typeof rulesFailing>>[number] | undefined>;
}

export function readsAs(identity: Identity): PageReads {
	return {
		rows: async (query) =>
			(await executeQuery(identity, parseQuerySpec(query as never))).rows,
		quality: async (sourceKey) =>
			(await failingFor(identity, [sourceKey]))[0],
	};
}

const waitingForOwner =
	"Waiting for you to open the app, to confirm what you can see.";

// A page's reads for a scheduled PDF while its owner is away. Each source has to be one the
// owner was confirmed able to read. One with row filters is narrowed to what they were
// recorded seeing, and a source that cannot be narrowed is not read at all.
export function readsWhileAway(
	ownerEmail: string,
	confirmedSources: string[],
	reads: BatchReads,
): PageReads {
	const restrictions = new Map<
		string,
		Promise<RowRestriction | null | undefined>
	>();
	const restrictionOf = (source: SemanticSource) => {
		const held = restrictions.get(source.sourceKey);
		if (held) return held;
		const found = runsUnattended(source)
			? Promise.resolve(undefined)
			: restrictionFor(ownerEmail, source.sourceKey);
		restrictions.set(source.sourceKey, found);
		return found;
	};
	return {
		rows: async (query) => {
			const spec = parseQuerySpec(query as never);
			const source = getSource(spec.sourceKey);
			if (!source || !confirmedSources.includes(source.sourceKey)) {
				throw new Error(waitingForOwner);
			}
			assertFieldsPresent(source, spec);
			const restriction = await restrictionOf(source);
			if (restriction === null) throw new Error(waitingForOwner);
			// Worked out as a page's own read is, with derived figures over the whole answer.
			const { spec: runSpec, window } = pagedSpec(spec);
			const { columns } = compileQuery(source, runSpec, { restriction });
			const rows = plainDates(
				await reads.read(source, runSpec, restriction),
			);
			return sliceWindow(
				applyTransforms(rows, columns, runSpec.transforms).rows,
				window,
			);
		},
		quality: async (sourceKey) =>
			confirmedSources.includes(sourceKey)
				? (await rulesFailing([sourceKey]))[0]
				: undefined,
	};
}

// Everything on a page, from these reads. The filters on screen replace the ones the page
// opens with, and a list of visuals with places replaces the page's own arrangement.
export async function readPageForExport(
	reads: PageReads,
	report: Pick<ReportDefinition, "theme" | "sourceKey">,
	page: ReportDefinition["pages"][number],
	options: {
		filters?: { field: string; op: string }[] | null;
		placed?: { visualId: string; box: PdfVisual["box"] }[];
	} = {},
): Promise<ReadPage> {
	const openingClauses = Object.values(
		openingFilters(
			page.visuals.map((visual) => ({
				visualId: visual.visualId,
				visualType: visual.visualType,
				config: visual.config as never,
			})),
			new Date(),
		),
	).flat();
	const opening = (options.filters ??
		openingClauses) as typeof openingClauses;
	await readyFonts();
	const { readThemeColors, withAlpha } =
		await import("../../app/visuals/colors");
	// The report's own theme, as the page draws it. The rest stays the light colours paper
	// needs, whatever the reader's choice on screen.
	const theme = allThemes(parseCustomThemes(settings().customThemes)).find(
		(held) => held.id === report.theme,
	);
	const colors = readThemeColors(theme ? themeTokens(theme) : null);
	const today = localToday();

	// A link has nowhere to go on paper, so it is left off rather than shown as dead words.
	const held: Placed[] = options.placed
		? options.placed.flatMap(({ visualId, box }) => {
				const visual = page.visuals.find(
					(item) => item.visualId === visualId,
				);
				return visual ? [{ visual, box }] : [];
			})
		: place(
				page.visuals.filter(
					(visual) =>
						!isPageControl(visual.visualType) &&
						visual.visualType !== "navLinks",
				),
			);

	const bodyFor = async ({ visual, box }: Placed): Promise<PdfBody> => {
		const type =
			visual.visualType === "forecastChart"
				? "lineChart"
				: visual.visualType;
		const options: Record<string, unknown> = {
			...((visual.config.options ?? {}) as Record<string, unknown>),
			...(visual.visualType === "forecastChart"
				? { forecast: true }
				: {}),
		};
		const option = <T>(key: string) =>
			optionValue<T>(visual.visualType, visual.config, key);

		if (type === "sectionHeader") {
			return {
				kind: "heading",
				text: String(options.text ?? visual.title ?? ""),
			};
		}

		const sourceKey =
			visual.sourceKey ?? page.sourceKey ?? report.sourceKey;
		const source = sourceKey ? getSource(sourceKey) : undefined;
		const dimensionNames = new Set(
			source?.dimensions.map((field) => field.name) ?? [],
		);
		const pageFilters = opening.filter((clause) =>
			dimensionNames.has(clause.field),
		);
		const hintFor = (field: string) =>
			(source?.measures.find((f) => f.name === field)?.formatHint ??
				source?.dimensions.find((f) => f.name === field)?.formatHint ??
				"text") as FormatHint;
		const read = reads.rows;

		if (type === "textPanel") {
			const html = String(
				options.html ?? (visual.config as { note?: string }).note ?? "",
			);
			const tokens = parseNarrative(html);
			if (tokens.length === 0 || !source) {
				return { kind: "text", paragraphs: textOfHtml(html) };
			}
			const answers = new Map<string, string>();
			await Promise.all(
				tokens.map(async (token) => {
					if (
						!source.measures.some((f) => f.name === token.measure)
					) {
						return;
					}
					const single = token.kind === "value";
					const rows = await read({
						sourceKey,
						dimensions: single ? [] : [token.dimension],
						measures: [token.measure],
						filters: pageFilters,
						...(single
							? {}
							: {
									sort: [
										{
											field: token.measure,
											direction:
												token.which === "top"
													? "desc"
													: "asc",
										},
									],
									limit: 1,
								}),
					});
					const row = rows[0];
					if (!row) return;
					answers.set(
						token.text,
						single
							? formatValue(
									row[token.measure],
									hintFor(token.measure),
								)
							: String(row[token.dimension] ?? "-"),
					);
				}),
			);
			return {
				kind: "text",
				paragraphs: textOfHtml(fillNarrative(html, answers)),
			};
		}

		if (type === "blockedNotice") {
			return {
				kind: "note",
				text:
					(visual.config as { note?: string }).note ??
					"This page is not available yet",
			};
		}
		if (type === "dataQualityTile") {
			const key = visual.sourceKey;
			const quality = key ? await reads.quality(key) : undefined;
			if (!quality) {
				return {
					kind: "lines",
					lines: [{ text: "No data rules on this source yet." }],
				};
			}
			return {
				kind: "lines",
				lines: [
					...(quality.score !== null
						? [{ text: `Score ${quality.score}`, large: true }]
						: []),
					{
						text:
							quality.failing.length === 0
								? "All data rules passing."
								: `${quality.failing.length} data rule${quality.failing.length === 1 ? "" : "s"} failing.`,
						tone:
							quality.failing.length === 0
								? ("good" as const)
								: ("bad" as const),
					},
					...quality.failing.map((rule) => ({ text: rule.name })),
				],
			};
		}

		const drawable =
			type === "kpiRow" ||
			type === "table" ||
			type === "matrixTable" ||
			type === "smallMultiples" ||
			type === "paceTile" ||
			type === "forecastRanking" ||
			recordTypes.has(type) ||
			chartTypes.has(type);
		if (!drawable || !source || !sourceKey) {
			return {
				kind: "note",
				text: "This visual can only be seen in the app.",
			};
		}

		const missing = waitingFor(
			requiredFields(
				type,
				options,
				page.config as { requireFilter?: unknown },
			),
			[...pageFilters, ...(visual.config.filters ?? [])],
		);
		if (missing.length > 0) {
			return {
				kind: "note",
				text: `Choose ${missing.join(", ")} in the app to see this.`,
			};
		}

		const ownFilters = [
			...pageFilters,
			...((visual.config.filters ?? []) as unknown[]),
		];
		const namedDimensions = (visual.config.dimensions ?? []) as string[];
		const namedMeasures = (visual.config.measures ?? []) as string[];

		if (type === "paceTile" || type === "forecastRanking") {
			const measure = namedMeasures[0];
			const hint = hintFor(measure);
			const needed = type === "paceTile" ? 1 : 2;
			if (!measure || namedDimensions.length < needed) {
				return { kind: "note", text: "This visual has no fields yet." };
			}
			const series = await read({
				sourceKey,
				dimensions: namedDimensions.slice(0, needed),
				measures: [measure],
				filters: ownFilters,
				sort: namedDimensions
					.slice(0, needed)
					.map((field) => ({ field, direction: "asc" })),
				limit: seriesRows,
			});
			if (type === "paceTile") {
				const target =
					typeof options.paceTarget === "number"
						? options.paceTarget
						: null;
				if (target === null) {
					return {
						kind: "note",
						text: "This visual has no target set.",
					};
				}
				const { pace, year, forecasted } = paceFromRows(
					series,
					namedDimensions[0],
					measure,
					target,
					today,
				);
				const tone = pace.onPace ? "good" : "bad";
				return {
					kind: "lines",
					lines: [
						{ text: formatValue(pace.expected, hint), large: true },
						{
							text: `${pace.onPace ? "On pace" : "Behind pace"} for ${formatValue(target, hint)} by the end of ${year}`,
							tone,
						},
						{
							text: forecasted
								? "What has happened so far, plus a forecast for the rest."
								: "Not enough history to forecast, so this is what has happened so far.",
						},
					],
					bar: { share: pace.percent / 100, tone },
				};
			}
			const ranked = rankForecasts(
				series,
				namedDimensions[0],
				namedDimensions[1],
				measure,
				today,
			);
			if (ranked.length === 0) {
				return {
					kind: "note",
					text: "Not enough history to forecast these.",
				};
			}
			return {
				kind: "table",
				columns: [
					{ name: namedDimensions[0], numeric: false },
					{ name: "Next period", numeric: true },
					{ name: "Likely range", numeric: true },
					{ name: "Heading", numeric: false },
				],
				rows: ranked.map((row) => [
					row.group,
					formatValue(row.next, hint),
					`${formatValue(row.low, hint)} to ${formatValue(row.high, hint)}`,
					row.trend ?? "-",
				]),
				more: false,
			};
		}

		const shape = initialQueryForVisual(
			{ ...visual, visualType: type } as VisualDefinition,
			sourceKey,
			source,
			pageFilters,
		);
		if (!shape) {
			return {
				kind: "note",
				text: "This visual has nothing to show yet.",
			};
		}
		const measures = (shape.measures ?? []) as string[];
		const dimensions = (shape.dimensions ?? []) as string[];

		if (type === "kpiRow") {
			return {
				kind: "figures",
				figures: await kpiFigures({
					measures,
					filters: ownFilters,
					style: (visual.config as { style?: VisualStyle }).style,
					groups: option<KpiGroup[]>("groups"),
					compareTo: option<ComparePeriod>("compareTo") ?? null,
					compareField:
						option<string>("compareField") ||
						source.defaultTimeField ||
						null,
					sparkline: option<string>("sparkline") ?? null,
					targets: option("targets"),
					sourceKey,
					read,
					hintFor,
					colors,
					withAlpha,
				}),
			};
		}

		if (type === "matrixTable") {
			return matrixBody({
				sourceKey,
				namedDimensions,
				measures,
				pivot: option<string>("columnDimension") ?? null,
				showTotals: option<boolean>("showTotals") === true,
				filters: ownFilters,
				read,
				hintFor,
			});
		}

		const rows = await read(shape);

		if (recordTypes.has(type)) {
			if (rows.length === 0) {
				return { kind: "note", text: "No rows match these filters." };
			}
			const pairs = [...dimensions, ...measures].map((name) => ({
				label: name,
				text: formatValue(rows[0][name], hintFor(name)),
			}));
			const notice =
				rows.length > 1
					? "Showing the first of several matching records."
					: null;
			return type === "entityHeader" && !notice
				? {
						kind: "figures",
						figures: pairs.map((pair) => ({
							label: pair.label,
							text: pair.text,
						})),
					}
				: { kind: "pairs", pairs, notice };
		}

		if (type === "smallMultiples") {
			const [split, axis] = dimensions;
			const measure = measures[0];
			if (!split || !axis || !measure) {
				return { kind: "note", text: "This visual has no fields yet." };
			}
			return multiplesBody(rows, split, axis, measure);
		}

		if (type === "table") {
			const shown = [...dimensions, ...measures];
			const limit = typeof shape.limit === "number" ? shape.limit : null;
			return {
				kind: "table",
				columns: shown.map((name) => ({
					name,
					numeric: measures.includes(name),
				})),
				rows: rows.map((row) =>
					shown.map((name) => formatValue(row[name], hintFor(name))),
				),
				more: limit !== null && rows.length >= limit,
			};
		}

		if (rows.length === 0) {
			return { kind: "note", text: "No rows match these filters." };
		}

		// The same comparison and forecast the page draws, from the same settings.
		const compareTo = option<ComparePeriod>("compareTo") ?? null;
		const compareField =
			option<string>("compareField") || source.defaultTimeField || null;
		const movedFilters =
			compareTo && compareField
				? shiftDateFilters(
						ownFilters as DateClause[],
						compareField,
						compareTo,
					)
				: null;
		const comparisonRows = movedFilters
			? await read({ ...shape, filters: movedFilters })
			: null;

		const periodField =
			dimensions.length === 1 &&
			forecastTypes.has(type) &&
			(dimensions[0] === compareField ||
				/date|timestamp/i.test(
					source.dimensions.find((f) => f.name === dimensions[0])
						?.dataType ?? "",
				))
				? dimensions[0]
				: null;
		const forecast =
			periodField && options.forecast === true
				? forecastRows(rows, periodField, measures, {
						horizon:
							typeof options.forecastPeriods === "number"
								? options.forecastPeriods
								: null,
						today,
						additive: Object.fromEntries(
							measures.map((measure) => [
								measure,
								looksAdditive(
									measure,
									source.measures.find(
										(f) => f.name === measure,
									)?.formatHint,
								),
							]),
						),
					})
				: null;

		const svg = await chartSvg(
			type,
			{
				rows,
				dimensions,
				measures,
				colors,
				style: (visual.config as { style?: never }).style,
				options,
				comparisonRows,
				forecast,
				hintFor,
			},
			Math.max(120, Math.round(box.width - 20)),
			Math.max(80, Math.round(box.height - 40)),
		);
		return svg
			? {
					kind: "chart",
					svg,
					caption: forecast ? describeForecast(forecast) : null,
					native: nativeChartFor({
						visualType: type,
						rows,
						dimensions,
						measures,
						hint: hintFor(measures[0]),
						forecast,
					}),
				}
			: {
					kind: "note",
					text:
						compareTo && !movedFilters
							? `Nothing to compare against. This moves the page's date range back, so the page needs a date filter${compareField ? ` on ${compareField}` : ""}.`
							: "This chart has nothing to draw from these rows.",
				};
	};

	const visuals = await Promise.all(
		held.map(async (item): Promise<PdfVisual> => {
			let body: PdfBody;
			try {
				body = await bodyFor(item);
			} catch (error) {
				console.warn(
					`A visual could not be drawn for a PDF, ${item.visual.visualId}:`,
					error,
				);
				body = {
					kind: "note",
					text: "This visual could not be read when this was prepared.",
				};
			}
			return { title: item.visual.title, box: item.box, body };
		}),
	);

	return {
		visuals,
		filterWords: opening.map(clauseWords),
		accent: theme?.accent ?? null,
		colors: colors.series,
	};
}

export async function drawPagePdf(
	identity: Identity,
	input: { slug: string; pageId: string },
): Promise<{ bytes: Uint8Array; filename: string; reportId: string }> {
	const policy = await resolvePolicyClass(identity);
	const report = await getReport(policy, identity, input.slug);
	const page = report?.pages.find((p) => p.pageId === input.pageId);
	if (!report || !page) {
		throw new PagePdfRefused("You can no longer open this page.");
	}
	if (!(await canDoOnReport(policy, identity, "export.run", report))) {
		throw new PagePdfRefused(
			"You no longer hold the right to export this.",
		);
	}

	await recordPrint(identity, report, {
		pageId: page.pageId,
		search: "scheduled",
	});
	return drawOnPaper(readsAs(identity), report, page, identity.email);
}

// The same PDF while its owner is away, for a delivery they were confirmed able to export
// and read while they were here. See lib/deliveries/runner.
export async function drawPagePdfWhileAway(
	reads: BatchReads,
	input: {
		slug: string;
		pageId: string;
		ownerEmail: string;
		confirmedSources: string[];
	},
): Promise<{ bytes: Uint8Array; filename: string; reportId: string }> {
	const report = await reportForScheduledRun(input.slug);
	const page = report?.pages.find((p) => p.pageId === input.pageId);
	if (!report || !page) {
		throw new PagePdfRefused("This page is no longer available.");
	}
	await writePrintRecord(input.ownerEmail, report, {
		pageId: page.pageId,
		search: "scheduled",
	});
	return drawOnPaper(
		readsWhileAway(input.ownerEmail, input.confirmedSources, reads),
		report,
		page,
		input.ownerEmail,
	);
}

async function drawOnPaper(
	reads: PageReads,
	report: Pick<
		ReportDefinition,
		"reportId" | "title" | "theme" | "sourceKey"
	>,
	page: ReportDefinition["pages"][number],
	preparedFor: string,
): Promise<{ bytes: Uint8Array; filename: string; reportId: string }> {
	const read = await readPageForExport(reads, report, page);
	const safeName = `${report.title} ${page.title}`
		.replace(/[^\w\s-]+/g, "")
		.trim()
		.replace(/\s+/g, "-");
	return {
		bytes: drawReportPage({
			reportTitle: report.title,
			pageTitle: page.title,
			preparedFor,
			preparedOn: new Date(),
			filters: read.filterWords,
			visuals: read.visuals,
			accent: read.accent,
			series: read.colors[0],
		}),
		filename: `${safeName || "report"}.pdf`,
		reportId: report.reportId,
	};
}

// Keeps a drawn file for its owner, returning how they fetch it.
export async function saveDeliveryFile(
	deliveryId: string,
	ownerEmail: string,
	drawn: { bytes: Uint8Array; filename: string; reportId: string },
): Promise<string> {
	const rows = await sql<{ file_id: string }>(
		`INSERT INTO delivery_files
		   (delivery_id, owner_email, report_id, filename, bytes, expires_on)
		 VALUES ($1::uuid, $2, $3::uuid, $4, $5,
		         now() + make_interval(days => $6))
		 RETURNING file_id::text AS file_id`,
		[
			deliveryId,
			ownerEmail.toLowerCase(),
			drawn.reportId,
			drawn.filename,
			Buffer.from(drawn.bytes),
			pdfKeptDays,
		],
	);
	return rows[0].file_id;
}
