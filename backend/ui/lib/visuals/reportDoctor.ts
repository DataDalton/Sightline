import { isPageControl } from "./catalog";
import { validateVisual, type SourceFields } from "./validate";

// Grades a page while it is being built, naming what will mislead a reader or keep
// them waiting, with a one-click fix where one exists.
//
// Pure, so every rule can be tested. It knows only what it is handed, and a rule
// needing a figure it was not given says nothing rather than guessing.

type DoctorStyle = {
	yAxis?: { min?: number | null } & Record<string, unknown>;
} & Record<string, unknown>;

export interface DoctorVisual {
	visualId: string;
	title: string | null;
	visualType: string;
	sourceKey?: string | null;
	config: {
		dimensions?: unknown;
		measures?: unknown;
		options?: Record<string, unknown>;
		style?: DoctorStyle;
		[key: string]: unknown;
	};
}

export interface DoctorFix {
	label: string;
	visualType?: string;
	options?: Record<string, unknown>;
	axisMin?: null;
}

export interface Finding {
	key: string;
	severity: "problem" | "suggestion";
	visualId: string | null;
	title: string;
	detail: string;
	fix?: DoctorFix;
}

export interface DoctorInput {
	visuals: DoctorVisual[];
	// From timing the page. Absent until it has been timed.
	timings?: Record<
		string,
		{ warehouseMs: number | null; rowCount: number | null }
	>;
	// How readers use the page. Absent for someone who cannot see that.
	usage?: {
		pageReaders: number;
		visuals: Record<string, { actions: number; readers: number }>;
	};
	sourceFields?: (sourceKey: string) => SourceFields | null;
}

// Waiting past these is noticed, and then is a reason to leave.
export const slowAfterMs = 3000;
export const verySlowAfterMs = 10000;

const sliceLimit = 8;
const categoryLimit = 30;
const columnLimit = 12;
const pageVisualLimit = 12;
// Too few readers says nothing about whether a visual is useful.
const readersBeforeJudging = 10;

const zeroBasedTypes = new Set([
	"barChart",
	"horizontalBarChart",
	"stackedBarChart",
	"comboChart",
]);
const sliceTypes = new Set(["pieChart", "donutChart"]);
const rankableTypes = new Set(["barChart", "horizontalBarChart"]);

function labelOf(visual: DoctorVisual): string {
	return visual.title?.trim() || "This visual";
}

