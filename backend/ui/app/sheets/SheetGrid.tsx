"use client";

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatValue, toNumber, type FormatHint } from "../../lib/format";
import type {
	ColumnFormat,
	ColumnSetting,
	DisplayColumn,
	SheetSort,
} from "../../lib/sheets/definition";
import { isError, type Value } from "../../lib/sheets/formula";
import type { Present } from "../../lib/sheets/store";
import styles from "./Sheets.module.css";

// The table a sheet shows, working the way a spreadsheet does: click a cell to
// select it, drag or shift-click for a range, move with the arrow keys, copy
// with Ctrl+C, and type into a note cell. Rows are drawn only while on screen,
// so a few thousand of them scroll as easily as a few dozen.

export interface CellRef {
	row: number;
	col: number;
}

const rowHeight = 32;
const defaultWidth = 150;

const formatToHint: Record<Exclude<ColumnFormat, "auto">, FormatHint> = {
	number: "decimal",
	integer: "integer",
	currency: "currency",
	percent: "percent",
	text: "text",
};

// Distinct colours for the people who have the sheet open, taken from the
// chart palette so they hold up in both themes.
const presenceColours = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--chart-6)",
	"var(--chart-7)",
];

function colourFor(email: string): string {
	let h = 0;
	for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return presenceColours[h % presenceColours.length];
}

function initials(email: string): string {
	const local = email.split("@")[0] ?? email;
	const parts = local.split(/[._-]+/).filter(Boolean);
	return (
		(parts[0]?.[0] ?? "?").toUpperCase() +
		(parts[1]?.[0] ?? "").toUpperCase()
	);
}

export interface GridColumn extends DisplayColumn {
	width: number;
	hint: FormatHint;
	format: ColumnFormat;
}

export function gridColumns(
	columns: DisplayColumn[],
	settings: Record<string, ColumnSetting>,
	fieldHints: Map<string, FormatHint>,
): GridColumn[] {
	return columns.map((c) => {
		const setting = settings[c.key] ?? {};
		const format = setting.format ?? "auto";
		const natural: FormatHint =
			c.kind === "field"
				? (fieldHints.get(c.name) ?? "text")
				: c.kind === "note"
					? "text"
					: "decimal";
		return {
			...c,
			width: setting.width ?? (c.kind === "note" ? 220 : defaultWidth),
			hint: format === "auto" ? natural : formatToHint[format],
			format,
		};
	});
}

// The raw value in a cell, before formatting.
export type CellValue = (row: number, column: GridColumn) => unknown;

export function displayValue(value: unknown, column: GridColumn): string {
	if (isError(value)) return value.code;
	if (value === null || value === undefined || value === "") return "";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (column.kind === "note") return String(value);
	if (column.kind === "formula" && typeof value === "string") return value;
	// A formula's percentage is a fraction, 0.25 for a quarter. The field
	// formats elsewhere take percentages as points, so it is scaled here.
	if (column.kind === "formula" && column.hint === "percent") {
		const n = toNumber(value);
		return n === null ? String(value) : formatValue(n * 100, "percent");
	}
	return formatValue(value, column.hint);
}

function isNumeric(value: unknown): boolean {
	return (
		!isError(value) &&
		typeof value !== "boolean" &&
		toNumber(value) !== null &&
		value !== ""
	);
}

export interface MenuAction {
	label: string;
	onSelect: () => void;
	danger?: boolean;
	separator?: boolean;
}

