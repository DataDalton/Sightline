"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import type { FormatHint } from "../../lib/format";
import {
	columnFormats,
	displayColumns,
	noteKey,
	type ColumnFormat,
	type SheetDefinition,
} from "../../lib/sheets/definition";
import type { PivotData, TableData } from "../../lib/sheets/data";
import { computeColumns, type FormulaColumn } from "../../lib/sheets/formula";
import { describeFetchError } from "../../lib/swr";
import { ago } from "../admin/when";
import { Modal } from "../components/shared/Modal";
import { SkeletonText } from "../components/shared/Skeleton";
import { ExploreBar } from "../explore/ExploreBar";
import { usePageTitle } from "../hooks/usePageTitle";
import type { SourceMeta } from "../visuals/types";
import { FormulaDialog } from "./FormulaDialog";
import { PivotBuilder, PivotGrid } from "./PivotView";
import { ShareDialog } from "./ShareDialog";
import { SheetActions } from "./SheetActions";
import {
	colourFor,
	displayValue,
	gridColumns,
	initials,
	SheetGrid,
	type CellRef,
	type GridColumn,
	type MenuAction,
} from "./SheetGrid";
import { useSheet } from "./useSheet";
import styles from "./Sheets.module.css";

// A sheet, open. The search bar above says what to read from the dataset,
// exactly as in Explore. The grid below adds the reader's own columns: formulas
// worked out from each row, and notes typed beside them. The same data can be
// turned into a pivot instead.

const formatLabel: Record<ColumnFormat, string> = {
	auto: "Automatic",
	number: "Number",
	integer: "Whole number",
	currency: "Currency",
	percent: "Percent",
	text: "Text",
};

function newId(): string {
	return Math.random().toString(36).slice(2, 10);
}

