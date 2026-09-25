// Which fields a visual's configuration names.
//
// A visual stores its fields in JSON, so nothing in the schema records that a
// report depends on a measure. Renaming one broke pages that could not be
// enumerated first, and the only way to find them was to open every report.
//
// Four places name a field and they are not the same shape. Dimensions and
// measures are arrays of names; filters and sort are arrays of objects with the
// name under a key. A walk that reads only the first two misses every field a
// page filters by, which is the reference most easily forgotten and the one
// most likely to break quietly: a chart missing a filtered field does not fail,
// it silently widens.

// Where in a configuration a field was named.
export type FieldRole = "dimension" | "measure" | "filter" | "sort";

// Checked in this order, so a field named in two places is reported as the one
// that decides the shape of the query rather than the one that narrows it.
const roleOrder: FieldRole[] = ["dimension", "measure", "filter", "sort"];

function names(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

// Objects carrying the name under "field", which is how both filters and sort
// entries are written.
function fieldProps(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const found: string[] = [];
	for (const item of value) {
		if (item && typeof item === "object" && !Array.isArray(item)) {
			const name = (item as { field?: unknown }).field;
			if (typeof name === "string") found.push(name);
		}
	}
	return found;
}

export function referencedFields(config: unknown): Record<FieldRole, string[]> {
	const held =
		config && typeof config === "object" && !Array.isArray(config)
			? (config as Record<string, unknown>)
			: {};

	return {
		dimension: names(held.dimensions),
		measure: names(held.measures),
		filter: fieldProps(held.filters),
		sort: fieldProps(held.sort),
	};
}

// The role a given field plays, or null where the configuration does not name
// it at all.
export function roleOf(config: unknown, field: string): FieldRole | null {
	const refs = referencedFields(config);
	for (const role of roleOrder) {
		if (refs[role].includes(field)) return role;
	}
	return null;
}

// Every distinct field a configuration names, in any of the four places.
export function allReferenced(config: unknown): string[] {
	const refs = referencedFields(config);
	return [...new Set(roleOrder.flatMap((role) => refs[role]))];
}
