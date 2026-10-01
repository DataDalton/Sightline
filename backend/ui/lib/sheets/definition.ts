import type { Condition } from "../explore/conditions";
import { cleanState } from "../explore/state";
import type { FormulaColumn } from "./formula";

// What a sheet is: a question asked of one dataset, the same one Explore asks,
// with the reader's own columns on top of the answer. It never changes the
// dataset. Formula columns are worked out from the rows, and notes are kept
// with the sheet, keyed by the row they sit on.
//
// A sheet shows its data one of two ways. As a table, one row per group of the
// chosen fields, which is where formulas and notes live. As a pivot, one field
// down the side and one across the top, with a measure in the cells.
//
// Pure, so it can be checked on its own and used on both sides.

export type SheetMode = "table" | "pivot";

export type ColumnFormat =
	| "auto"
	| "number"
	| "integer"
	| "currency"
	| "percent"
	| "text";

export const columnFormats: ColumnFormat[] = [
	"auto",
	"number",
	"integer",
	"currency",
	"percent",
	"text",
];

export interface NoteColumn {
	id: string;
	name: string;
}

export interface ColumnSetting {
	width?: number;
	format?: ColumnFormat;
}

export interface PivotLayout {
	// Fields down the side, one row per combination.
	rows: string[];
	// One field across the top, or none for a plain summary.
	columns: string | null;
	// Measures in the cells.
	values: string[];
}

export interface SheetSort {
	// A field, a formula column's name, or a note column's id.
	column: string;
	direction: "asc" | "desc";
}

export interface SheetDefinition {
	sourceKey: string;
	mode: SheetMode;
	// The dataset's fields shown in the table, in the order they were added.
	columns: string[];
	conditions: Condition[];
	formulas: FormulaColumn[];
	notes: NoteColumn[];
	// Every column in display order, by key. See columnKey.
	order: string[];
	settings: Record<string, ColumnSetting>;
	sort: SheetSort | null;
	pivot: PivotLayout;
	// Leading columns kept in view while scrolling sideways.
	frozen: number;
}

export const limits = {
	fields: 60,
	formulas: 40,
	notes: 10,
	formulaLength: 2000,
	nameLength: 80,
	pivotRows: 4,
	pivotValues: 8,
	// Rows a table shows. The warehouse is asked for one more, so a sheet
	// that reached it can say so rather than look complete.
	tableRows: 5000,
	// Distinct values of the across field shown as columns.
	pivotColumns: 60,
	pivotCells: 20000,
};

export const emptyDefinition = (sourceKey = ""): SheetDefinition => ({
	sourceKey,
	mode: "table",
	columns: [],
	conditions: [],
	formulas: [],
	notes: [],
	order: [],
	settings: {},
	sort: null,
	pivot: { rows: [], columns: null, values: [] },
	frozen: 0,
});

// A column's key in the display order and the settings. Fields by name,
// formulas and notes by id, so renaming a formula keeps its place and width.
export type ColumnKey = string;
export const fieldKey = (name: string): ColumnKey => `field:${name}`;
export const formulaKey = (id: string): ColumnKey => `formula:${id}`;
export const noteKey = (id: string): ColumnKey => `note:${id}`;

export interface DisplayColumn {
	key: ColumnKey;
	kind: "field" | "formula" | "note";
	// What a formula calls it and what the header says.
	name: string;
	id: string;
}

// Every column in the order shown. Anything missing from the stored order is
// added at the end, and anything in it that no longer exists is dropped, so
// the order can never disagree with the columns.
export function displayColumns(def: SheetDefinition): DisplayColumn[] {
	const all = new Map<ColumnKey, DisplayColumn>();
	for (const name of def.columns) {
		all.set(fieldKey(name), {
			key: fieldKey(name),
			kind: "field",
			name,
			id: name,
		});
	}
	for (const f of def.formulas) {
		all.set(formulaKey(f.id), {
			key: formulaKey(f.id),
			kind: "formula",
			name: f.name,
			id: f.id,
		});
	}
	for (const n of def.notes) {
		all.set(noteKey(n.id), {
			key: noteKey(n.id),
			kind: "note",
			name: n.name,
			id: n.id,
		});
	}
	const out: DisplayColumn[] = [];
	for (const key of def.order) {
		const c = all.get(key);
		if (c) {
			out.push(c);
			all.delete(key);
		}
	}
	return [...out, ...all.values()];
}

