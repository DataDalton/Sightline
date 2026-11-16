import { visualByType, isFilterVisual } from "../visuals/catalog";
import { gridColumns } from "../visuals/layout";

// Turning what the model proposed into edits that are known to be valid.
//
// The model is asked for a small JSON plan rather than for edits, and nothing it
// says is applied as given. Every visual it proposes is checked against the
// catalogue, for a real type with the number of dimensions and measures that type
// takes, and against the source, for field names that exist as the kind they are
// used as. Whatever fails is dropped with the reason, so a plan that is half
// right still applies its right half and says what it left out.
//
// Kept free of database and network imports so it can be tested on its own.

// The edits produced here, in the shape lib/platform/editing takes. Declared
// here so this module needs nothing from the database side.
export type EditOperation =
	| {
			type: "addVisual";
			visualId: string;
			pageId: string;
			visualType: string;
			title: string | null;
			sourceKey: string | null;
			config: Record<string, unknown>;
			layout: { x: number; y: number; w: number; h: number };
	  }
	| {
			type: "updateVisual";
			visualId: string;
			config: Record<string, unknown>;
	  };

export interface SourceShape {
	sourceKey: string;
	dimensions: string[];
	measures: string[];
}

export interface VisualShape {
	visualId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	dimensions: string[];
	measures: string[];
	// The whole stored configuration, which an edit replaces as one.
	config: Record<string, unknown>;
	layout: { x: number; y: number; w: number; h: number };
	isActive: boolean;
}

export interface PageShape {
	pageId: string;
	title: string;
	protected: boolean;
	visuals: VisualShape[];
}

export interface ReportShape {
	reportId: string;
	slug: string;
	title: string;
	description: string | null;
	protected: boolean;
	pages: PageShape[];
}

export interface ProposedVisual {
	visualType: string;
	title: string;
	dimensions: string[];
	measures: string[];
}

export interface Checked<T> {
	value: T | null;
	reason: string | null;
}

