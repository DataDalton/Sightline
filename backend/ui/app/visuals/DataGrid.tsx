"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { maxExportRows } from "../../lib/query/exportLimits";
import { createResultMemo, resultMaxAgeMs } from "./resultMemo";
import { useExport } from "../hooks/useExport";
import {
	formatValue,
	isNumericHint,
	toNumber,
	type FormatHint,
} from "../../lib/format";
import {
	evaluateConditions,
	scalePosition,
	type VisualStyle,
} from "../../lib/visuals/style";
import { readThemeColors, mix, withAlpha } from "./colors";
import { ColumnFilter } from "./ColumnFilter";
import { VisualError } from "./VisualFrame";
import type { FieldMeta } from "./types";
import styles from "./DataGrid.module.css";

// The detail grid.
//
// Rows are fetched a page at a time and only the visible ones are rendered, so
// the cost of showing a large result is bounded by the viewport rather than by
// the row count. Paging is triggered by an IntersectionObserver on a sentinel
// below the last row: watching an element enter view is cheaper and steadier
// than measuring scrollTop on every scroll event.
//
// Sorting and filtering are server-side by necessity. The client holds a
// window of the result, so sorting what is loaded would order a sample rather
// than the data.

interface DataGridProps {
	sourceKey: string;
	dimensions: string[];
	measures: string[];
	baseFilters?: unknown[];
	fields: Map<string, FieldMeta>;
	pageSize?: number;
	// How tall a row is. An author's judgement about the data rather than a
	// reader preference, so it travels with the visual.
	density?: GridDensity;
	// A number, or "100%" when an enclosing layout has already decided.
	height?: number | string;
	reportId?: string | null;
	pageId?: string | null;
	visualId?: string | null;
	style?: VisualStyle;
	// The reader's own column arrangement. Held by the page rather than here
	// so a saved view can carry it, which is the only way it survives a
	// reload.
	columnOrder?: string[];
	pinnedColumns?: string[];
	onColumnLayout?: (next: {
		columnOrder: string[];
		pinnedColumns: string[];
	}) => void;
}

interface SortState {
	field: string;
	direction: "asc" | "desc";
}

interface QueryFilterShape {
	field: string;
	op: string;
	value?: string;
	values?: string[];
}

// Row heights the author can pick between.
//
// Not a reader preference and not resolution dependent: it is a judgement about
// the data. A row of short codes reads fine at the tighter height and fits half
// again as many on a screen, and a row of long names does not.
const rowHeights = { comfortable: 34, compact: 26 } as const;
export type GridDensity = keyof typeof rowHeights;
const minColumnWidth = 130;
const maxColumnWidth = 260;

// Width is estimated from the header and the kind of value, since measuring
// every cell would mean rendering them all, which virtualization exists to
// avoid.
function columnWidth(name: string, hint: FormatHint): number {
	const base = name.length * 8 + 56;
	const forKind = isNumericHint(hint) ? 140 : 180;
	return Math.min(Math.max(base, forKind, minColumnWidth), maxColumnWidth);
}

// The first page of each query, kept across mounts.
//
// Only the first page. Later pages are cheap to re-fetch and rarely still
// wanted, and holding all of them would keep whole result sets alive for a
// report nobody has open.
interface FirstPage {
	rows: Record<string, unknown>[];
	columns: string[];
	hasMore: boolean;
}

const firstPages = createResultMemo<FirstPage>(40, resultMaxAgeMs);

