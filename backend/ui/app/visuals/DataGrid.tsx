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
import { maxExportRows } from "../../lib/query/exportLimits";
import { createResultMemo, resultMaxAge } from "./resultMemo";
import { canonical } from "../hooks/canonicalKey";
import { runBatchedQuery } from "../hooks/queryBatch";
import { useExport } from "../hooks/useExport";
import type { QueryTransform } from "../../lib/query/transform";
import {
	relativeChange,
	shiftDateFilters,
	type ComparePeriod,
	type DateClause,
} from "../../lib/query/compare";
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
import {
	matchesSelection,
	selectionCovers,
	type SelectionPart,
} from "../../lib/visuals/selection";
import { readThemeColors, mix, withAlpha } from "./colors";
import { useTheme } from "../context/ThemeContext";
import { ColumnFilter } from "./ColumnFilter";
import {
	FilteredEmptyState,
	useEmptyGuidance,
	VisualError,
} from "./VisualFrame";
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
	// Alternatives, each a set of conditions that must all hold, ORed
	// together and applied on top of the filters above. Set only by a query
	// somebody builds by hand.
	anyOf?: unknown[][];
	// Conditions nested with brackets, applied on top of the rest.
	where?: unknown;
	// Figures worked out from the answer, declared on the visual. Part of the
	// query, so a derived column arrives with the rows and sorts and exports
	// like any other.
	transforms?: QueryTransform[];
	fields: Map<string, FieldMeta>;
	pageSize?: number;
	// How tall a row is. An author's judgement about the data rather than a
	// reader preference, so it travels with the visual.
	density?: GridDensity;
	// A row at the foot holding the total of every measure across the whole
	// result rather than across the rows that happen to be loaded.
	showTotals?: boolean;
	// The change against an earlier window, shown under each measure. Both
	// halves are needed: the field says which range filter to move, the period
	// says how far.
	compareTo?: ComparePeriod | null;
	compareField?: string | null;
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
	// Widths the reader has dragged to, by column. Only the ones they changed:
	// everything else keeps the width worked out from its name and its format.
	columnWidths?: Record<string, number>;
	onColumnLayout?: (next: {
		columnOrder: string[];
		pinnedColumns: string[];
		columnWidths: Record<string, number>;
	}) => void;
	// Fires when a reader clicks a cell in a dimension column, with the
	// column and the row's own value, so the page can filter to it the way a
	// click on a chart mark does. Measure cells are figures rather than
	// values of anything, so they are left alone.
	onCellSelect?: (field: string, value: unknown) => void;
	// The page selection this grid made. Its rows stay as they are and the
	// rest fade, as the marks outside a selection do on a chart.
	selection?: SelectionPart[];
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

const firstPages = createResultMemo<FirstPage>(40, resultMaxAge);

// Combines threshold rules and colour scales for one cell.
//
// A rule that paints a background also carries a marker or a weight change,
// so the meaning survives greyscale printing and does not rely on the reader
// distinguishing hues.
interface CellAppearance {
	background?: string;
	color?: string;
	bold?: boolean;
	marker?: string;
	bar?: { width: number; color: string };
}

// How one cell is drawn, beyond its value. The change is against the earlier
// window, or null when there is nothing to compare.
interface CellLook {
	appearance: CellAppearance;
	change: number | null;
}

type Row = Record<string, unknown>;

const noLook: CellLook = { appearance: {}, change: null };

// The custom properties that carry each column's width and, for a pinned
// column, its left offset. Every cell reads its width from these, so a drag on
// a column edge writes one property on the grid and every row follows without
// being drawn again.
function widthVar(index: number): string {
	return `--dg-w${index}`;
}

function leftVar(index: number): string {
	return `--dg-l${index}`;
}

