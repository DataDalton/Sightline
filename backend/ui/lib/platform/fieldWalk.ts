import { visualCatalog } from "../visuals/catalog";

// One walk over every place a stored item names a field, used three ways: to
// list the names, to rename one, and to remove one.
//
// Finding, renaming and removing were separate code that each had to know every
// place a field can be named. A place added to one and forgotten in another is a
// reference that is found but left broken, or rewritten on rename and left
// dangling on removal. Here each kind of item is walked once, and the visit
// decides what happens to each name it meets.
//
// A visit returns null to keep a name, a string to rename it, or dropField to
// remove whatever names it. Removing takes out the smallest thing that cannot
// stand without the field: the name from a list, a filter clause, a sort entry,
// a style rule, a target, a transform, and anything that read that transform's
// result.
//
// Kept free of database and network imports so it can be tested on its own.

export const dropField: unique symbol = Symbol("dropField");

export type FieldVisit = (name: string) => string | typeof dropField | null;

export interface Walked<T> {
	value: T;
	changed: boolean;
}

type Json = Record<string, unknown>;

// Visual settings whose value is one field name, read from the catalogue so a
// setting added there is covered here without a second list to keep in step.
export const fieldOptionKeys = new Set(
	visualCatalog.flatMap((definition) =>
		(definition.options ?? [])
			.filter((option) => option.kind === "field")
			.map((option) => option.key),
	),
);

// Visual settings whose value is a list of field names.
export const fieldListOptionKeys = new Set(["drillFields", "requireFilter"]);

// Visual settings keyed by measure name.
const measureKeyedOptionKeys = new Set(["targets", "tooltips"]);

// Lists a saved view's overlay keeps beside the visual shape. See
// lib/platform/overlay.
export const overlayListKeys = [
	"hiddenDimensions",
	"hiddenMeasures",
	"addedDimensions",
	"addedMeasures",
	"dimensionOrder",
	"measureOrder",
];

// Placeholders a visual config holds where a field name would be, which are not
// fields. See lib/visuals/validate.
const placeholders = new Set(["<selected>", "<grain>"]);

