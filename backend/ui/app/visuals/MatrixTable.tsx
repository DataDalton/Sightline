"use client";

import { ValueNotesStrip } from "./ValueNotes";
import { useScenario } from "./ScenarioContext";
import { scenarioFactor } from "../../lib/insight/insight";
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
import { formatValue, toNumber, type FormatHint } from "../../lib/format";
import type { VisualStyle } from "../../lib/visuals/style";
import {
	matchesSelection,
	selectionCovers,
	selectionValue,
	type SelectionPart,
} from "../../lib/visuals/selection";
import { readThemeColors } from "./colors";
import {
	cellAppearance,
	type CellAppearance,
	type ColumnRange,
} from "./cellAppearance";
import { useTheme } from "../context/ThemeContext";
import { useGridState } from "./GridStates";
import { VisualError } from "./VisualFrame";
import { VisualLoadingState } from "./LoadingState";
import { ColumnFilter } from "./ColumnFilter";
import { createResultMemo, resultMaxAge } from "./resultMemo";
import { canonical } from "../hooks/canonicalKey";
import { runBatchedQuery } from "../hooks/queryBatch";
import { useExport } from "../hooks/useExport";
import { maxLimit } from "../../lib/query/spec";
import { maxExportRows } from "../../lib/query/exportLimits";
import type { FieldMeta } from "./types";
import styles from "./Matrix.module.css";
import gridStyles from "./DataGrid.module.css";

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
// Every level is fetched whole, so sorting siblings on the client orders the
// real level rather than a sample of it. Filters on a level or on the pivot
// go into every query, so the figures at every level cover only what passes.
// A search finds matching values at any level and opens the branches that
// lead to them. Export writes the whole hierarchy out flat, one column per
// level.
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
	height?: number | string;
	style?: VisualStyle;
	reportId?: string | null;
	pageId?: string | null;
	visualId?: string | null;
	// A total row at the bottom and, with a pivot, a total column on the right.
	showTotals?: boolean;
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

// The order siblings are shown in. A null key orders by the row label, and
// any other key names one cell, a measure under one pivoted value.
interface MatrixSort {
	key: string | null;
	direction: "asc" | "desc";
}

// How many children an expanded node shows at first, and how many more each
// press of "Show more" reveals. A node with thousands of children would
// otherwise push its siblings out of reach of the scrollbar.
const childBatch = 200;

// How many matching values a search reads per level. A term that matches
// more than this is too broad to open every branch for, and the reader is
// asked to narrow it.
const searchLimit = 500;

// A row's rendered height before it has been measured.
const estimatedRowHeight = 33;

const labelOrder = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

function cellKey(columnValue: string | null, measure: string): string {
	return columnValue === null ? measure : `${columnValue}||${measure}`;
}

function pathKey(path: string[]): string {
	return path.join("||");
}

// Whether a node key belongs to `key` itself or to anything beneath it.
function underKey(candidate: string, key: string): boolean {
	return candidate === key || candidate.startsWith(`${key}||`);
}

function isBlank(raw: unknown): boolean {
	return raw === null || raw === undefined || raw === "";
}

// The column groups already on screen plus any a new level brought, sorted.
// Returns the same array when nothing is new, so state does not change.
function mergeColumnValues(current: string[], added: string[]): string[] {
	if (added.every((value) => current.includes(value))) return current;
	return Array.from(new Set([...current, ...added])).sort();
}

// Siblings in the chosen order. Blank figures sort last in both directions,
// so a descending sort opens on the largest value rather than on gaps.
function arrange(rows: MatrixRow[], sort: MatrixSort | null): MatrixRow[] {
	if (!sort) return rows;
	const sign = sort.direction === "asc" ? 1 : -1;
	const key = sort.key;
	if (key === null) {
		return [...rows].sort(
			(a, b) => sign * labelOrder.compare(a.label, b.label),
		);
	}
	return [...rows].sort((a, b) => {
		const x = toNumber(a.values[key]);
		const y = toNumber(b.values[key]);
		if (x === null && y === null) return 0;
		if (x === null) return 1;
		if (y === null) return -1;
		return sign * (x - y);
	});
}

// The rows in display order, with a "Show more" line after the shown
// children of every node that still holds some back.
function buildItems(
	top: MatrixRow[],
	children: Map<string, MatrixRow[]>,
	shown: Map<string, number>,
	expanded: Set<string>,
	sort: MatrixSort | null,
): DisplayItem[] {
	const items: DisplayItem[] = [];
	const visit = (row: MatrixRow) => {
		const key = pathKey(row.path);
		items.push({ kind: "row", key, row });
		if (!expanded.has(key)) return;
		const kids = children.get(key);
		if (!kids) return;
		const ordered = arrange(kids, sort);
		const limit = shown.get(key) ?? childBatch;
		for (const child of ordered.slice(0, limit)) visit(child);
		if (ordered.length > limit) {
			items.push({
				kind: "more",
				key: `more:${key}`,
				parentKey: key,
				depth: row.depth + 1,
				remaining: ordered.length - limit,
			});
		}
	};
	for (const row of arrange(top, sort)) visit(row);
	return items;
}

