// Field metadata the report endpoint sends alongside a report, so a visual can
// label and format a column without another round trip.

export interface FieldMeta {
	name: string;
	// Shown instead of the key where the key is a raw column name.
	displayName?: string | null;
	dataType: string | null;
	formatHint: string | null;
	// Description and tags come from Unity Catalog, refreshed from
	// information_schema, so a tooltip shows the definition maintained next to
	// the data rather than a copy that drifts.
	description: string | null;
	tags?: Record<string, string>;
}

// Whether a field holds a date.
//
// Read from the type the catalogue reports rather than from the name, because a
// column called "Fiscal Period" is a date and one called "Update Date Flag" is
// not. The source's own default time field always counts: somebody has said so
// explicitly, and that beats any inference from a type string.
export function isTemporalField(
	source: SourceMeta | undefined,
	name: string,
): boolean {
	if (!source) return false;
	if (source.defaultTimeField === name) return true;

	const field = source.dimensions.find((f) => f.name === name);
	if (!field) return false;
	if (field.dataType && /date|timestamp/i.test(field.dataType)) return true;

	// Metric views report no type for several of their dimensions, so a name
	// that reads as a date is the only signal left. Narrow on purpose: a false
	// positive here puts a field in a list where it does not belong, and the
	// author simply does not pick it.
	return /(date|month|quarter|year|week|day|period)/i.test(name);
}

// One tooltip string from everything known about a field.
export function fieldTooltip(
	field: FieldMeta | undefined,
	fallback: string,
): string {
	if (!field) return fallback;
	const parts = [
		field.description?.trim() || field.displayName || field.name,
	];
	const tags = Object.entries(field.tags ?? {});
	if (tags.length > 0) {
		parts.push(tags.map(([k, v]) => (v ? `${k}: ${v}` : k)).join(" · "));
	}
	if (field.dataType) parts.push(field.dataType);
	return parts.join(", ");
}

export interface SourceMeta {
	sourceKey: string;
	title: string;
	kind: "metric_view" | "table";
	defaultTimeField: string | null;
	dimensions: FieldMeta[];
	measures: FieldMeta[];
}

// Flattens a source's dimensions and measures into one lookup keyed by name.
export function fieldMap(
	source: SourceMeta | undefined,
): Map<string, FieldMeta> {
	const map = new Map<string, FieldMeta>();
	if (!source) return map;
	for (const f of source.dimensions) map.set(f.name, f);
	for (const f of source.measures) map.set(f.name, f);
	return map;
}
