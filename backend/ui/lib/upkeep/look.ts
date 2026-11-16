import { sql } from "../data/lakebase";
import { asApp } from "../alerts/runner";
import { compileQuery } from "../query/builder";
import { parseQuerySpec } from "../query/spec";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import type { ReportShape, SourceShape, VisualShape } from "./decide";

// What the assistant reads before deciding what to build.
//
// The source's own field definitions, the reports already built on it, and a
// small summary of a field's values. The summary is read as the application and
// goes only to the model, to judge whether a field is worth a place on a report.
// No person sees it, and nothing the assistant writes repeats a figure from it.

export function sourceShape(source: SemanticSource): SourceShape {
	return {
		sourceKey: source.sourceKey,
		dimensions: source.dimensions.map((field) => field.name),
		measures: source.measures.map((field) => field.name),
	};
}

// The fields as the model is shown them: name, kind, type and the definition
// written on the source.
export function describeFields(source: SemanticSource) {
	const describe = (field: SemanticSource["dimensions"][number]) => ({
		name: field.name,
		kind: field.kind,
		type: field.dataType,
		description: field.description ?? undefined,
		expression: field.expression ?? undefined,
	});
	return {
		dimensions: source.dimensions.map(describe),
		measures: source.measures.map(describe),
	};
}

interface VisualRow {
	report_id: string;
	slug: string;
	report_title: string;
	description: string | null;
	report_protected: boolean;
	page_id: string;
	page_title: string;
	page_protected: boolean;
	page_order: number;
	visual_id: string | null;
	visual_type: string | null;
	title: string | null;
	source_key: string | null;
	config: Record<string, unknown> | null;
	layout_x: number | null;
	layout_y: number | null;
	layout_w: number | null;
	layout_h: number | null;
	is_active: boolean | null;
}