export function SheetGrid({
	columns,
	rowCount,
	valueAt,
	rowKeyAt,
	frozen,
	sort,
	editable,
	present,
	menuFor,
	onSort,
	onResize,
	onNote,
	onSelect,
}: {
	columns: GridColumn[];
	rowCount: number;
	valueAt: CellValue;
	rowKeyAt: (row: number) => string;
	frozen: number;
	sort: SheetSort | null;
	editable: boolean;
	present: Present[];
	menuFor: (column: GridColumn) => MenuAction[];
	onSort: (column: GridColumn) => void;
	onResize: (column: GridColumn, width: number) => void;
	onNote: (
		rowKey: string,
		column: GridColumn,
		value: string,
	) => Promise<string | null>;
	onSelect: (cell: CellRef | null) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const [anchor, setAnchor] = useState<CellRef | null>(null);
	const [focus, setFocus] = useState<CellRef | null>(null);
	// The note being typed, held by row key and column key rather than by
	// position, so rows read again in another order while it is open do not
	// move the text onto a different row.
	const [editing, setEditing] = useState<{
		rowKey: string;
		columnKey: string;
		original: string;
		text: string;
	} | null>(null);
	// Whether the open edit is still to be committed. Enter and the blur that
	// follows the editor closing both commit, and only the first is sent.
	const editOpen = useRef(false);
	const [noteError, setNoteError] = useState<string | null>(null);
	const [menu, setMenu] = useState<{
		column: GridColumn;
		x: number;
		y: number;
	} | null>(null);
	const [widths, setWidths] = useState<Record<string, number>>({});
	const dragging = useRef(false);

	const width = (c: GridColumn) => widths[c.key] ?? c.width;

	// Where each frozen column sits, measured from the left edge after the
	// row number column.
	const gutter = 52;
	const offsets = useMemo(() => {
		const out: number[] = [];
		let left = gutter;
		columns.forEach((c, i) => {
			out.push(left);
			if (i < frozen) left += widths[c.key] ?? c.width;
		});
		return out;
	}, [columns, frozen, widths]);
	const totalWidth = gutter + columns.reduce((sum, c) => sum + width(c), 0);

	const virtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scroller.current,
		estimateSize: () => rowHeight,
		overscan: 12,
	});

	// --- Selection -------------------------------------------------------

	const range = useMemo(() => {
		if (!anchor || !focus) return null;
		return {
			r0: Math.min(anchor.row, focus.row),
			r1: Math.max(anchor.row, focus.row),
			c0: Math.min(anchor.col, focus.col),
			c1: Math.max(anchor.col, focus.col),
		};
	}, [anchor, focus]);

	const inRange = (r: number, c: number) =>
		range !== null &&
		r >= range.r0 &&
		r <= range.r1 &&
		c >= range.c0 &&
		c <= range.c1;

	const select = useCallback(
		(cell: CellRef | null, extend = false) => {
			if (!cell) {
				setAnchor(null);
				setFocus(null);
				onSelect(null);
				return;
			}
			const clamped = {
				row: Math.max(0, Math.min(rowCount - 1, cell.row)),
				col: Math.max(0, Math.min(columns.length - 1, cell.col)),
			};
			setFocus(clamped);
			if (!extend) setAnchor(clamped);
			onSelect(clamped);
			virtualizer.scrollToIndex(clamped.row, { align: "auto" });
		},
		[rowCount, columns.length, onSelect, virtualizer],
	);

	// Rows or columns going away can leave a selection pointing past the end.
	useEffect(() => {
		if (focus && (focus.row >= rowCount || focus.col >= columns.length)) {
			select(null);
		}
	}, [rowCount, columns.length, focus, select]);

	const stats = useMemo(() => {
		if (!range) return null;
		let count = 0;
		let numbers = 0;
		let sum = 0;
		for (let r = range.r0; r <= range.r1 && r < rowCount; r++) {
			for (let c = range.c0; c <= range.c1; c++) {
				const v = valueAt(r, columns[c]);
				if (v === null || v === undefined || v === "") continue;
				count++;
				if (isNumeric(v)) {
					numbers++;
					sum += toNumber(v) as number;
				}
			}
		}
		return {
			count,
			numbers,
			sum,
			cells: (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1),
		};
	}, [range, rowCount, columns, valueAt]);

	const copy = useCallback(async () => {
		if (!range) return;
		const lines: string[] = [];
		for (let r = range.r0; r <= range.r1; r++) {
			const cells: string[] = [];
			for (let c = range.c0; c <= range.c1; c++) {
				const v = valueAt(r, columns[c]);
				// Numbers go out unformatted, so they paste as numbers.
				const text = isError(v)
					? v.code
					: isNumeric(v) && columns[c].kind !== "note"
						? String(toNumber(v))
						: displayValue(v, columns[c]);
				cells.push(text.replace(/[\t\r\n]+/g, " "));
			}
			lines.push(cells.join("\t"));
		}
		await navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
	}, [range, valueAt, columns]);

	// --- Notes ------------------------------------------------------------

	const startEdit = (cell: CellRef, initial?: string) => {
		const column = columns[cell.col];
		if (!editable || column?.kind !== "note") return;
		const current = valueAt(cell.row, column);
		const original = typeof current === "string" ? current : "";
		const next = {
			rowKey: rowKeyAt(cell.row),
			columnKey: column.key,
			original,
			text: initial ?? original,
		};
		setNoteError(null);
		editOpen.current = true;
		setEditing(next);
	};

	const commit = async (move: number) => {
		if (!editing || !editOpen.current) return;
		editOpen.current = false;
		const { rowKey, columnKey, original, text } = editing;
		setEditing(null);
		const column = columns.find((c) => c.key === columnKey);
		if (column && original !== text) {
			const problem = await onNote(rowKey, column, text);
			setNoteError(problem);
		}
		if (move && column) {
			let row = -1;
			for (let r = 0; r < rowCount; r++) {
				if (rowKeyAt(r) === rowKey) {
					row = r;
					break;
				}
			}
			if (row >= 0)
				select({ row: row + move, col: columns.indexOf(column) });
		}
		scroller.current?.focus();
	};

	const cancelEdit = () => {
		editOpen.current = false;
		setEditing(null);
		scroller.current?.focus();
	};

	// --- Keyboard ---------------------------------------------------------

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (editing) return;
		if (!focus) {
			if (
				[
					"ArrowDown",
					"ArrowUp",
					"ArrowLeft",
					"ArrowRight",
					"Enter",
				].includes(e.key) &&
				rowCount > 0
			) {
				e.preventDefault();
				select({ row: 0, col: 0 });
			}
			return;
		}
		const step = (dr: number, dc: number) => {
			e.preventDefault();
			const big = e.ctrlKey || e.metaKey;
			select(
				{
					row:
						big && dr
							? dr > 0
								? rowCount - 1
								: 0
							: focus.row + dr,
					col:
						big && dc
							? dc > 0
								? columns.length - 1
								: 0
							: focus.col + dc,
				},
				e.shiftKey,
			);
		};
		switch (e.key) {
			case "ArrowDown":
				return step(1, 0);
			case "ArrowUp":
				return step(-1, 0);
			case "ArrowRight":
				return step(0, 1);
			case "ArrowLeft":
				return step(0, -1);
			case "Tab":
				// At either end of a row, Tab leaves the grid as it does
				// anywhere else on the page.
				if (
					e.shiftKey
						? focus.col === 0
						: focus.col >= columns.length - 1
				)
					return;
				return step(0, e.shiftKey ? -1 : 1);
			case "PageDown":
				return step(20, 0);
			case "PageUp":
				return step(-20, 0);
			case "Enter":
			case "F2":
				e.preventDefault();
				if (columns[focus.col]?.kind === "note") startEdit(focus);
				else select({ row: focus.row + 1, col: focus.col });
				return;
			case "Escape":
				select(null);
				return;
			case "Delete":
			case "Backspace":
				if (columns[focus.col]?.kind === "note" && editable) {
					e.preventDefault();
					void onNote(
						rowKeyAt(focus.row),
						columns[focus.col],
						"",
					).then(setNoteError);
				}
				return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
			e.preventDefault();
			void copy();
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
			e.preventDefault();
			setAnchor({ row: 0, col: 0 });
			setFocus({ row: rowCount - 1, col: columns.length - 1 });
			return;
		}
		// Typing into a note cell starts editing it with what was typed, as
		// in any spreadsheet.
		if (
			e.key.length === 1 &&
			!e.ctrlKey &&
			!e.metaKey &&
			columns[focus.col]?.kind === "note"
		) {
			e.preventDefault();
			startEdit(focus, e.key);
		}
	};

	// --- Column resizing -------------------------------------------------

	const startResize = (column: GridColumn, e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startWidth = width(column);
		let latest = startWidth;
		const move = (ev: PointerEvent) => {
			latest = Math.max(
				48,
				Math.min(800, startWidth + ev.clientX - startX),
			);
			setWidths((w) => ({ ...w, [column.key]: latest }));
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			document.body.style.cursor = "";
			if (latest !== startWidth) onResize(column, latest);
		};
		document.body.style.cursor = "col-resize";
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	// Widths saved to the sheet replace the ones held while dragging.
	useEffect(() => {
		setWidths({});
	}, [columns]);

	// Closed by a press outside it, by Escape, or by focus moving out of it,
	// so its items can be reached with Tab and the arrow keys.
	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setMenu(null);
			scroller.current?.focus();
		};
		window.addEventListener("pointerdown", close);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	// Where everybody else has their cursor, by row and column position.
	const others = useMemo(() => {
		const map = new Map<string, Present[]>();
		for (const p of present) {
			if (p.self || !p.cell) continue;
			const key = `${p.cell.row}\u0000${p.cell.column}`;
			map.set(key, [...(map.get(key) ?? []), p]);
		}
		return map;
	}, [present]);

	const frozenStyle = (i: number) =>
		i < frozen
			? { position: "sticky" as const, left: offsets[i], zIndex: 2 }
			: undefined;

	const items = virtualizer.getVirtualItems();

	return (
		<div className={styles.gridFrame}>
			<div
				ref={scroller}
				className={styles.gridScroller}
				tabIndex={0}
				role="grid"
				aria-rowcount={rowCount}
				aria-colcount={columns.length}
				aria-label="Sheet"
				onKeyDown={onKeyDown}
			>
				<div style={{ width: totalWidth, minWidth: "100%" }}>
					<div
						className={styles.headRow}
						role="row"
						style={{ width: totalWidth }}
					>
						<div
							className={`${styles.gutter} ${styles.headGutter}`}
							aria-hidden="true"
						/>
						{columns.map((c, i) => {
							const sorted =
								sort?.column ===
								(c.kind === "field"
									? c.name
									: c.kind === "formula"
										? c.name
										: c.id);
							return (
								<div
									key={c.key}
									role="columnheader"
									aria-sort={
										sorted
											? sort!.direction === "asc"
												? "ascending"
												: "descending"
											: "none"
									}
									className={`${styles.headCell} ${i === frozen - 1 ? styles.frozenEdge : ""} ${
										range && i >= range.c0 && i <= range.c1
											? styles.headSelected
											: ""
									}`}
									style={{
										width: width(c),
										...frozenStyle(i),
										zIndex: i < frozen ? 4 : 3,
									}}
								>
									<button
										type="button"
										className={styles.headLabel}
										onClick={() => onSort(c)}
										title={
											c.kind === "formula"
												? "Formula column. Click to sort."
												: "Click to sort"
										}
									>
										{c.kind === "formula" && (
											<span className={styles.kindTag}>
												fx
											</span>
										)}
										{c.kind === "note" && (
											<svg
												className={styles.kindIcon}
												width="12"
												height="12"
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
										)}
										<span className={styles.headText}>
											{c.name}
										</span>
										{sorted && (
											<span
												className={styles.sortMark}
												aria-hidden="true"
											>
												{sort!.direction === "asc"
													? "▲"
													: "▼"}
											</span>
										)}
									</button>
									<button
										type="button"
										className={styles.headMenu}
										aria-label={`${c.name} column options`}
										onPointerDown={(e) =>
											e.stopPropagation()
										}
										onClick={(e) => {
											const r = (
												e.currentTarget as HTMLElement
											).getBoundingClientRect();
											setMenu({
												column: c,
												x: r.right,
												y: r.bottom,
											});
										}}
									>
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="currentColor"
											aria-hidden="true"
										>
											<circle cx="12" cy="5" r="1.8" />
											<circle cx="12" cy="12" r="1.8" />
											<circle cx="12" cy="19" r="1.8" />
										</svg>
									</button>
									<span
										className={styles.resizeHandle}
										onPointerDown={(e) => startResize(c, e)}
										role="separator"
										aria-orientation="vertical"
										aria-label={`Resize ${c.name}`}
									/>
								</div>
							);
						})}
					</div>

					<div
						style={{
							height: virtualizer.getTotalSize(),
							position: "relative",
						}}
					>
						{items.map((item) => {
							const r = item.index;
							const key = rowKeyAt(r);
							return (
								<div
									key={item.key}
									role="row"
									className={styles.row}
									style={{
										transform: `translateY(${item.start}px)`,
										width: totalWidth,
									}}
								>
									<div
										className={styles.gutter}
										aria-hidden="true"
									>
										{r + 1}
									</div>
									{columns.map((c, i) => {
										const v = valueAt(r, c);
										const text = displayValue(v, c);
										const selected = inRange(r, i);
										const isFocus =
											focus?.row === r &&
											focus?.col === i;
										const here = others.get(
											`${key}\u0000${c.key}`,
										);
										const numeric =
											c.kind !== "note" &&
											isNumeric(v) &&
											c.hint !== "text";
										if (
											editing &&
											editing.rowKey === key &&
											editing.columnKey === c.key
										) {
											return (
												<div
													key={c.key}
													className={`${styles.cell} ${styles.cellEditing}`}
													style={{
														width: width(c),
														...frozenStyle(i),
													}}
												>
													<textarea
														className={
															styles.noteInput
														}
														autoFocus
														value={editing.text}
														maxLength={4000}
														onChange={(e) =>
															setEditing({
																...editing,
																text: e.target
																	.value,
															})
														}
														onBlur={() =>
															void commit(0)
														}
														onKeyDown={(e) => {
															if (
																e.key ===
																	"Enter" &&
																!e.shiftKey
															) {
																e.preventDefault();
																void commit(1);
															} else if (
																e.key ===
																"Escape"
															) {
																e.preventDefault();
																cancelEdit();
															} else if (
																e.key === "Tab"
															) {
																e.preventDefault();
																void commit(0);
															}
														}}
													/>
												</div>
											);
										}
										return (
											<div
												key={c.key}
												role="gridcell"
												aria-selected={selected}
												className={[
													styles.cell,
													numeric
														? styles.cellNumber
														: "",
													c.kind === "formula"
														? styles.cellFormula
														: "",
													c.kind === "note"
														? styles.cellNote
														: "",
													isError(v)
														? styles.cellError
														: "",
													selected
														? styles.cellSelected
														: "",
													isFocus
														? styles.cellFocus
														: "",
													i === frozen - 1
														? styles.frozenEdge
														: "",
												].join(" ")}
												style={{
													width: width(c),
													...frozenStyle(i),
													...(here
														? {
																boxShadow: `inset 0 0 0 2px ${colourFor(here[0].email)}`,
															}
														: {}),
												}}
												title={
													isError(v)
														? v.detail || v.code
														: text.length > 24
															? text
															: undefined
												}
												onPointerDown={(e) => {
													if (e.button !== 0) return;
													scroller.current?.focus();
													select(
														{ row: r, col: i },
														e.shiftKey,
													);
													dragging.current = true;
												}}
												onPointerEnter={() => {
													if (dragging.current)
														select(
															{ row: r, col: i },
															true,
														);
												}}
												onPointerUp={() => {
													dragging.current = false;
												}}
												onDoubleClick={() =>
													startEdit({
														row: r,
														col: i,
													})
												}
											>
												<span
													className={styles.cellText}
												>
													{text}
												</span>
												{here && (
													<span
														className={
															styles.presenceTag
														}
														style={{
															background:
																colourFor(
																	here[0]
																		.email,
																),
														}}
														title={here
															.map((p) => p.email)
															.join(", ")}
													>
														{initials(
															here[0].email,
														)}
													</span>
												)}
											</div>
										);
									})}
								</div>
							);
						})}
					</div>
				</div>
			</div>

			<div className={styles.statusBar} aria-live="polite">
				<span>
					{rowCount.toLocaleString()}{" "}
					{rowCount === 1 ? "row" : "rows"}
				</span>
				{stats && stats.cells > 1 && (
					<span className={styles.stats}>
						<span>{stats.count.toLocaleString()} filled</span>
						{stats.numbers > 0 && (
							<>
								<span>
									Sum {formatValue(stats.sum, "decimal")}
								</span>
								<span>
									Average{" "}
									{formatValue(
										stats.sum / stats.numbers,
										"decimal",
									)}
								</span>
							</>
						)}
					</span>
				)}
				{noteError && (
					<span className={styles.statusError}>{noteError}</span>
				)}
			</div>

			{menu && (
				<div
					className={styles.menu}
					role="menu"
					style={{ top: menu.y + 4, left: Math.max(8, menu.x - 220) }}
					onPointerDown={(e) => e.stopPropagation()}
					onBlur={(e) => {
						if (
							!e.currentTarget.contains(
								e.relatedTarget as Node | null,
							)
						)
							setMenu(null);
					}}
					onKeyDown={(e) => {
						if (e.key !== "ArrowDown" && e.key !== "ArrowUp")
							return;
						e.preventDefault();
						const items = [
							...e.currentTarget.querySelectorAll<HTMLElement>(
								'[role="menuitem"]',
							),
						];
						const at = items.indexOf(
							document.activeElement as HTMLElement,
						);
						const by = e.key === "ArrowDown" ? 1 : -1;
						items[(at + by + items.length) % items.length]?.focus();
					}}
				>
					{menuFor(menu.column).map((a, i) =>
						a.separator ? (
							<div
								key={`s${i}`}
								className={styles.menuSeparator}
								role="separator"
							/>
						) : (
							<button
								key={a.label}
								type="button"
								role="menuitem"
								autoFocus={i === 0}
								className={`${styles.menuItem} ${a.danger ? styles.menuDanger : ""}`}
								onClick={() => {
									setMenu(null);
									a.onSelect();
								}}
							>
								{a.label}
							</button>
						),
					)}
				</div>
			)}

			{/* Somewhere for the pointer to be let go outside a cell. */}
			<PointerRelease onRelease={() => (dragging.current = false)} />
		</div>
	);
}

function PointerRelease({ onRelease }: { onRelease: () => void }) {
	useEffect(() => {
		window.addEventListener("pointerup", onRelease);
		return () => window.removeEventListener("pointerup", onRelease);
	}, [onRelease]);
	return null;
}

export { colourFor, initials };
