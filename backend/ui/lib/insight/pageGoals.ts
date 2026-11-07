import { isPageControl } from "../visuals/catalog";

// Which measures a page shows, since a goal appears on the pages showing its measure.

export interface MeasureOnPage {
	sourceKey: string;
	measure: string;
}

function measureName(entry: unknown): string | null {
	if (typeof entry === "string") return entry;
	const name = (entry as { name?: unknown } | null)?.name;
	return typeof name === "string" ? name : null;
}

// Each source and measure on a page once. A visual with no source reads the page's.
export function measuresOnPage(
	visuals: {
		visualType: string;
		sourceKey: string | null;
		config: { measures?: unknown };
	}[],
	pageSourceKey: string | null,
): MeasureOnPage[] {
	const found = new Map<string, MeasureOnPage>();
	for (const visual of visuals) {
		if (isPageControl(visual.visualType)) continue;
		const sourceKey = visual.sourceKey ?? pageSourceKey;
		if (!sourceKey || !Array.isArray(visual.config.measures)) continue;
		for (const entry of visual.config.measures) {
			const measure = measureName(entry);
			if (measure) {
				found.set(`${sourceKey}|${measure}`, { sourceKey, measure });
			}
		}
	}
	return [...found.values()];
}

export function goalBelongsOnPage(
	goal: { source_key: string; measure: string },
	measures: MeasureOnPage[],
): boolean {
	return measures.some(
		(held) =>
			held.sourceKey === goal.source_key &&
			held.measure === goal.measure,
	);
}
