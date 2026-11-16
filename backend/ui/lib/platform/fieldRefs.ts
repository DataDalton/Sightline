import {
	fieldListOptionKeys,
	fieldOptionKeys,
	namesIn,
	overlayListKeys,
	renaming,
	scanFormula,
	walkAlert,
	walkExplore,
	walkList,
	walkPage,
	walkSavedView,
	walkSheet,
	walkVisual,
	type Walked,
} from "./fieldWalk";

// Which fields a stored configuration names, and the same configuration with
// one name swapped for another.
//
// Everything that reads a dataset stores its fields by name inside JSON, so
// nothing in the schema records that a report, an alert or a sheet depends on
// a measure. Renaming one broke items that could not be enumerated first, and
// the only way to find them was to open each one.
//
// Every reading and renaming here goes through the walks in fieldWalk, which
// know each place an item can name a field. The roles below are a summary for
// display, kept to the places that decide what a query asks.
//
// Kept free of database and network imports so it can be tested on its own.

// Where in a visual's configuration a field was named.
export type FieldRole = "dimension" | "measure" | "filter" | "sort" | "option";

// Checked in this order, so a field named in two places is reported as the one
// that decides the shape of the query rather than the one that narrows it.
const roleOrder: FieldRole[] = [
	"dimension",
	"measure",
	"filter",
	"sort",
	"option",
];

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: {};
}

function names(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

// Every "field" property inside a filter or sort list, at any depth, because
// a filter can hold a group of further conditions.
function fieldProps(value: unknown): string[] {
	const found: string[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		if (!node || typeof node !== "object") return;
		const held = node as Json;
		if (typeof held.field === "string") found.push(held.field);
		for (const [key, inner] of Object.entries(held)) {
			if (key !== "field" && inner && typeof inner === "object") {
				walk(inner);
			}
		}
	};
	if (Array.isArray(value)) walk(value);
	return found;
}

function optionFields(value: unknown): string[] {
	const options = asObject(value);
	const found: string[] = [];
	for (const [key, setting] of Object.entries(options)) {
		if (fieldOptionKeys.has(key) && typeof setting === "string") {
			// "none" is how a field option says nothing is chosen.
			if (setting && setting !== "none") found.push(setting);
		} else if (fieldListOptionKeys.has(key)) {
			found.push(...names(setting));
		}
	}
	return found;
}

// --- Visuals ---------------------------------------------------------------

export function referencedFields(config: unknown): Record<FieldRole, string[]> {
	const held = asObject(config);
	return {
		dimension: names(held.dimensions),
		measure: names(held.measures),
		filter: fieldProps(held.filters),
		sort: fieldProps(held.sort),
		option: optionFields(held.options),
	};
}

// The role a given field plays, or null where the configuration does not name
// it at all. A field named only by styling, a transform or a target counts as
// a setting.
export function roleOf(config: unknown, field: string): FieldRole | null {
	const refs = referencedFields(config);
	for (const role of roleOrder) {
		if (refs[role].includes(field)) return role;
	}
	return allReferenced(config).includes(field) ? "option" : null;
}

// Every distinct field a visual's configuration names. Also the reading for a
// saved exploration, which stores the same shape.
export function allReferenced(config: unknown): string[] {
	return namesIn((visit) => walkVisual(config, visit));
}

// --- Other items -----------------------------------------------------------

// Every field a saved view names, whether it stores the visual shape or the
// overlay of differences against the page, with the state it keeps per visual.
export function savedViewFields(config: unknown): string[] {
	return namesIn((visit) => walkSavedView(config, visit));
}

// The fields a page's settings name: its data-through stamp and the filters
// every visual on it waits for.
export function pageFields(config: unknown): string[] {
	return namesIn((visit) => walkPage(config, visit));
}

// Columns and conditions of an Explore question, as a saved Explore view
// stores it.
export function exploreFields(state: unknown): string[] {
	return namesIn((visit) => walkExplore(state, visit));
}

// The measure an alert watches, what it splits by, what narrows it and the
// date its history is read across. A page alert stores the same definition.
export function alertFields(definition: unknown): string[] {
	return namesIn((visit) => walkAlert(definition, visit));
}

// Every column a sheet formula reads by name, skipping text inside quotes so a
// literal "[Region]" is not taken for a reference.
export function formulaReferences(formula: string): string[] {
	const found = new Set<string>();
	scanFormula(formula, (name) => {
		found.add(name);
		return null;
	});
	return [...found];
}

// Every field a sheet names: its columns, its conditions, its pivot, the keys
// its layout is stored under, its sort and what its formulas read.
export function sheetFields(definition: unknown): string[] {
	return namesIn((visit) => walkSheet(definition, visit));
}

// --- Renaming --------------------------------------------------------------

export type Renamed<T> = Walked<T>;

// A plain list of field names with one renamed, such as the fields an access
// recording or a source's access mapping holds. A list that already held the
// new name keeps it once, in its first place.
export function renameInNames(
	value: string[],
	from: string,
	to: string,
): Renamed<string[]> {
	const next = walkList(value, renaming(from, to)) as string[];
	return {
		value: next,
		changed: JSON.stringify(value) !== JSON.stringify(next),
	};
}

// A visual, a saved view or a saved exploration with one field renamed. A saved
// view's per-visual state is renamed too.
export function renameInVisual<T>(
	config: T,
	from: string,
	to: string,
): Renamed<T> {
	const held = asObject(config);
	const isSavedView =
		overlayListKeys.some((key) => key in held) ||
		[
			"columnOrder",
			"pinnedColumns",
			"columnWidths",
			"pageFilters",
			"gridStates",
			"dimension",
		].some((key) => key in held);
	return isSavedView
		? walkSavedView(config, renaming(from, to))
		: walkVisual(config, renaming(from, to));
}

export function renameInPage<T>(
	config: T,
	from: string,
	to: string,
): Renamed<T> {
	return walkPage(config, renaming(from, to));
}

export function renameInExplore<T>(
	state: T,
	from: string,
	to: string,
): Renamed<T> {
	return walkExplore(state, renaming(from, to));
}

export function renameInAlert<T>(
	definition: T,
	from: string,
	to: string,
): Renamed<T> {
	const { value, changed } = walkAlert(definition, renaming(from, to));
	return { value, changed };
}

// A formula with every reference to one column renamed, and nothing inside
// quoted text touched.
export function renameInFormula(
	formula: string,
	from: string,
	to: string,
): string {
	return scanFormula(formula, (name) => (name === from ? to : null));
}

export function renameInSheet<T>(
	definition: T,
	from: string,
	to: string,
): Renamed<T> {
	return walkSheet(definition, renaming(from, to));
}
