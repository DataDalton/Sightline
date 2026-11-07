// Turning a picture of an old dashboard into visuals on real fields. The model suggests and
// this keeps only what is real, so a field it made up never reaches a report.
//
// Pure, so what is kept can be tested without a model.

export interface RebuildSource {
	dimensions: string[];
	measures: string[];
}

export interface RebuiltVisual {
	visualType: string;
	title: string;
	dimensions: string[];
	measures: string[];
	layout: { x: number; y: number; w: number; h: number };
}

const allowedTypes = new Set([
	"kpiRow",
	"barChart",
	"horizontalBarChart",
	"lineChart",
	"areaChart",
	"pieChart",
	"donutChart",
	"stackedBarChart",
	"table",
]);

// The whole width of the page, which the model has no way of knowing.
const pageColumns = 12;

export function rebuildPrompt(source: RebuildSource): string {
	return [
		"This picture shows a dashboard or spreadsheet someone wants rebuilt. Work out each chart, table and headline number in it, in reading order.",
		`The only fields that exist are these. Dimensions: ${JSON.stringify(source.dimensions)}. Measures: ${JSON.stringify(source.measures)}.`,
		"Pick the closest real field for what each one shows, and leave out anything with no close match. Never invent a field.",
		`Allowed visual types: ${[...allowedTypes].join(", ")}.`,
		'Answer with only a JSON array, each item {"visualType","title","dimensions":[...],"measures":[...]}. Do not copy any numbers from the picture.',
	].join(" ");
}

// Stacked in the order given, two to a row where they fit, and full width for tiles and tables.
export function parseRebuild(
	answer: string,
	source: RebuildSource,
): { visuals: RebuiltVisual[]; dropped: number } {
	const start = answer.indexOf("[");
	const end = answer.lastIndexOf("]");
	if (start < 0 || end <= start) return { visuals: [], dropped: 0 };
	let parsed: unknown;
	try {
		parsed = JSON.parse(answer.slice(start, end + 1));
	} catch {
		return { visuals: [], dropped: 0 };
	}
	if (!Array.isArray(parsed)) return { visuals: [], dropped: 0 };

	const realDimensions = new Set(source.dimensions);
	const realMeasures = new Set(source.measures);
	const kept: Omit<RebuiltVisual, "layout">[] = [];
	let dropped = 0;
	for (const item of parsed) {
		const held = (item ?? {}) as Record<string, unknown>;
		const visualType = String(held.visualType ?? "");
		const dimensions = (
			Array.isArray(held.dimensions) ? held.dimensions : []
		)
			.map(String)
			.filter((name) => realDimensions.has(name));
		const measures = (Array.isArray(held.measures) ? held.measures : [])
			.map(String)
			.filter((name) => realMeasures.has(name));
		const usable =
			allowedTypes.has(visualType) &&
			(measures.length > 0 ||
				(visualType === "table" && dimensions.length > 0));
		if (!usable) {
			dropped += 1;
			continue;
		}
		kept.push({
			visualType,
			title:
				String(held.title ?? "").slice(0, 200) ||
				measures[0] ||
				"Table",
			dimensions: visualType === "kpiRow" ? [] : dimensions,
			measures,
		});
	}

	const visuals: RebuiltVisual[] = [];
	let x = 0;
	let y = 0;
	let rowHeight = 0;
	for (const visual of kept) {
		const wide =
			visual.visualType === "kpiRow" || visual.visualType === "table";
		const w = wide ? pageColumns : pageColumns / 2;
		const h = visual.visualType === "kpiRow" ? 2 : 6;
		if (x + w > pageColumns) {
			x = 0;
			y += rowHeight;
			rowHeight = 0;
		}
		visuals.push({ ...visual, layout: { x, y, w, h } });
		x += w;
		rowHeight = Math.max(rowHeight, h);
	}
	return { visuals, dropped };
}