// The first JSON object or array in a reply, which a model sometimes wraps in
// prose or a code fence.
export function parseJson(text: string): unknown {
	const start = text.search(/[[{]/);
	if (start < 0) return null;
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	const end = text.lastIndexOf(close);
	if (end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function text(value: unknown, limit: number): string {
	return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

// Visual types the assistant may place. Controls that act on the whole page and
// panels of text are left to people.
export function placeableType(type: string): boolean {
	const definition = visualByType[type];
	if (!definition) return false;
	if (isFilterVisual(type)) return type === "dropdownFilter";
	return !["text", "layout"].includes(definition.category);
}

// One proposed visual, checked against the catalogue and the source.
export function checkVisual(
	raw: unknown,
	source: SourceShape,
): Checked<ProposedVisual> {
	const held = (raw ?? {}) as Record<string, unknown>;
	const visualType = text(held.visualType, 60);
	const definition = visualByType[visualType];
	if (!definition || !placeableType(visualType)) {
		return {
			value: null,
			reason: `${visualType || "A visual"} is not a type that can be placed`,
		};
	}
	const dimensions = [...new Set(strings(held.dimensions))];
	const measures = [...new Set(strings(held.measures))];
	const unknownDimension = dimensions.find(
		(name) => !source.dimensions.includes(name),
	);
	if (unknownDimension) {
		return {
			value: null,
			reason: `${unknownDimension} is not a dimension of this source`,
		};
	}
	const unknownMeasure = measures.find(
		(name) => !source.measures.includes(name),
	);
	if (unknownMeasure) {
		return {
			value: null,
			reason: `${unknownMeasure} is not a measure of this source`,
		};
	}
	const { encoding } = definition;
	if (
		dimensions.length < encoding.dimensions.min ||
		dimensions.length > encoding.dimensions.max ||
		measures.length < encoding.measures.min ||
		measures.length > encoding.measures.max
	) {
		return {
			value: null,
			reason: `${definition.label} takes ${encoding.dimensions.min} to ${encoding.dimensions.max} dimensions and ${encoding.measures.min} to ${encoding.measures.max} measures`,
		};
	}
	const title = text(held.title, 120) || definition.label;
	return { value: { visualType, title, dimensions, measures }, reason: null };
}

// Where a new visual goes on a page: under everything already there, at the
// type's own default size.
export function placeBelow(
	visuals: { layout: VisualShape["layout"]; isActive: boolean }[],
	visualType: string,
): VisualShape["layout"] {
	const size = visualByType[visualType]?.defaultLayout ?? { w: 6, h: 4 };
	const bottom = visuals
		.filter((visual) => visual.isActive)
		.reduce(
			(most, visual) => Math.max(most, visual.layout.y + visual.layout.h),
			0,
		);
	return { x: 0, y: bottom, w: Math.min(size.w, gridColumns), h: size.h };
}

// The edits a plan for a new field asks for, grouped by report, with what was
// left out and why.
//
// The plan says, per item, to add the field to an existing visual or to add a
// new visual to a page. Adding to a visual keeps within what its type takes.
export function newFieldEdits(
	plan: unknown,
	field: string,
	fieldKind: "dimension" | "measure",
	source: SourceShape,
	reports: ReportShape[],
	makeId: () => string,
): {
	byReport: Map<string, EditOperation[]>;
	// What was done on each report, for its version label.
	doneByReport: Map<string, string[]>;
	done: string[];
	skipped: string[];
} {
	const doneByReport = new Map<string, string[]>();
	const did = (reportId: string, line: string) => {
		done.push(line);
		doneByReport.set(reportId, [
			...(doneByReport.get(reportId) ?? []),
			line,
		]);
	};
	const byReport = new Map<string, EditOperation[]>();
	const done: string[] = [];
	const skipped: string[] = [];
	const edits = Array.isArray((plan as { edits?: unknown })?.edits)
		? ((plan as { edits: unknown[] }).edits as Record<string, unknown>[])
		: [];

	const visualIndex = new Map<
		string,
		{ report: ReportShape; page: PageShape; visual: VisualShape }
	>();
	const pageIndex = new Map<
		string,
		{ report: ReportShape; page: PageShape }
	>();
	for (const report of reports) {
		for (const page of report.pages) {
			pageIndex.set(page.pageId, { report, page });
			for (const visual of page.visuals) {
				visualIndex.set(visual.visualId, { report, page, visual });
			}
		}
	}
	const push = (reportId: string, operation: EditOperation) => {
		const held = byReport.get(reportId) ?? [];
		held.push(operation);
		byReport.set(reportId, held);
	};

	for (const edit of edits.slice(0, 12)) {
		if (edit?.do === "addToVisual") {
			const found = visualIndex.get(String(edit.visualId ?? ""));
			if (!found) {
				skipped.push("A visual the plan named is not on these reports");
				continue;
			}
			const { report, page, visual } = found;
			if (report.protected || page.protected) {
				skipped.push(`${report.title} is protected`);
				continue;
			}
			if (visual.sourceKey !== source.sourceKey) continue;
			const dimensions =
				fieldKind === "dimension" && !visual.dimensions.includes(field)
					? [...visual.dimensions, field]
					: visual.dimensions;
			const measures =
				fieldKind === "measure" && !visual.measures.includes(field)
					? [...visual.measures, field]
					: visual.measures;
			const encoding = visualByType[visual.visualType]?.encoding;
			if (
				!encoding ||
				dimensions.length > encoding.dimensions.max ||
				measures.length > encoding.measures.max
			) {
				skipped.push(
					`${visual.title ?? "A visual"} on ${report.title} has no room for another ${fieldKind}`,
				);
				continue;
			}
			push(report.reportId, {
				type: "updateVisual",
				visualId: visual.visualId,
				config: { ...visual.config, dimensions, measures },
			});
			did(
				report.reportId,
				`added ${field} to ${visual.title ?? "a visual"} on ${report.title}`,
			);
		} else if (edit?.do === "addVisual") {
			const found = pageIndex.get(String(edit.pageId ?? ""));
			if (!found) {
				skipped.push("A page the plan named is not on these reports");
				continue;
			}
			const { report, page } = found;
			if (report.protected || page.protected) {
				skipped.push(`${report.title} is protected`);
				continue;
			}
			const checked = checkVisual(edit, source);
			if (!checked.value) {
				skipped.push(checked.reason ?? "A visual did not fit");
				continue;
			}
			const visual = checked.value;
			if (
				!visual.dimensions.includes(field) &&
				!visual.measures.includes(field)
			) {
				skipped.push(`${visual.title} did not use ${field}`);
				continue;
			}
			const visualId = makeId();
			const layout = placeBelow(page.visuals, visual.visualType);
			push(report.reportId, {
				type: "addVisual",
				visualId,
				pageId: page.pageId,
				visualType: visual.visualType,
				title: visual.title,
				sourceKey: source.sourceKey,
				config: {
					dimensions: visual.dimensions,
					measures: visual.measures,
				},
				layout,
			});
			// Later visuals on the same page go under this one.
			page.visuals.push({
				visualId,
				visualType: visual.visualType,
				title: visual.title,
				sourceKey: source.sourceKey,
				dimensions: visual.dimensions,
				measures: visual.measures,
				config: {
					dimensions: visual.dimensions,
					measures: visual.measures,
				},
				layout,
				isActive: true,
			});
			did(
				report.reportId,
				`added ${visual.title} to ${page.title} in ${report.title}`,
			);
		}
	}
	return { byReport, doneByReport, done, skipped };
}

// A report the model proposed for a new source, with every visual checked.
export interface ProposedReport {
	title: string;
	description: string;
	pages: { title: string; visuals: ProposedVisual[] }[];
}

export function checkReportPlan(
	plan: unknown,
	source: SourceShape,
	fallbackTitle: string,
): { report: ProposedReport | null; skipped: string[] } {
	const held = (plan ?? {}) as Record<string, unknown>;
	const skipped: string[] = [];
	const pages: ProposedReport["pages"] = [];
	const rawPages = Array.isArray(held.pages) ? held.pages.slice(0, 5) : [];
	for (const rawPage of rawPages) {
		const page = (rawPage ?? {}) as Record<string, unknown>;
		const visuals: ProposedVisual[] = [];
		const rawVisuals = Array.isArray(page.visuals)
			? page.visuals.slice(0, 8)
			: [];
		for (const raw of rawVisuals) {
			const checked = checkVisual(raw, source);
			if (checked.value) visuals.push(checked.value);
			else skipped.push(checked.reason ?? "A visual did not fit");
		}
		if (visuals.length > 0) {
			pages.push({ title: text(page.title, 120) || "Overview", visuals });
		}
	}
	if (pages.length === 0) return { report: null, skipped };
	return {
		report: {
			title: text(held.title, 120) || fallbackTitle,
			description: text(held.description, 400),
			pages,
		},
		skipped,
	};
}

// Lays a page's visuals out in reading order, each at its type's default size,
// filling rows of the grid from the left.
export function layoutPage(
	visuals: ProposedVisual[],
): { visual: ProposedVisual; layout: VisualShape["layout"] }[] {
	const placed: { visual: ProposedVisual; layout: VisualShape["layout"] }[] =
		[];
	let x = 0;
	let y = 0;
	let rowHeight = 0;
	for (const visual of visuals) {
		const size = visualByType[visual.visualType]?.defaultLayout ?? {
			w: 6,
			h: 4,
		};
		const w = Math.min(size.w, gridColumns);
		if (x + w > gridColumns) {
			x = 0;
			y += rowHeight;
			rowHeight = 0;
		}
		placed.push({ visual, layout: { x, y, w, h: size.h } });
		x += w;
		rowHeight = Math.max(rowHeight, size.h);
	}
	return placed;
}

// Text the assistant writes for people to read carries no figures, since it was
// written from data the reader may not be allowed to see. A sentence with a
// number in it is dropped.
export function withoutFigures(value: string): string {
	return value
		.split(/(?<=[.!?])\s+/)
		.filter((sentence) => !/\d/.test(sentence))
		.join(" ")
		.trim();
}