// --- Cleaning what arrives -------------------------------------------------

const text = (v: unknown, max: number) =>
	typeof v === "string" ? v.trim().slice(0, max) : "";

const idPattern = /^[A-Za-z0-9_-]{1,40}$/;

export class SheetDefinitionError extends Error {}

export function cleanDefinition(raw: unknown): SheetDefinition {
	const r = (raw ?? {}) as Record<string, unknown>;
	const sourceKey = text(r.sourceKey, 200);

	// The dataset, fields and conditions are Explore's, and checked the same
	// way.
	const state = sourceKey
		? cleanState({
				sourceKey,
				columns: Array.isArray(r.columns) ? r.columns : [],
				conditions: Array.isArray(r.conditions) ? r.conditions : [],
			})
		: null;

	const seenNames = new Set<string>();
	const formulas: FormulaColumn[] = [];
	for (const f of Array.isArray(r.formulas) ? r.formulas : []) {
		const item = (f ?? {}) as Record<string, unknown>;
		const id = text(item.id, 40);
		const name = text(item.name, limits.nameLength);
		const formula = text(item.formula, limits.formulaLength);
		if (!idPattern.test(id) || !name || seenNames.has(name.toLowerCase())) {
			continue;
		}
		seenNames.add(name.toLowerCase());
		formulas.push({ id, name, formula });
		if (formulas.length >= limits.formulas) break;
	}

	const notes: NoteColumn[] = [];
	for (const n of Array.isArray(r.notes) ? r.notes : []) {
		const item = (n ?? {}) as Record<string, unknown>;
		const id = text(item.id, 40);
		const name = text(item.name, limits.nameLength);
		if (!idPattern.test(id) || !name) continue;
		notes.push({ id, name });
		if (notes.length >= limits.notes) break;
	}

	const settings: Record<string, ColumnSetting> = {};
	const rawSettings = (r.settings ?? {}) as Record<string, unknown>;
	for (const [key, value] of Object.entries(rawSettings).slice(0, 200)) {
		const v = (value ?? {}) as Record<string, unknown>;
		const width = Number(v.width);
		const setting: ColumnSetting = {};
		if (Number.isFinite(width))
			setting.width = Math.min(800, Math.max(48, Math.round(width)));
		if (columnFormats.includes(v.format as ColumnFormat)) {
			setting.format = v.format as ColumnFormat;
		}
		if (Object.keys(setting).length) settings[key.slice(0, 200)] = setting;
	}

	const rawSort = (r.sort ?? null) as Record<string, unknown> | null;
	const sort: SheetSort | null =
		rawSort && text(rawSort.column, 200)
			? {
					column: text(rawSort.column, 200),
					direction: rawSort.direction === "desc" ? "desc" : "asc",
				}
			: null;

	const rawPivot = (r.pivot ?? {}) as Record<string, unknown>;
	const names = (v: unknown, max: number) =>
		(Array.isArray(v) ? v : [])
			.map((x) => text(x, 200))
			.filter(Boolean)
			.slice(0, max);
	const pivot: PivotLayout = {
		rows: names(rawPivot.rows, limits.pivotRows),
		columns: text(rawPivot.columns, 200) || null,
		values: names(rawPivot.values, limits.pivotValues),
	};

	const frozen = Number(r.frozen);

	return {
		sourceKey: state?.sourceKey ?? "",
		mode: r.mode === "pivot" ? "pivot" : "table",
		columns: (state?.columns ?? []).slice(0, limits.fields),
		conditions: state?.conditions ?? [],
		formulas,
		notes,
		order: names(r.order, 200),
		settings,
		sort,
		pivot,
		frozen: Number.isInteger(frozen)
			? Math.min(10, Math.max(0, frozen))
			: 0,
	};
}

