import { createHash, randomUUID } from "node:crypto";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { insertLog } from "../activityLog";
import { toFilterLogic } from "../explore/conditions";
import { csvHeader, csvRows } from "../query/csv";
import { executeQuery } from "../query/execute";
import { maxLimit, parseQuerySpec, type QuerySpec } from "../query/spec";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import { record } from "../telemetry/usage";
import {
	buildPivot,
	displayColumns,
	limits,
	pivotGroupings,
	rowKey,
	type PivotTable,
	type SheetDefinition,
} from "./definition";
import { computeColumns, isError } from "./formula";
import { notesFor, SheetError, type Note, type Sheet } from "./store";

// Reading a sheet's data, always as the person looking at it.
//
// A shared sheet is the same question for everybody, and each person gets
// their own answer to it: the query runs under their token like any report,
// so a row filter shows each of them their own rows. Notes are returned only
// for the rows in that answer. A note is keyed by its row's values, so handing
// back notes for rows somebody cannot see would show them values their filter
// hides.

interface Resolved {
	source: SemanticSource;
	dimensions: string[];
	measures: string[];
	logic: ReturnType<typeof toFilterLogic>;
}

function resolve(def: SheetDefinition): Resolved {
	const source = getSource(def.sourceKey);
	if (!source)
		throw new SheetError("The sheet's dataset is not available.", 404);
	const dims = new Set(source.dimensions.map((d) => d.name));
	const meas = new Set(source.measures.map((m) => m.name));
	const kinds = new Map<string, "dimension" | "measure">([
		...source.dimensions.map((f) => [f.name, "dimension"] as const),
		...source.measures.map((f) => [f.name, "measure"] as const),
	]);
	const logic = toFilterLogic(def.conditions, kinds);
	if (logic.problem) throw new SheetError(logic.problem);
	return {
		source,
		dimensions: def.columns.filter((c) => dims.has(c)),
		measures: def.columns.filter((c) => meas.has(c)),
		logic,
	};
}

function specFor(
	r: Resolved,
	dimensions: string[],
	measures: string[],
	sort: QuerySpec["sort"],
	limit: number,
): QuerySpec {
	return parseQuerySpec({
		sourceKey: r.source.sourceKey,
		dimensions,
		measures,
		filters: r.logic.filters,
		...(r.logic.anyOf ? { anyOf: r.logic.anyOf } : {}),
		...(r.logic.where ? { where: r.logic.where } : {}),
		sort,
		limit,
		offset: 0,
	});
}

export interface TableData {
	mode: "table";
	columns: string[];
	rows: Record<string, unknown>[];
	// Row keys in the same order as rows.
	keys: string[];
	notes: Note[];
	truncated: boolean;
	computedAt: number;
	stale: boolean;
}

export interface PivotData {
	mode: "pivot";
	table: PivotTable;
	truncated: boolean;
	computedAt: number;
}

async function tableRows(
	identity: Identity,
	def: SheetDefinition,
	limit: number,
) {
	const r = resolve(def);
	if (r.dimensions.length + r.measures.length === 0) {
		return {
			r,
			rows: [],
			columns: [],
			truncated: false,
			computedAt: Date.now(),
			stale: false,
		};
	}
	// Sorted by the warehouse when it is a field, so the rows kept under the
	// ceiling are the ones that sort first. A formula or note column sorts in
	// the page over the rows that came back.
	const sortField =
		def.sort && def.columns.includes(def.sort.column) ? def.sort : null;
	const result = await executeQuery(
		identity,
		specFor(
			r,
			r.dimensions,
			r.measures,
			sortField
				? [{ field: sortField.column, direction: sortField.direction }]
				: [],
			limit + 1,
		),
	);
	return {
		r,
		rows: result.rows.slice(0, limit),
		columns: result.columns,
		truncated: result.rows.length > limit,
		computedAt: result.computedAt,
		stale: result.stale,
	};
}

export async function tableData(
	identity: Identity,
	sheet: Sheet,
): Promise<TableData> {
	const { r, rows, columns, truncated, computedAt, stale } = await tableRows(
		identity,
		sheet.definition,
		limits.tableRows,
	);
	const keys = rows.map((row) => rowKey(row, r.dimensions));
	const notes =
		sheet.definition.notes.length > 0
			? await notesFor(sheet.id, [...new Set(keys)])
			: [];
	return {
		mode: "table",
		columns,
		rows,
		keys,
		notes,
		truncated,
		computedAt,
		stale,
	};
}

// Whether a row is one this person can see now, which is the condition on
// writing a note to it. Asked through the same query the table uses, so it is
// normally answered from the cache.
export async function canSeeRow(
	identity: Identity,
	sheet: Sheet,
	key: string,
): Promise<boolean> {
	const data = await tableData(identity, sheet);
	return data.keys.includes(key);
}