function countOf(fields: unknown): number {
	return Array.isArray(fields) ? fields.length : 0;
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)} seconds`;
}

export function examinePage(input: DoctorInput): Finding[] {
	const findings: Finding[] = [];
	const data = input.visuals.filter((v) => !isPageControl(v.visualType));

	for (const visual of data) {
		const label = labelOf(visual);
		const timing = input.timings?.[visual.visualId];
		const rowCount = timing?.rowCount ?? null;
		const options = visual.config.options ?? {};
		const add = (finding: Omit<Finding, "visualId">) =>
			findings.push({ ...finding, visualId: visual.visualId });

		const source =
			visual.sourceKey && input.sourceFields
				? input.sourceFields(visual.sourceKey)
				: null;
		if (source) {
			for (const problem of validateVisual(
				visual.visualType,
				visual.config,
				source,
			)) {
				add({
					key: `valid:${visual.visualId}:${problem.field}:${problem.message}`,
					severity:
						problem.severity === "error" ? "problem" : "suggestion",
					title: `${label} has a setting that needs attention`,
					detail: problem.message,
				});
			}
		}

		const axisMin = visual.config.style?.yAxis?.min;
		if (
			zeroBasedTypes.has(visual.visualType) &&
			typeof axisMin === "number" &&
			axisMin > 0
		) {
			add({
				key: `axis:${visual.visualId}`,
				severity: "problem",
				title: `${label} starts its axis above zero`,
				detail: "A bar's length is what gets read, so cutting off the bottom makes differences look bigger than they are.",
				fix: { label: "Start at zero", axisMin: null },
			});
		}

		if (
			sliceTypes.has(visual.visualType) &&
			rowCount !== null &&
			rowCount > sliceLimit
		) {
			add({
				key: `slices:${visual.visualId}`,
				severity: "problem",
				title: `${label} has ${rowCount} slices`,
				detail: "Past a handful, slices are too thin to compare and the labels collide. A ranked bar shows the same figures readably.",
				fix: {
					label: "Show as a ranked bar",
					visualType: "horizontalBarChart",
				},
			});
		}

		if (
			rankableTypes.has(visual.visualType) &&
			rowCount !== null &&
			rowCount > categoryLimit &&
			!options.topN
		) {
			add({
				key: `categories:${visual.visualId}`,
				severity: "suggestion",
				title: `${label} draws ${rowCount} bars`,
				detail: "Most of them will be too small to read. Keeping the top ones also asks less of the warehouse.",
				fix: { label: "Keep the top 20", options: { topN: 20 } },
			});
		}

		if (
			visual.visualType === "table" &&
			countOf(visual.config.dimensions) +
				countOf(visual.config.measures) >
				columnLimit
		) {
			add({
				key: `columns:${visual.visualId}`,
				severity: "suggestion",
				title: `${label} has a lot of columns`,
				detail: "Readers have to scroll sideways to see them, and each one adds to the query.",
			});
		}

		if (!visual.title?.trim() && visual.visualType !== "kpiRow") {
			add({
				key: `title:${visual.visualId}`,
				severity: "suggestion",
				title: "A visual has no title",
				detail: "A reader sees the shape before they know what it is measuring.",
			});
		}

		if (timing?.warehouseMs != null && timing.warehouseMs >= slowAfterMs) {
			const verySlow = timing.warehouseMs >= verySlowAfterMs;
			add({
				key: `slow:${visual.visualId}`,
				severity: verySlow ? "problem" : "suggestion",
				title: `${label} took ${seconds(timing.warehouseMs)} from cold`,
				detail: "Whoever reaches it first after the cache expires waits this long. Fewer fields, a default date range or a filter requirement usually help.",
			});
		}

		const used = input.usage;
		if (
			used &&
			used.pageReaders >= readersBeforeJudging &&
			!used.visuals[visual.visualId]?.readers
		) {
			add({
				key: `unused:${visual.visualId}`,
				severity: "suggestion",
				title: `Nobody has used ${label}`,
				detail: `${used.pageReaders} people read this page lately and none of them opened, expanded or selected anything in it. Reading it without touching it does not show up here, so check before removing it.`,
			});
		}
	}

	if (data.length > pageVisualLimit) {
		findings.push({
			key: "crowded",
			severity: "suggestion",
			visualId: null,
			title: `This page has ${data.length} visuals`,
			detail: "Every one is a query and something more to read. Splitting it over two pages loads faster and reads better.",
		});
	}

	return findings.sort(
		(a, b) =>
			Number(b.severity === "problem") - Number(a.severity === "problem"),
	);
}

// Visuals with a query that have not been timed. The speed, slice and bar checks need that, so
// a grade with any of these left is only a grade so far.
export function untimedVisuals(
	visuals: DoctorVisual[],
	timings: NonNullable<DoctorInput["timings"]>,
): number {
	return visuals.filter(
		(visual) =>
			!isPageControl(visual.visualType) &&
			countOf(visual.config.dimensions) +
				countOf(visual.config.measures) >
				0 &&
			!timings[visual.visualId],
	).length;
}

export type Grade = "A" | "B" | "C" | "D";

// A report is graded by its weakest page, since that is the one a reader can land on.
export function reportGrade(pages: Grade[]): Grade {
	return pages.reduce<Grade>(
		(worst, grade) => (grade > worst ? grade : worst),
		"A",
	);
}

// A problem counts for two suggestions.
export function gradeFor(findings: Finding[]): Grade {
	const score = findings.reduce(
		(total, finding) => total + (finding.severity === "problem" ? 2 : 1),
		0,
	);
	if (score === 0) return "A";
	if (score <= 2) return "B";
	if (score <= 5) return "C";
	return "D";
}

// The visual once a fix is applied. Returns the same shape it was given.
export function applyFix<T extends DoctorVisual>(visual: T, fix: DoctorFix): T {
	const config = { ...visual.config };
	if (fix.options) {
		config.options = { ...config.options, ...fix.options };
	}
	if (fix.axisMin === null) {
		const yAxis = { ...config.style?.yAxis };
		delete yAxis.min;
		config.style = { ...config.style, yAxis };
	}
	return {
		...visual,
		visualType: fix.visualType ?? visual.visualType,
		config,
	};
}

// Where a page's warehouse time goes, slowest first, with each visual's share.
export function speedRanking(
	visuals: DoctorVisual[],
	timings: NonNullable<DoctorInput["timings"]>,
): {
	visualId: string;
	title: string;
	warehouseMs: number;
	rowCount: number | null;
	share: number;
}[] {
	const timed = visuals.flatMap((visual) => {
		const timing = timings[visual.visualId];
		return timing?.warehouseMs == null
			? []
			: [
					{
						visualId: visual.visualId,
						title: labelOf(visual),
						warehouseMs: timing.warehouseMs,
						rowCount: timing.rowCount,
					},
				];
	});
	const total = timed.reduce((sum, row) => sum + row.warehouseMs, 0);
	return timed
		.sort((a, b) => b.warehouseMs - a.warehouseMs)
		.map((row) => ({
			...row,
			share: total > 0 ? (row.warehouseMs / total) * 100 : 0,
		}));
}
