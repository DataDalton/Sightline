"use client";

import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatValue, type FormatHint } from "../../lib/format";
import type { VisualStyle } from "../../lib/visuals/style";
import {
	matchesSelection,
	selectionCovers,
	selectionValue,
	type SelectionPart,
} from "../../lib/visuals/selection";
import { VisualError } from "./VisualFrame";
import { VisualLoadingState } from "./LoadingState";
import { createResultMemo, resultMaxAge } from "./resultMemo";
import { canonical } from "../hooks/canonicalKey";
import { runBatchedQuery } from "../hooks/queryBatch";
import { maxLimit } from "../../lib/query/spec";
import type { FieldMeta } from "./types";
import styles from "./Matrix.module.css";

// The matrix: a hierarchy down the left, a pivoted dimension across the top.
//
// Rows nest through the row dimensions in order, so Year expands into Division
// and Division into Business Unit. Expansion is lazy: opening a node queries
// only that node's children, filtered to its ancestors. Fetching the whole
// tree up front would mean pulling every leaf to show a dozen top-level rows,
// which on these sources is millions of rows to display twelve.
//
// Columns pivot on an optional dimension, with the measures repeated beneath
// each of its values and a rule between groups so one period reads as separate
// from the next.
//
// Only the rows in view are rendered. The table keeps its sticky headers, and
// spacer rows above and below the rendered window stand in for the rest, so
// the scrollbar describes the whole list.

interface MatrixProps {
	sourceKey: string;
	// Ordered outermost first. Year, then Division, then Business Unit.
	rowDimensions: string[];
	// Optional dimension pivoted across the top, such as Quarter.
	columnDimension?: string | null;
	measures: string[];
	baseFilters?: unknown[];
	fields: Map<string, FieldMeta>;
	height?: number;
	style?: VisualStyle;
	// Fires when a reader clicks a row's label, with the row's value and the
	// values of every level above it, so a business unit is selected inside
	// the division it sits under rather than across all of them. Fires with
	// the pivoted field alone when a column heading is clicked.
	onSelect?: (selection: SelectionPart[]) => void;
	// The page selection this matrix made, so its rows or columns stay solid
	// and the rest fade.
	selection?: SelectionPart[];
}

interface FilterClause {
	field: string;
	op: string;
	value?: string;
	values?: string[];
}

interface MatrixRow {
	// Ancestor values, outermost first. Identifies the node and provides the
	// filter that scopes its children.
	path: string[];
	label: string;
	depth: number;
	// The row values behind the path as the query returned them, which is
	// what a click on the row filters by.
	raws: unknown[];
	// Values keyed by "columnValue||measure", or by measure alone when there is
	// no pivoted column.
	values: Record<string, unknown>;
	hasChildren: boolean;
}

// One line of the rendered body. Either a data row, or the row that reveals
// the next batch of an expanded node's children.
type DisplayItem =
	| { kind: "row"; key: string; row: MatrixRow }
	| {
			kind: "more";
			key: string;
			parentKey: string;
			depth: number;
			remaining: number;
	  };

// How many children an expanded node shows at first, and how many more each
// press of "Show more" reveals. A node with thousands of children would
// otherwise push its siblings out of reach of the scrollbar.
const childBatch = 200;

// A row's rendered height before it has been measured.
const estimatedRowHeight = 33;

function cellKey(columnValue: string | null, measure: string): string {
	return columnValue === null ? measure : `${columnValue}||${measure}`;
}

function pathKey(path: string[]): string {
	return path.join("||");
}

// Whether `row` sits anywhere beneath the node at `parentPath`.
function isDescendant(row: MatrixRow, parentPath: string[]): boolean {
	return (
		row.path.length > parentPath.length &&
		pathKey(row.path.slice(0, parentPath.length)) === pathKey(parentPath)
	);
}

// Whether a node key belongs to `key` itself or to anything beneath it.
function underKey(candidate: string, key: string): boolean {
	return candidate === key || candidate.startsWith(`${key}||`);
}

// The column groups already on screen plus any a new level brought, sorted.
// Returns the same array when nothing is new, so state does not change.
function mergeColumnValues(current: string[], added: string[]): string[] {
	if (added.every((value) => current.includes(value))) return current;
	return Array.from(new Set([...current, ...added])).sort();
}

