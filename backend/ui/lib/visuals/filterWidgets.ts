import { isFilterVisual } from "./catalog";

// Which field each filter control on a page writes against.
//
// The address bar names a parameter after a field, so putting a link back
// together means knowing which control owns which field. That mapping already
// exists, spread across the renderer's switch: most controls take the first
// dimension, a threshold and a numeric range prefer a measure, and a filter
// group is not one control at all but one per field, each writing under its own
// id.
//
// Written down once here rather than read back out of the renderer, because the
// two drifting apart would put a link's filter on the wrong control, and a
// filter on the wrong control is a wrong number presented as a right one.

export interface FilterWidget {
	visualId: string;
	field: string;
}

interface PlacedVisual {
	visualId: string;
	visualType: string;
	config?: {
		dimensions?: unknown;
		measures?: unknown;
	};
}

function names(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];
}

// Controls that read a measure before a dimension, because what they filter is
// a quantity: a threshold cuts on a figure, and a numeric range bounds one.
const measureFirst = new Set(["thresholdControl", "numericRangeFilter"]);

export function filterWidgetsOf(visuals: PlacedVisual[]): FilterWidget[] {
	const out: FilterWidget[] = [];

	for (const visual of visuals) {
		if (!isFilterVisual(visual.visualType)) continue;

		const dimensions = names(visual.config?.dimensions);
		const measures = names(visual.config?.measures);

		// A filter group renders one dropdown per field, each its own control
		// with its own id. Without this the group would look like one control
		// filtering one field, and every field after the first would be lost
		// from a link.
		if (visual.visualType === "filterBar") {
			for (const field of dimensions) {
				out.push({ visualId: `${visual.visualId}:${field}`, field });
			}
			continue;
		}

		const field = measureFirst.has(visual.visualType)
			? (measures[0] ?? dimensions[0] ?? measures[0])
			: (dimensions[0] ?? measures[0]);

		// A control with nothing encoded filters nothing, so there is no
		// parameter for it to own.
		if (field) out.push({ visualId: visual.visualId, field });
	}

	return out;
}