// --- Rows ------------------------------------------------------------------

// Which row a note belongs to: the values of the fields that group it. The same
// group keeps its notes when the data refreshes, a group that disappears takes
// nothing with it, and one that comes back finds its notes again.
//
// A sheet with no grouping fields is one row.
export function rowKey(
	row: Record<string, unknown>,
	groupFields: string[],
): string {
	if (groupFields.length === 0) return "*";
	return JSON.stringify(
		groupFields.map((f) => {
			const v = row[f];
			return v === null || v === undefined ? null : String(v);
		}),
	);
}

// The values a row key was made from, in the order of the fields that group
// it, or null when the text is not a key for that many fields.
export function parseRowKey(
	key: string,
	fieldCount: number,
): (string | null)[] | null {
	if (fieldCount === 0) return key === "*" ? [] : null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length !== fieldCount) return null;
	if (!parsed.every((v) => v === null || typeof v === "string")) return null;
	return parsed as (string | null)[];
}

// --- What the data is read from ---------------------------------------------

// The parts of a definition its rows are read from. Widths, formats, the
// title, the column order, frozen columns, formulas and notes leave the rows
// as they are. A sort on a formula or a note column is applied in the page,
// so only a sort on a field is part of the question.
export function queryShape(def: SheetDefinition): unknown {
	if (def.mode === "pivot") {
		return {
			s: def.sourceKey,
			m: "pivot",
			c: def.conditions,
			p: def.pivot,
		};
	}
	return {
		s: def.sourceKey,
		m: "table",
		f: def.columns,
		c: def.conditions,
		o: def.sort && def.columns.includes(def.sort.column) ? def.sort : null,
	};
}

// One 32 bit FNV-1a pass over the text from the given starting value.
function fnv1a(text: string, basis: number): string {
	let h = basis;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

// A fingerprint of queryShape, worked out the same way in the browser and on
// the server. Two definitions with the same fingerprint read the same rows.
export function queryFingerprint(def: SheetDefinition): string {
	const text = JSON.stringify(queryShape(def));
	return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x050c5d1f);
}

// --- Pivots ----------------------------------------------------------------

export interface PivotColumn {
	// Value of the across field this column is for, or null for the total.
	across: string | null;
	measure: string;
	label: string;
}

export interface PivotRow {
	// Values of the fields down the side, or null throughout for the total row.
	keys: (string | null)[];
	cells: (unknown | null)[];
	total: boolean;
}

export interface PivotTable {
	down: string[];
	columns: PivotColumn[];
	rows: PivotRow[];
	// The across field had more values than are shown.
	clipped: boolean;
}

const asKey = (v: unknown) =>
	v === null || v === undefined ? null : String(v);