function isObject(value: unknown): value is Json {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function done<T>(before: unknown, after: T): Walked<T> {
	return {
		value: after,
		changed: JSON.stringify(before) !== JSON.stringify(after),
	};
}

// Applies a visit to one name, leaving placeholders and empty names alone.
function visitName(
	name: unknown,
	visit: FieldVisit,
): string | typeof dropField | null {
	if (typeof name !== "string" || !name || placeholders.has(name)) {
		return null;
	}
	return visit(name);
}

// A list of names with each one visited. A rename that lands on a name the list
// already holds keeps it once, in its first place.
export function walkList(value: unknown, visit: FieldVisit): unknown {
	if (!Array.isArray(value)) return value;
	const out: unknown[] = [];
	for (const item of value) {
		const seen = visitName(item, visit);
		if (seen === dropField) continue;
		const next = seen === null ? item : seen;
		if (typeof next === "string" && out.includes(next)) continue;
		out.push(next);
	}
	return out;
}

// An object keyed by field name with each key visited. A rename onto a key that
// already exists keeps the existing entry.
function walkKeys(value: unknown, visit: FieldVisit): unknown {
	if (!isObject(value)) return value;
	const out: Json = {};
	for (const [key, inner] of Object.entries(value)) {
		const seen = visitName(key, visit);
		if (seen === dropField) continue;
		const next = seen === null ? key : seen;
		if (next in out) continue;
		out[next] = inner;
	}
	return out;
}

// A list of clauses, each naming a field under "field", where an item may be a
// group holding further clauses in a list of its own. A clause on a removed
// field goes, and a group left with nothing in it goes too.
export function walkClauses(value: unknown, visit: FieldVisit): unknown {
	if (!Array.isArray(value)) return value;
	const out: unknown[] = [];
	for (const item of value) {
		if (!isObject(item)) {
			out.push(item);
			continue;
		}
		const clause = { ...item };
		if (typeof clause.field === "string") {
			const seen = visitName(clause.field, visit);
			if (seen === dropField) continue;
			if (seen !== null) clause.field = seen;
		}
		let emptied = false;
		for (const [key, inner] of Object.entries(clause)) {
			if (key === "field" || !Array.isArray(inner)) continue;
			const walked = walkClauses(inner, visit) as unknown[];
			if (inner.length > 0 && walked.length === 0) emptied = true;
			clause[key] = walked;
		}
		if (emptied && typeof clause.field !== "string") continue;
		out.push(clause);
	}
	return out;
}

// Entries of a list that each name one field under a given key. An entry whose
// field is removed goes. With optional set, an entry without the key stays,
// since it applies to whatever the visual shows first.
function walkKeyedEntries(
	value: unknown,
	key: string,
	visit: FieldVisit,
): unknown {
	if (!Array.isArray(value)) return value;
	const out: unknown[] = [];
	for (const item of value) {
		if (!isObject(item) || typeof item[key] !== "string") {
			out.push(item);
			continue;
		}
		const seen = visitName(item[key], visit);
		if (seen === dropField) continue;
		out.push(seen === null ? item : { ...item, [key]: seen });
	}
	return out;
}

// --- Visuals ---------------------------------------------------------------

// Transforms read measures and write a derived column under "as". A transform
// on a removed measure goes, and the derived names it wrote are returned so
// whatever sorted or styled by them goes with it.
function walkTransforms(
	value: unknown,
	visit: FieldVisit,
): { transforms: unknown; lost: Set<string> } {
	const lost = new Set<string>();
	if (!Array.isArray(value)) return { transforms: value, lost };
	const out: unknown[] = [];
	for (const item of value) {
		if (!isObject(item)) {
			out.push(item);
			continue;
		}
		const next = { ...item };
		let removed = false;
		for (const key of ["measure", "denominator"]) {
			if (typeof next[key] !== "string") continue;
			const seen = visitName(next[key], visit);
			if (seen === dropField) removed = true;
			else if (seen !== null) next[key] = seen;
		}
		if (removed) {
			if (typeof next.as === "string") lost.add(next.as);
			continue;
		}
		out.push(next);
	}
	return { transforms: out, lost };
}

function walkOptions(value: unknown, visit: FieldVisit): unknown {
	if (!isObject(value)) return value;
	const options: Json = { ...value };
	for (const [key, setting] of Object.entries(options)) {
		if (fieldOptionKeys.has(key) && typeof setting === "string") {
			// "none" is how a field option says nothing is chosen.
			if (!setting || setting === "none") continue;
			const seen = visitName(setting, visit);
			if (seen === dropField) delete options[key];
			else if (seen !== null) options[key] = seen;
		} else if (fieldListOptionKeys.has(key)) {
			options[key] = walkList(setting, visit);
		} else if (measureKeyedOptionKeys.has(key)) {
			let keyed = walkKeys(setting, visit);
			// A target measured against another measure goes when that
			// measure does, and follows it when it is renamed.
			if (key === "targets" && isObject(keyed)) {
				const targets: Json = {};
				for (const [measure, target] of Object.entries(keyed)) {
					const basis = isObject(target) ? target.basis : null;
					if (
						isObject(basis) &&
						basis.kind === "measure" &&
						typeof basis.measure === "string"
					) {
						const seen = visitName(basis.measure, visit);
						if (seen === dropField) continue;
						if (seen !== null) {
							targets[measure] = {
								...(target as Json),
								basis: { ...basis, measure: seen },
							};
							continue;
						}
					}
					targets[measure] = target;
				}
				keyed = targets;
			}
			options[key] = keyed;
		}
	}
	return options;
}

function walkStyle(value: unknown, visit: FieldVisit): unknown {
	if (!isObject(value)) return value;
	const style: Json = { ...value };
	if ("series" in style) {
		style.series = walkKeyedEntries(style.series, "measure", visit);
	}
	if ("conditions" in style && Array.isArray(style.conditions)) {
		const rules: unknown[] = [];
		for (const rule of style.conditions) {
			if (!isObject(rule)) {
				rules.push(rule);
				continue;
			}
			const next = { ...rule };
			const tested = visitName(next.field, visit);
			if (tested === dropField) continue;
			if (tested !== null) next.field = tested;
			// A rule painting another column goes when that column does,
			// rather than falling back to painting the column it tests.
			if (typeof next.applyTo === "string" && next.applyTo !== "row") {
				const painted = visitName(next.applyTo, visit);
				if (painted === dropField) continue;
				if (painted !== null) next.applyTo = painted;
			}
			rules.push(next);
		}
		style.conditions = rules;
	}
	if ("colorScales" in style) {
		style.colorScales = walkKeyedEntries(style.colorScales, "field", visit);
	}
	if (isObject(style.tooltip) && "extraFields" in style.tooltip) {
		style.tooltip = {
			...style.tooltip,
			extraFields: walkList(style.tooltip.extraFields, visit),
		};
	}
	if ("referenceLines" in style) {
		style.referenceLines = walkKeyedEntries(
			style.referenceLines,
			"measure",
			visit,
		);
	}
	return style;
}

// A visual's configuration with every field it names visited. Also the shape a
// saved exploration, a board item, a block and an edit suggestion store.
export function walkVisual<T>(config: T, visit: FieldVisit): Walked<T> {
	if (!isObject(config)) return { value: config, changed: false };
	const next = clone(config) as Json;

	const { transforms, lost } = walkTransforms(next.transforms, visit);
	if ("transforms" in next) next.transforms = transforms;
	// Derived columns of a removed transform are removed wherever they are
	// named, and their names are never fields of the source.
	const reach: FieldVisit = (name) =>
		lost.has(name) ? dropField : visit(name);

	for (const key of ["dimensions", "measures", ...overlayListKeys]) {
		if (key in next) next[key] = walkList(next[key], reach);
	}
	if ("filters" in next) next.filters = walkClauses(next.filters, reach);
	if ("sort" in next) next.sort = walkClauses(next.sort, reach);
	if ("options" in next) next.options = walkOptions(next.options, reach);
	if ("style" in next) next.style = walkStyle(next.style, reach);
	return done(config, next as T);
}

// A page's settings: the field its data-through stamp reads and the fields
// every visual on it waits for.
export function walkPage<T>(config: T, visit: FieldVisit): Walked<T> {
	if (!isObject(config)) return { value: config, changed: false };
	const next = clone(config) as Json;
	if (isObject(next.freshness) && typeof next.freshness.field === "string") {
		const seen = visitName(next.freshness.field, visit);
		if (seen === dropField) {
			const { field: _field, ...rest } = next.freshness;
			next.freshness = rest;
		} else if (seen !== null) {
			next.freshness = { ...next.freshness, field: seen };
		}
	}
	if ("requireFilter" in next) {
		next.requireFilter = walkList(next.requireFilter, visit);
	}
	return done(config, next as T);
}

// A saved view of a page: the visual shape or overlay it stores, and the state
// it keeps per visual, its table columns, page filters, switcher choice and grid
// state.
export function walkSavedView<T>(config: T, visit: FieldVisit): Walked<T> {
	const base = walkVisual(config, visit);
	if (!isObject(base.value)) return base;
	const next = base.value as Json;
	if ("columnOrder" in next) {
		next.columnOrder = walkList(next.columnOrder, visit);
	}
	if ("pinnedColumns" in next) {
		next.pinnedColumns = walkList(next.pinnedColumns, visit);
	}
	if ("columnWidths" in next) {
		next.columnWidths = walkKeys(next.columnWidths, visit);
	}
	if (typeof next.dimension === "string") {
		const seen = visitName(next.dimension, visit);
		if (seen === dropField) delete next.dimension;
		else if (seen !== null) next.dimension = seen;
	}
	if (isObject(next.pageFilters)) {
		const filters: Json = {};
		for (const [key, clauses] of Object.entries(next.pageFilters)) {
			// A filter group stores one entry per field, keyed by the
			// visual's id and the field. See lib/visuals/filterWidgets.
			const split = key.indexOf(":");
			let entryKey = key;
			if (split > 0) {
				const seen = visitName(key.slice(split + 1), visit);
				if (seen === dropField) continue;
				if (seen !== null) entryKey = `${key.slice(0, split)}:${seen}`;
			}
			const walked = walkClauses(clauses, visit);
			if (
				Array.isArray(clauses) &&
				clauses.length > 0 &&
				Array.isArray(walked) &&
				walked.length === 0
			) {
				continue;
			}
			filters[entryKey] = walked;
		}
		next.pageFilters = filters;
	}
	if (isObject(next.gridStates)) {
		const grids: Json = {};
		for (const [visualId, state] of Object.entries(next.gridStates)) {
			if (!isObject(state)) {
				grids[visualId] = state;
				continue;
			}
			const grid: Json = { ...state };
			if (isObject(grid.sort) && typeof grid.sort.key === "string") {
				const seen = visitName(grid.sort.key, visit);
				if (seen === dropField) delete grid.sort;
				else if (seen !== null) grid.sort = { ...grid.sort, key: seen };
			}
			if ("filters" in grid) grid.filters = walkKeys(grid.filters, visit);
			grids[visualId] = grid;
		}
		next.gridStates = grids;
	}
	return done(config, next as T);
}

// An Explore question: its columns and its conditions.
export function walkExplore<T>(state: T, visit: FieldVisit): Walked<T> {
	if (!isObject(state)) return { value: state, changed: false };
	const next = clone(state) as Json;
	if ("columns" in next) next.columns = walkList(next.columns, visit);
	if ("conditions" in next) {
		next.conditions = walkClauses(next.conditions, visit);
	}
	return done(state, next as T);
}

// An alert's definition. Removing the measure it watches leaves nothing to
// watch, which is reported as orphaned so the caller turns the alert off.
export function walkAlert<T>(
	definition: T,
	visit: FieldVisit,
): Walked<T> & { orphaned: boolean } {
	if (!isObject(definition)) {
		return { value: definition, changed: false, orphaned: false };
	}
	const next = clone(definition) as Json;
	let orphaned = false;
	if (typeof next.measure === "string" && next.measure) {
		const seen = visitName(next.measure, visit);
		if (seen === dropField) orphaned = true;
		else if (seen !== null) next.measure = seen;
	}
	if (typeof next.groupBy === "string" && next.groupBy) {
		const seen = visitName(next.groupBy, visit);
		if (seen === dropField) delete next.groupBy;
		else if (seen !== null) next.groupBy = seen;
	}
	if ("conditions" in next) {
		next.conditions = walkClauses(next.conditions, visit);
	}
	if (isObject(next.anomaly) && typeof next.anomaly.timeField === "string") {
		const seen = visitName(next.anomaly.timeField, visit);
		// Anomaly checking reads history across the date, so it cannot go on
		// without one.
		if (seen === dropField) delete next.anomaly;
		else if (seen !== null) {
			next.anomaly = { ...next.anomaly, timeField: seen };
		}
	}
	return { ...done(definition, next as T), orphaned };
}

const fieldKeyPrefix = "field:";
const formulaKeyPrefix = "formula:";

// Walks a formula's references in order. The visit may rename a reference, and
// the formula is returned rebuilt with it. Text inside quotes is left alone so
// a literal "[Region]" is not taken for a reference.
export function scanFormula(
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

// A sheet's definition: columns, conditions, pivot, layout keys, sort and
// formulas. A formula reading a removed column goes, since it can no longer be
// worked out, along with anything keyed by that formula's own name.
export function walkSheet<T>(definition: T, visit: FieldVisit): Walked<T> {
	if (!isObject(definition)) return { value: definition, changed: false };
	const next = clone(definition) as Json;

	// Names of removed formula columns, which other formulas and the sort may
	// read, and their ids, which the layout is keyed by.
	const lost = new Set<string>();
	const lostIds = new Set<string>();
	const reach: FieldVisit = (name) =>
		lost.has(name) ? dropField : visit(name);
	if (Array.isArray(next.formulas)) {
		// Repeated until nothing more goes, since a formula reading a removed
		// formula's result cannot be worked out either.
		let formulas = next.formulas as unknown[];
		let removedAny = true;
		while (removedAny) {
			removedAny = false;
			const kept: unknown[] = [];
			for (const formula of formulas) {
				const item = isObject(formula) ? { ...formula } : formula;
				if (isObject(item) && typeof item.formula === "string") {
					let broken = false;
					const rewritten = scanFormula(item.formula, (name) => {
						const seen = visitName(name, reach);
						if (seen === dropField) {
							broken = true;
							return null;
						}
						return seen;
					});
					if (broken) {
						if (typeof item.name === "string") lost.add(item.name);
						if (typeof item.id === "string") lostIds.add(item.id);
						removedAny = true;
						continue;
					}
					item.formula = rewritten;
				}
				kept.push(item);
			}
			formulas = kept;
		}
		next.formulas = formulas;
	}

	if ("columns" in next) next.columns = walkList(next.columns, reach);
	if ("conditions" in next) {
		next.conditions = walkClauses(next.conditions, reach);
	}
	if (isObject(next.pivot)) {
		const pivot: Json = { ...next.pivot };
		if ("rows" in pivot) pivot.rows = walkList(pivot.rows, reach);
		if ("values" in pivot) pivot.values = walkList(pivot.values, reach);
		if (typeof pivot.columns === "string" && pivot.columns) {
			const seen = visitName(pivot.columns, reach);
			if (seen === dropField) delete pivot.columns;
			else if (seen !== null) pivot.columns = seen;
		}
		next.pivot = pivot;
	}
	// Layout is keyed "field:<name>" for a source column and "formula:<id>" for
	// a formula column.
	const keyed: FieldVisit = (key) => {
		if (key.startsWith(formulaKeyPrefix)) {
			return lostIds.has(key.slice(formulaKeyPrefix.length))
				? dropField
				: null;
		}
		if (!key.startsWith(fieldKeyPrefix)) return null;
		const seen = visitName(key.slice(fieldKeyPrefix.length), reach);
		if (seen === null || seen === dropField) return seen;
		return fieldKeyPrefix + seen;
	};
	if ("order" in next) next.order = walkList(next.order, keyed);
	if ("settings" in next) next.settings = walkKeys(next.settings, keyed);
	if (isObject(next.sort) && typeof next.sort.column === "string") {
		const seen = visitName(next.sort.column, reach);
		if (seen === dropField) delete next.sort;
		else if (seen !== null) next.sort = { ...next.sort, column: seen };
	}
	return done(definition, next as T);
}

// A tour's steps, whose filters are keyed by field name.
export function walkDeckSteps<T>(steps: T, visit: FieldVisit): Walked<T> {
	if (!Array.isArray(steps)) return { value: steps, changed: false };
	const next = clone(steps) as unknown[];
	for (const step of next) {
		if (isObject(step) && "filters" in step) {
			step.filters = walkKeys(step.filters, visit);
		}
	}
	return done(steps, next as T);
}

// A board's definition. Each item holds a visual of its own with the source it
// reads, and only items reading the changed source are walked.
export function walkBoard<T>(
	definition: T,
	sourceKey: string,
	visit: FieldVisit,
): Walked<T> {
	if (!isObject(definition)) return { value: definition, changed: false };
	const next = clone(definition) as Json;
	const walkItems = (items: unknown): unknown => {
		if (!Array.isArray(items)) return items;
		return items.map((item) => {
			if (!isObject(item)) return item;
			const copy: Json = { ...item };
			if (isObject(copy.visual) && copy.visual.sourceKey === sourceKey) {
				copy.visual = {
					...copy.visual,
					config: walkVisual(copy.visual.config, visit).value,
				};
			}
			for (const [key, inner] of Object.entries(copy)) {
				if (key !== "visual" && Array.isArray(inner)) {
					copy[key] = walkItems(inner);
				}
			}
			return copy;
		});
	};
	for (const [key, inner] of Object.entries(next)) {
		if (Array.isArray(inner)) next[key] = walkItems(inner);
	}
	return done(definition, next as T);
}

// Every name a walk would meet, gathered by visiting with a collector.
export function namesIn(walk: (visit: FieldVisit) => unknown): string[] {
	const found = new Set<string>();
	walk((name) => {
		found.add(name);
		return null;
	});
	return [...found];
}

// A visit that renames one field and keeps every other.
export function renaming(from: string, to: string): FieldVisit {
	return (name) => (name === from ? to : null);
}

// A visit that removes one field and keeps every other.
export function removing(field: string): FieldVisit {
	return (name) => (name === field ? dropField : null);
}