// The rows in display order with a "Show more" line placed after the last
// visible descendant of every node that still holds children back.
function buildItems(
	rows: MatrixRow[],
	remainder: Map<string, MatrixRow[]>,
): DisplayItem[] {
	const items: DisplayItem[] = [];
	// Open nodes with children still held back, innermost last.
	const open: MatrixRow[] = [];

	const close = (parent: MatrixRow) => {
		const parentKey = pathKey(parent.path);
		items.push({
			kind: "more",
			key: `more:${parentKey}`,
			parentKey,
			depth: parent.depth + 1,
			remaining: remainder.get(parentKey)?.length ?? 0,
		});
	};

	for (const row of rows) {
		while (
			open.length > 0 &&
			!isDescendant(row, open[open.length - 1].path)
		) {
			close(open.pop() as MatrixRow);
		}
		const key = pathKey(row.path);
		items.push({ kind: "row", key, row });
		if (remainder.has(key)) open.push(row);
	}
	while (open.length > 0) close(open.pop() as MatrixRow);
	return items;
}

// The top level of each matrix, kept across mounts, so returning to a report
// does not re-ask for the rows the reader just waited for.
interface TopLevel {
	rows: MatrixRow[];
	columnValues: string[];
}

const topLevels = createResultMemo<TopLevel>(40, resultMaxAge);