function names(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

// The shared reports built on a source, page by page with their visuals. A page
// somebody built for themselves is theirs, so the assistant adds nothing to it.
export async function reportsOn(sourceKey: string): Promise<ReportShape[]> {
	const rows = await sql<VisualRow>(
		`SELECT r.report_id::text AS report_id, r.slug, r.title AS report_title,
		        r.description, r.protect_edit AS report_protected,
		        p.page_id::text AS page_id, p.title AS page_title,
		        p.protect_edit AS page_protected, p.sort_order AS page_order,
		        v.visual_id::text AS visual_id, v.visual_type, v.title,
		        coalesce(v.source_key, p.source_key, r.source_key) AS source_key,
		        v.config, v.layout_x, v.layout_y, v.layout_w, v.layout_h,
		        v.is_active
		 FROM reports r
		 JOIN report_pages p ON p.report_id = r.report_id AND p.is_active
		 LEFT JOIN report_visuals v ON v.page_id = p.page_id
		 WHERE r.is_active AND NOT r.is_personal
		   AND r.report_id IN (
		     SELECT DISTINCT r2.report_id FROM reports r2
		     LEFT JOIN report_pages p2 ON p2.report_id = r2.report_id
		     LEFT JOIN report_visuals v2 ON v2.page_id = p2.page_id
		     WHERE r2.source_key = $1 OR p2.source_key = $1 OR v2.source_key = $1)
		 ORDER BY r.title, p.sort_order, v.sort_order`,
		[sourceKey],
	);
	const reports = new Map<string, ReportShape>();
	for (const row of rows) {
		let report = reports.get(row.report_id);
		if (!report) {
			report = {
				reportId: row.report_id,
				slug: row.slug,
				title: row.report_title,
				description: row.description,
				protected: row.report_protected,
				pages: [],
			};
			reports.set(row.report_id, report);
		}
		let page = report.pages.find((held) => held.pageId === row.page_id);
		if (!page) {
			page = {
				pageId: row.page_id,
				title: row.page_title,
				protected: row.page_protected,
				visuals: [],
			};
			report.pages.push(page);
		}
		if (row.visual_id && row.visual_type) {
			const config = row.config ?? {};
			const visual: VisualShape = {
				visualId: row.visual_id,
				visualType: row.visual_type,
				title: row.title,
				sourceKey: row.source_key,
				dimensions: names(config.dimensions),
				measures: names(config.measures),
				config,
				layout: {
					x: row.layout_x ?? 0,
					y: row.layout_y ?? 0,
					w: row.layout_w ?? 6,
					h: row.layout_h ?? 4,
				},
				isActive: row.is_active !== false,
			};
			page.visuals.push(visual);
		}
	}
	return [...reports.values()];
}

// The measure the reports on a source use most, which is what a dimension is
// best judged against.
function mainMeasure(
	source: SemanticSource,
	reports: ReportShape[],
): string | null {
	const used = new Map<string, number>();
	for (const report of reports) {
		for (const page of report.pages) {
			for (const visual of page.visuals) {
				if (visual.sourceKey !== source.sourceKey) continue;
				for (const measure of visual.measures) {
					used.set(measure, (used.get(measure) ?? 0) + 1);
				}
			}
		}
	}
	const known = new Set(source.measures.map((field) => field.name));
	const ranked = [...used.entries()]
		.filter(([name]) => known.has(name))
		.sort((a, b) => b[1] - a[1]);
	return ranked[0]?.[0] ?? source.measures[0]?.name ?? null;
}

// The dimension the reports on a source split by most.
function mainDimension(
	source: SemanticSource,
	reports: ReportShape[],
): string | null {
	const used = new Map<string, number>();
	for (const report of reports) {
		for (const page of report.pages) {
			for (const visual of page.visuals) {
				if (visual.sourceKey !== source.sourceKey) continue;
				for (const dimension of visual.dimensions) {
					used.set(dimension, (used.get(dimension) ?? 0) + 1);
				}
			}
		}
	}
	const known = new Set(source.dimensions.map((field) => field.name));
	const ranked = [...used.entries()]
		.filter(([name]) => known.has(name) && name !== source.defaultTimeField)
		.sort((a, b) => b[1] - a[1]);
	return ranked[0]?.[0] ?? null;
}

async function readAsApp(
	source: SemanticSource,
	raw: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	const spec = parseQuerySpec({
		sourceKey: source.sourceKey,
		filters: [],
		sort: [],
		offset: 0,
		transforms: [],
		...raw,
	});
	const compiled = compileQuery(source, spec);
	const rows = await asApp(compiled.sql, compiled.params);
	return rows.map((row) =>
		Object.fromEntries(
			compiled.columns.map((column) => [column, row[column]]),
		),
	);
}

// A small summary of one field, for the model to judge it by.
//
// A dimension is read against the main measure: how many values it has and how
// the measure spreads across the largest of them. A measure is read on its own
// and split by the dimension the reports use most.
export async function firstLook(
	sourceKey: string,
	field: string,
): Promise<Record<string, unknown> | null> {
	const source = getSource(sourceKey);
	if (!source) return null;
	const reports = await reportsOn(sourceKey);
	const isDimension = source.dimensions.some((item) => item.name === field);
	try {
		if (isDimension) {
			const measure = mainMeasure(source, reports);
			const rows = await readAsApp(source, {
				dimensions: [field],
				measures: measure ? [measure] : [],
				sort: measure ? [{ field: measure, direction: "desc" }] : [],
				limit: 26,
			});
			return {
				field,
				kind: "dimension",
				againstMeasure: measure,
				distinctValues: rows.length > 25 ? "more than 25" : rows.length,
				largest: rows.slice(0, 25),
			};
		}
		const split = mainDimension(source, reports);
		const total = await readAsApp(source, {
			dimensions: [],
			measures: [field],
			limit: 1,
		});
		const bySplit = split
			? await readAsApp(source, {
					dimensions: [split],
					measures: [field],
					sort: [{ field, direction: "desc" }],
					limit: 12,
				})
			: [];
		return {
			field,
			kind: "measure",
			total: total[0] ?? null,
			splitBy: split,
			bySplit,
		};
	} catch (error) {
		// A look that fails leaves the decision to the definitions alone.
		return {
			field,
			unreadable:
				error instanceof Error ? error.message : "could not be read",
		};
	}
}