export function DataGrid({
	sourceKey,
	dimensions,
	measures,
	baseFilters = [],
	anyOf,
	where,
	transforms,
	fields,
	pageSize = 200,
	showTotals = false,
	compareTo,
	compareField,
	density = "comfortable",
	height = 520,
	reportId,
	pageId,
	visualId,
	style,
	columnOrder,
	pinnedColumns,
	columnWidths,
	onColumnLayout,
	onCellSelect,
	selection,
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
	const [sortState, setSort] = useState<SortState | null>(null);
	const [columnFilterState, setColumnFilters] = useState<
		Record<string, string[]>
	>({});

	// The fields the query can sort and filter on. A breakdown switch can take
	// away the column a sort or a column filter names, and sending it anyway
	// fails the query, so both are read through this set. A transform's column
	// is worked out after the warehouse answers, so the warehouse cannot order
	// or filter by it and it is left out.
	const queryFieldKey = [...dimensions, ...measures].join("\u001f");
	const queryFields = useMemo(
		() => new Set(queryFieldKey.split("\u001f")),
		[queryFieldKey],
	);
	const sort =
		sortState && queryFields.has(sortState.field) ? sortState : null;
	const columnFilters = useMemo(() => {
		const kept: Record<string, string[]> = {};
		for (const [field, values] of Object.entries(columnFilterState)) {
			if (queryFields.has(field)) kept[field] = values;
		}
		return kept;
	}, [columnFilterState, queryFields]);

	// Dropped from state as well, so a column that comes back later starts
	// unsorted and unfiltered rather than picking up an old choice.
	useEffect(() => {
		setSort((prev) => (prev && !queryFields.has(prev.field) ? null : prev));
		setColumnFilters((prev) =>
			Object.keys(prev).every((field) => queryFields.has(field))
				? prev
				: Object.fromEntries(
						Object.entries(prev).filter(([field]) =>
							queryFields.has(field),
						),
					),
		);
	}, [queryFields]);
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

	// Widths the reader has dragged to. Only the columns they touched: the
	// rest keep the width worked out from the name and the format, so adding a
	// column to the report does not arrive at somebody else's size.
	const [sized, setSized] = useState<Record<string, number>>(
		columnWidths ?? {},
	);
	useEffect(() => {
		setSized(columnWidths ?? {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [JSON.stringify(columnWidths ?? {})]);

	// A drag on the edge between two columns.
	//
	// Held in a ref rather than in state, and drawn by writing the column's
	// custom property on the grid element directly. It updates on every
	// pointer move, and re-rendering a virtualized grid per pixel of travel is
	// the difference between a resize that follows the cursor and one that
	// lags behind it. State carries the committed width, set once on release.
	const gridRef = useRef<HTMLDivElement | null>(null);
	const resizeRef = useRef<{
		column: string;
		startX: number;
		startWidth: number;
		// Where the column sits in the display order, which names its
		// custom property.
		index: number;
		// The width of every column together when the drag began.
		total: number;
		// Pinned columns to the right of this one, with their left offsets
		// when the drag began. They move by however much this one grows.
		laterPins: { index: number; left: number }[];
	} | null>(null);

	// Writes a column's width, and everything that depends on it, onto the
	// grid element without a render.
	const paintWidth = (
		state: NonNullable<typeof resizeRef.current>,
		width: number,
	) => {
		const grid = gridRef.current;
		if (!grid) return;
		const delta = width - state.startWidth;
		grid.style.setProperty(widthVar(state.index), `${width}px`);
		grid.style.setProperty("--dg-total", `${state.total + delta}px`);
		for (const pin of state.laterPins) {
			grid.style.setProperty(leftVar(pin.index), `${pin.left + delta}px`);
		}
	};

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

	// Held by value, so a new array with the same conditions is the same
	// query rather than a refetch.
	const anyOfKey = JSON.stringify(anyOf && anyOf.length > 0 ? anyOf : null);
	const logic = useMemo(
		() => (anyOf && anyOf.length > 0 ? anyOf : undefined),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[anyOfKey],
	);

	const whereKey = JSON.stringify(where ?? null);
	const tree = useMemo(
		() => where ?? undefined,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[whereKey],
	);

	const filterKey = JSON.stringify(activeFilters) + anyOfKey + whereKey;
	const sortKey = sort ? `${sort.field}:${sort.direction}` : "";

	// Everything that shapes the query, which is exactly what makes a
	// remembered page still the right answer.
	const queryKey = `${sourceKey}|${dimensions.join(",")}|${measures.join(
		",",
	)}|${filterKey}|${sortKey}|${pageSize}|${JSON.stringify(transforms ?? [])}`;
	queryKeyRef.current = queryKey;

	const fetchPage = useCallback(
		async (offset: number, replace: boolean) => {
			const token = ++requestRef.current;
			// The query this request answers. The ref moves on with the next
			// render, so reading it after the response would cache these rows
			// under whatever query is current by then.
			const cacheKey = queryKeyRef.current;
			if (replace) setLoading(true);
			else setLoadingMore(true);
			setError(null);

			try {
				const data = await runBatchedQuery(
					canonical({
						sourceKey,
						dimensions,
						measures,
						filters: activeFilters,
						anyOf: logic,
						where: tree,
						sort: sort
							? [{ field: sort.field, direction: sort.direction }]
							: [],
						limit: pageSize,
						offset,
						...(transforms?.length ? { transforms } : {}),
					}),
				);

				// A newer request has since been issued, so this result is
				// already obsolete.
				if (token !== requestRef.current) return;

				setColumns(data.columns ?? []);
				const pageRows = data.rows ?? [];
				setRows((prev) =>
					replace ? pageRows : [...prev, ...pageRows],
				);
				// A short page means the end of the result.
				const more = pageRows.length >= pageSize;
				setHasMore(more);

				if (replace) {
					firstPages.set(cacheKey, {
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
		[
			sourceKey,
			dimensions,
			measures,
			activeFilters,
			logic,
			tree,
			sort,
			pageSize,
			transforms,
		],
	);

	// The total of every measure, across the whole result.
	//
	// Its own query rather than a sum of what is on screen. The grid loads two
	// hundred rows at a time out of a result that can be millions, so adding up
	// the loaded ones would total a sample and label it a total, which is worse
	// than showing nothing.
	//
	// The same filters, no dimensions and no sort, which is a spec the query
	// layer already understands and which the batcher sends alongside the
	// page's other queries rather than as a round trip of its own.
	const [totals, setTotals] = useState<Record<string, unknown> | null>(null);

	useEffect(() => {
		// Nothing to add up, so nothing is asked for.
		if (!showTotals || measures.length === 0) {
			setTotals(null);
			return;
		}

		let live = true;
		setTotals(null);

		void runBatchedQuery(
			canonical({
				sourceKey,
				dimensions: [],
				measures,
				filters: activeFilters,
				anyOf: logic,
				where: tree,
				sort: [],
				limit: 1,
				offset: 0,
			}),
		)
			.then((data) => {
				if (live) setTotals(data.rows?.[0] ?? null);
			})
			.catch(() => {
				// A total that could not be fetched is left off rather than
				// shown as zero. The rows above it are still correct, and a
				// wrong total would put them in doubt.
				if (live) setTotals(null);
			});

		return () => {
			live = false;
		};
		// Keyed on the query shape, which is what decides the answer.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [showTotals, sourceKey, measures.join(","), filterKey]);

	// The same rows for an earlier window, keyed by their dimension values.
	//
	// One query for the page rather than one per row, and the same spec shape
	// the grid already asks for, so it shares the batcher and the cache. Only
	// the first page is compared: the comparison is read alongside a figure the
	// reader is looking at, and fetching an earlier window for rows nobody has
	// scrolled to yet would double the cost of the whole table for nothing.
	const comparisonFilters = useMemo(() => {
		if (!compareTo || !compareField || measures.length === 0) return null;
		return shiftDateFilters(
			activeFilters as DateClause[],
			compareField,
			compareTo,
		);
	}, [compareTo, compareField, activeFilters, measures.length]);

	const [earlier, setEarlier] = useState<
		Map<string, Record<string, unknown>>
	>(new Map());

	// The dimension values of a row, joined into something a map can key on.
	// The unit separator, because it cannot occur inside a value the way a
	// comma or a pipe can and quietly merge two different rows.
	const rowKey = useCallback(
		(row: Record<string, unknown>): string =>
			dimensions.map((d) => String(row[d] ?? "")).join(""),
		[dimensions],
	);

	useEffect(() => {
		if (!comparisonFilters) {
			setEarlier(new Map());
			return;
		}

		let live = true;
		void runBatchedQuery(
			canonical({
				sourceKey,
				dimensions,
				measures,
				filters: comparisonFilters,
				anyOf: logic,
				where: tree,
				sort: [],
				limit: pageSize,
				offset: 0,
			}),
		)
			.then((data) => {
				if (!live) return;
				const map = new Map<string, Record<string, unknown>>();
				for (const row of data.rows ?? []) map.set(rowKey(row), row);
				setEarlier(map);
			})
			.catch(() => {
				// No comparison rather than a wrong one. The figures beside it
				// are still correct, and a change against a window that failed
				// to load would not be.
				if (live) setEarlier(new Map());
			});

		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		JSON.stringify(comparisonFilters),
		anyOfKey,
		whereKey,
		sourceKey,
		dimensions.join(","),
		measures.join(","),
		pageSize,
	]);

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
			// Retires any request still in flight, so a late answer to an
			// earlier query cannot replace these rows.
			requestRef.current++;
			setLoadingMore(false);
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

	const { resolved: resolvedTheme } = useTheme();
	const themeColors = useMemo(
		() => (typeof window === "undefined" ? null : readThemeColors()),
		// The palette is read off the document, so a theme switch reads it again.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[rows.length, resolvedTheme],
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
			// The reader's own width wins over the one worked out from the
			// name. A drag in progress is drawn straight onto the grid
			// element, see paintWidth.
			map.set(
				column,
				sized[column] ??
					columnWidth(column, hints.get(column) ?? "text"),
			);
		}
		return map;
	}, [orderedColumns, hints, sized]);

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

	// Each column's place in the display order, which names the custom
	// properties holding its width and offset.
	const columnIndex = useMemo(
		() => new Map(orderedColumns.map((column, i) => [column, i])),
		[orderedColumns],
	);

	// The widths and pinned offsets as custom properties on the grid element.
	// Cells read these rather than a number of their own, so a width change
	// is one style write rather than a render of every row.
	const columnVars = useMemo(() => {
		const vars: Record<string, string> = {
			"--dg-total": `${totalWidth}px`,
		};
		orderedColumns.forEach((column, i) => {
			vars[widthVar(i)] = `${widths.get(column) ?? minColumnWidth}px`;
			const left = pinOffsets.get(column);
			if (left !== undefined) vars[leftVar(i)] = `${left}px`;
		});
		return vars;
	}, [orderedColumns, widths, pinOffsets, totalWidth]);

	const beginResize = (
		event: React.PointerEvent,
		column: string,
		from: number,
	) => {
		// Its own gesture, and the header's drag-to-reorder must not also
		// start, because a press on the edge is a resize, not a move.
		event.stopPropagation();
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		const index = columnIndex.get(column) ?? 0;
		resizeRef.current = {
			column,
			startX: event.clientX,
			startWidth: from,
			index,
			total: totalWidth,
			laterPins: pinned.includes(column)
				? orderedColumns.flatMap((c, i) => {
						const left = pinOffsets.get(c);
						return i > index && left !== undefined
							? [{ index: i, left }]
							: [];
					})
				: [],
		};
	};

	const moveResize = (event: React.PointerEvent) => {
		const state = resizeRef.current;
		if (!state) return;
		// Bounded below so a column cannot be dragged to nothing and lost.
		// Not bounded above, since a column of long descriptions is exactly
		// the case this exists for, and the grid already scrolls sideways.
		const width = Math.max(
			minColumnWidth,
			state.startWidth + (event.clientX - state.startX),
		);
		paintWidth(state, width);
	};

	const endResize = (event: React.PointerEvent) => {
		const state = resizeRef.current;
		resizeRef.current = null;
		if (!state) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}

		const width = Math.max(
			minColumnWidth,
			state.startWidth + (event.clientX - state.startX),
		);
		// A press that went nowhere is not a resize, so nothing is recorded
		// and the column goes back to whatever it had.
		if (Math.abs(width - state.startWidth) < 2) {
			paintWidth(state, state.startWidth);
			return;
		}

		// The render that follows writes the same values the drag painted.
		const next = { ...sized, [state.column]: width };
		setSized(next);
		onColumnLayout?.({
			columnOrder: order,
			pinnedColumns: pinned,
			columnWidths: next,
		});
	};

	// The pinned run, always drawn, and the loose columns after it.
	const pinCount = useMemo(() => {
		const at = orderedColumns.findIndex((c) => !pinned.includes(c));
		return at < 0 ? orderedColumns.length : at;
	}, [orderedColumns, pinned]);
	const pins = useMemo(
		() => orderedColumns.slice(0, pinCount),
		[orderedColumns, pinCount],
	);
	const loose = useMemo(
		() => orderedColumns.slice(pinCount),
		[orderedColumns, pinCount],
	);
	const pinnedWidth = pins.reduce(
		(sum, c) => sum + (widths.get(c) ?? minColumnWidth),
		0,
	);

	// Only the loose columns near the viewport are drawn in each row, so a
	// wide result costs what is on screen rather than every column. The
	// pinned run sits at the left edge and is always drawn. Spacers either
	// side of the drawn columns keep every cell where it would otherwise be.
	const columnVirtualizer = useVirtualizer({
		horizontal: true,
		count: loose.length,
		getScrollElement: () => scrollerRef.current,
		estimateSize: (i) => widths.get(loose[i]) ?? minColumnWidth,
		paddingStart: pinnedWidth,
		overscan: 3,
	});
	useLayoutEffect(() => {
		columnVirtualizer.measure();
	}, [columnVirtualizer, widths, loose, pinnedWidth]);

	const columnItems = columnVirtualizer.getVirtualItems();
	const firstColumn = columnItems[0]?.index ?? 0;
	const lastColumn = columnItems.at(-1)?.index ?? loose.length - 1;
	const shownColumns = useMemo(
		() => loose.slice(firstColumn, lastColumn + 1),
		[loose, firstColumn, lastColumn],
	);
	const leftSpace =
		shownColumns.length > 0
			? (columnOffsets.get(shownColumns[0]) ?? pinnedWidth) - pinnedWidth
			: 0;
	const shownEnd =
		shownColumns.length > 0
			? (columnOffsets.get(shownColumns[shownColumns.length - 1]) ?? 0) +
				(widths.get(shownColumns[shownColumns.length - 1]) ??
					minColumnWidth)
			: pinnedWidth;
	const rightSpace = Math.max(0, totalWidth - shownEnd);

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
		onColumnLayout?.({
			columnOrder: nextOrder,
			pinnedColumns: nextPinned,
			columnWidths: sized,
		});
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
		// A transform's column has no field in the warehouse to order by.
		if (!queryFields.has(field)) return;
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
				anyOf: logic,
				where: tree,
				sort: sort
					? [{ field: sort.field, direction: sort.direction }]
					: [],
				limit: maxExportRows,
				...(transforms?.length ? { transforms } : {}),
			},
			reportId,
			pageId,
			visualId,
		});

	// An export that failed says so where it was asked for, rather than in the
	// grid's own error slot, which would replace the rows the reader still has.
	const exportError = exporter.error;

	// Alternating row shading, on unless an author turns it off. Reading across
	// a wide row is where a grid loses people, and a stripe is the cheapest fix.
	//
	// Keyed off the row's index in the data rather than a CSS nth-child rule,
	// because the rows are virtualised: the rendered window moves, so a row's
	// position in the DOM says nothing about where it sits in the result.
	const striped = style?.stripedRows !== false;

	// Only a selection about this grid's own dimensions marks its rows. One
	// left over from a breakdown switch names a column that is gone.
	const marking = selectionCovers(selection, dimensions) ? selection : null;
	const dimensionKey = dimensions.join("\u001f");
	const canPick = Boolean(onCellSelect);
	const pickable = useMemo(
		() => (canPick ? new Set(dimensionKey.split("\u001f")) : null),
		[canPick, dimensionKey],
	);

	// The latest cell handler, read when a cell is clicked, so the rows can be
	// memoised against a callback that does not change.
	const pickRef = useRef(onCellSelect);
	useLayoutEffect(() => {
		pickRef.current = onCellSelect;
	});
	const onPick = useCallback(
		(column: string, value: unknown) => pickRef.current?.(column, value),
		[],
	);

	// How each cell is drawn, worked out the first time the cell is shown and
	// kept per row object until something it reads changes. Scrolling back
	// over rows, typing in the search box and dragging a column reuse what is
	// held rather than evaluating every rule again.
	const measureKey = measures.join("\u001f");
	const cellLook = useMemo(() => {
		const cache = new WeakMap<Row, Map<string, CellLook>>();
		const measureSet = new Set(measureKey.split("\u001f"));
		const conditions = style?.conditions ?? [];
		const scales = style?.colorScales ?? [];
		const total = rows.length;

		// The change in one measure against the earlier window, or null when
		// there is nothing to compare: no comparison asked for, not a measure,
		// the row absent from the earlier window, or an earlier figure of zero
		// which has no percentage to express.
		const changeFor = (row: Row, column: string): number | null => {
			if (earlier.size === 0 || !measureSet.has(column)) return null;
			const before = earlier.get(rowKey(row));
			if (!before) return null;
			return relativeChange(
				toNumber(row[column]),
				toNumber(before[column]),
			);
		};

		const appearanceOf = (
			row: Row,
			column: string,
			rowIndex: number,
		): CellAppearance => {
			if (!themeColors) return {};
			const result: CellAppearance = {};

			const match = evaluateConditions(conditions, row, column, {
				position: rowIndex,
				total,
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

			const scale = scales.find((s) => s.field === column);
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
							// A bar compares more precisely than a colour
							// wash and reads without colour at all.
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
		};

		return (row: Row, column: string, rowIndex: number): CellLook => {
			let byColumn = cache.get(row);
			if (!byColumn) {
				byColumn = new Map();
				cache.set(row, byColumn);
			}
			let look = byColumn.get(column);
			if (!look) {
				const appearance = appearanceOf(row, column, rowIndex);
				const change = changeFor(row, column);
				look =
					change === null && Object.keys(appearance).length === 0
						? noLook
						: { appearance, change };
				byColumn.set(column, look);
			}
			return look;
		};
	}, [rows, style, themeColors, columnStats, earlier, rowKey, measureKey]);

	// The column being reordered, faded in every row while it is lifted.
	const lifted = drag && !drag.settling ? drag.column : null;

	// The page filters this grid is drawn under, named when it comes back
	// empty.
	const emptyGuidance = useEmptyGuidance();

	const activeChips = Object.entries(columnFilters).filter(
		([, values]) => values.length > 0,
	);

	if (error && rows.length === 0) return <VisualError error={error} />;

	return (
		<div
			className={styles.grid}
			ref={gridRef}
			style={{ height, ...columnVars } as React.CSSProperties}
		>
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

				<div
					className={styles.headerRow}
					style={{ width: "var(--dg-total)" }}
				>
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
									width: `var(${widthVar(columnIndex.get(column) ?? 0)})`,
									left: isPinned
										? `var(${leftVar(columnIndex.get(column) ?? 0)})`
										: undefined,
								}}
								onPointerDown={(e) =>
									onHeaderPointerDown(e, column)
								}
								onPointerMove={onHeaderPointerMove}
								onPointerUp={endHeaderDrag}
								onPointerCancel={cancelHeaderDrag}
							>
								{/* The edge between this column and the
								    next. Its own gesture, so a press here
								    never starts the drag that reorders. */}
								<span
									className={styles.resizeHandle}
									role="separator"
									aria-label={`Resize ${column}`}
									onPointerDown={(e) =>
										beginResize(
											e,
											column,
											widths.get(column) ??
												minColumnWidth,
										)
									}
									onPointerMove={moveResize}
									onPointerUp={endResize}
									onPointerCancel={endResize}
									onClick={(e) => e.stopPropagation()}
								/>
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
						style={{ width: "var(--dg-total)" }}
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
										style={{ width: `var(${widthVar(c)})` }}
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
					emptyGuidance ? (
						<FilteredEmptyState
							guidance={emptyGuidance}
							message="No rows match the filters on this page"
						/>
					) : (
						<div className={styles.state}>
							No rows match the current filters
						</div>
					)
				) : (
					<div
						className={styles.rows}
						style={{
							height: virtualizer.getTotalSize(),
							width: "var(--dg-total)",
						}}
					>
						{virtualizer.getVirtualItems().map((item) => {
							const row = rows[item.index];
							const chosen =
								marking !== null &&
								matchesSelection(marking, row);
							return (
								<GridRow
									key={item.key}
									row={row}
									index={item.index}
									start={item.start}
									size={item.size}
									alt={striped && item.index % 2 === 1}
									chosen={chosen}
									dimmed={marking !== null && !chosen}
									pins={pins}
									lastPinned={lastPinned}
									columns={shownColumns}
									leftSpace={leftSpace}
									rightSpace={rightSpace}
									columnIndex={columnIndex}
									hints={hints}
									cellLook={cellLook}
									pickable={pickable}
									lifted={lifted}
									onPick={onPick}
								/>
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

				{/* Inside the scroller rather than below it, so it slides
				    sideways with the columns it is totalling and stays put
				    vertically. A footer outside would line up only until
				    somebody scrolled across. */}
				{showTotals && totals && rows.length > 0 && (
					<div
						className={styles.totalRow}
						style={{ width: "var(--dg-total)" }}
					>
						{orderedColumns.map((column, index) => {
							const hint = hints.get(column) ?? "text";
							const isMeasure = measures.includes(column);
							const isPinned = pinned.includes(column);
							return (
								<div
									key={column}
									className={`${styles.cell} ${
										isNumericHint(hint)
											? styles.numeric
											: ""
									} ${isPinned ? styles.pinned : ""} ${
										isPinned && column === lastPinned
											? styles.pinEdge
											: ""
									}`}
									style={{
										width: `var(${widthVar(index)})`,
										left: isPinned
											? `var(${leftVar(index)})`
											: undefined,
									}}
								>
									<span className={styles.cellText}>
										{isMeasure
											? formatValue(totals[column], hint)
											: index === 0
												? "Total"
												: ""}
									</span>
								</div>
							);
						})}
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

interface GridRowProps {
	row: Row;
	index: number;
	start: number;
	size: number;
	// Striped, by the row's place in the result.
	alt: boolean;
	chosen: boolean;
	dimmed: boolean;
	pins: string[];
	lastPinned: string | undefined;
	// The loose columns near the viewport, the only ones drawn.
	columns: string[];
	// The width of the loose columns left out either side of those drawn.
	leftSpace: number;
	rightSpace: number;
	columnIndex: Map<string, number>;
	hints: Map<string, FormatHint>;
	cellLook: (row: Row, column: string, rowIndex: number) => CellLook;
	pickable: Set<string> | null;
	lifted: string | null;
	onPick: (column: string, value: unknown) => void;
}

// One data row. Memoised so scrolling, typing in the search box and dragging
// a column draw only the rows whose own props changed. Every prop is a
// primitive or held steady by the grid.
const GridRow = memo(function GridRow({
	row,
	index,
	start,
	size,
	alt,
	chosen,
	dimmed,
	pins,
	lastPinned,
	columns,
	leftSpace,
	rightSpace,
	columnIndex,
	hints,
	cellLook,
	pickable,
	lifted,
	onPick,
}: GridRowProps) {
	const cell = (column: string, isPinned: boolean) => {
		const hint = hints.get(column) ?? "text";
		const { appearance, change } = cellLook(row, column, index);
		const at = columnIndex.get(column) ?? 0;
		const isLastPin = isPinned && column === lastPinned;
		return (
			<div
				key={column}
				className={`${styles.cell} ${
					isNumericHint(hint) ? styles.numeric : ""
				} ${isPinned ? styles.pinned : ""} ${
					isLastPin ? styles.pinEdge : ""
				} ${lifted === column ? styles.lifted : ""} ${
					pickable?.has(column) ? styles.pickable : ""
				}`}
				onClick={
					pickable?.has(column)
						? () => {
								// A drag across the text to copy it ends in a
								// click, and is not a choice of value.
								if (window.getSelection()?.toString()) {
									return;
								}
								onPick(column, row[column]);
							}
						: undefined
				}
				style={{
					width: `var(${widthVar(at)})`,
					left: isPinned ? `var(${leftVar(at)})` : undefined,
					// A pinned cell scrolls over the others, so it carries its
					// own ground. Faintly tinted with the accent, so the
					// frozen columns read as a group at a glance, and still
					// striped so a row is followable across the boundary.
					background:
						appearance.background ??
						(isPinned
							? alt
								? "var(--pin-surface-alt)"
								: "var(--pin-surface)"
							: undefined),
					color: appearance.color,
					fontWeight: appearance.bold ? 600 : undefined,
				}}
				title={String(row[column] ?? "")}
			>
				{appearance.bar && (
					<span
						className={styles.dataBar}
						style={{
							width: `${appearance.bar.width}%`,
							background: appearance.bar.color,
						}}
						aria-hidden="true"
					/>
				)}
				<span className={styles.cellText}>
					{appearance.marker && (
						<span className={styles.marker}>
							{appearance.marker}
						</span>
					)}
					{formatValue(row[column], hint)}
				</span>
				{/* The change under the figure rather than in a column of its
				    own, so the number and its movement are read together and
				    the reader's column arrangement is left alone. */}
				{change !== null && (
					<span
						className={`${styles.cellChange} ${
							change > 0
								? styles.changeUp
								: change < 0
									? styles.changeDown
									: ""
						}`}
					>
						{change > 0 ? "▲" : change < 0 ? "▼" : "="}
						{Math.abs(change * 100) < 0.05
							? "0%"
							: `${Math.abs(change * 100).toFixed(1)}%`}
					</span>
				)}
			</div>
		);
	};

	return (
		<div
			className={`${styles.row} ${alt ? styles.rowAlt : ""} ${
				chosen ? styles.rowChosen : ""
			} ${dimmed ? styles.rowDimmed : ""}`}
			style={{
				height: size,
				transform: `translateY(${start}px)`,
			}}
		>
			{pins.map((column) => cell(column, true))}
			{leftSpace > 0 && (
				<div
					style={{ width: leftSpace, flexShrink: 0 }}
					aria-hidden="true"
				/>
			)}
			{columns.map((column) => cell(column, false))}
			{rightSpace > 0 && (
				<div
					style={{ width: rightSpace, flexShrink: 0 }}
					aria-hidden="true"
				/>
			)}
		</div>
	);
});
