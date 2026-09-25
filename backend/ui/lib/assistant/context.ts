import type { SemanticSource } from "../semantic/types";
import { visualCatalog } from "../visuals/catalog";

// What the model is told.
//
// Field names and the definitions written on the view itself, which is the
// context that decides whether the answer names the right measure. It is also
// the whole of what leaves: no rows, no totals, nothing computed. A field name
// and its comment are metadata that already travel to every reader's browser.
//
// The definitions are the point. Several measures on one source sum to
// plausible-looking numbers and only one of them is additive across the grain
// being asked about, and the comment on the view is where that is written down.

// Charts the assistant is allowed to choose from.
//
// A subset on purpose: filters, headers and text panels are page furniture
// rather than answers, and offering them means a question sometimes returns a
// dropdown.
const answerable = new Set([
	"table",
	"kpiRow",
	"barChart",
	"horizontalBarChart",
	"lineChart",
	"areaChart",
	"pieChart",
	"donutChart",
	"scatterChart",
	"stackedBarChart",
	"treemapChart",
	"heatmapChart",
	"comboChart",
]);

function describeField(field: {
	name: string;
	dataType: string | null;
	description: string | null;
}): string {
	const type = field.dataType ? ` [${field.dataType}]` : "";
	const meaning = field.description ? ` — ${field.description}` : "";
	return `  ${field.name}${type}${meaning}`;
}

// One source, as much of it as matters. Sent whole rather than sampled: a
// hundred field names with their definitions is a page of text, and leaving
// some out is how the model ends up choosing from the ones that were cheap to
// include rather than the ones that fit.
export function sourceContext(source: SemanticSource): string {
	const lines = [`Source: ${source.sourceKey}`, `Title: ${source.title}`];
	if (source.description) lines.push(`About: ${source.description}`);
	if (source.defaultTimeField) {
		lines.push(`Default time field: ${source.defaultTimeField}`);
	}

	lines.push("", "DIMENSIONS (group by these):");
	for (const field of source.dimensions) lines.push(describeField(field));

	lines.push("", "MEASURES (aggregate these):");
	for (const field of source.measures) lines.push(describeField(field));

	return lines.join("\n");
}

// Choosing between sources, before any field list is sent. Titles and
// descriptions only, because the question at this point is which dataset the
// question is about and a field list per source would be most of a book.
export function sourceMenu(sources: SemanticSource[]): string {
	return sources
		.map(
			(s) =>
				`  ${s.sourceKey}: ${s.title}${s.description ? ` — ${s.description}` : ""}`,
		)
		.join("\n");
}

export function visualMenu(): string {
	return visualCatalog
		.filter((v) => answerable.has(v.type))
		.map(
			(v) =>
				`  ${v.type}: ${v.label}. ${v.guidance} Takes ${v.encoding.dimensions.min}-${v.encoding.dimensions.max} dimensions and ${v.encoding.measures.min}-${v.encoding.measures.max} measures.`,
		)
		.join("\n");
}

export function chooseSourcePrompt(sources: SemanticSource[]): string {
	return [
		"You choose which dataset a question is about. Answer with the source key alone and nothing else.",
		"",
		"Datasets:",
		sourceMenu(sources),
		"",
		"If none of them can answer the question, reply with the single word NONE.",
	].join("\n");
}

export function composePrompt(source: SemanticSource): string {
	return [
		"You compose queries against one dataset. You never see the results and you never write SQL.",
		"",
		"Reply with one JSON object and nothing else:",
		"{",
		'  "dimensions": [],   // field names to group by, exactly as listed below',
		'  "measures": [],     // field names to aggregate, exactly as listed below',
		'  "filters": [],      // { "field": "...", "op": "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains", "value": "..." }',
		'                      // or { "field": "...", "op": "eq", "values": ["...", "..."] } for a set',
		'  "sort": [],         // { "field": "...", "direction": "asc"|"desc" }',
		'  "limit": 200,',
		'  "visualType": "barChart",',
		'  "note": "one line saying what this shows"',
		"}",
		"",
		"Rules:",
		"- Use only the field names listed below, spelled exactly as they appear.",
		"- A dimension can only go in dimensions, a measure only in measures.",
		"- Read the definitions. Where several measures look similar, the definition says which one answers the question and which one does not add up across the grain being asked about.",
		"- Keep the visual within the dimension and measure counts it declares.",
		"- Sort by a measure when the question asks for most, least, best, worst, top or bottom.",
		"- The note describes what you built. You have not seen any numbers, so do not describe results.",
		"",
		"Visuals:",
		visualMenu(),
		"",
		sourceContext(source),
	].join("\n");
}