export async function pivotData(
	identity: Identity,
	sheet: Sheet,
): Promise<PivotData> {
	const def = sheet.definition;
	const r = resolve(def);
	const layout = def.pivot;
	const dims = new Set(r.source.dimensions.map((d) => d.name));
	const meas = new Set(r.source.measures.map((m) => m.name));
	for (const f of [
		...layout.rows,
		...(layout.columns ? [layout.columns] : []),
	]) {
		if (!dims.has(f))
			throw new SheetError(`${f} is not a field that groups rows.`);
	}
	const values = layout.values.filter((v) => meas.has(v));
	if (values.length === 0) {
		return {
			mode: "pivot",
			table: { down: layout.rows, columns: [], rows: [], clipped: false },
			truncated: false,
			computedAt: Date.now(),
		};
	}

	const groups = pivotGroupings(layout);
	const ask = (dimensions: string[] | null, limit: number) =>
		dimensions === null
			? Promise.resolve(null)
			: executeQuery(identity, specFor(r, dimensions, values, [], limit));

	const [cells, rowTotals, colTotals, grand] = await Promise.all([
		ask(groups.cells, limits.pivotCells + 1),
		ask(groups.rowTotals, limits.pivotCells + 1),
		ask(groups.colTotals, limits.pivotColumns * 4),
		ask(groups.grand, 1),
	]);

	const table = buildPivot(
		{
			rows: layout.rows.filter((x) => x !== layout.columns),
			columns: layout.columns,
			values,
		},
		{
			cells: cells!.rows.slice(0, limits.pivotCells),
			rowTotals: rowTotals?.rows,
			colTotals: colTotals?.rows,
			grand: grand?.rows,
		},
	);
	return {
		mode: "pivot",
		table,
		truncated: cells!.rows.length > limits.pivotCells,
		computedAt: cells!.computedAt,
	};
}

// --- Taking it away --------------------------------------------------------

// A cell a spreadsheet program would run as a formula when the file is
// opened. Notes are written by people, so one beginning with = could be a
// formula planted for whoever downloads the sheet next. Prefixed with a quote,
// which every spreadsheet program reads as "this is text".
function inert(value: unknown): unknown {
	if (typeof value !== "string") return value;
	return /^[=+\-@\t\r]/.test(value) && !Number.isFinite(Number(value))
		? `'${value}`
		: value;
}

// The sheet as a CSV file, with its formulas worked out on the server rather
// than trusted from the page, and recorded in the export audit like any other
// data leaving the platform.
export async function downloadSheet(
	identity: Identity,
	sheet: Sheet,
): Promise<{ filename: string; body: string; rows: number }> {
	const def = sheet.definition;
	const policy = await resolvePolicyClass(identity);
	const auditId = randomUUID();
	const filename = `${sheet.title.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "sheet"}.csv`;

	let header: string[] = [];
	let lines: Record<string, unknown>[] = [];

	if (def.mode === "pivot") {
		const data = await pivotData(identity, sheet);
		header = [
			...data.table.down,
			...data.table.columns.map((c) => c.label),
		];
		lines = data.table.rows.map((row) => {
			const out: Record<string, unknown> = {};
			data.table.down.forEach((d, i) => {
				out[d] = row.total && i === 0 ? "Total" : row.keys[i];
			});
			data.table.columns.forEach((c, i) => {
				out[c.label] = row.cells[i];
			});
			return out;
		});
	} else {
		const { r, rows } = await tableRows(identity, def, maxLimit);
		const keys = rows.map((row) => rowKey(row, r.dimensions));
		const notes =
			def.notes.length > 0
				? await notesFor(sheet.id, [...new Set(keys)])
				: [];
		const noteIndex = new Map(
			notes.map((n) => [`${n.rowKey}\u0000${n.noteId}`, n.value]),
		);
		const computed = computeColumns(rows, def.columns, def.formulas);
		const columns = displayColumns(def);
		header = columns.map((c) => c.name);
		lines = rows.map((row, i) => {
			const out: Record<string, unknown> = {};
			for (const c of columns) {
				if (c.kind === "field") out[c.name] = row[c.name];
				else if (c.kind === "formula") {
					const v = computed.values[i][c.name];
					out[c.name] = isError(v) ? v.code : inert(v);
				} else
					out[c.name] = inert(
						noteIndex.get(`${keys[i]}\u0000${c.id}`) ?? "",
					);
			}
			return out;
		});
	}

	// Recorded before the bytes leave, so a failure part way still shows the
	// attempt.
	await insertLog({
		recordType: "export",
		recordId: auditId,
		action: "requested",
		changedBy: identity.email,
		newValue: JSON.stringify({
			sheetId: sheet.id,
			sourceKey: def.sourceKey,
			mode: def.mode,
			columns: def.columns,
			conditions: def.conditions.length,
			policyClass: policy.id,
			fingerprint: createHash("sha256")
				.update(JSON.stringify(def))
				.digest("hex")
				.slice(0, 16),
		}),
		notes: `csv export of sheet ${sheet.title}`,
	});

	const body = csvHeader(header) + csvRows(header, lines);

	await insertLog({
		recordType: "export",
		recordId: auditId,
		action: "completed",
		changedBy: identity.email,
		newValue: JSON.stringify({
			rowCount: lines.length,
			columns: header.length,
			bytes: body.length,
		}),
		notes: `${lines.length} rows`,
	});
	record({
		occurredOn: new Date().toISOString(),
		userEmail: identity.email,
		policyClass: policy.id,
		eventType: "export",
		sourceKey: def.sourceKey,
		rowCount: lines.length,
		cacheHit: false,
	});

	return { filename, body, rows: lines.length };
}