export function DataGrid({
	sourceKey,
	dimensions,
	measures,
	baseFilters = [],
	fields,
	pageSize = 200,
	density = "comfortable",
	height = 520,
	reportId,
	pageId,
	visualId,
	style,
	columnOrder,
	pinnedColumns,
	onColumnLayout,
}: DataGridProps) {
	const [rows, setRows] = useState<Record<string, unknown>[]>([]);
	// Seeded from the fields the visual is defined with, not left empty until
	// the first response. The placeholder is drawn from these, so an empty list
	// means a skeleton of no columns inside a container of no width, which is
	// invisible and lets the table appear all at once instead. The server
	// replaces it with what it actually returned.
	const [columns, setColumns] = useState<string[]>(() => [
		...dimensions,
		...measures,
	]);
	const [sort, setSort] = useState<SortState | null>(null);
	const [columnFilters, setColumnFilters] = useState<
		Record<string, string[]>
	>({});
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [hasMore, setHasMore] = useState(true);
	const [error, setError] = useState<(Error & { status?: number }) | null>(
		null,
	);
	const [openFilter, setOpenFilter] = useState<{
		field: string;
		x: number;
		y: number;
	} | null>(null);

	// Column arrangement. Mirrored locally so a drag feels immediate, and
	// pushed up so the page can save it.
	const [order, setOrder] = useState<string[]>(columnOrder ?? []);
	const [pinned, setPinned] = useState<string[]>(pinnedColumns ?? []);
	const [drag, setDrag] = useState<{
		column: string;
		isPinned: boolean;
		// Where in its group the column would land.
		index: number;
		// Where to draw the line, in grid coordinates.
		indicator: number;
		// Left edge of the moving band, in grid coordinates. Horizontal only:
		// a column can only change its place in a row, so following the cursor
		// vertically would suggest a move that is not on offer.
		ghostLeft: number;
		// Set on release, while the band travels to where it landed.
		settling: boolean;
	} | null>(null);

	useEffect(() => {
		setOrder(columnOrder ?? []);
	}, [JSON.stringify(columnOrder ?? [])]);
	useEffect(() => {
		setPinned(pinnedColumns ?? []);
	}, [JSON.stringify(pinnedColumns ?? [])]);

	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	// Guards against a second page being requested while one is in flight, and
	// against a stale response overwriting a newer query.
	const requestRef = useRef(0);
	// Read inside the fetch, which resolves after the key may have moved on.
	const queryKeyRef = useRef("");

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSearch(search), 300);
		return () => clearTimeout(timer);
	}, [search]);

	// Free-text search maps to a contains filter across the dimensions on show,
	// which is what a reader means by "find this".
	const activeFilters = useMemo(() => {
		const result: QueryFilterShape[] = [
			...(baseFilters as QueryFilterShape[]),
		];

		for (const [field, values] of Object.entries(columnFilters)) {
			if (values.length > 0) result.push({ field, op: "eq", values });
		}

		if (debouncedSearch.trim() !== "" && dimensions.length > 0) {
			result.push({
				field: dimensions[0],
				op: "contains",
				value: debouncedSearch.trim(),
			});
		}
		return result;
	}, [baseFilters, columnFilters, debouncedSearch, dimensions]);

	const filterKey = JSON.stringify(activeFilters);
	const sortKey = sort ? `${sort.field}:${sort.direction}` : "";

	// Everything that shapes the query, which is exactly what makes a
	// remembered page still the right answer.
	const queryKey = `${sourceKey}|${dimensions.join(",")}|${measures.join(
		",",
	)}|${filterKey}|${sortKey}|${pageSize}`;
	queryKeyRef.current = queryKey;

	const fetchPage = useCallback(
		async (offset: number, replace: boolean) => {
			const token = ++requestRef.current;
			if (replace) setLoading(true);
			else setLoadingMore(true);
			setError(null);

			try {
				const response = await fetch("/api/query", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sourceKey,
						dimensions,
						measures,
						filters: activeFilters,
						sort: sort
							? [{ field: sort.field, direction: sort.direction }]
							: [],
						limit: pageSize,
						offset,
					}),
				});

				if (!response.ok) {
					const detail = await response.json().catch(() => null);
					const err: Error & { status?: number } = new Error(
						detail?.error ?? `Query failed (${response.status})`,
					);
					err.status = response.status;
					throw err;
				}

				const data = await response.json();
				// A newer request has since been issued, so this result is
				// already obsolete.
				if (token !== requestRef.current) return;

				setColumns(data.columns ?? []);
				setRows((prev) =>
					replace ? data.rows : [...prev, ...data.rows],
				);
				// A short page means the end of the result.
				const more = (data.rows?.length ?? 0) >= pageSize;
				setHasMore(more);

				if (replace) {
					firstPages.set(queryKeyRef.current, {
						rows: data.rows ?? [],
						columns: data.columns ?? [],
						hasMore: more,
					});
				}
			} catch (e) {
				if (token !== requestRef.current) return;
				setError(e as Error & { status?: number });
				setHasMore(false);
			} finally {
				if (token === requestRef.current) {
					setLoading(false);
					setLoadingMore(false);
				}
			}
		},
		[sourceKey, dimensions, measures, activeFilters, sort, pageSize],
	);

	// Any change to the query shape restarts from the first page and returns
	// the scroller to the top, so the user is not left mid-way through a
	// result they are no longer looking at.
	useEffect(() => {
		scrollerRef.current?.scrollTo({ top: 0 });

		// Straight back on screen if this exact query has been answered before,
		// with no request and no placeholder. The server caches the answer too,
		// but a round trip is still a round trip.
		const remembered = firstPages.get(queryKey);
		if (remembered) {
			setRows(remembered.rows);
			setColumns(remembered.columns);
			setHasMore(remembered.hasMore);
			setLoading(false);
			return;
		}

		setRows([]);
		setHasMore(true);
		void fetchPage(0, true);
		// fetchPage changes with the query shape, which is exactly when a
		// reload is wanted.
		// queryKey is these five combined, so it is the whole dependency.
	}, [queryKey]);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollerRef.current,
		estimateSize: () => rowHeights[density],
		overscan: 12,
	});

	// Paging is driven by the sentinel becoming visible rather than by scroll
	// position arithmetic, which keeps it correct when rows vary in height and
	// when the container resizes.
	useEffect(() => {
		const sentinel = sentinelRef.current;
		const scroller = scrollerRef.current;
		if (!sentinel || !scroller || !hasMore || loading) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (
					entries[0]?.isIntersecting &&
					!loadingMore &&
					hasMore &&
					rows.length > 0
				) {
					void fetchPage(rows.length, false);
				}
			},
			// Start the next page slightly before the sentinel is reached, so
			// the rows are usually there by the time the user arrives.
			{ root: scroller, rootMargin: "300px" },
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMore, loading, loadingMore, rows.length, fetchPage]);

	const hints = useMemo(() => {
		const map = new Map<string, FormatHint>();
		for (const column of columns) {
			map.set(
				column,
				(fields.get(column)?.formatHint as FormatHint) ?? "text",
			);
		}
		return map;
	}, [columns, fields]);

	// Ranges for colour scales and data bars, over the rows currently loaded.
	// With infinite scroll that is a window rather than the whole result, so a
	// scale describes what is on screen rather than the entire dataset.
	const columnStats = useMemo(() => {
		const scales = style?.colorScales ?? [];
		const stats = new Map<string, { min: number; max: number }>();
		if (scales.length === 0 || rows.length === 0) return stats;

		for (const scale of scales) {
			let min = Number.POSITIVE_INFINITY;
			let max = Number.NEGATIVE_INFINITY;
			for (const row of rows) {
				const value = toNumber(row[scale.field]);
				if (value === null) continue;
				if (value < min) min = value;
				if (value > max) max = value;
			}
			if (Number.isFinite(min) && Number.isFinite(max)) {
				stats.set(scale.field, { min, max });
			}
		}
		return stats;
	}, [rows, style]);

	const themeColors = useMemo(
		() => (typeof window === "undefined" ? null : readThemeColors()),
		// Recomputed as loaded rows change, which picks up a theme switch
		// without having to observe one directly.
		[rows.length],
	);

	// Display order: pinned columns first in the order they were pinned, then
	// everything else in the reader's order, then anything the server returned
	// that neither list mentions. A column added to the report after a view
	// was saved appears at the end rather than disappearing.
	const orderedColumns = useMemo(() => {
		const present = new Set(columns);
		const pins = pinned.filter((c) => present.has(c));
		const rest = order.filter((c) => present.has(c) && !pins.includes(c));
		const remainder = columns.filter(
			(c) => !pins.includes(c) && !rest.includes(c),
		);
		return [...pins, ...rest, ...remainder];
	}, [columns, order, pinned]);

	const widths = useMemo(() => {
		const map = new Map<string, number>();
		for (const column of orderedColumns) {
			map.set(column, columnWidth(column, hints.get(column) ?? "text"));
		}
		return map;
	}, [orderedColumns, hints]);

	const totalWidth = useMemo(
		() =>
			orderedColumns.reduce(
				(sum, c) => sum + (widths.get(c) ?? minColumnWidth),
				0,
			),
		[orderedColumns, widths],
	);

	// The rightmost frozen column, which carries the edge marking where the
	// frozen region ends.
	const lastPinned = orderedColumns.filter((c) => pinned.includes(c)).at(-1);

	// How far from the left edge each pinned column sits, so several pins stack
	// rather than overlapping.
	const pinOffsets = useMemo(() => {
		const map = new Map<string, number>();
		let offset = 0;
		for (const column of orderedColumns) {
			if (!pinned.includes(column)) break;
			map.set(column, offset);
			offset += widths.get(column) ?? minColumnWidth;
		}
		return map;
	}, [orderedColumns, pinned, widths]);

	// Enough placeholder rows to reach the bottom of the card, so the
	// placeholder is the size of the thing it stands in for.
	const skeletonRows = Math.max(
		3,
		Math.ceil(
			((typeof height === "number" ? height : 420) - 44) /
				rowHeights[density],
		),
	);

	const publish = (nextOrder: string[], nextPinned: string[]) => {
		setOrder(nextOrder);
		setPinned(nextPinned);
		onColumnLayout?.({ columnOrder: nextOrder, pinnedColumns: nextPinned });
	};

	// Where a column sat before it was pinned, so unpinning puts it back rather
	// than leaving it at the head of the row. Keyed by column, holding the
	// column it followed: a position is only meaningful relative to its
	// neighbours, since the reader may have moved other columns meanwhile.
	const pinOriginRef = useRef<Map<string, string | null>>(new Map());

	const togglePin = (column: string) => {
		const isPinned = pinned.includes(column);
		const loose = orderedColumns.filter((c) => !pinned.includes(c));

		if (!isPinned) {
			const at = loose.indexOf(column);
			pinOriginRef.current.set(column, at > 0 ? loose[at - 1] : null);
			publish(
				loose.filter((c) => c !== column),
				[...pinned, column],
			);
			return;
		}

		const nextPinned = pinned.filter((c) => c !== column);
		const nextLoose = [...loose];

		// Back where it came from. The neighbour it followed is the anchor;
		// where that neighbour has since gone or was never recorded, the
		// report's own column order decides, which is the position it had
		// before anyone touched anything.
		const after = pinOriginRef.current.get(column);
		let index: number;
		if (after === null) {
			index = 0;
		} else if (after !== undefined && nextLoose.includes(after)) {
			index = nextLoose.indexOf(after) + 1;
		} else {
			const natural = columns.indexOf(column);
			index = nextLoose.findIndex((c) => columns.indexOf(c) > natural);
			if (index < 0) index = nextLoose.length;
		}

		nextLoose.splice(index, 0, column);
		pinOriginRef.current.delete(column);
		publish(nextLoose, nextPinned);
	};

	// Where each column starts, measured across the whole grid.
	const columnOffsets = useMemo(() => {
		const map = new Map<string, number>();
		let x = 0;
		for (const column of orderedColumns) {
			map.set(column, x);
			x += widths.get(column) ?? minColumnWidth;
		}
		return map;
	}, [orderedColumns, widths]);

	// Reordering by pointer rather than by the native drag events.
	//
	// The native ones hand the browser an unstyleable screenshot of the header
	// and give the reader nothing to aim at, so a drag was a guess followed by
	// a surprise. Here the column being moved lifts and follows the cursor, and
	// a line shows exactly where it will land, which is the whole reason to
	// drag rather than to pick from a list.
	//
	// A drag stays inside its group: pinned columns reorder among themselves,
	// loose ones among themselves. Crossing the boundary is what the pin button
	// is for, so a drag never silently pins or unpins anything.
	const dragStateRef = useRef<{
		column: string;
		isPinned: boolean;
		startX: number;
		startY: number;
		grabOffset: number;
	} | null>(null);

	// Set once a drag has actually moved, and read by the sort handler so
	// letting go after a drag does not also re-sort the column.
	const draggedRef = useRef(false);

	const dropIndexFor = (
		clientX: number,
		column: string,
		isPinned: boolean,
		grabOffset: number,
	) => {
		const scroller = scrollerRef.current;
		if (!scroller) return { index: 0, indicator: 0, ghostLeft: 0 };

		const rect = scroller.getBoundingClientRect();
		// A pinned column stays at the left edge while the rest scrolls under
		// it, so a pointer over the pinned run is already in grid coordinates.
		// Everything else has been scrolled away from them by scrollLeft.
		const scrollLeft = isPinned ? 0 : scroller.scrollLeft;
		const pointer = clientX - rect.left + scrollLeft;

		const group = orderedColumns.filter(
			(c) => pinned.includes(c) === isPinned,
		);
		const withoutDragged = group.filter((c) => c !== column);

		let index = withoutDragged.length;
		for (let i = 0; i < withoutDragged.length; i++) {
			const c = withoutDragged[i];
			const left = columnOffsets.get(c) ?? 0;
			const centre = left + (widths.get(c) ?? minColumnWidth) / 2;
			if (pointer < centre) {
				index = i;
				break;
			}
		}

		// The line sits on the boundary the column would land at.
		const at = withoutDragged[index];
		const indicator = at
			? (columnOffsets.get(at) ?? 0)
			: (() => {
					const last = withoutDragged[withoutDragged.length - 1];
					if (!last) return columnOffsets.get(column) ?? 0;
					return (
						(columnOffsets.get(last) ?? 0) +
						(widths.get(last) ?? minColumnWidth)
					);
				})();

		// The band is held inside its own group, so a column cannot appear to
		// be dragged somewhere a drop would not take it.
		const groupStart = columnOffsets.get(group[0]) ?? 0;
		const last = group[group.length - 1];
		const groupEnd =
			(columnOffsets.get(last) ?? 0) +
			(widths.get(last) ?? minColumnWidth);
		const bandWidth = widths.get(column) ?? minColumnWidth;
		const ghostLeft = Math.min(
			Math.max(pointer - grabOffset, groupStart),
			groupEnd - bandWidth,
		);

		// Handed back in the coordinates the grid content is drawn in, so both
		// land in the right place whichever group is being dragged.
		const toContent = isPinned ? scroller.scrollLeft : 0;
		return {
			index,
			indicator: indicator + toContent,
			ghostLeft: ghostLeft + toContent,
		};
	};

	const onHeaderPointerDown = (event: React.PointerEvent, column: string) => {
		if (event.button !== 0) return;
		// The pin and filter controls live inside the header. Capturing the
		// pointer for a drag retargets every later event to the header, so the
		// button never sees its own release and no click is ever produced.
		// A press that starts on a control is that control's, not a drag.
		if ((event.target as HTMLElement).closest("button")) return;
		const isPinned = pinned.includes(column);
		const cell = (
			event.currentTarget as HTMLElement
		).getBoundingClientRect();
		dragStateRef.current = {
			column,
			isPinned,
			startX: event.clientX,
			startY: event.clientY,
			// Where inside the header the reader grabbed, so the floating copy
			// sits under the cursor exactly where it was picked up.
			grabOffset: event.clientX - cell.left,
		};
		draggedRef.current = false;
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
	};

	const onHeaderPointerMove = (event: React.PointerEvent) => {
		const state = dragStateRef.current;
		if (!state) return;

		// A few pixels of slack, so a click to sort is not read as a drag.
		if (!draggedRef.current) {
			const moved =
				Math.abs(event.clientX - state.startX) > 4 ||
				Math.abs(event.clientY - state.startY) > 4;
			if (!moved) return;
			draggedRef.current = true;
		}

		const { index, indicator, ghostLeft } = dropIndexFor(
			event.clientX,
			state.column,
			state.isPinned,
			state.grabOffset,
		);
		setDrag({
			column: state.column,
			isPinned: state.isPinned,
			index,
			indicator,
			ghostLeft,
			settling: false,
		});
	};

	const endHeaderDrag = (event: React.PointerEvent) => {
		const state = dragStateRef.current;
		const element = event.currentTarget as Element;
		if (element.hasPointerCapture(event.pointerId)) {
			element.releasePointerCapture(event.pointerId);
		}
		dragStateRef.current = null;

		const current = drag;
		if (!state || !draggedRef.current || !current) {
			setDrag(null);
			return;
		}

		const group = orderedColumns.filter(
			(c) => pinned.includes(c) === state.isPinned,
		);
		const next = group.filter((c) => c !== state.column);
		next.splice(current.index, 0, state.column);

		if (state.isPinned) publish(order, next);
		else publish(next, pinned);

		// The columns have already moved underneath. The band travels the last
		// short distance to sit exactly over the column's new place, which is
		// what makes the drop read as landing rather than as vanishing.
		setDrag({ ...current, ghostLeft: current.indicator, settling: true });
		window.setTimeout(() => setDrag(null), 160);
	};

	const cancelHeaderDrag = () => {
		dragStateRef.current = null;
		setDrag(null);
	};

	const toggleSort = (field: string) => {
		// A drag that ended on the header it started from would otherwise also
		// register as a click and re-sort the column.
		if (draggedRef.current) {
			draggedRef.current = false;
			return;
		}
		setSort((prev) => {
			if (!prev || prev.field !== field)
				return { field, direction: "asc" };
			if (prev.direction === "asc") return { field, direction: "desc" };
			return null;
		});
	};

	// Scoped to this grid, so two on one page do not watch each other's work
	// and a reader who leaves and comes back is offered the file they asked for.
	const exporter = useExport(`export:${visualId ?? sourceKey}`);

	const runExport = () =>
		void exporter.start({
			spec: {
				sourceKey,
				dimensions,
				measures,
				filters: activeFilters,
				sort: sort
					? [{ field: sort.field, direction: sort.direction }]
					: [],
				limit: maxExportRows,
			},
			reportId,
			pageId,
			visualId,
		});

	// An export that failed says so where it was asked for, rather than in the
	// grid's own error slot, which would replace the rows the reader still has.
	const exportError = exporter.error;

	// Combines threshold rules and colour scales for one cell.
	//
	// A rule that paints a background also carries a marker or a weight change,
	// so the meaning survives greyscale printing and does not rely on the
	// reader distinguishing hues.
	interface CellAppearance {
		background?: string;
		color?: string;
		bold?: boolean;
		marker?: string;
		bar?: { width: number; color: string };
	}

	// Alternating row shading, on unless an author turns it off. Reading across
	// a wide row is where a grid loses people, and a stripe is the cheapest fix.
	//
	// Keyed off the row's index in the data rather than a CSS nth-child rule,
	// because the rows are virtualised: the rendered window moves, so a row's
	// position in the DOM says nothing about where it sits in the result.
	const striped = style?.stripedRows !== false;

	function cellAppearance(
		row: Record<string, unknown>,
		column: string,
		rowIndex: number,
	): CellAppearance {
		if (!themeColors) return {};
		const result: CellAppearance = {};

		const match = evaluateConditions(style?.conditions ?? [], row, column, {
			position: rowIndex,
			total: rows.length,
		});
		if (match) {
			if (match.background) {
				result.background = withAlpha(
					themeColors.resolve(
						match.background,
						themeColors.series[0],
					),
					0.18,
				);
			}
			if (match.textColor) {
				result.color = themeColors.resolve(
					match.textColor,
					themeColors.text,
				);
			}
			result.bold = match.bold;
			result.marker = match.marker;
		}

		const scale = (style?.colorScales ?? []).find(
			(s) => s.field === column,
		);
		if (scale) {
			const stats = columnStats.get(column);
			const value = toNumber(row[column]);
			if (stats && value !== null) {
				const position = scalePosition(
					value,
					stats.min,
					stats.max,
					scale.kind === "diverging"
						? (scale.midpoint ?? 0)
						: undefined,
				);
				if (position) {
					const endpoint =
						position.side === "low"
							? themeColors.resolve(
									scale.low,
									themeColors.negative,
								)
							: themeColors.resolve(
									scale.high,
									themeColors.positive,
								);

					if (scale.asDataBar) {
						// A bar compares more precisely than a colour wash and
						// reads without colour at all.
						result.bar = {
							width: Math.round(position.ratio * 100),
							color: withAlpha(endpoint, 0.25),
						};
					} else {
						const base = themeColors.resolve(
							scale.mid,
							themeColors.surface,
						);
						result.background = mix(
							base,
							endpoint,
							position.ratio * 0.7,
						);
					}
				}
			}
		}

		return result;
	}

	const activeChips = Object.entries(columnFilters).filter(
		([, values]) => values.length > 0,
	);

	if (error && rows.length === 0) return <VisualError error={error} />;

	return (
		<div className={styles.grid} style={{ height }}>
			<div className={styles.toolbar}>
				<div className={styles.search}>
					<svg
						className={styles.searchIcon}
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
					>
						<circle cx="11" cy="11" r="7" />
						<path d="M21 21l-4.35-4.35" />
					</svg>
					<input
						type="text"
						className={styles.searchInput}
						placeholder={
							dimensions.length > 0
								? `Search ${dimensions[0]}`
								: "Search"
						}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>

				<div className={styles.spacer} />

				<span className={styles.rowCount}>
					{rows.length.toLocaleString()}
					{hasMore ? "+" : ""} rows
				</span>

				{/* A file that stopped at the ceiling is not the whole answer,
				    and a reader who is not told will treat it as one. */}
				{exporter.job?.truncated && !exporter.busy && (
					<span
						className={styles.exportNote}
						title={`An export stops at ${maxExportRows.toLocaleString()} rows. Narrow the filters, or read the source directly for more.`}
					>
						first {maxExportRows.toLocaleString()} rows exported
					</span>
				)}

				<button
					type="button"
					className={styles.toolButton}
					onClick={runExport}
					disabled={exporter.busy || rows.length === 0}
					title={
						exportError
							? exportError.message
							: "Exports are recorded in the audit log. Large ones keep running if you leave the page."
					}
				>
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
						<path d="M7 10l5 5 5-5M12 15V3" />
					</svg>
					{exporter.busy
						? exporter.job && exporter.job.rowCount > 0
							? `${exporter.job.rowCount.toLocaleString()} rows`
							: "Exporting"
						: exportError
							? "Export failed"
							: "Export"}
				</button>
			</div>

			{activeChips.length > 0 && (
				<div className={styles.chips}>
					{activeChips.map(([field, values]) => (
						<span key={field} className={styles.chip}>
							<span className={styles.chipField}>{field}</span>
							<span>
								{values.length === 1
									? values[0]
									: `${values.length} selected`}
							</span>
							<button
								type="button"
								className={styles.chipRemove}
								aria-label={`Remove ${field} filter`}
								onClick={() =>
									setColumnFilters((prev) => {
										const next = { ...prev };
										delete next[field];
										return next;
									})
								}
							>
								✕
							</button>
						</span>
					))}
					<button
						type="button"
						className={styles.clearAll}
						onClick={() => setColumnFilters({})}
					>
						Clear all
					</button>
				</div>
			)}

			<div className={styles.scroller} ref={scrollerRef}>
				{drag && (
					<>
						{/* The column itself, lifted. A band the width of the
						    column over its full height, so the reader is moving
						    the column rather than a label that came off it. */}
						<div
							className={`${styles.columnGhost} ${
								drag.settling ? styles.columnGhostSettling : ""
							}`}
							style={{
								left: drag.ghostLeft,
								width: widths.get(drag.column),
							}}
							aria-hidden="true"
						>
							<span className={styles.columnGhostLabel}>
								{drag.column}
							</span>
						</div>

						{/* Where it will land. Hidden once the band is on its
						    way there, since by then it is saying the same
						    thing twice. */}
						{!drag.settling && (
							<div
								className={styles.dropLine}
								style={{ left: drag.indicator }}
								aria-hidden="true"
							/>
						)}
					</>
				)}

				<div className={styles.headerRow} style={{ width: totalWidth }}>
					{orderedColumns.map((column) => {
						const hint = hints.get(column) ?? "text";
						const isSorted = sort?.field === column;
						const hasFilter =
							(columnFilters[column]?.length ?? 0) > 0;
						const isDimension = dimensions.includes(column);
						const isPinned = pinned.includes(column);
						const isLastPin = isPinned && column === lastPinned;

						return (
							<div
								key={column}
								className={`${styles.headerCell} ${
									isPinned ? styles.pinned : ""
								} ${isLastPin ? styles.pinEdge : ""} ${
									drag?.column === column ? styles.lifted : ""
								} ${drag ? styles.dragInProgress : ""}`}
								style={{
									width: widths.get(column),
									left: isPinned
										? pinOffsets.get(column)
										: undefined,
								}}
								onPointerDown={(e) =>
									onHeaderPointerDown(e, column)
								}
								onPointerMove={onHeaderPointerMove}
								onPointerUp={endHeaderDrag}
								onPointerCancel={cancelHeaderDrag}
							>
								<span
									className={styles.gripDots}
									aria-hidden="true"
								>
									<svg
										width="8"
										height="14"
										viewBox="0 0 8 14"
										fill="currentColor"
									>
										<circle cx="2" cy="3" r="1" />
										<circle cx="6" cy="3" r="1" />
										<circle cx="2" cy="7" r="1" />
										<circle cx="6" cy="7" r="1" />
										<circle cx="2" cy="11" r="1" />
										<circle cx="6" cy="11" r="1" />
									</svg>
								</span>
								<span
									className={styles.headerLabel}
									onClick={() => toggleSort(column)}
									title={
										fields.get(column)?.description ??
										column
									}
									role="button"
									tabIndex={0}
									onKeyDown={(e) => {
										if (e.key === "Enter")
											toggleSort(column);
									}}
								>
									{column}
								</span>

								{isSorted && (
									<svg
										className={styles.sortIcon}
										width="11"
										height="11"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="3"
										strokeLinecap="round"
									>
										{sort?.direction === "asc" ? (
											<path d="M6 15l6-6 6 6" />
										) : (
											<path d="M6 9l6 6 6-6" />
										)}
									</svg>
								)}

								<button
									type="button"
									className={`${styles.pinButton} ${
										isPinned ? styles.pinActive : ""
									}`}
									onClick={(e) => {
										e.stopPropagation();
										togglePin(column);
									}}
									title={
										isPinned
											? "Unpin this column"
											: "Pin this column so it stays visible while scrolling across"
									}
									aria-pressed={isPinned}
								>
									<svg
										width="11"
										height="11"
										viewBox="0 0 24 24"
										fill={
											isPinned ? "currentColor" : "none"
										}
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M12 17v5" />
										<path d="M9 10.76V7a3 3 0 0 1 6 0v3.76a2 2 0 0 0 .59 1.42L17 13.6V17H7v-3.4l1.41-1.42A2 2 0 0 0 9 10.76Z" />
									</svg>
								</button>

								{/* Only a dimension has a meaningful value list;
								    a measure is an aggregate. */}
								{isDimension && (
									<button
										type="button"
										className={`${styles.filterButton} ${
											hasFilter ? styles.filterActive : ""
										}`}
										aria-label={`Filter ${column}`}
										onClick={(e) => {
											const rect =
												e.currentTarget.getBoundingClientRect();
											setOpenFilter({
												field: column,
												x: rect.left - 240,
												y: rect.bottom + 4,
											});
										}}
									>
										<svg
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
										>
											<path d="M3 5h18l-7 8v6l-4 2v-8z" />
										</svg>
									</button>
								)}
							</div>
						);
					})}
				</div>

				{loading && rows.length === 0 ? (
					// Table shaped, and the width of the real columns, so the
					// placeholder holds the layout instead of announcing itself
					// with a word in the middle of an empty card.
					<div
						className={styles.skeletonRows}
						style={{ width: totalWidth }}
						role="status"
						aria-busy="true"
						aria-label="Loading"
					>
						{Array.from({ length: skeletonRows }, (_, r) => (
							<div key={r} className={styles.skeletonRow}>
								{orderedColumns.map((column, c) => (
									<div
										key={column}
										className={styles.skeletonCell}
										style={{ width: widths.get(column) }}
									>
										<span
											className={styles.skeletonBar}
											style={{
												// Varied so it reads as text
												// rather than as a bar chart.
												width: `${45 + ((r * 7 + c * 23) % 40)}%`,
											}}
										/>
									</div>
								))}
							</div>
						))}
					</div>
				) : rows.length === 0 ? (
					<div className={styles.state}>
						No rows match the current filters
					</div>
				) : (
					<div
						className={styles.rows}
						style={{
							height: virtualizer.getTotalSize(),
							width: totalWidth,
						}}
					>
						{virtualizer.getVirtualItems().map((item) => {
							const row = rows[item.index];
							return (
								<div
									key={item.key}
									className={`${styles.row} ${
										striped && item.index % 2 === 1
											? styles.rowAlt
											: ""
									}`}
									style={{
										height: item.size,
										transform: `translateY(${item.start}px)`,
									}}
								>
									{orderedColumns.map((column) => {
										const hint =
											hints.get(column) ?? "text";
										const cell = cellAppearance(
											row,
											column,
											item.index,
										);
										const isPinned =
											pinned.includes(column);
										const isLastPin =
											isPinned && column === lastPinned;
										return (
											<div
												key={column}
												className={`${styles.cell} ${
													isNumericHint(hint)
														? styles.numeric
														: ""
												} ${isPinned ? styles.pinned : ""} ${
													isLastPin
														? styles.pinEdge
														: ""
												} ${
													drag?.column === column &&
													!drag.settling
														? styles.lifted
														: ""
												}`}
												style={{
													width: widths.get(column),
													left: isPinned
														? pinOffsets.get(column)
														: undefined,
													// A pinned cell scrolls over the
													// others, so it carries its own
													// ground. Faintly tinted with the
													// accent, so the frozen columns
													// read as a group at a glance,
													// and still striped so a row is
													// followable across the boundary.
													background:
														cell.background ??
														(isPinned
															? striped &&
																item.index %
																	2 ===
																	1
																? "var(--pin-surface-alt)"
																: "var(--pin-surface)"
															: undefined),
													color: cell.color,
													fontWeight: cell.bold
														? 600
														: undefined,
												}}
												title={String(
													row[column] ?? "",
												)}
											>
												{cell.bar && (
													<span
														className={
															styles.dataBar
														}
														style={{
															width: `${cell.bar.width}%`,
															background:
																cell.bar.color,
														}}
														aria-hidden="true"
													/>
												)}
												<span
													className={styles.cellText}
												>
													{cell.marker && (
														<span
															className={
																styles.marker
															}
														>
															{cell.marker}
														</span>
													)}
													{formatValue(
														row[column],
														hint,
													)}
												</span>
											</div>
										);
									})}
								</div>
							);
						})}
					</div>
				)}

				{/* Only once there is something to be at the end of. Rendered
				    while the first page is still in flight, its padding showed
				    as a strip of empty card below the placeholder. */}
				{rows.length > 0 && (
					<div ref={sentinelRef} className={styles.sentinel}>
						{loadingMore
							? "Loading more"
							: hasMore
								? ""
								: "End of results"}
					</div>
				)}
			</div>

			{openFilter && (
				<ColumnFilter
					field={openFilter.field}
					sourceKey={sourceKey}
					otherFilters={activeFilters.filter(
						(f) =>
							(f as QueryFilterShape).field !== openFilter.field,
					)}
					selected={columnFilters[openFilter.field] ?? []}
					sortDirection={
						sort?.field === openFilter.field ? sort.direction : null
					}
					anchor={{ x: openFilter.x, y: openFilter.y }}
					onSort={(direction) => {
						setSort(
							direction
								? { field: openFilter.field, direction }
								: null,
						);
					}}
					onApply={(values) => {
						setColumnFilters((prev) => ({
							...prev,
							[openFilter.field]: values,
						}));
						setOpenFilter(null);
					}}
					onClose={() => setOpenFilter(null)}
				/>
			)}
		</div>
	);
}