export default function SheetEditor({ id }: { id: string }) {
	const s = useSheet(id);
	const router = useRouter();
	const def = s.definition;
	usePageTitle(s.sheet?.title ?? "Sheet");

	const { data: authoring } = useSWR<{ sources: SourceMeta[] }>(
		"/api/authoring",
	);
	const sources = useMemo(
		() =>
			[...(authoring?.sources ?? [])].sort((a, b) =>
				a.title.localeCompare(b.title),
			),
		[authoring],
	);
	const source = sources.find((x) => x.sourceKey === def?.sourceKey);

	const [title, setTitle] = useState("");
	useEffect(() => {
		if (s.sheet) setTitle(s.sheet.title);
	}, [s.sheet?.title]);

	const [formulaDialog, setFormulaDialog] = useState<{
		editing: FormulaColumn | null;
	} | null>(null);
	const [renaming, setRenaming] = useState<{
		key: string;
		name: string;
	} | null>(null);
	const [sharing, setSharing] = useState(false);
	const [selected, setSelected] = useState<CellRef | null>(null);

	const change = s.change;
	const update = useCallback(
		(patch: Partial<SheetDefinition>) =>
			change((d) => ({ ...d, ...patch })),
		[change],
	);

	// --- Table data --------------------------------------------------------

	const table = s.data?.mode === "table" ? (s.data as TableData) : null;
	const pivot = s.data?.mode === "pivot" ? (s.data as PivotData) : null;

	const fieldHints = useMemo(() => {
		const m = new Map<string, FormatHint>();
		for (const f of [
			...(source?.dimensions ?? []),
			...(source?.measures ?? []),
		]) {
			m.set(f.name, (f.formatHint as FormatHint) ?? "text");
		}
		return m;
	}, [source]);

	const columns = useMemo(
		() =>
			def
				? gridColumns(displayColumns(def), def.settings, fieldHints)
				: [],
		[def, fieldHints],
	);

	// Only the columns the rows actually carry. A field just added shows once
	// the data for it arrives, rather than as an empty column meanwhile.
	const shown = useMemo(
		() =>
			table
				? columns.filter(
						(c) =>
							c.kind !== "field" ||
							table.columns.includes(c.name),
					)
				: [],
		[columns, table],
	);

	const computed = useMemo(
		() =>
			table && def
				? computeColumns(table.rows, table.columns, def.formulas)
				: { values: [], problems: {} },
		[table, def?.formulas],
	);

	const notes = useMemo(() => {
		const m = new Map<string, string>();
		for (const n of table?.notes ?? [])
			m.set(`${n.rowKey}\u0000${n.noteId}`, n.value);
		return m;
	}, [table]);

	// Fields are sorted by the warehouse. A formula or a note sorts here, over
	// the rows that came back.
	const order = useMemo(() => {
		const n = table?.rows.length ?? 0;
		const idx = Array.from({ length: n }, (_, i) => i);
		const sort = def?.sort;
		if (!table || !sort || def?.columns.includes(sort.column)) return idx;
		const formula = def.formulas.find((f) => f.name === sort.column);
		const note = def.notes.find((x) => x.id === sort.column);
		if (!formula && !note) return idx;
		const val = (i: number): unknown =>
			formula
				? computed.values[i]?.[formula.name]
				: notes.get(`${table.keys[i]}\u0000${note!.id}`);
		const dir = sort.direction === "asc" ? 1 : -1;
		return idx.sort((a, b) => {
			const x = val(a);
			const y = val(b);
			const blank = (v: unknown) =>
				v === null ||
				v === undefined ||
				v === "" ||
				typeof v === "object";
			if (blank(x) && blank(y)) return 0;
			if (blank(x)) return 1;
			if (blank(y)) return -1;
			if (typeof x === "number" && typeof y === "number")
				return (x - y) * dir;
			return (
				String(x).localeCompare(String(y), undefined, {
					numeric: true,
				}) * dir
			);
		});
	}, [
		table,
		def?.sort,
		def?.columns,
		def?.formulas,
		def?.notes,
		computed,
		notes,
	]);

	const valueAt = useCallback(
		(r: number, c: GridColumn): unknown => {
			if (!table) return null;
			const i = order[r];
			if (c.kind === "field") return table.rows[i]?.[c.name];
			if (c.kind === "formula")
				return computed.values[i]?.[c.name] ?? null;
			return notes.get(`${table.keys[i]}\u0000${c.id}`) ?? "";
		},
		[table, order, computed, notes],
	);

	const rowKeyAt = useCallback(
		(r: number) => table?.keys[order[r]] ?? "",
		[table, order],
	);

	const setCell = s.setCell;
	const onSelect = useCallback(
		(cell: CellRef | null) => {
			setSelected(cell);
			setCell(
				cell && shown[cell.col]
					? { row: rowKeyAt(cell.row), column: shown[cell.col].key }
					: null,
			);
		},
		[setCell, shown, rowKeyAt],
	);

	// --- Column actions ----------------------------------------------------

	const sortKey = (c: GridColumn) => (c.kind === "note" ? c.id : c.name);

	const setSort = (c: GridColumn, direction: "asc" | "desc" | null) =>
		update({ sort: direction ? { column: sortKey(c), direction } : null });

	const cycleSort = (c: GridColumn) => {
		const current =
			def?.sort?.column === sortKey(c) ? def.sort.direction : null;
		setSort(
			c,
			current === null ? "asc" : current === "asc" ? "desc" : null,
		);
	};

	const move = (c: GridColumn, by: number) =>
		change((d) => {
			const keys = displayColumns(d).map((x) => x.key);
			const from = keys.indexOf(c.key);
			const to = Math.max(0, Math.min(keys.length - 1, from + by));
			keys.splice(to, 0, keys.splice(from, 1)[0]);
			return { ...d, order: keys };
		});

	const remove = (c: GridColumn) =>
		change((d) => ({
			...d,
			columns:
				c.kind === "field"
					? d.columns.filter((x) => x !== c.name)
					: d.columns,
			formulas:
				c.kind === "formula"
					? d.formulas.filter((f) => f.id !== c.id)
					: d.formulas,
			notes:
				c.kind === "note"
					? d.notes.filter((n) => n.id !== c.id)
					: d.notes,
			sort: d.sort?.column === sortKey(c) ? null : d.sort,
		}));

	const setFormat = (c: GridColumn, format: ColumnFormat) =>
		change((d) => ({
			...d,
			settings: {
				...d.settings,
				[c.key]: { ...d.settings[c.key], format },
			},
		}));

	const menuFor = (c: GridColumn): MenuAction[] => {
		const i = shown.findIndex((x) => x.key === c.key);
		const actions: MenuAction[] = [
			{ label: "Sort ascending", onSelect: () => setSort(c, "asc") },
			{ label: "Sort descending", onSelect: () => setSort(c, "desc") },
		];
		if (!s.editable) return actions;
		actions.push({ label: "", onSelect: () => {}, separator: true });
		if (c.kind === "formula") {
			const f = def?.formulas.find((x) => x.id === c.id) ?? null;
			actions.push({
				label: "Edit formula",
				onSelect: () => setFormulaDialog({ editing: f }),
			});
		}
		if (c.kind === "note") {
			actions.push({
				label: "Rename",
				onSelect: () => setRenaming({ key: c.key, name: c.name }),
			});
		}
		if (c.kind !== "note") {
			for (const format of columnFormats) {
				if (format === c.format) continue;
				actions.push({
					label: `Show as ${formatLabel[format].toLowerCase()}`,
					onSelect: () => setFormat(c, format),
				});
			}
		}
		actions.push({ label: "", onSelect: () => {}, separator: true });
		actions.push({
			label:
				def && def.frozen === i + 1
					? "Unfreeze columns"
					: "Freeze up to here",
			onSelect: () =>
				update({ frozen: def && def.frozen === i + 1 ? 0 : i + 1 }),
		});
		if (i > 0)
			actions.push({ label: "Move left", onSelect: () => move(c, -1) });
		if (i < shown.length - 1)
			actions.push({ label: "Move right", onSelect: () => move(c, 1) });
		actions.push({ label: "", onSelect: () => {}, separator: true });
		actions.push({
			label: "Remove column",
			onSelect: () => remove(c),
			danger: true,
		});
		return actions;
	};

	// --- The page ----------------------------------------------------------

	if (s.error) {
		return (
			<div className={styles.page}>
				<div className={styles.empty}>
					{describeFetchError(s.error, "sheet")}
				</div>
			</div>
		);
	}
	if (!s.sheet || !def) {
		return (
			<div className={styles.page}>
				<SkeletonText lines={3} />
			</div>
		);
	}

	const others = [
		...new Map(
			s.present.filter((p) => !p.self).map((p) => [p.email, p]),
		).values(),
	];
	const selectedColumn = selected ? shown[selected.col] : null;
	const selectedValue =
		selected && selectedColumn
			? valueAt(selected.row, selectedColumn)
			: null;
	const selectedFormula =
		selectedColumn?.kind === "formula"
			? def.formulas.find((f) => f.id === selectedColumn.id)
			: null;

	return (
		<div className={styles.editor}>
			<header className={styles.editorHead}>
				<div className={styles.titleBlock}>
					<Link href="/sheets/" className={styles.back}>
						Sheets
					</Link>
					<input
						className={styles.titleInput}
						value={title}
						readOnly={!s.editable}
						// For browsers without field-sizing, which size an
						// input by character count instead.
						size={Math.max(8, title.length + 1)}
						maxLength={120}
						aria-label="Sheet name"
						onChange={(e) => setTitle(e.target.value)}
						onBlur={() =>
							title.trim() &&
							title !== s.sheet!.title &&
							s.rename(title)
						}
						onKeyDown={(e) =>
							e.key === "Enter" &&
							(e.target as HTMLInputElement).blur()
						}
					/>
					<span className={styles.saveState}>
						{s.saving
							? "Saving"
							: s.sheet.permission === "view"
								? "View only"
								: `Saved ${ago(s.sheet.modifiedOn)}`}
					</span>
				</div>
				<div className={styles.headActions}>
					{others.length > 0 && (
						<span
							className={styles.avatars}
							aria-label={`Also here: ${others.map((p) => p.email).join(", ")}`}
						>
							{others.slice(0, 5).map((p) => (
								<span
									key={p.email}
									className={styles.avatar}
									style={{ background: colourFor(p.email) }}
									title={p.email}
								>
									{initials(p.email)}
								</span>
							))}
						</span>
					)}
					<div
						className={styles.segmented}
						role="radiogroup"
						aria-label="View"
					>
						{(["table", "pivot"] as const).map((m) => (
							<button
								key={m}
								type="button"
								role="radio"
								aria-checked={def.mode === m}
								className={`${styles.segment} ${def.mode === m ? styles.segmentOn : ""}`}
								onClick={() => update({ mode: m })}
								disabled={!s.editable}
							>
								{m === "table" ? "Table" : "Pivot"}
							</button>
						))}
					</div>
					<button
						type="button"
						className={styles.secondary}
						onClick={s.reload}
						title="Read the data again"
					>
						Refresh
					</button>
					<a
						className={styles.secondary}
						href={`/api/sheets/${id}/download`}
						download
					>
						Download
					</a>
					<button
						type="button"
						className={styles.primary}
						onClick={() => setSharing(true)}
					>
						Share
					</button>
					<SheetActions
						id={id}
						title={s.sheet.title}
						permission={s.sheet.permission}
						onDeleted={() => router.push("/sheets/")}
						onDuplicated={(copy) => router.push(`/sheets/${copy}/`)}
					/>
				</div>
			</header>

			{s.notice && (
				<div className={styles.notice} role="status">
					<span>{s.notice}</span>
					<button
						type="button"
						className={styles.linkButton}
						onClick={s.clearNotice}
					>
						Dismiss
					</button>
				</div>
			)}

			{s.editable ? (
				<ExploreBar
					sources={sources}
					source={source}
					columns={def.columns}
					conditions={def.conditions}
					onSource={(key) =>
						change((d) => ({
							...d,
							sourceKey: key,
							columns: [],
							conditions: [],
							sort: null,
							pivot: { rows: [], columns: null, values: [] },
						}))
					}
					onColumns={(next) => update({ columns: next })}
					onConditions={(next) => update({ conditions: next })}
				/>
			) : (
				<p className={styles.readOnlyQuery}>
					{source?.title ?? def.sourceKey}
					{def.columns.length > 0 && ` · ${def.columns.join(", ")}`}
				</p>
			)}

			{!def.sourceKey ? (
				<div className={styles.empty}>
					Type the name of a dataset in the bar above to start. The
					sheet reads from it live and never changes it.
				</div>
			) : def.mode === "pivot" ? (
				<>
					<PivotBuilder
						source={source}
						layout={def.pivot}
						editable={s.editable}
						onChange={(pivot) => update({ pivot })}
					/>
					{s.dataError ? (
						<div className={styles.empty}>
							{describeFetchError(s.dataError, "sheet")}
						</div>
					) : pivot ? (
						<PivotGrid
							table={pivot.table}
							hints={fieldHints}
							clipped={pivot.table.clipped || pivot.truncated}
						/>
					) : (
						<SkeletonText lines={4} />
					)}
				</>
			) : (
				<>
					<div className={styles.tableTools}>
						{s.editable && (
							<>
								<button
									type="button"
									className={styles.toolButton}
									onClick={() =>
										setFormulaDialog({ editing: null })
									}
									disabled={
										!table || table.columns.length === 0
									}
								>
									<span className={styles.kindTag}>fx</span>{" "}
									Formula column
								</button>
								<button
									type="button"
									className={styles.toolButton}
									onClick={() => {
										const nid = newId();
										change((d) => ({
											...d,
											notes: [
												...d.notes,
												{
													id: nid,
													name: d.notes.length
														? `Notes ${d.notes.length + 1}`
														: "Notes",
												},
											],
										}));
									}}
									disabled={def.notes.length >= 10}
								>
									<svg
										width="13"
										height="13"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2.2"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
									</svg>
									Notes column
								</button>
							</>
						)}
						<div className={styles.formulaBar} aria-live="polite">
							{selectedColumn ? (
								<>
									<span className={styles.formulaRef}>
										{selectedColumn.name} · row{" "}
										{selected!.row + 1}
									</span>
									{selectedFormula ? (
										<button
											type="button"
											className={styles.formulaText}
											onClick={() =>
												s.editable &&
												setFormulaDialog({
													editing: selectedFormula,
												})
											}
											title={
												s.editable
													? "Edit the formula"
													: undefined
											}
										>
											={selectedFormula.formula}
										</button>
									) : (
										<span className={styles.formulaValue}>
											{displayValue(
												selectedValue,
												selectedColumn,
											)}
										</span>
									)}
								</>
							) : (
								<span className={styles.fieldHint}>
									Select a cell. Shift or drag to select a
									range, Ctrl+C to copy
									{s.editable && def.notes.length > 0
										? ", and type into a notes cell to write in it"
										: ""}
									.
								</span>
							)}
						</div>
					</div>

					{Object.keys(computed.problems).length > 0 && (
						<p className={styles.problem}>
							{Object.entries(computed.problems)
								.map(([n, p]) => `${n}: ${p}`)
								.join(" ")}
						</p>
					)}
					{table?.truncated && (
						<p className={styles.problem}>
							Showing the first{" "}
							{table.rows.length.toLocaleString()} rows. Add a
							condition to narrow them, or download for up to
							50,000.
						</p>
					)}

					{s.dataError ? (
						<div className={styles.empty}>
							{describeFetchError(s.dataError, "sheet")}
						</div>
					) : !table ? (
						<SkeletonText lines={6} />
					) : def.columns.length === 0 ? (
						<div className={styles.empty}>
							Add columns from {source?.title ?? "the dataset"} in
							the bar above.
						</div>
					) : (
						<SheetGrid
							columns={shown}
							rowCount={table.rows.length}
							valueAt={valueAt}
							rowKeyAt={rowKeyAt}
							frozen={Math.min(def.frozen, shown.length)}
							sort={def.sort}
							editable={s.editable}
							present={s.present}
							menuFor={menuFor}
							onSort={cycleSort}
							onResize={(c, width) =>
								change((d) => ({
									...d,
									settings: {
										...d.settings,
										[c.key]: {
											...d.settings[c.key],
											width,
										},
									},
								}))
							}
							onNote={(r, c, value) =>
								s.writeNote(rowKeyAt(r), c.id, value)
							}
							onSelect={onSelect}
						/>
					)}
				</>
			)}

			{formulaDialog && table && (
				<FormulaDialog
					editing={formulaDialog.editing}
					columns={table.columns}
					formulas={def.formulas}
					sampleRows={order.slice(0, 200).map((i) => table.rows[i])}
					onClose={() => setFormulaDialog(null)}
					onSave={(f) => {
						setFormulaDialog(null);
						change((d) => ({
							...d,
							formulas: d.formulas.some((x) => x.id === f.id)
								? d.formulas.map((x) => (x.id === f.id ? f : x))
								: [...d.formulas, f],
						}));
					}}
				/>
			)}

			{renaming && (
				<Modal
					isOpen
					onClose={() => setRenaming(null)}
					title="Rename column"
					width="420px"
					footer={
						<>
							<button
								type="button"
								className={styles.secondary}
								onClick={() => setRenaming(null)}
							>
								Cancel
							</button>
							<button
								type="button"
								className={styles.primary}
								disabled={!renaming.name.trim()}
								onClick={() => {
									const { key, name } = renaming;
									setRenaming(null);
									change((d) => ({
										...d,
										notes: d.notes.map((n) =>
											noteKey(n.id) === key
												? { ...n, name: name.trim() }
												: n,
										),
									}));
								}}
							>
								Rename
							</button>
						</>
					}
				>
					<input
						className={styles.input}
						value={renaming.name}
						maxLength={80}
						autoFocus
						onChange={(e) =>
							setRenaming({ ...renaming, name: e.target.value })
						}
						aria-label="Column name"
					/>
				</Modal>
			)}

			{sharing && (
				<ShareDialog
					sheetId={id}
					isOwner={s.sheet.permission === "owner"}
					onClose={() => setSharing(false)}
				/>
			)}
		</div>
	);
}