// The top level of each matrix, kept across mounts, so returning to a report
// does not re-ask for the rows the reader just waited for.
interface TopLevel {
	rows: MatrixRow[];
	columnValues: string[];
}

const topLevels = createResultMemo<TopLevel>(40, resultMaxAge);

// What a search opened: the branches leading to every match, with the
// matches marked.
interface SearchResult {
	top: MatrixRow[];
	children: Map<string, MatrixRow[]>;
	expanded: Set<string>;
	matches: Set<string>;
	columnValues: string[];
	truncated: boolean;
}

export function MatrixTable({
	sourceKey,
	rowDimensions,
	columnDimension,
	measures,
	baseFilters = [],
	fields,
	height = 520,
	style,
	reportId,
	pageId,
	visualId,
	showTotals = false,
	onSelect,
	selection,
}: MatrixProps) {
	const [top, setTop] = useState<MatrixRow[]>([]);
	// Fetched children of every open node, keyed by the node's path key.
	const [children, setChildren] = useState<Map<string, MatrixRow[]>>(
		new Map(),
	);
	// How many of a node's children are shown, when more than the first batch.
	const [shown, setShown] = useState<Map<string, number>>(new Map());
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
	const [columnValues, setColumnValues] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<(Error & { status?: number }) | null>(
		null,
	);
	// Held by the page, so a reload, a link and a saved view can carry them. The
	// sort on the row labels is stored with an empty key.
	const [gridState, updateGridState] = useGridState(visualId);
	const sort = useMemo<MatrixSort | null>(
		() =>
			gridState.sort
				? {
						key:
							gridState.sort.key === ""
								? null
								: gridState.sort.key,
						direction: gridState.sort.direction,
					}
				: null,
		[gridState.sort],
	);
	const levelFilterState = useMemo(
		() => gridState.filters ?? {},
		[gridState.filters],
	);
	const setLevelFilters = useCallback(
		(next: (prev: Record<string, string[]>) => Record<string, string[]>) =>
			updateGridState((current) => ({
				...current,
				filters: next(current.filters ?? {}),
			})),
		[updateGridState],
	);
	const [openFilter, setOpenFilter] = useState<{
		field: string;
		x: number;
		y: number;
	} | null>(null);
	const [search, setSearch] = useState(gridState.search ?? "");
	const [term, setTerm] = useState((gridState.search ?? "").trim());
	// The path keys a search matched, or null when no search is running.
	const [matches, setMatches] = useState<Set<string> | null>(null);
	const [searchTruncated, setSearchTruncated] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => {
			const typed = search.trim();
			setTerm(typed);
			updateGridState((current) =>
				(current.search ?? "") === typed
					? current
					: { ...current, search: typed || undefined },
			);
		}, 300);
		return () => clearTimeout(timer);
	}, [search, updateGridState]);

	// A saved view being applied replaces the search from outside.
	const heldSearch = gridState.search ?? "";
	useEffect(() => {
		setSearch(heldSearch);
		setTerm(heldSearch);
	}, [heldSearch]);

	// The field lists by content, so the memoised rows below are not all
	// re-rendered when the page hands over an equal but new array.
	const rowDimensionKey = JSON.stringify(rowDimensions);
	const measureKey = JSON.stringify(measures);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const rowFields = useMemo(() => rowDimensions, [rowDimensionKey]);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const measureFields = useMemo(() => measures, [measureKey]);

	// The fields a level filter may name. One left over from a field that
	// was taken off the matrix would fail every query, so it is dropped.
	const filterableKey = JSON.stringify([
		...rowDimensions,
		...(columnDimension ? [columnDimension] : []),
	]);
	const filterable = useMemo<string[]>(
		() => JSON.parse(filterableKey),
		[filterableKey],
	);
	const levelFilters = useMemo(() => {
		const kept: Record<string, string[]> = {};
		for (const [field, values] of Object.entries(levelFilterState)) {
			if (filterable.includes(field) && values.length > 0) {
				kept[field] = values;
			}
		}
		return kept;
	}, [levelFilterState, filterable]);

	// The page's filters and the matrix's own, which every level is read
	// under.
	const baseKey = JSON.stringify(baseFilters);
	const levelKey = JSON.stringify(levelFilters);
	const activeFilters = useMemo<FilterClause[]>(
		() => [
			...(baseFilters as FilterClause[]),
			...Object.entries(levelFilters).map(([field, values]) => ({
				field,
				op: "eq",
				values,
			})),
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[baseKey, levelKey],
	);

	// Advanced whenever the top level reloads, so an expansion that started
	// against the previous query shape can tell its answer no longer applies.
	const generation = useRef(0);

	// Reads one level completely. With a prefix it is the children of that
	// node, grouped by the level's own field and placed under the node. With
	// none it is every row at that depth, grouped by the whole path, which is
	// how a search reads many branches in one query. The level is read page
	// by page until a page comes back short, so no row and no column cell is
	// left out however many combinations the level holds. isCurrent is
	// checked before every page after the first, so a superseded load stops
	// asking.
	const readLevel = useCallback(
		async (
			depth: number,
			filters: FilterClause[],
			prefix: { path: string[]; raws: unknown[] } | null,
			isCurrent: () => boolean,
		): Promise<{ rows: MatrixRow[]; columnValues: string[] }> => {
			const dimension = rowDimensions[depth];
			if (!dimension) return { rows: [], columnValues: [] };
			const grouped = prefix
				? [dimension]
				: rowDimensions.slice(0, depth + 1);

			// Sorted by every grouped dimension, so each combination has one
			// fixed position and consecutive pages neither repeat nor skip one.
			const order = grouped.map((field) => ({
				field,
				direction: "asc" as const,
			}));
			if (columnDimension) {
				order.push({ field: columnDimension, direction: "asc" });
			}

			// Collapse the pivoted dimension into one row per path, with the
			// measures spread across the column groups. Both maps live across
			// pages, so a row whose cells straddle a page boundary is still
			// merged into one row.
			const byPath = new Map<string, MatrixRow>();
			const seenColumns = new Set<string>();

			for (let offset = 0; ; offset += maxLimit) {
				if (offset > 0 && !isCurrent()) break;
				const data = await runBatchedQuery(
					canonical({
						sourceKey,
						dimensions: columnDimension
							? [...grouped, columnDimension]
							: grouped,
						measures,
						filters,
						sort: order,
						limit: maxLimit,
						offset,
					}),
				);
				const page: Record<string, unknown>[] = data.rows ?? [];
				for (const record of page) {
					const columnValue = columnDimension
						? String(record[columnDimension] ?? "")
						: null;
					if (columnValue !== null) seenColumns.add(columnValue);

					const path = prefix
						? [...prefix.path, String(record[dimension] ?? "")]
						: grouped.map((field) => String(record[field] ?? ""));
					const key = pathKey(path);
					let row = byPath.get(key);
					if (!row) {
						row = {
							path,
							raws: prefix
								? [...prefix.raws, record[dimension]]
								: grouped.map((field) => record[field]),
							label: path[path.length - 1],
							depth,
							values: {},
							// A node has children whenever another row dimension
							// remains below it.
							hasChildren: depth + 1 < rowDimensions.length,
						};
						byPath.set(key, row);
					}
					for (const measure of measures) {
						row.values[cellKey(columnValue, measure)] =
							record[measure];
					}
				}
				if (page.length < maxLimit) break;
			}

			// The total across the pivot for each row, read with the pivot left
			// out rather than added up from its cells, which would be wrong for
			// an average or a percentage. Kept under the cell key with no column
			// value, which is the column the total is drawn in.
			if (columnDimension && showTotals) {
				for (let offset = 0; ; offset += maxLimit) {
					if (!isCurrent()) break;
					const data = await runBatchedQuery(
						canonical({
							sourceKey,
							dimensions: grouped,
							measures,
							filters,
							sort: grouped.map((field) => ({
								field,
								direction: "asc",
							})),
							limit: maxLimit,
							offset,
						}),
					);
					const page: Record<string, unknown>[] = data.rows ?? [];
					for (const record of page) {
						const path = prefix
							? [...prefix.path, String(record[dimension] ?? "")]
							: grouped.map((field) =>
									String(record[field] ?? ""),
								);
						const row = byPath.get(pathKey(path));
						if (!row) continue;
						for (const measure of measures) {
							row.values[cellKey(null, measure)] =
								record[measure];
						}
					}
					if (page.length < maxLimit) break;
				}
			}

			return {
				rows: Array.from(byPath.values()),
				columnValues: columnDimension ? Array.from(seenColumns) : [],
			};
		},
		[sourceKey, rowDimensions, columnDimension, measures, showTotals],
	);

	// The children of one node, scoped to its ancestors, so expanding
	// "2025 / Medical" asks only for business units inside it.
	const readChildren = useCallback(
		(row: MatrixRow, isCurrent: () => boolean) =>
			readLevel(
				row.depth + 1,
				[
					...activeFilters,
					// A blank ancestor is a null or an empty value, which an
					// equality on its empty label would not match.
					...row.path.map(
						(value, i): FilterClause =>
							isBlank(row.raws[i])
								? { field: rowDimensions[i], op: "is_empty" }
								: {
										field: rowDimensions[i],
										op: "eq",
										values: [value],
									},
					),
				],
				{ path: row.path, raws: row.raws },
				isCurrent,
			),
		[readLevel, activeFilters, rowDimensions],
	);

	// Finds the values containing the term at every level, then reads the
	// branches that lead to them. One query per level for the matches, and
	// one per level for the rows on those branches, each narrowed to the
	// values the matches named and trimmed to the exact paths afterwards.
	const runSearch = useCallback(
		async (
			text: string,
			isCurrent: () => boolean,
		): Promise<SearchResult> => {
			const found = await Promise.all(
				rowDimensions.map((field, depth) => {
					const grouped = rowDimensions.slice(0, depth + 1);
					return runBatchedQuery(
						canonical({
							sourceKey,
							dimensions: grouped,
							measures: [],
							filters: [
								...activeFilters,
								{ field, op: "contains", value: text },
							],
							sort: grouped.map((f) => ({
								field: f,
								direction: "asc",
							})),
							limit: searchLimit,
							offset: 0,
						}),
					);
				}),
			);

			const matched = new Set<string>();
			// Every node on the way to a match, by depth.
			const onBranch: Set<string>[] = rowDimensions.map(() => new Set());
			// The values each depth's branch nodes hold, and whether any is
			// blank, which a value list cannot express.
			const valuesAt: Set<string>[] = rowDimensions.map(() => new Set());
			const blankAt: boolean[] = rowDimensions.map(() => false);
			let truncated = false;

			found.forEach((data, depth) => {
				const rows: Record<string, unknown>[] = data.rows ?? [];
				if (rows.length >= searchLimit) truncated = true;
				const grouped = rowDimensions.slice(0, depth + 1);
				for (const record of rows) {
					const path = grouped.map((f) => String(record[f] ?? ""));
					matched.add(pathKey(path));
					for (let i = 0; i <= depth; i++) {
						onBranch[i].add(pathKey(path.slice(0, i + 1)));
						valuesAt[i].add(path[i]);
						if (isBlank(record[grouped[i]])) blankAt[i] = true;
					}
				}
			});

			const result: SearchResult = {
				top: [],
				children: new Map(),
				expanded: new Set(),
				matches: matched,
				columnValues: [],
				truncated,
			};
			if (matched.size === 0) return result;

			const levels = await Promise.all(
				onBranch.map((keys, depth) => {
					if (keys.size === 0) {
						return Promise.resolve({ rows: [], columnValues: [] });
					}
					const narrowed: FilterClause[] = [...activeFilters];
					for (let i = 0; i <= depth; i++) {
						if (!blankAt[i]) {
							narrowed.push({
								field: rowDimensions[i],
								op: "eq",
								values: Array.from(valuesAt[i]),
							});
						}
					}
					return readLevel(depth, narrowed, null, isCurrent);
				}),
			);

			const columns = new Set<string>();
			levels.forEach((level, depth) => {
				for (const value of level.columnValues) columns.add(value);
				for (const row of level.rows) {
					if (!onBranch[depth].has(pathKey(row.path))) continue;
					if (depth === 0) {
						result.top.push(row);
						continue;
					}
					const parent = pathKey(row.path.slice(0, -1));
					const kids = result.children.get(parent) ?? [];
					kids.push(row);
					result.children.set(parent, kids);
					result.expanded.add(parent);
				}
			});
			result.columnValues = Array.from(columns);
			return result;
		},
		[sourceKey, rowDimensions, activeFilters, readLevel],
	);

	// Everything that shapes the top level, which is what makes a remembered
	// one still the right answer.
	const topKey = `${sourceKey}|${JSON.stringify(activeFilters)}|${rowDimensions.join(
		",",
	)}|${columnDimension ?? ""}|${measures.join(",")}|${showTotals}`;

	// Reload from the top whenever the query shape or the search changes.
	useEffect(() => {
		let cancelled = false;
		generation.current += 1;
		setError(null);
		setExpanded(new Set());
		setChildren(new Map());
		setShown(new Map());
		setSearchTruncated(false);

		if (term) {
			setLoading(true);
			runSearch(term, () => !cancelled)
				.then((found) => {
					if (cancelled) return;
					setTop(found.top);
					setChildren(found.children);
					setExpanded(found.expanded);
					setMatches(found.matches);
					setSearchTruncated(found.truncated);
					setColumnValues((prev) =>
						mergeColumnValues(prev, found.columnValues),
					);
					setLoading(false);
				})
				.catch((e) => {
					if (cancelled) return;
					setError(e as Error & { status?: number });
					setLoading(false);
				});
			return () => {
				cancelled = true;
			};
		}

		setMatches(null);

		// Straight back on screen if this matrix has been opened before. Only
		// the top level: an expanded subtree is deliberately discarded on
		// collapse so a later expansion cannot show stale figures, and holding
		// it here would be the same staleness by another route.
		const remembered = topLevels.get(topKey);
		if (remembered) {
			setTop(remembered.rows);
			setColumnValues(remembered.columnValues);
			setLoading(false);
			return;
		}

		setLoading(true);
		setColumnValues([]);

		readLevel(0, activeFilters, null, () => !cancelled)
			.then((level) => {
				if (cancelled) return;
				setTop(level.rows);
				setLoading(false);
				// Merged into state rather than replacing it, and read back
				// from the merge so the remembered level carries the same
				// column groups the screen does.
				setColumnValues((prev) => {
					const merged = mergeColumnValues(prev, level.columnValues);
					topLevels.set(topKey, {
						rows: level.rows,
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
		// topKey and term together are the whole query shape.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [topKey, term]);

	// The figures for the total row, keyed as the cells are. Its own query, for
	// the same reason as the column above, and it leaves out a search, which
	// decides which branches are open and not what is being totalled. One that
	// could not be fetched is left off rather than shown as zero.
	const [totals, setTotals] = useState<Record<string, unknown> | null>(null);
	useEffect(() => {
		if (!showTotals) {
			setTotals(null);
			return;
		}
		let live = true;
		const read = (dimensions: string[], limit: number) =>
			runBatchedQuery(
				canonical({
					sourceKey,
					dimensions,
					measures,
					filters: activeFilters,
					sort: dimensions.map((field) => ({
						field,
						direction: "asc",
					})),
					limit,
					offset: 0,
				}),
			);
		void Promise.all([
			read([], 1),
			columnDimension ? read([columnDimension], maxLimit) : null,
		])
			.then(([overall, pivoted]) => {
				if (!live) return;
				const next: Record<string, unknown> = {};
				for (const measure of measures) {
					next[cellKey(null, measure)] = overall.rows?.[0]?.[measure];
				}
				for (const record of pivoted?.rows ?? []) {
					const group = String(
						(record as Record<string, unknown>)[
							columnDimension as string
						] ?? "",
					);
					for (const measure of measures) {
						next[cellKey(group, measure)] = (
							record as Record<string, unknown>
						)[measure];
					}
				}
				setTotals(next);
			})
			.catch(() => {
				if (live) setTotals(null);
			});
		return () => {
			live = false;
		};
		// topKey holds every field and filter these read.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [topKey, showTotals]);

	const toggle = async (row: MatrixRow) => {
		const key = pathKey(row.path);

		if (expanded.has(key)) {
			// Collapsing removes the subtree rather than hiding it, so a later
			// expansion refetches and cannot show stale figures. Everything
			// open beneath it goes too, so reopening starts every level
			// closed.
			const keep = <T,>(map: Map<string, T>) => {
				const next = new Map<string, T>();
				for (const [held, value] of map) {
					if (!underKey(held, key)) next.set(held, value);
				}
				return next;
			};
			setExpanded((prev) => {
				const next = new Set<string>();
				for (const open of prev) {
					if (!underKey(open, key)) next.add(open);
				}
				return next;
			});
			setChildren(keep);
			setShown(keep);
			return;
		}

		// A second press while the children are still loading would insert
		// them twice.
		if (loadingPaths.has(key)) return;

		setLoadingPaths((prev) => new Set(prev).add(key));
		const startedIn = generation.current;
		try {
			const level = await readChildren(
				row,
				() => startedIn === generation.current,
			);
			if (startedIn !== generation.current) return;
			// Column groups accumulate across expansions, so a child that
			// introduces a period the parent lacked still lines up.
			setColumnValues((prev) =>
				mergeColumnValues(prev, level.columnValues),
			);
			setChildren((prev) => new Map(prev).set(key, level.rows));
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

	// Shows the next batch of a node's children after the ones already shown.
	const showMore = (parentKey: string) => {
		setShown((prev) =>
			new Map(prev).set(
				parentKey,
				(prev.get(parentKey) ?? childBatch) + childBatch,
			),
		);
	};

	const collapseAll = () => {
		setExpanded(new Set());
		setChildren(new Map());
		setShown(new Map());
	};

	// Label first ascending, then descending, then the query's own order. A
	// figure first descending, since the largest is usually what is wanted.
	const toggleSort = (key: string | null) => {
		const stored = key ?? "";
		const first = key === null ? "asc" : "desc";
		updateGridState((current) => {
			const { sort: held, ...rest } = current;
			if (!held || held.key !== stored) {
				return { ...rest, sort: { key: stored, direction: first } };
			}
			if (held.direction === first) {
				return {
					...rest,
					sort: {
						key: stored,
						direction: first === "asc" ? "desc" : "asc",
					},
				};
			}
			return rest;
		});
	};

	// Scoped to this matrix, so two on one page do not watch each other's work
	// and a reader who leaves and comes back is offered the file they asked for.
	const exporter = useExport(`export:${visualId ?? sourceKey}`);

	// The whole hierarchy flat, one column per level and the pivoted field as
	// a column of its own, under the same filters the matrix shows. A search
	// only decides which branches are open, so it is not applied.
	const runExport = () => {
		const flat = [
			...rowDimensions,
			...(columnDimension ? [columnDimension] : []),
		];
		void exporter.start({
			spec: {
				sourceKey,
				dimensions: flat,
				measures,
				filters: activeFilters,
				sort: flat.map((field) => ({ field, direction: "asc" })),
				limit: maxExportRows,
			},
			reportId,
			pageId,
			visualId,
		});
	};
	const exportError = exporter.error;

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
			columnDimension && columnValues.length > 0
				? showTotals
					? [...columnValues, null]
					: columnValues
				: [null],
		[columnDimension, columnValues, showTotals],
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

	// The rows as they would read under the page's what if. Nothing is asked of the warehouse,
	// so a figure adding up more than the chosen value stays as read.
	const scenario = useScenario();
	const moved = useMemo(() => {
		const applies = (scenario ?? []).some(
			(held) => held.percent !== 0 && measures.includes(held.measure),
		);
		if (!applies) return { top, children, totals };
		const cells = (
			values: Record<string, unknown>,
			within: Record<string, string>,
		) => {
			const next = { ...values };
			for (const group of groups) {
				for (const measure of measures) {
					const factor = scenarioFactor(
						scenario,
						measure,
						group !== null && columnDimension
							? { ...within, [columnDimension]: group }
							: within,
					);
					if (factor === 1) continue;
					const key = cellKey(group, measure);
					const value = toNumber(next[key]);
					if (value !== null) next[key] = value * factor;
				}
			}
			return next;
		};
		const moveRow = (row: MatrixRow): MatrixRow => ({
			...row,
			values: cells(
				row.values,
				Object.fromEntries(
					row.path.map((value, depth) => [
						rowDimensions[depth],
						value,
					]),
				),
			),
		});
		return {
			top: top.map(moveRow),
			children: new Map(
				[...children].map(([key, rows]) => [key, rows.map(moveRow)]),
			),
			totals: totals ? cells(totals, {}) : null,
		};
	}, [
		scenario,
		measures,
		top,
		children,
		totals,
		groups,
		columnDimension,
		rowDimensions,
	]);
	const partial = (scenario ?? []).filter(
		(held) =>
			held.percent !== 0 &&
			measures.includes(held.measure) &&
			held.field &&
			held.value,
	);

	const items = useMemo(
		() => buildItems(moved.top, moved.children, shown, expanded, sort),
		[moved, shown, expanded, sort],
	);

	// What is on screen, for the notes on those values.
	const noteRows = useMemo(() => {
		const out: Record<string, unknown>[] = [];
		for (const item of items) {
			if (item.kind !== "row") continue;
			out.push({
				[rowDimensions[item.row.depth]]: item.row.label,
			});
		}
		if (columnDimension) {
			for (const value of columnValues) {
				out.push({ [columnDimension]: value });
			}
		}
		return out;
	}, [items, rowDimensions, columnDimension, columnValues]);
	const noteFields = useMemo(
		() =>
			columnDimension
				? [...rowDimensions, columnDimension]
				: rowDimensions,
		[rowDimensions, columnDimension],
	);

	// How each cell is drawn under the author's rules and colour scales. Null
	// when there are none, which is most matrices and costs them nothing.
	const { resolved: resolvedTheme } = useTheme();
	const looksOf = useMemo(() => {
		const conditions = style?.conditions ?? [];
		const scales = style?.colorScales ?? [];
		if (
			(conditions.length === 0 && scales.length === 0) ||
			typeof window === "undefined"
		) {
			return null;
		}
		const colors = readThemeColors();

		// Ranges per level, since a year and a business unit are different
		// sizes and one range would leave every level but the top looking flat.
		const ranges = new Map<number, Map<string, ColumnRange>>();
		for (const item of items) {
			if (item.kind !== "row") continue;
			const row = item.row;
			const held =
				ranges.get(row.depth) ?? new Map<string, ColumnRange>();
			for (const scale of scales) {
				for (const group of groups) {
					// The total column is on another scale from the columns it
					// adds up, so it stays out of their range.
					if (group === null && columnDimension) continue;
					const value = toNumber(
						row.values[cellKey(group, scale.field)],
					);
					if (value === null) continue;
					const range = held.get(scale.field);
					held.set(
						scale.field,
						range
							? {
									min: Math.min(range.min, value),
									max: Math.max(range.max, value),
								}
							: { min: value, max: value },
					);
				}
			}
			ranges.set(row.depth, held);
		}

		const cache = new WeakMap<MatrixRow, CellAppearance[]>();
		return (row: MatrixRow): CellAppearance[] => {
			let looks = cache.get(row);
			if (!looks) {
				const labels = Object.fromEntries(
					row.raws.map((raw, i) => [rowFields[i], raw]),
				);
				looks = [];
				for (const group of groups) {
					const record: Record<string, unknown> = { ...labels };
					for (const measure of measureFields) {
						record[measure] = row.values[cellKey(group, measure)];
					}
					for (const measure of measureFields) {
						looks.push(
							cellAppearance(record, measure, {
								conditions,
								scales,
								stats: ranges.get(row.depth) ?? new Map(),
								colors,
							}),
						);
					}
				}
				cache.set(row, looks);
			}
			return looks;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		JSON.stringify(style?.conditions ?? []),
		JSON.stringify(style?.colorScales ?? []),
		items,
		groups,
		columnDimension,
		measureFields,
		rowFields,
		resolvedTheme,
	]);

	// Alternating row shading, on unless an author turns it off.
	const striped = style?.stripedRows !== false;

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

	// With nothing of the reader's own narrowing it, the matrix opens the way
	// every visual does: a placeholder, then the rows. Once a search or a
	// level filter is in play the toolbar stays, so it can be undone.
	const narrowed = term !== "" || Object.keys(levelFilters).length > 0;
	if (!narrowed && error && top.length === 0) {
		return <VisualError error={error} />;
	}
	if (!narrowed && loading) {
		return (
			<VisualLoadingState
				variant={style?.loadingAnimation}
				label="Loading matrix"
				height={height}
			/>
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

	const sortArrow = (key: string | null) =>
		sort && sort.key === key ? (
			<svg
				className={gridStyles.sortIcon}
				width="10"
				height="10"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="3"
				strokeLinecap="round"
				aria-hidden="true"
			>
				{sort.direction === "asc" ? (
					<path d="M6 15l6-6 6 6" />
				) : (
					<path d="M6 9l6 6 6-6" />
				)}
			</svg>
		) : null;

	const sortState = (
		key: string | null,
	): "ascending" | "descending" | "none" =>
		sort && sort.key === key
			? sort.direction === "asc"
				? "ascending"
				: "descending"
			: "none";

	const rowHeading = (
		<button
			type="button"
			className={styles.sortButton}
			onClick={() => toggleSort(null)}
			title="Sort by name"
		>
			{rowDimensions.join(" › ")}
			{sortArrow(null)}
		</button>
	);

	const activeChips = Object.entries(levelFilters);

	let body: React.ReactNode;
	if (loading) {
		body = (
			<VisualLoadingState
				variant={style?.loadingAnimation}
				label={term ? "Searching" : "Loading matrix"}
			/>
		);
	} else if (error && top.length === 0) {
		body = <VisualError error={error} />;
	} else if (top.length === 0) {
		body = (
			<div className={styles.state}>
				{term
					? `Nothing in ${rowDimensions.join(", ")} contains "${term}"`
					: "No rows match the current filters"}
			</div>
		);
	} else {
		body = (
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
								<th
									className={styles.rowHeader}
									rowSpan={2}
									aria-sort={sortState(null)}
								>
									{rowHeading}
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
												(group ?? "Total")
											)}
										</th>
									);
								})}
							</tr>
						)}
						<tr className={styles.measureHeader}>
							{!columnDimension && (
								<th
									className={styles.rowHeader}
									aria-sort={sortState(null)}
								>
									{rowHeading}
								</th>
							)}
							{groups.map((group, g) =>
								measures.map((measure, i) => {
									const key = cellKey(group, measure);
									return (
										<th
											key={`${group ?? "all"}-${measure}`}
											aria-sort={sortState(key)}
											className={`${
												i === 0 ? styles.groupStart : ""
											} ${
												columnChosen !== null &&
												!columnChosen[g]
													? styles.columnDimmed
													: ""
											}`}
										>
											<button
												type="button"
												className={`${styles.sortButton} ${styles.sortButtonEnd}`}
												onClick={() => toggleSort(key)}
												title={
													fields.get(measure)
														?.description ??
													`Sort by ${measure}`
												}
											>
												{sortArrow(key)}
												{measure}
											</button>
										</th>
									);
								}),
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
									looks={looksOf ? looksOf(row) : null}
									alt={striped && virtual.index % 2 === 1}
									measureCount={measures.length}
									columnChosen={columnChosen}
									isOpen={expanded.has(item.key)}
									isLoading={loadingPaths.has(item.key)}
									chosen={chosen}
									dimmed={marking !== null && !chosen}
									highlight={
										matches?.has(item.key) ? term : null
									}
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
					{moved.totals && (
						<tfoot className={styles.totalRow}>
							<tr>
								<td className={styles.labelCell}>Total</td>
								{groups.map((group) =>
									measures.map((measure, i) => (
										<td
											key={`${group ?? "all"}-${measure}`}
											className={`${styles.cell} ${
												i === 0 ? styles.groupStart : ""
											}`}
										>
											{formatValue(
												moved.totals?.[
													cellKey(group, measure)
												],
												hints.get(measure) ?? "decimal",
											)}
										</td>
									)),
								)}
							</tr>
						</tfoot>
					)}
				</table>
			</div>
		);
	}

	return (
		<div className={styles.matrix} style={{ height }}>
			<div className={styles.toolbar}>
				<div className={gridStyles.search}>
					<svg
						className={gridStyles.searchIcon}
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<circle cx="11" cy="11" r="7" />
						<path d="M21 21l-4.35-4.35" />
					</svg>
					<input
						type="text"
						className={gridStyles.searchInput}
						placeholder={`Search ${rowDimensions.join(", ")}`}
						aria-label={`Search ${rowDimensions.join(", ")}`}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>

				{filterable.map((field) => (
					<button
						key={field}
						type="button"
						className={`${styles.toolButton} ${styles.filterTool} ${
							levelFilters[field] ? styles.filterToolActive : ""
						}`}
						aria-label={`Filter ${field}`}
						onClick={(e) => {
							const rect =
								e.currentTarget.getBoundingClientRect();
							setOpenFilter({
								field,
								x: rect.left,
								y: rect.bottom + 4,
							});
						}}
					>
						<svg
							width="11"
							height="11"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<path d="M3 5h18l-7 8v6l-4 2v-8z" />
						</svg>
						{field}
					</button>
				))}

				<div className={styles.spacer} />

				{searchTruncated && !loading && (
					<span className={gridStyles.exportNote}>
						first {searchLimit.toLocaleString()} matches per level
					</span>
				)}

				{/* A file that stopped at the ceiling is not the whole answer,
				    and a reader who is not told will treat it as one. */}
				{exporter.job?.truncated && !exporter.busy && (
					<span
						className={gridStyles.exportNote}
						title={`An export stops at ${maxExportRows.toLocaleString()} rows. Narrow the filters, or read the source directly for more.`}
					>
						first {maxExportRows.toLocaleString()} rows exported
					</span>
				)}

				<button
					type="button"
					className={styles.toolButton}
					onClick={collapseAll}
					disabled={expanded.size === 0}
				>
					Collapse all
				</button>

				<button
					type="button"
					className={`${styles.toolButton} ${styles.exportTool}`}
					onClick={runExport}
					disabled={exporter.busy || top.length === 0}
					title={
						exportError
							? exportError.message
							: "Every level as its own column, under the filters shown. Exports are recorded in the audit log. Large ones keep running if you leave the page."
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
						aria-hidden="true"
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
				<div className={gridStyles.chips}>
					{activeChips.map(([field, values]) => (
						<span key={field} className={gridStyles.chip}>
							<span className={gridStyles.chipField}>
								{field}
							</span>
							<span>
								{values.length === 1
									? values[0]
									: `${values.length} selected`}
							</span>
							<button
								type="button"
								className={gridStyles.chipRemove}
								aria-label={`Remove ${field} filter`}
								onClick={() =>
									setLevelFilters((prev) => {
										const next = { ...prev };
										delete next[field];
										return next;
									})
								}
							>
								<svg
									width="10"
									height="10"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.5"
									strokeLinecap="round"
									aria-hidden="true"
								>
									<path d="M6 6l12 12M18 6L6 18" />
								</svg>
							</button>
						</span>
					))}
					<button
						type="button"
						className={gridStyles.clearAll}
						onClick={() => setLevelFilters(() => ({}))}
					>
						Clear all
					</button>
				</div>
			)}

			{body}

			{partial.length > 0 && (
				<p className={gridStyles.exportNote}>
					The what if applies only to{" "}
					{partial.map((held) => held.value).join(", ")}, so totals
					and rows adding up more than that stay as read.
				</p>
			)}
			<ValueNotesStrip
				sourceKey={sourceKey}
				dimensions={noteFields}
				rows={noteRows}
			/>

			{openFilter && (
				<ColumnFilter
					field={openFilter.field}
					sourceKey={sourceKey}
					otherFilters={activeFilters.filter(
						(f) => f.field !== openFilter.field,
					)}
					selected={levelFilters[openFilter.field] ?? []}
					sortDirection={null}
					sortable={false}
					anchor={{ x: openFilter.x, y: openFilter.y }}
					onSort={() => {}}
					onApply={(values) => {
						setLevelFilters((prev) => ({
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

// A label with the searched text marked, or the label as it is.
function markedLabel(label: string, highlight: string | null) {
	if (!highlight) return label;
	const at = label.toLowerCase().indexOf(highlight.toLowerCase());
	if (at < 0) return label;
	return (
		<>
			{label.slice(0, at)}
			<mark className={styles.match}>
				{label.slice(at, at + highlight.length)}
			</mark>
			{label.slice(at + highlight.length)}
		</>
	);
}

interface BodyRowProps {
	index: number;
	row: MatrixRow;
	rowDimensions: string[];
	cells: string[];
	// How each cell is drawn, or null where the visual has no rules or scales.
	looks: CellAppearance[] | null;
	// Shaded, by the row's place in the list.
	alt: boolean;
	measureCount: number;
	columnChosen: boolean[] | null;
	isOpen: boolean;
	isLoading: boolean;
	chosen: boolean;
	dimmed: boolean;
	// The search term when this row is one of its matches.
	highlight: string | null;
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
	looks,
	alt,
	measureCount,
	columnChosen,
	isOpen,
	isLoading,
	chosen,
	dimmed,
	highlight,
	selectable,
	onToggle,
	onSelect,
	measure,
}: BodyRowProps) {
	const label = markedLabel(row.label, highlight);
	return (
		<tr
			data-index={index}
			ref={measure}
			tabIndex={-1}
			className={`${styles.row} ${
				styles[`level${Math.min(row.depth, 3)}`] ?? ""
			} ${alt ? styles.rowAlt : ""} ${chosen ? styles.rowChosen : ""} ${
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
						{label}
					</button>
				) : (
					label
				)}
			</td>

			{cells.map((text, c) => {
				const group = Math.floor(c / measureCount);
				const columnDimmed =
					columnChosen !== null && !columnChosen[group];
				const look = looks?.[c];
				return (
					<td
						key={c}
						className={`${styles.cell} ${
							c % measureCount === 0 ? styles.groupStart : ""
						} ${columnDimmed ? styles.cellDimmed : ""}`}
						style={
							look
								? {
										background: look.background,
										color: look.color,
										fontWeight: look.bold ? 600 : undefined,
									}
								: undefined
						}
					>
						{look?.bar && (
							<span
								className={styles.dataBar}
								style={{
									width: `${look.bar.width}%`,
									background: look.bar.color,
								}}
								aria-hidden="true"
							/>
						)}
						<span className={styles.cellText}>
							{look?.marker && <>{look.marker} </>}
							{text}
						</span>
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
