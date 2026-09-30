import { visualCatalog } from "../visuals/catalog";

// Which fields a stored configuration names, and the same configuration with
// one name swapped for another.
//
// Everything that reads a dataset stores its fields by name inside JSON, so
// nothing in the schema records that a report, an alert or a sheet depends on
// a measure. Renaming one broke items that could not be enumerated first, and
// the only way to find them was to open each one.
//
// Each kind of item names fields in its own places and they are not the same
// shape. A visual has dimensions and measures as name lists, filters and sort
// as objects with the name under a key, and settings such as the measure a top
// ten is ranked by. A walk that reads only the first two misses every field a
// page filters by, which is the reference most easily forgotten and the one
// most likely to break quietly. A chart missing a filtered field does not
// fail, it silently widens.
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

// Visual settings whose value is one field name, read from the catalogue so a
// setting added there is covered here without a second list to keep in step.
const fieldOptionKeys = new Set(
	visualCatalog.flatMap((definition) =>
		(definition.options ?? [])
			.filter((option) => option.kind === "field")
			.map((option) => option.key),
	),
);

// Visual settings whose value is a list of field names.
const fieldListOptionKeys = new Set(["drillFields"]);

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

function unique(values: string[]): string[] {
	return [...new Set(values)];
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
// it at all.
export function roleOf(config: unknown, field: string): FieldRole | null {
	const refs = referencedFields(config);
	for (const role of roleOrder) {
		if (refs[role].includes(field)) return role;
	}
	return null;
}

// Every distinct field a visual's configuration names. Also the reading for a
// saved view and a saved exploration, which store the same shape.
export function allReferenced(config: unknown): string[] {
	const refs = referencedFields(config);
	return unique(roleOrder.flatMap((role) => refs[role]));
}

// --- Other items -----------------------------------------------------------

// Lists a saved view's overlay keeps beside the visual shape. See
// lib/platform/overlay.
const overlayListKeys = [
	"hiddenDimensions",
	"hiddenMeasures",
	"addedDimensions",
	"addedMeasures",
	"dimensionOrder",
	"measureOrder",
];

// Every field a saved view names, whether it stores the visual shape or the
// overlay of differences against the page.
export function savedViewFields(config: unknown): string[] {
	const held = asObject(config);
	return unique([
		...allReferenced(config),
		...overlayListKeys.flatMap((key) => names(held[key])),
	]);
}

// The field a page's data-through stamp reads.
export function pageFields(config: unknown): string[] {
	const field = asObject(asObject(config).freshness).field;
	return typeof field === "string" && field ? [field] : [];
}

// Columns and conditions of an Explore question, as a saved Explore view
// stores it.
export function exploreFields(state: unknown): string[] {
	const held = asObject(state);
	return unique([...names(held.columns), ...fieldProps(held.conditions)]);
}

// The measure an alert watches, what it splits by, what narrows it and the
// date its history is read across. A page alert stores the same definition.
export function alertFields(definition: unknown): string[] {
	const held = asObject(definition);
	const found: string[] = [];
	if (typeof held.measure === "string" && held.measure) {
		found.push(held.measure);
	}
	if (typeof held.groupBy === "string" && held.groupBy) {
		found.push(held.groupBy);
	}
	found.push(...fieldProps(held.conditions));
	const timeField = asObject(held.anomaly).timeField;
	if (typeof timeField === "string" && timeField) found.push(timeField);
	return unique(found);
}

const fieldKeyPrefix = "field:";

// Every column a sheet formula reads by name, skipping text inside quotes so a
// literal "[Region]" is not taken for a reference.
export function formulaReferences(formula: string): string[] {
	const found: string[] = [];
	scanFormula(formula, (name) => {
		found.push(name);
		return null;
	});
	return unique(found);
}

// Walks a formula's references in order. The callback may return a new name
// for a reference, and the formula is returned rebuilt with it.
function scanFormula(
	formula: string,
	visit: (name: string) => string | null,
): string {
	let out = "";
	let i = 0;
	while (i < formula.length) {
		const c = formula[i];
		if (c === '"') {
			// Two quotes in a row are one quote inside the text.
			let j = i + 1;
			while (j < formula.length) {
				if (formula[j] === '"') {
					if (formula[j + 1] === '"') {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			out += formula.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (c === "[") {
			const close = formula.indexOf("]", i + 1);
			if (close < 0) {
				out += formula.slice(i);
				break;
			}
			const inner = formula.slice(i + 1, close);
			const replaced = visit(inner.trim());
			out +=
				replaced === null
					? formula.slice(i, close + 1)
					: `[${replaced}]`;
			i = close + 1;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

// Every field a sheet names: its columns, its conditions, its pivot, the keys
// its layout is stored under, its sort and what its formulas read.
export function sheetFields(definition: unknown): string[] {
	const held = asObject(definition);
	const pivot = asObject(held.pivot);
	const found: string[] = [
		...names(held.columns),
		...fieldProps(held.conditions),
		...names(pivot.rows),
		...names(pivot.values),
	];
	if (typeof pivot.columns === "string" && pivot.columns) {
		found.push(pivot.columns);
	}
	for (const key of [
		...names(held.order),
		...Object.keys(asObject(held.settings)),
	]) {
		if (key.startsWith(fieldKeyPrefix)) {
			found.push(key.slice(fieldKeyPrefix.length));
		}
	}
	const sort = asObject(held.sort);
	if (typeof sort.column === "string" && sort.column) found.push(sort.column);
	for (const formula of Array.isArray(held.formulas) ? held.formulas : []) {
		const text = asObject(formula).formula;
		if (typeof text === "string") found.push(...formulaReferences(text));
	}
	return unique(found);
}

// --- Renaming --------------------------------------------------------------

export interface Renamed<T> {
	value: T;
	changed: boolean;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value ?? null)) as T;
}

// A name list with one name swapped. A list that already held the new name
// keeps it once, in its first place.
function renameList(value: unknown, from: string, to: string): unknown {
	if (!Array.isArray(value)) return value;
	const out: unknown[] = [];
	for (const item of value) {
		const next = item === from ? to : item;
		if (typeof next === "string" && out.includes(next)) continue;
		out.push(next);
	}
	return out;
}

function renameFieldProps(value: unknown, from: string, to: string): void {
	if (Array.isArray(value)) {
		value.forEach((item) => renameFieldProps(item, from, to));
		return;
	}
	if (!value || typeof value !== "object") return;
	const held = value as Json;
	if (held.field === from) held.field = to;
	for (const [key, inner] of Object.entries(held)) {
		if (key !== "field" && inner && typeof inner === "object") {
			renameFieldProps(inner, from, to);
		}
	}
}

// A plain list of field names with one renamed, such as the fields an access
// recording or a source's access mapping holds.
export function renameInNames(
	value: string[],
	from: string,
	to: string,
): Renamed<string[]> {
	const next = renameList(value, from, to) as string[];
	return result(value, next);
}

function result<T>(before: unknown, after: T): Renamed<T> {
	return {
		value: after,
		changed: JSON.stringify(before) !== JSON.stringify(after),
	};
}

// A visual, a saved view or a saved exploration with one field renamed.
export function renameInVisual<T>(
	config: T,
	from: string,
	to: string,
): Renamed<T> {
	const next = clone(config);
	if (!next || typeof next !== "object" || Array.isArray(next)) {
		return { value: config, changed: false };
	}
	const held = next as Json;
	// A saved view's overlay names fields in its own lists as well.
	for (const key of ["dimensions", "measures", ...overlayListKeys]) {
		if (key in held) held[key] = renameList(held[key], from, to);
	}
	renameFieldProps(held.filters, from, to);
	renameFieldProps(held.sort, from, to);
	const options = held.options;
	if (options && typeof options === "object" && !Array.isArray(options)) {
		const settings = options as Json;
		for (const [key, setting] of Object.entries(settings)) {
			if (fieldOptionKeys.has(key) && setting === from)
				settings[key] = to;
			else if (fieldListOptionKeys.has(key)) {
				settings[key] = renameList(setting, from, to);
			}
		}
	}
	return result(config, next as T);
}

export function renameInPage<T>(
	config: T,
	from: string,
	to: string,
): Renamed<T> {
	const next = clone(config);
	const freshness = asObject(asObject(next).freshness);
	if (freshness.field === from) freshness.field = to;
	return result(config, next as T);
}

export function renameInExplore<T>(
	state: T,
	from: string,
	to: string,
): Renamed<T> {
	const next = clone(state);
	if (!next || typeof next !== "object" || Array.isArray(next)) {
		return { value: state, changed: false };
	}
	const held = next as Json;
	held.columns = renameList(held.columns, from, to);
	renameFieldProps(held.conditions, from, to);
	return result(state, next as T);
}

export function renameInAlert<T>(
	definition: T,
	from: string,
	to: string,
): Renamed<T> {
	const next = clone(definition);
	if (!next || typeof next !== "object" || Array.isArray(next)) {
		return { value: definition, changed: false };
	}
	const held = next as Json;
	if (held.measure === from) held.measure = to;
	if (held.groupBy === from) held.groupBy = to;
	renameFieldProps(held.conditions, from, to);
	const anomaly = asObject(held.anomaly);
	if (anomaly.timeField === from) anomaly.timeField = to;
	return result(definition, next as T);
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
	const next = clone(definition);
	if (!next || typeof next !== "object" || Array.isArray(next)) {
		return { value: definition, changed: false };
	}
	const held = next as Json;
	held.columns = renameList(held.columns, from, to);
	renameFieldProps(held.conditions, from, to);

	const pivot = held.pivot;
	if (pivot && typeof pivot === "object" && !Array.isArray(pivot)) {
		const layout = pivot as Json;
		layout.rows = renameList(layout.rows, from, to);
		layout.values = renameList(layout.values, from, to);
		if (layout.columns === from) layout.columns = to;
	}

	const oldKey = fieldKeyPrefix + from;
	const newKey = fieldKeyPrefix + to;
	held.order = renameList(held.order, oldKey, newKey);
	const settings = held.settings;
	if (settings && typeof settings === "object" && !Array.isArray(settings)) {
		const byKey = settings as Json;
		if (oldKey in byKey) {
			if (!(newKey in byKey)) byKey[newKey] = byKey[oldKey];
			delete byKey[oldKey];
		}
	}

	const sort = held.sort;
	if (sort && typeof sort === "object" && !Array.isArray(sort)) {
		const order = sort as Json;
		if (order.column === from) order.column = to;
	}

	if (Array.isArray(held.formulas)) {
		for (const formula of held.formulas) {
			const item = asObject(formula);
			if (typeof item.formula === "string") {
				item.formula = renameInFormula(item.formula, from, to);
			}
		}
	}
	return result(definition, next as T);
}