function naturalCompare(a: string | null, b: string | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	const an = Number(a);
	const bn = Number(b);
	if (a !== "" && b !== "" && Number.isFinite(an) && Number.isFinite(bn)) {
		return an - bn;
	}
	return a.localeCompare(b, undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

// Lays the answers out as a pivot.
//
// The totals are four separate answers rather than sums of the cells, because
// most measures cannot be added up: an average of averages, a distinct count
// across groups, a margin. The warehouse works each one out at its own grain,
// so every total is the figure the measure itself defines.
//
//   cells       grouped by the fields down the side and the one across
//   rowTotals   grouped by the fields down the side only
//   colTotals   grouped by the across field only
//   grand       not grouped
export function buildPivot(
	layout: PivotLayout,
	answers: {
		cells: Record<string, unknown>[];
		rowTotals?: Record<string, unknown>[];
		colTotals?: Record<string, unknown>[];
		grand?: Record<string, unknown>[];
	},
): PivotTable {
	const down = layout.rows;
	const across = layout.columns;
	const measures = layout.values;

	let acrossValues: (string | null)[] = [];
	let clipped = false;
	if (across) {
		const seen = new Set<string | null>();
		for (const row of answers.cells) seen.add(asKey(row[across]));
		acrossValues = [...seen].sort(naturalCompare);
		if (acrossValues.length > limits.pivotColumns) {
			acrossValues = acrossValues.slice(0, limits.pivotColumns);
			clipped = true;
		}
	}

	const columns: PivotColumn[] = [];
	const labelFor = (a: string | null, m: string) =>
		measures.length === 1 ? (a ?? "(blank)") : `${a ?? "(blank)"} · ${m}`;
	if (across) {
		for (const a of acrossValues) {
			for (const m of measures) {
				columns.push({ across: a, measure: m, label: labelFor(a, m) });
			}
		}
	}
	for (const m of measures) {
		columns.push({
			across: null,
			measure: m,
			label: across
				? measures.length === 1
					? "Total"
					: `Total · ${m}`
				: m,
		});
	}

	const keyOf = (row: Record<string, unknown>) =>
		JSON.stringify(down.map((d) => asKey(row[d])));

	// Rows in the order of the fields down the side.
	const groups = new Map<string, (string | null)[]>();
	for (const row of [...answers.cells, ...(answers.rowTotals ?? [])]) {
		const k = keyOf(row);
		if (!groups.has(k))
			groups.set(
				k,
				down.map((d) => asKey(row[d])),
			);
	}
	const ordered = [...groups.entries()].sort(([, a], [, b]) => {
		for (let i = 0; i < a.length; i++) {
			const c = naturalCompare(a[i], b[i]);
			if (c !== 0) return c;
		}
		return 0;
	});

	const cellIndex = new Map<string, Record<string, unknown>>();
	if (across) {
		for (const row of answers.cells) {
			cellIndex.set(`${keyOf(row)}\u0000${asKey(row[across])}`, row);
		}
	}
	const rowTotalIndex = new Map<string, Record<string, unknown>>();
	for (const row of across ? (answers.rowTotals ?? []) : answers.cells) {
		rowTotalIndex.set(keyOf(row), row);
	}
	const colTotalIndex = new Map<string | null, Record<string, unknown>>();
	if (across) {
		for (const row of answers.colTotals ?? []) {
			colTotalIndex.set(asKey(row[across]), row);
		}
	}
	const grand = answers.grand?.[0] ?? null;

	const rows: PivotRow[] = ordered.map(([k, keys]) => ({
		keys,
		total: false,
		cells: columns.map((c) => {
			const source =
				c.across === null
					? rowTotalIndex.get(k)
					: cellIndex.get(`${k}\u0000${c.across}`);
			return source?.[c.measure] ?? null;
		}),
	}));

	// A total row only when there is more than one row to total.
	if (down.length > 0 && rows.length > 1 && grand) {
		rows.push({
			keys: down.map(() => null),
			total: true,
			cells: columns.map((c) => {
				const source =
					c.across === null ? grand : colTotalIndex.get(c.across);
				return source?.[c.measure] ?? null;
			}),
		});
	}

	return { down, columns, rows, clipped };
}

// The questions a pivot asks, as the dimensions each one groups by. The
// measures and conditions are the same for all four.
export function pivotGroupings(layout: PivotLayout): {
	cells: string[];
	rowTotals: string[] | null;
	colTotals: string[] | null;
	grand: string[] | null;
} {
	const across = layout.columns;
	const down = layout.rows.filter((r) => r !== across);
	return {
		cells: across ? [...down, across] : down,
		rowTotals: across ? down : null,
		colTotals: across && down.length > 0 ? [across] : null,
		grand: down.length > 0 ? [] : null,
	};
}
