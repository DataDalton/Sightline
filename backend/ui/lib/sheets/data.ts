import { createHash, randomUUID } from "node:crypto";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { insertLog } from "../activityLog";
import { queryAsUser, queryAsUserBatches } from "../data/userSession";
import { toFilterLogic } from "../explore/conditions";
import { plainDates } from "../format";
import { compileQuery, type RowRestriction } from "../query/builder";
import { csvHeader, csvRows } from "../query/csv";
import {
	assertCanReadSource,
	executeQuery,
	QueryAccessError,
} from "../query/execute";
import { maxLimit, parseQuerySpec, type QuerySpec } from "../query/spec";
import { isDatabricksApp } from "../runtime";
import { getSource } from "../semantic/registry";
import { findMissingField, type SemanticSource } from "../semantic/types";
import { record } from "../telemetry/usage";
import {
	buildPivot,
	displayColumns,
	limits,
	parseRowKey,
	pivotGroupings,
	queryFingerprint,
	rowKey,
	type PivotTable,
	type SheetDefinition,
} from "./definition";
import { computeColumns, isError, readsWholeColumn } from "./formula";
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
	// Fields the sheet names that its dataset does not publish, left out of
	// the query and reported so the page can say which ones.
	missing: string[];
}

// Why a sheet cannot be read, naming the field and what became of it where
// the dataset remembers it.
function missingFieldProblem(source: SemanticSource, name: string): string {
	const known = findMissingField(source, name);
	if (known?.renamedTo) {
		return `The sheet filters on ${name}, which ${source.title} renamed to ${known.renamedTo}. Change the condition to use the new name.`;
	}
	return `The sheet filters on ${name}, which ${source.title} no longer has. Remove that condition to read the sheet.`;
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
	// A condition cannot be dropped the way a column can. Without it the sheet
	// would show more rows than it asks for and look right doing it.
	for (const condition of def.conditions) {
		if (!kinds.has(condition.field)) {
			throw new SheetError(missingFieldProblem(source, condition.field));
		}
	}
	const logic = toFilterLogic(def.conditions, kinds);
	if (logic.problem) throw new SheetError(logic.problem);
	return {
		source,
		dimensions: def.columns.filter((c) => dims.has(c)),
		measures: def.columns.filter((c) => meas.has(c)),
		logic,
		missing: def.columns.filter((c) => !kinds.has(c)),
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

// The order the table's rows are read in. Sorted by the warehouse when it is
// a field, so the rows kept under the ceiling are the ones that sort first. A
// formula or note column sorts in the page over the rows that came back.
function sortFor(r: Resolved, def: SheetDefinition): QuerySpec["sort"] {
	const sortField =
		def.sort &&
		(r.dimensions.includes(def.sort.column) ||
			r.measures.includes(def.sort.column))
			? def.sort
			: null;
	return sortField
		? [{ field: sortField.column, direction: sortField.direction }]
		: [];
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
	// Columns the sheet names that its dataset no longer publishes.
	missing: string[];
}

export interface PivotData {
	mode: "pivot";
	table: PivotTable;
	truncated: boolean;
	computedAt: number;
	// Fields in the layout that the dataset no longer publishes.
	missing: string[];
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
	const result = await executeQuery(
		identity,
		specFor(r, r.dimensions, r.measures, sortFor(r, def), limit + 1),
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

// The table's rows and their keys, remembered as the keys this person can
// see.
async function readTable(identity: Identity, sheet: Sheet) {
	const read = await tableRows(identity, sheet.definition, limits.tableRows);
	const keys = read.rows.map((row) => rowKey(row, read.r.dimensions));
	remember(identity, sheet, keys, !read.truncated);
	return { ...read, keys };
}

export async function tableData(
	identity: Identity,
	sheet: Sheet,
): Promise<TableData> {
	const { r, rows, keys, columns, truncated, computedAt, stale } =
		await readTable(identity, sheet);
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
		missing: r.missing,
	};
}

// --- Which rows somebody can see ---------------------------------------------

// A row key is the row's values, so anything handed out by key, a note or
// another viewer's selected cell, is handed out only for keys the person
// asking can see. Every answer here comes from that person's own reading of
// the sheet, under their own token.
//
// Each person's answers are kept for a short time, against the sheet and a
// fingerprint of what its rows are read from, so the presence beat and a
// note do not read the data again for keys just answered. A change to the
// question starts afresh.

interface Seen {
	visible: Set<string>;
	hidden: Set<string>;
	// The visible keys are every row the table holds for this person, so a
	// key outside them is hidden.
	complete: boolean;
	expires: number;
}

const seen = new Map<string, Seen>();
const seenMs = 30_000;
// Entries kept at most, the oldest dropped first. A bound on memory only.
const maxSeen = 2000;
// Keys asked of the warehouse by value at most. Past this the whole table is
// read instead, which is the same reading the sheet itself makes.
const targetedKeys = 200;

function seenKey(identity: Identity, sheet: Sheet): string {
	return [
		identity.email.toLowerCase(),
		sheet.id,
		queryFingerprint(sheet.definition),
	].join("\u0000");
}

function recall(identity: Identity, sheet: Sheet): Seen | null {
	const key = seenKey(identity, sheet);
	const entry = seen.get(key);
	if (!entry) return null;
	if (entry.expires <= Date.now()) {
		seen.delete(key);
		return null;
	}
	return entry;
}

// Stores an entry as the newest, then drops expired entries from the oldest
// end, and the oldest live ones while there are too many.
function store(key: string, entry: Seen): void {
	seen.delete(key);
	seen.set(key, entry);
	const now = Date.now();
	for (const [k, e] of seen) {
		if (seen.size <= maxSeen && e.expires > now) break;
		seen.delete(k);
	}
}

function remember(
	identity: Identity,
	sheet: Sheet,
	keys: string[],
	complete: boolean,
): void {
	store(seenKey(identity, sheet), {
		visible: new Set(keys),
		hidden: new Set(),
		complete,
		expires: Date.now() + seenMs,
	});
}

function learn(
	identity: Identity,
	sheet: Sheet,
	asked: string[],
	visible: Set<string>,
): void {
	const entry = recall(identity, sheet) ?? {
		visible: new Set<string>(),
		hidden: new Set<string>(),
		complete: false,
		expires: Date.now() + seenMs,
	};
	for (const k of asked) {
		if (visible.has(k)) entry.visible.add(k);
		else entry.hidden.add(k);
	}
	store(seenKey(identity, sheet), entry);
}

// Column types the warehouse writes as text the same way a row key holds
// them, so a key can be matched against them by value. Others, such as
// timestamps and decimals, are spelled differently on the two sides and are
// matched only once the rows come back.
const keyComparableType =
	/^(string|varchar|char|tinyint|smallint|short|byte|int|integer|bigint|long|boolean|date)\b/i;

// Refuses a reader the warehouse read would refuse, with the checks a query
// of the sheet makes before it runs.
async function checkReader(identity: Identity, sourceKey: string) {
	await assertCanReadSource(identity, sourceKey);
	const policy = await resolvePolicyClass(identity);
	if (policy.degraded) {
		throw new QueryAccessError(
			"Access could not be verified. Group membership is temporarily unavailable.",
		);
	}
	if (!identity.userToken && isDatabricksApp) {
		throw new QueryAccessError(
			"A user token is required to query data. Enable user authorization " +
				"with the sql scope on the app.",
		);
	}
	return policy;
}

interface Compiled {
	sql: string;
	params: Record<string, unknown>;
}

// Runs a compiled query under the reader's own token and hands its rows to
// onBatch a batch at a time. Never through the result cache, and never as the
// app. onBatch is awaited, so a slow consumer holds the next batch back.
async function readAsReader(
	identity: Identity,
	compiled: Compiled,
	batchRows: number,
	onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
	if (identity.userToken) {
		await queryAsUserBatches(
			identity.userToken,
			compiled.sql,
			compiled.params,
			batchRows,
			(rows) => onBatch(plainDates(rows)),
		);
		return;
	}
	if (isDatabricksApp) {
		throw new QueryAccessError("A user token is required to query data.");
	}
	// Development only. Runs as the local Databricks credentials, so row
	// filtering reflects that identity rather than the caller's.
	const { queryLocally } = await import("../data/localSession");
	const all = plainDates(await queryLocally(compiled.sql, compiled.params));
	for (let i = 0; i < all.length; i += batchRows) {
		await onBatch(all.slice(i, i + batchRows));
	}
}

// Which of the keys this person can see, asked of the warehouse for those
// rows alone. The sheet's own question runs under their token, narrowed to the
// values the keys name, and a key counts as visible only when a row with
// exactly that key comes back. Null when the keys cannot be narrowed to, and
// the whole table has to be read instead.
async function keysVisibleNow(
	identity: Identity,
	def: SheetDefinition,
	keys: string[],
): Promise<Set<string> | null> {
	const r = resolve(def);
	if (r.dimensions.length + r.measures.length === 0) return new Set();
	const tuples = new Map<string, (string | null)[]>();
	for (const k of keys) {
		const values = parseRowKey(k, r.dimensions.length);
		if (values) tuples.set(k, values);
	}
	if (tuples.size === 0) return new Set();

	let restriction: RowRestriction | undefined;
	if (r.dimensions.length > 0) {
		const types = new Map(
			r.source.dimensions.map((d) => [d.name, d.dataType ?? ""]),
		);
		const exact = r.dimensions
			.map((name, at) => ({ name, at }))
			.filter(({ name }) =>
				keyComparableType.test(types.get(name) ?? ""),
			);
		if (exact.length === 0) return null;
		const narrowed = new Map<string, (string | null)[]>();
		for (const values of tuples.values()) {
			const part = exact.map(({ at }) => values[at]);
			narrowed.set(JSON.stringify(part), part);
		}
		restriction = {
			fields: exact.map(({ name }) => name),
			tuples: [...narrowed.values()],
		};
	}

	await checkReader(identity, r.source.sourceKey);
	const compiled = compileQuery(
		r.source,
		specFor(r, r.dimensions, r.measures, [], limits.tableRows + 1),
		{ restriction },
	);
	const found = new Set<string>();
	let read = 0;
	await readAsReader(
		identity,
		compiled,
		limits.tableRows + 1,
		async (rows) => {
			read += rows.length;
			for (const row of rows) found.add(rowKey(row, r.dimensions));
		},
	);
	const visible = new Set([...tuples.keys()].filter((k) => found.has(k)));
	// Cut short with keys still unanswered, which a fuller reading may find.
	if (read > limits.tableRows && visible.size < tuples.size) return null;
	return visible;
}

// The keys, of those given, that this person can see on the sheet now.
export async function visibleKeys(
	identity: Identity,
	sheet: Sheet,
	keys: string[],
): Promise<Set<string>> {
	const out = new Set<string>();
	if (sheet.definition.mode !== "table") return out;
	const memo = recall(identity, sheet);
	const unknown: string[] = [];
	for (const k of new Set(keys)) {
		if (memo?.visible.has(k)) out.add(k);
		else if (!memo || !(memo.complete || memo.hidden.has(k)))
			unknown.push(k);
	}
	if (unknown.length === 0) return out;

	const found =
		unknown.length <= targetedKeys
			? await keysVisibleNow(identity, sheet.definition, unknown)
			: null;
	if (found) {
		learn(identity, sheet, unknown, found);
		for (const k of found) out.add(k);
		return out;
	}
	const table = new Set((await readTable(identity, sheet)).keys);
	for (const k of unknown) if (table.has(k)) out.add(k);
	return out;
}

// Whether a row is one this person can see now, which is the condition on
// writing a note to it.
export async function canSeeRow(
	identity: Identity,
	sheet: Sheet,
	key: string,
): Promise<boolean> {
	return (await visibleKeys(identity, sheet, [key])).has(key);
}

// The notes on the given rows, for a page that already holds those rows and
// was told the notes changed. A note shows the values of the row it sits on,
// so notes are answered only on rows this person can see, and only the rows
// that carry a note are checked.
export async function notesOnRows(
	identity: Identity,
	sheet: Sheet,
	keys: string[],
): Promise<Note[]> {
	const def = sheet.definition;
	if (def.mode !== "table" || def.notes.length === 0) return [];
	const notes = await notesFor(sheet.id, [...new Set(keys)]);
	if (notes.length === 0) return [];
	const visible = await visibleKeys(
		identity,
		sheet,
		notes.map((n) => n.rowKey),
	);
	return notes.filter((n) => visible.has(n.rowKey));
}

export async function pivotData(
	identity: Identity,
	sheet: Sheet,
): Promise<PivotData> {
	const def = sheet.definition;
	const r = resolve(def);
	const dims = new Set(r.source.dimensions.map((d) => d.name));
	const meas = new Set(r.source.measures.map((m) => m.name));

	// A layout field the dataset no longer publishes is left out and reported,
	// so the rest of the pivot still reads.
	const gone = (name: string) =>
		findMissingField(r.source, name) !== null ||
		(!dims.has(name) && !meas.has(name));
	const missing = [
		...new Set(
			[
				...def.pivot.rows,
				...(def.pivot.columns ? [def.pivot.columns] : []),
				...def.pivot.values,
			].filter(gone),
		),
	];
	const layout = {
		rows: def.pivot.rows.filter((f) => !gone(f)),
		columns:
			def.pivot.columns && !gone(def.pivot.columns)
				? def.pivot.columns
				: null,
		values: def.pivot.values.filter((f) => !gone(f)),
	};

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
			missing,
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
		missing,
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

// Rows per round trip out of the warehouse, and per piece of the file.
const downloadBatchRows = 2000;

// Rows are keyed by column position rather than by header text. Two columns
// may carry the same name, such as a note column named after a field, and
// keying by name writes one column's values into both.
type Line = Record<string, unknown>;

// What a download writes, worked out before the first byte goes. Lines are
// handed to emit, which is awaited, so the file is written a piece at a time
// as the reader takes it.
interface DownloadPlan {
	header: string[];
	produce: (emit: (lines: Line[]) => Promise<void>) => Promise<void>;
	truncated: () => boolean;
}

async function pivotPlan(
	identity: Identity,
	sheet: Sheet,
): Promise<DownloadPlan> {
	const data = await pivotData(identity, sheet);
	const down = data.table.down.length;
	const header = [
		...data.table.down,
		...data.table.columns.map((c) => c.label),
	];
	const lines = data.table.rows.map((row) => {
		const out: Line = {};
		data.table.down.forEach((_d, i) => {
			out[i] = row.total && i === 0 ? "Total" : row.keys[i];
		});
		data.table.columns.forEach((_c, i) => {
			out[down + i] = row.cells[i];
		});
		return out;
	});
	return {
		header,
		produce: async (emit: (lines: Line[]) => Promise<void>) => {
			for (let i = 0; i < lines.length; i += downloadBatchRows) {
				await emit(lines.slice(i, i + downloadBatchRows));
			}
		},
		truncated: () => data.truncated,
	};
}

// The table read straight from the warehouse under the reader's token, a
// batch at a time, with formulas worked out and notes looked up per batch.
// A formula that reads down a whole column needs every row first, so with
// one of those the field values are held until the reading ends, bounded by
// the download ceiling, and written out from there.
function tablePlan(identity: Identity, sheet: Sheet): DownloadPlan {
	const def = sheet.definition;
	const r = resolve(def);
	const columns = displayColumns(def);
	const header = columns.map((c) => c.name);
	let truncated = false;

	// The rows' keys, and the notes on them by key and note column.
	const notesOn = async (rows: Record<string, unknown>[]) => {
		const keys = rows.map((row) => rowKey(row, r.dimensions));
		const notes =
			def.notes.length > 0
				? await notesFor(sheet.id, [...new Set(keys)])
				: [];
		const noteIndex = new Map(
			notes.map((n) => [`${n.rowKey}\u0000${n.noteId}`, n.value]),
		);
		return { keys, noteIndex };
	};

	const toLines = (
		rows: Record<string, unknown>[],
		from: number,
		keys: string[],
		noteIndex: Map<string, string>,
		values: ReturnType<typeof computeColumns>["values"],
	): Line[] =>
		rows.map((row, j) => {
			const i = from + j;
			const out: Line = {};
			columns.forEach((c, at) => {
				if (c.kind === "field") out[at] = row[c.name];
				else if (c.kind === "formula") {
					const v = values[i][c.name];
					out[at] = isError(v) ? v.code : inert(v);
				} else
					out[at] = inert(
						noteIndex.get(`${keys[j]}\u0000${c.id}`) ?? "",
					);
			});
			return out;
		});

	const produce = async (emit: (lines: Line[]) => Promise<void>) => {
		if (r.dimensions.length + r.measures.length === 0) return;
		const compiled = compileQuery(
			r.source,
			specFor(r, r.dimensions, r.measures, sortFor(r, def), maxLimit + 1),
		);
		const wholeColumn = readsWholeColumn(def.formulas);
		const held: Record<string, unknown>[] = [];
		let taken = 0;

		await readAsReader(
			identity,
			compiled,
			downloadBatchRows,
			async (batch) => {
				// The query asks for one row past the ceiling, so the last batch can
				// carry the row that shows the file was cut short.
				const room = maxLimit - taken;
				if (batch.length > room) truncated = true;
				const rows = batch.length > room ? batch.slice(0, room) : batch;
				if (rows.length === 0) return;
				taken += rows.length;
				if (wholeColumn) {
					held.push(...rows);
					return;
				}
				const { keys, noteIndex } = await notesOn(rows);
				const computed = computeColumns(
					rows,
					def.columns,
					def.formulas,
				);
				await emit(toLines(rows, 0, keys, noteIndex, computed.values));
			},
		);

		if (held.length === 0) return;
		const computed = computeColumns(held, def.columns, def.formulas);
		for (let i = 0; i < held.length; i += downloadBatchRows) {
			const rows = held.slice(i, i + downloadBatchRows);
			const { keys, noteIndex } = await notesOn(rows);
			await emit(toLines(rows, i, keys, noteIndex, computed.values));
		}
	};

	return { header, produce, truncated: () => truncated };
}

// The sheet as a CSV file, with its formulas worked out on the server rather
// than trusted from the page, and recorded in the export audit like any other
// data leaving the platform.
//
// The file is written to the response as it is read, and never through the
// result cache. Everything that can refuse the download, the access checks
// and the first batch of rows, happens before this returns, so a refusal is
// an answer the page can show rather than a broken file.
export async function downloadSheet(
	identity: Identity,
	sheet: Sheet,
): Promise<{ filename: string; body: ReadableStream<Uint8Array> }> {
	const def = sheet.definition;
	// A sheet whose dataset is gone says so before the access checks run.
	resolve(def);
	const policy = await checkReader(identity, def.sourceKey);
	const auditId = randomUUID();
	const filename = `${sheet.title.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "sheet"}.csv`;

	const plan =
		def.mode === "pivot"
			? await pivotPlan(identity, sheet)
			: tablePlan(identity, sheet);
	const positions = plan.header.map((_h, i) => String(i));

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

	const { readable, writable } = new TransformStream<
		Uint8Array,
		Uint8Array
	>();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	let rows = 0;
	let bytes = 0;

	// Settled when the first piece of the file is ready or the reading has
	// failed before any was, whichever comes first.
	let started!: () => void;
	let refused!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		started = resolve;
		refused = reject;
	});
	let sentAny = false;

	const write = async (text: string) => {
		if (!sentAny) {
			sentAny = true;
			text = csvHeader(plan.header) + text;
			started();
		}
		const chunk = encoder.encode(text);
		bytes += chunk.byteLength;
		await writer.ready;
		await writer.write(chunk);
	};

	void (async () => {
		try {
			await plan.produce(async (lines) => {
				if (lines.length === 0) return;
				await write(csvRows(positions, lines));
				rows += lines.length;
			});
			if (!sentAny) await write("");
			await writer.close();
		} catch (error) {
			const message =
				error instanceof Error
					? error.message.slice(0, 400)
					: "unknown";
			// Before the first piece the route answers with the error. After
			// it the response is already under way and can only be cut off.
			if (sentAny)
				console.error(`Sheet download ${auditId} stopped:`, error);
			else refused(error);
			await writer.abort(error).catch(() => {});
			await insertLog({
				recordType: "export",
				recordId: auditId,
				action: "failed",
				changedBy: identity.email,
				notes: message,
			}).catch(() => {});
			return;
		}
		await insertLog({
			recordType: "export",
			recordId: auditId,
			action: "completed",
			changedBy: identity.email,
			newValue: JSON.stringify({
				rowCount: rows,
				columns: plan.header.length,
				bytes,
				truncated: plan.truncated(),
			}),
			notes: `${rows} rows`,
		}).catch((error) => {
			console.error(`Sheet download ${auditId} audit failed:`, error);
		});
		record({
			occurredOn: new Date().toISOString(),
			userEmail: identity.email,
			policyClass: policy.id,
			eventType: "export",
			sourceKey: def.sourceKey,
			rowCount: rows,
			cacheHit: false,
		});
	})();

	await ready;
	return { filename, body: readable };
}