export function MatrixTable({
	sourceKey,
	rowDimensions,
	columnDimension,
	measures,
	baseFilters = [],
	fields,
	height = 520,
	style,
	onSelect,
	selection,
}: MatrixProps) {
	const [rows, setRows] = useState<MatrixRow[]>([]);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
	// Children fetched but not yet shown, keyed by the parent's path key.
	const [remainder, setRemainder] = useState<Map<string, MatrixRow[]>>(
		new Map(),
	);
	const [columnValues, setColumnValues] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<(Error & { status?: number }) | null>(
		null,
	);

	const baseKey = JSON.stringify(baseFilters);

	// The field lists by content, so the memoised rows below are not all
	// re-rendered when the page hands over an equal but new array.
	const rowDimensionKey = JSON.stringify(rowDimensions);
	const measureKey = JSON.stringify(measures);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const rowFields = useMemo(() => rowDimensions, [rowDimensionKey]);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const measureFields = useMemo(() => measures, [measureKey]);

	// Advanced whenever the top level reloads, so an expansion that started
	// against the previous query shape can tell its answer no longer applies.
	const generation = useRef(0);

	// Fetches one level completely, the children of `path` or the top level
	// when empty. The level is read page by page until a page comes back
	// short, so no row and no column cell is left out however many
	// combinations the level holds. The pivoted column values it saw come
	// back with the rows rather than going into state here, so a caller whose
	// request was superseded can discard both. isCurrent is checked before
	// every page after the first, so a superseded load stops asking.
	const fetchLevel = useCallback(
		async (
			path: string[],
			parentRaws: unknown[],
			isCurrent: () => boolean,
		): Promise<{ rows: MatrixRow[]; columnValues: string[] }> => {
			const depth = path.length;
			const dimension = rowDimensions[depth];
			if (!dimension) return { rows: [], columnValues: [] };

			// Scope to the ancestors, so expanding "2025 / Medical" asks only
			// for business units inside it.
			const scope: FilterClause[] = [
				...(baseFilters as FilterClause[]),
				// A blank ancestor is a null or an empty value, which an
				// equality on its empty label would not match.
				...path.map((value, i): FilterClause => {
					const raw = parentRaws[i];
					return raw === null || raw === undefined || raw === ""
						? { field: rowDimensions[i], op: "is_empty" }
						: {
								field: rowDimensions[i],
								op: "eq",
								values: [value],
							};
				}),
			];

			// Sorted by every grouped dimension, so each combination has one
			// fixed position and consecutive pages neither repeat nor skip one.
			const sort: { field: string; direction: "asc" }[] = [
				{ field: dimension, direction: "asc" },
			];
			if (columnDimension) {
				sort.push({ field: columnDimension, direction: "asc" });
			}

			// Collapse the pivoted dimension into one row per row-value, with
			// the measures spread across the column groups. Both maps live
			// across pages, so a row label whose cells straddle a page
			// boundary is still merged into one row.
			const byLabel = new Map<string, MatrixRow>();
			const seenColumns = new Set<string>();

			for (let offset = 0; ; offset += maxLimit) {
				if (offset > 0 && !isCurrent()) break;
				const data = await runBatchedQuery(
					canonical({
						sourceKey,
						dimensions: columnDimension
							? [dimension, columnDimension]
							: [dimension],
						measures,
						filters: scope,
						sort,
						limit: maxLimit,
						offset,
					}),
				);
				const page: Record<string, unknown>[] = data.rows ?? [];
				for (const record of page) {
					const label = String(record[dimension] ?? "");
					const columnValue = columnDimension
						? String(record[columnDimension] ?? "")
						: null;
					if (columnValue !== null) seenColumns.add(columnValue);

					let row = byLabel.get(label);
					if (!row) {
						row = {
							path: [...path, label],
							raws: [...parentRaws, record[dimension]],
							label,
							depth,
							values: {},
							// A node has children whenever another row dimension
							// remains below it.
							hasChildren: depth + 1 < rowDimensions.length,
						};
						byLabel.set(label, row);
					}
					for (const measure of measures) {
						row.values[cellKey(columnValue, measure)] =
							record[measure];
					}
				}
				if (page.length < maxLimit) break;
			}

			return {
				rows: Array.from(byLabel.values()),
				columnValues: columnDimension ? Array.from(seenColumns) : [],
			};
		},
		[sourceKey, rowDimensions, columnDimension, measures, baseFilters],
	);

	// Everything that shapes the top level, which is what makes a remembered
	// one still the right answer.
	const topKey = `${sourceKey}|${baseKey}|${rowDimensions.join(
		",",
	)}|${columnDimension ?? ""}|${measures.join(",")}`;

	// Reload from the top whenever the query shape changes.
	useEffect(() => {
		let cancelled = false;
		generation.current += 1;
		setError(null);
		setExpanded(new Set());
		setRemainder(new Map());

		// Straight back on screen if this matrix has been opened before. Only
		// the top level: an expanded subtree is deliberately discarded on
		// collapse so a later expansion cannot show stale figures, and holding
		// it here would be the same staleness by another route.
		const remembered = topLevels.get(topKey);
		if (remembered) {
			setRows(remembered.rows);
			setColumnValues(remembered.columnValues);
			setLoading(false);
			return;
		}

		setLoading(true);
		setColumnValues([]);

		fetchLevel([], [], () => !cancelled)
			.then((top) => {
				if (cancelled) return;
				setRows(top.rows);
				setLoading(false);
				// Merged into state rather than replacing it, and read back
				// from the merge so the remembered level carries the same
				// column groups the screen does.
				setColumnValues((prev) => {
					const merged = mergeColumnValues(prev, top.columnValues);
					topLevels.set(topKey, {
						rows: top.rows,
						columnValues: merged,
					});
					return merged;
				});
			})
			.catch((e) => {
				if (cancelled) return;
				setError(e as Error & { status?: number });
				setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [topKey]);

	const toggle = async (row: MatrixRow) => {
		const key = pathKey(row.path);

		if (expanded.has(key)) {
			// Collapsing removes the subtree rather than hiding it, so a later
			// expansion refetches and cannot show stale figures. Everything
			// open or held back beneath it goes too, so reopening starts
			// every level closed.
			setExpanded((prev) => {
				const next = new Set<string>();
				for (const open of prev) {
					if (!underKey(open, key)) next.add(open);
				}
				return next;
			});
			setRemainder((prev) => {
				const next = new Map<string, MatrixRow[]>();
				for (const [held, children] of prev) {
					if (!underKey(held, key)) next.set(held, children);
				}
				return next;
			});
			setRows((prev) => prev.filter((r) => !isDescendant(r, row.path)));
			return;
		}

		// A second press while the children are still loading would insert
		// them twice.
		if (loadingPaths.has(key)) return;

		setLoadingPaths((prev) => new Set(prev).add(key));
		const startedIn = generation.current;
		try {
			const { rows: children, columnValues: childColumns } =
				await fetchLevel(
					row.path,
					row.raws,
					() => startedIn === generation.current,
				);
			if (startedIn !== generation.current) return;
			// Column groups accumulate across expansions, so a child that
			// introduces a period the parent lacked still lines up.
			setColumnValues((prev) => mergeColumnValues(prev, childColumns));
			const shown = children.slice(0, childBatch);
			const held = children.slice(childBatch);
			setRows((prev) => {
				const index = prev.findIndex((r) => pathKey(r.path) === key);
				if (index < 0) return prev;
				const next = [...prev];
				next.splice(index + 1, 0, ...shown);
				return next;
			});
			if (held.length > 0) {
				setRemainder((prev) => new Map(prev).set(key, held));
			}
			setExpanded((prev) => new Set(prev).add(key));
		} catch (e) {
			if (startedIn !== generation.current) return;
			setError(e as Error & { status?: number });
		} finally {
			setLoadingPaths((prev) => {
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
		}
	};

	// Moves the next batch of a node's held-back children into view, after
	// the last row currently shown beneath it.
	const showMore = (parentKey: string) => {
		const held = remainder.get(parentKey);
		if (!held || held.length === 0) return;
		const batch = held.slice(0, childBatch);
		const rest = held.slice(childBatch);
		setRows((prev) => {
			const index = prev.findIndex((r) => pathKey(r.path) === parentKey);
			if (index < 0) return prev;
			const parentPath = prev[index].path;
			let end = index + 1;
			while (end < prev.length && isDescendant(prev[end], parentPath)) {
				end += 1;
			}
			const next = [...prev];
			next.splice(end, 0, ...batch);
			return next;
		});
		setRemainder((prev) => {
			const next = new Map(prev);
			if (rest.length > 0) next.set(parentKey, rest);
			else next.delete(parentKey);
			return next;
		});
	};

	const collapseAll = () => {
		setExpanded(new Set());
		setRemainder(new Map());
		setRows((prev) => prev.filter((r) => r.depth === 0));
	};

	// The handlers read the latest state through refs, so the rows can be
	// memoised against stable callbacks and skip re-rendering when an
	// unrelated row opens or loads.
	const handlers = useRef({ toggle, showMore, onSelect });
	useLayoutEffect(() => {
		handlers.current = { toggle, showMore, onSelect };
	});
	const onToggle = useCallback(
		(row: MatrixRow) => void handlers.current.toggle(row),
		[],
	);
	const onSelectParts = useCallback(
		(parts: SelectionPart[]) => handlers.current.onSelect?.(parts),
		[],
	);

	const hints = useMemo(() => {
		const map = new Map<string, FormatHint>();
		for (const measure of measureFields) {
			map.set(
				measure,
				(fields.get(measure)?.formatHint as FormatHint) ?? "decimal",
			);
		}
		return map;
	}, [measureFields, fields]);

	// One column group per pivoted value, or a single unnamed group.
	const groups = useMemo<(string | null)[]>(
		() =>
			columnDimension && columnValues.length > 0 ? columnValues : [null],
		[columnDimension, columnValues],
	);

	// Formatted cells per row, computed once for each row object and kept
	// until the columns or their formats change. A row keeps its identity
	// while others open and close around it, so scrolling and expanding do
	// not re-format rows that were already drawn.
	const formatted = useMemo(() => {
		const cache = new WeakMap<MatrixRow, string[]>();
		return (row: MatrixRow): string[] => {
			let cells = cache.get(row);
			if (!cells) {
				cells = [];
				for (const group of groups) {
					for (const measure of measureFields) {
						cells.push(
							formatValue(
								row.values[cellKey(group, measure)],
								hints.get(measure) ?? "decimal",
							),
						);
					}
				}
				cache.set(row, cells);
			}
			return cells;
		};
	}, [groups, measureFields, hints]);

	// The page selection is rebuilt on every render upstream, so it is keyed
	// by its content to keep the marking below stable.
	const selectionKey = JSON.stringify(selection ?? null);

	// The selection when it is about this matrix's row fields.
	const marking = useMemo(
		() => (selectionCovers(selection, rowFields) ? selection : null),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[selectionKey, rowFields],
	);

	// Whether each column group is inside the selection, or null when the
	// selection is not about the pivoted field.
	const columnChosen = useMemo(() => {
		if (!columnDimension) return null;
		if (!selectionCovers(selection, [columnDimension])) return null;
		const parts = selection;
		return groups.map((group) =>
			group === null
				? true
				: matchesSelection(parts, { [columnDimension]: group }),
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectionKey, columnDimension, groups]);

	const items = useMemo(() => buildItems(rows, remainder), [rows, remainder]);

	// How far down the second header row has to sit: the height of the row
	// above it, or nothing when that row is not rendered. Measured rather than
	// assumed, because assuming it is what left a gap for the body to scroll
	// through on every matrix without a pivot. The whole header's height is
	// where the body starts inside the scroller, which the virtualizer needs
	// to place rows and to scroll one into view below the sticky header.
	const groupRowRef = useRef<HTMLTableRowElement | null>(null);
	const headRef = useRef<HTMLTableSectionElement | null>(null);
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const [stackOffset, setStackOffset] = useState(0);
	const [headHeight, setHeadHeight] = useState(0);

	useLayoutEffect(() => {
		setStackOffset(groupRowRef.current?.offsetHeight ?? 0);
		setHeadHeight(headRef.current?.offsetHeight ?? 0);
	}, [columnDimension, columnValues.length, measures.length, loading]);

	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollerRef.current,
		estimateSize: () => estimatedRowHeight,
		getItemKey: (index) => items[index]?.key ?? index,
		overscan: 12,
		scrollMargin: headHeight,
		scrollPaddingStart: headHeight,
	});

	// A row to focus once it has been rendered, for keyboard moves that
	// scroll further than the rows already drawn.
	const pendingFocus = useRef<{ index: number; role: string } | null>(null);

	const tryFocus = useCallback((index: number, role: string): boolean => {
		const row = scrollerRef.current?.querySelector(
			`tr[data-index="${index}"]`,
		);
		if (!row) return false;
		// A row with no control of that kind, such as a leaf when the
		// matrix does not cross-filter, takes the focus itself so the arrow
		// keys keep working from it.
		const target =
			row.querySelector<HTMLElement>(`[data-role="${role}"]`) ??
			row.querySelector<HTMLElement>("button") ??
			(row as HTMLElement);
		target.focus({ preventScroll: true });
		return true;
	}, []);

	const focusItem = (index: number, role: string) => {
		if (index < 0 || index >= items.length) return;
		virtualizer.scrollToIndex(index, { align: "auto" });
		pendingFocus.current = tryFocus(index, role) ? null : { index, role };
	};

	useEffect(() => {
		const pending = pendingFocus.current;
		if (pending && tryFocus(pending.index, pending.role)) {
			pendingFocus.current = null;
		}
	});

	// Arrow keys move between rows, right opens a node or steps into it, and
	// left closes it or steps out to its parent. The control focused on the
	// new row matches the one that was focused, so moving down a column of
	// labels stays on labels.
	const onBodyKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		const target = event.target as HTMLElement;
		const rowElement = target.closest<HTMLElement>("tr[data-index]");
		if (!rowElement) return;
		if (target.tagName !== "BUTTON" && target !== rowElement) return;
		const index = Number(rowElement.dataset.index);
		const role = target.dataset.role ?? "label";
		const item = items[index];
		if (!item) return;

		switch (event.key) {
			case "ArrowDown":
				focusItem(index + 1, role === "more" ? "label" : role);
				break;
			case "ArrowUp":
				focusItem(index - 1, role === "more" ? "label" : role);
				break;
			case "Home":
				focusItem(0, "label");
				break;
			case "End":
				focusItem(items.length - 1, "label");
				break;
			case "ArrowRight": {
				if (item.kind !== "row" || !item.row.hasChildren) return;
				if (expanded.has(item.key)) focusItem(index + 1, role);
				else void toggle(item.row);
				break;
			}
			case "ArrowLeft": {
				if (item.kind === "row" && expanded.has(item.key)) {
					void toggle(item.row);
					break;
				}
				const depth = item.kind === "row" ? item.row.depth : item.depth;
				for (let i = index - 1; i >= 0; i--) {
					const above = items[i];
					if (above.kind === "row" && above.row.depth < depth) {
						focusItem(i, role === "more" ? "label" : role);
						break;
					}
				}
				break;
			}
			default:
				return;
		}
		event.preventDefault();
	};

	if (error && rows.length === 0) return <VisualError error={error} />;
	if (loading) {
		return (
			<VisualLoadingState
				variant={style?.loadingAnimation}
				label="Loading matrix"
				height={height}
			/>
		);
	}
	if (rows.length === 0) {
		return (
			<div className={styles.state}>
				No rows match the current filters
			</div>
		);
	}

	const columnCount = 1 + groups.length * measures.length;
	const virtualItems = virtualizer.getVirtualItems();
	const totalSize = virtualizer.getTotalSize();
	const paddingTop =
		virtualItems.length > 0 ? virtualItems[0].start - headHeight : 0;
	const paddingBottom =
		virtualItems.length > 0
			? totalSize -
				(virtualItems[virtualItems.length - 1].end - headHeight)
			: 0;

	const selectColumn = (group: string) => {
		if (!columnDimension) return;
		onSelect?.([
			{ field: columnDimension, values: [selectionValue(group)] },
		]);
	};

	return (
		<div className={styles.matrix} style={{ height }}>
			<div className={styles.toolbar}>
				<button
					type="button"
					className={styles.toolButton}
					onClick={collapseAll}
				>
					Collapse all
				</button>
				<div className={styles.spacer} />
				<span className={styles.hint}>
					{rowDimensions.join(" › ")}
					{columnDimension ? ` by ${columnDimension}` : ""}
				</span>
			</div>

			<div className={styles.scroller} ref={scrollerRef}>
				<table
					className={styles.table}
					style={
						{
							"--matrix-stack": `${stackOffset}px`,
						} as React.CSSProperties
					}
				>
					<thead ref={headRef}>
						{columnDimension && (
							<tr
								className={styles.groupHeader}
								ref={groupRowRef}
							>
								<th className={styles.rowHeader} rowSpan={2}>
									{rowDimensions[0]}
								</th>
								{groups.map((group, g) => {
									const chosen = columnChosen?.[g] ?? false;
									const dimmed =
										columnChosen !== null && !chosen;
									return (
										<th
											key={group ?? "all"}
											colSpan={measures.length}
											className={`${styles.groupStart} ${
												chosen
													? styles.columnChosen
													: ""
											} ${dimmed ? styles.columnDimmed : ""}`}
										>
											{onSelect && group !== null ? (
												<button
													type="button"
													className={
														styles.columnButton
													}
													onClick={() =>
														selectColumn(group)
													}
													aria-pressed={chosen}
													title={`Filter the page to ${group || "blank"}`}
												>
													{group}
												</button>
											) : (
												group
											)}
										</th>
									);
								})}
							</tr>
						)}
						<tr className={styles.measureHeader}>
							{!columnDimension && (
								<th className={styles.rowHeader}>
									{rowDimensions[0]}
								</th>
							)}
							{groups.map((group, g) =>
								measures.map((measure, i) => (
									<th
										key={`${group ?? "all"}-${measure}`}
										className={`${
											i === 0 ? styles.groupStart : ""
										} ${
											columnChosen !== null &&
											!columnChosen[g]
												? styles.columnDimmed
												: ""
										}`}
										title={
											fields.get(measure)?.description ??
											measure
										}
									>
										{measure}
									</th>
								)),
							)}
						</tr>
					</thead>
					<tbody onKeyDown={onBodyKeyDown}>
						{paddingTop > 0 && (
							<tr aria-hidden="true" className={styles.spacerRow}>
								<td
									colSpan={columnCount}
									style={{ height: paddingTop }}
								/>
							</tr>
						)}
						{virtualItems.map((virtual) => {
							const item = items[virtual.index];
							if (!item) return null;
							if (item.kind === "more") {
								return (
									<MoreRow
										key={item.key}
										index={virtual.index}
										item={item}
										columnCount={columnCount}
										measure={virtualizer.measureElement}
										onShowMore={() => {
											handlers.current.showMore(
												item.parentKey,
											);
											// The first revealed row takes the
											// place the button was in, and is
											// focused once it has rendered.
											pendingFocus.current = {
												index: virtual.index,
												role: "label",
											};
										}}
									/>
								);
							}
							const row = item.row;
							const chosen =
								marking !== null &&
								matchesSelection(
									marking,
									Object.fromEntries(
										row.raws.map((raw, i) => [
											rowDimensions[i],
											raw,
										]),
									),
								);
							return (
								<BodyRow
									key={item.key}
									index={virtual.index}
									row={row}
									rowDimensions={rowFields}
									cells={formatted(row)}
									measureCount={measures.length}
									columnChosen={columnChosen}
									isOpen={expanded.has(item.key)}
									isLoading={loadingPaths.has(item.key)}
									chosen={chosen}
									dimmed={marking !== null && !chosen}
									selectable={Boolean(onSelect)}
									onToggle={onToggle}
									onSelect={onSelectParts}
									measure={virtualizer.measureElement}
								/>
							);
						})}
						{paddingBottom > 0 && (
							<tr aria-hidden="true" className={styles.spacerRow}>
								<td
									colSpan={columnCount}
									style={{ height: paddingBottom }}
								/>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</div>
	);
}

interface BodyRowProps {
	index: number;
	row: MatrixRow;
	rowDimensions: string[];
	cells: string[];
	measureCount: number;
	columnChosen: boolean[] | null;
	isOpen: boolean;
	isLoading: boolean;
	chosen: boolean;
	dimmed: boolean;
	selectable: boolean;
	onToggle: (row: MatrixRow) => void;
	onSelect: (parts: SelectionPart[]) => void;
	measure: (element: Element | null) => void;
}

// One data row. Memoised so a row re-renders only when something it draws has
// changed, rather than whenever any other row opens, loads or is scrolled in.
const BodyRow = memo(function BodyRow({
	index,
	row,
	rowDimensions,
	cells,
	measureCount,
	columnChosen,
	isOpen,
	isLoading,
	chosen,
	dimmed,
	selectable,
	onToggle,
	onSelect,
	measure,
}: BodyRowProps) {
	return (
		<tr
			data-index={index}
			ref={measure}
			tabIndex={-1}
			className={`${styles.row} ${
				styles[`level${Math.min(row.depth, 3)}`] ?? ""
			} ${chosen ? styles.rowChosen : ""} ${
				dimmed ? styles.rowDimmed : ""
			}`}
		>
			<td
				className={styles.labelCell}
				style={{
					paddingLeft: 12 + row.depth * 18,
				}}
			>
				{row.hasChildren ? (
					<button
						type="button"
						data-role="expander"
						className={`${styles.expander} ${
							isOpen ? styles.expanderOpen : ""
						}`}
						onClick={() => onToggle(row)}
						aria-expanded={isOpen}
						aria-label={`${isOpen ? "Collapse" : "Expand"} ${row.label}`}
					>
						{isLoading ? (
							<span className={styles.hint}>·</span>
						) : (
							<svg
								width="11"
								height="11"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="3"
								strokeLinecap="round"
							>
								<path d="M9 6l6 6-6 6" />
							</svg>
						)}
					</button>
				) : (
					<span className={styles.leafSpacer} />
				)}
				{selectable ? (
					<button
						type="button"
						data-role="label"
						className={styles.labelButton}
						onClick={() =>
							onSelect(
								row.raws.map((raw, i) => ({
									field: rowDimensions[i],
									values: [selectionValue(raw)],
								})),
							)
						}
						aria-pressed={chosen}
						title={`Filter the page to ${row.label}`}
					>
						{row.label}
					</button>
				) : (
					row.label
				)}
			</td>

			{cells.map((text, c) => {
				const group = Math.floor(c / measureCount);
				const columnDimmed =
					columnChosen !== null && !columnChosen[group];
				return (
					<td
						key={c}
						className={`${styles.cell} ${
							c % measureCount === 0 ? styles.groupStart : ""
						} ${columnDimmed ? styles.cellDimmed : ""}`}
					>
						{text}
					</td>
				);
			})}
		</tr>
	);
});

// The line under an expanded node that still holds children back.
function MoreRow({
	index,
	item,
	columnCount,
	measure,
	onShowMore,
}: {
	index: number;
	item: Extract<DisplayItem, { kind: "more" }>;
	columnCount: number;
	measure: (element: Element | null) => void;
	onShowMore: () => void;
}) {
	const next = Math.min(childBatch, item.remaining);
	return (
		<tr
			data-index={index}
			ref={measure}
			tabIndex={-1}
			className={styles.moreRow}
		>
			<td
				className={styles.labelCell}
				style={{ paddingLeft: 12 + item.depth * 18 }}
			>
				<span className={styles.leafSpacer} />
				<button
					type="button"
					data-role="more"
					className={styles.moreButton}
					onClick={onShowMore}
				>
					Show {next} more
				</button>
				<span className={styles.moreCount}>
					{item.remaining} not shown
				</span>
			</td>
			{columnCount > 1 && (
				<td className={styles.moreFill} colSpan={columnCount - 1} />
			)}
		</tr>
	);
}
