"use client";

import { Fragment, useCallback, useMemo, memo } from "react";
import { ColumnFilter, type ColumnFilterOption } from "./ColumnFilter";
import styles from "./DataTable.module.css";

interface Column<T> {
	key: string;
	header: string;
	width?: string;
	sortable?: boolean;
	// Renders a funnel button in the header that opens a checkbox value filter.
	// Requires `columnFilters` and `onColumnFilterChange` on the table.
	filterable?: boolean;
	render?: (value: any, row: T) => React.ReactNode;
	// Replaces the header text with custom content, e.g. a select-all checkbox.
	// `header` is still used as the column filter's label.
	renderHeader?: () => React.ReactNode;
	// Text used for filtering and sorting when the value isn't `row[key]`,
	// e.g. a column rendered from a nested object.
	filterValue?: (row: T) => string;
}

// Selected filter values per column key. An empty or missing array means the
// column isn't filtered.
type ColumnFilterState = Record<string, string[]>;

// The comparable text for a cell, used to build the filter option list and to
// match rows against selected values.
function columnFilterValue<T extends Record<string, any>>(
	col: Column<T>,
	row: T,
): string {
	const raw = col.filterValue ? col.filterValue(row) : row[col.key];
	return raw === null || raw === undefined ? "" : String(raw);
}

// Keeps rows whose value in each filtered column is one of the selected
// values. Columns filter each other down (AND across columns, OR within one).
function applyColumnFilters<T extends Record<string, any>>(
	rows: T[],
	columns: Column<T>[],
	filters: ColumnFilterState,
): T[] {
	const active = columns
		.map((col) => ({ col, values: filters[col.key] }))
		.filter(
			(entry): entry is { col: Column<T>; values: string[] } =>
				Array.isArray(entry.values) && entry.values.length > 0,
		)
		.map(({ col, values }) => ({ col, values: new Set(values) }));
	if (active.length === 0) return rows;
	return rows.filter((row) =>
		active.every(({ col, values }) =>
			values.has(columnFilterValue(col, row)),
		),
	);
}

interface PaginationInfo {
	page: number;
	pageSize: number;
	totalCount: number;
	totalPages: number;
}

interface DataTableProps<T> {
	columns: Column<T>[];
	data: T[];
	pagination?: PaginationInfo;
	loading?: boolean;
	sortKey?: string;
	sortDirection?: "asc" | "desc";
	emptyMessage?: string;
	hidePagination?: boolean;
	onPageChange?: (page: number) => void;
	onPageSizeChange?: (pageSize: number) => void;
	onSort?: (key: string, direction: "asc" | "desc") => void;
	onRowClick?: (row: T) => void;
	expandedRowId?: string | number | null;
	getRowId?: (row: T) => string | number;
	renderExpanded?: (row: T) => React.ReactNode;
	// Optional "Add" action rendered as a footer row inside the table.
	// When the table is empty, this row replaces the empty-state message.
	addAction?: { label: string; onClick: () => void };
	// Selected values per filterable column. The parent owns this state and is
	// responsible for filtering `data` (use `applyColumnFilters`), so its own
	// row bookkeeping stays aligned with what the table shows.
	columnFilters?: ColumnFilterState;
	onColumnFilterChange?: (key: string, values: string[]) => void;
	// Rows the filter option lists are built from. Defaults to `data`; pass the
	// unfiltered rows so a column's options don't disappear once it's filtered.
	filterOptionRows?: T[];
	// Drops the table's own border, radius and background so it can sit flush
	// inside a card that already provides them, instead of drawing a second box
	// inside the first.
	flush?: boolean;
}

const pageSizeOptions = [10, 25, 50];

function DataTableInner<T extends Record<string, any>>({
	columns,
	data,
	pagination,
	loading = false,
	sortKey,
	sortDirection,
	emptyMessage = "No data available",
	hidePagination = false,
	onPageChange,
	onPageSizeChange,
	onSort,
	onRowClick,
	expandedRowId,
	getRowId,
	renderExpanded,
	addAction,
	columnFilters,
	onColumnFilterChange,
	filterOptionRows,
	flush = false,
}: DataTableProps<T>) {
	const page = pagination?.page ?? 1;
	const pageSize = pagination?.pageSize ?? 25;
	const totalCount = pagination?.totalCount ?? 0;
	const totalPages = pagination?.totalPages ?? 1;
	const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
	const rangeEnd = Math.min(page * pageSize, totalCount);

	const handleSort = useCallback(
		(key: string) => {
			if (!onSort) return;
			const newDirection =
				sortKey === key && sortDirection === "asc" ? "desc" : "asc";
			onSort(key, newDirection);
		},
		[onSort, sortKey, sortDirection],
	);

	const handlePageSizeChange = useCallback(
		(e: React.ChangeEvent<HTMLSelectElement>) => {
			onPageSizeChange?.(Number(e.target.value));
		},
		[onPageSizeChange],
	);

	// Distinct values per filterable column, counted across the option rows.
	// Blanks sort last so real values stay at the top of the list.
	const optionRows = filterOptionRows ?? data;
	const filterOptions = useMemo(() => {
		const result: Record<string, ColumnFilterOption[]> = {};
		for (const col of columns) {
			if (!col.filterable) continue;
			const counts = new Map<string, number>();
			for (const row of optionRows) {
				const value = columnFilterValue(col, row);
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
			result[col.key] = [...counts.entries()]
				.map(([value, count]) => ({ value, count }))
				.sort((a, b) => {
					if (a.value === "") return 1;
					if (b.value === "") return -1;
					return a.value.localeCompare(b.value, undefined, {
						numeric: true,
						sensitivity: "base",
					});
				});
		}
		return result;
	}, [columns, optionRows]);

	return (
		<div
			className={`${styles.wrapper} ${flush ? styles.wrapperFlush : ""}`}
		>
			{addAction && (
				<div className={styles.addActionBar}>
					<button
						type="button"
						className={styles.addActionButton}
						onClick={addAction.onClick}
					>
						<svg
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
						>
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
						{addAction.label}
					</button>
				</div>
			)}
			<div className={styles.tableContainer}>
				<table className={styles.table}>
					<thead className={styles.thead}>
						<tr>
							{columns.map((col) => (
								<th
									key={col.key}
									className={`${styles.th} ${col.sortable ? styles.sortable : ""} ${
										sortKey === col.key
											? styles.sortActive
											: ""
									}`}
									style={
										col.width
											? { width: col.width }
											: undefined
									}
									onClick={
										col.sortable
											? () => handleSort(col.key)
											: undefined
									}
								>
									<span className={styles.thContent}>
										{col.renderHeader
											? col.renderHeader()
											: col.header}
										{col.sortable && (
											<svg
												className={`${styles.sortIcon} ${
													sortKey === col.key &&
													sortDirection === "desc"
														? styles.sortDesc
														: ""
												}`}
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
											>
												<polyline points="6 9 12 15 18 9" />
											</svg>
										)}
										{col.filterable &&
											onColumnFilterChange && (
												<ColumnFilter
													label={col.header}
													options={
														filterOptions[
															col.key
														] ?? []
													}
													selected={
														columnFilters?.[
															col.key
														] ?? []
													}
													onChange={(values) =>
														onColumnFilterChange(
															col.key,
															values,
														)
													}
												/>
											)}
									</span>
								</th>
							))}
						</tr>
					</thead>
					<tbody className={styles.tbody}>
						{loading ? (
							Array.from({ length: 5 }).map((_, i) => (
								<tr
									key={`skeleton-${i}`}
									className={styles.skeletonRow}
								>
									{columns.map((col) => (
										<td key={col.key} className={styles.td}>
											<div className={styles.skeleton} />
										</td>
									))}
								</tr>
							))
						) : data.length === 0 ? (
							<tr>
								<td
									className={styles.emptyCell}
									colSpan={columns.length}
								>
									{emptyMessage}
								</td>
							</tr>
						) : (
							data.map((row, rowIndex) => {
								const rowId = getRowId
									? getRowId(row)
									: rowIndex;
								const isExpanded =
									renderExpanded != null &&
									expandedRowId != null &&
									rowId === expandedRowId;
								return (
									<Fragment key={rowId}>
										<tr
											className={`${styles.row} ${onRowClick ? styles.clickable : ""} ${isExpanded ? styles.rowExpanded : ""}`}
											onClick={
												onRowClick
													? () => onRowClick(row)
													: undefined
											}
										>
											{columns.map((col) => (
												<td
													key={col.key}
													className={styles.td}
												>
													{col.render
														? col.render(
																row[col.key],
																row,
															)
														: (row[col.key] ?? "")}
												</td>
											))}
										</tr>
										{isExpanded && (
											<tr className={styles.expandedRow}>
												<td
													className={
														styles.expandedCell
													}
													colSpan={columns.length}
												>
													{renderExpanded!(row)}
												</td>
											</tr>
										)}
									</Fragment>
								);
							})
						)}
					</tbody>
				</table>
			</div>

			{!hidePagination && pagination && (
				<div className={styles.paginationBar}>
					<div className={styles.paginationInfo}>
						Showing {rangeStart}-{rangeEnd} of {totalCount}
					</div>
					<div className={styles.paginationControls}>
						<div className={styles.pageSizeControl}>
							<span className={styles.pageSizeLabel}>Rows:</span>
							<select
								className={styles.pageSizeSelect}
								value={pageSize}
								onChange={handlePageSizeChange}
							>
								{pageSizeOptions.map((size) => (
									<option key={size} value={size}>
										{size}
									</option>
								))}
							</select>
						</div>
						<div className={styles.pageNav}>
							<button
								className={styles.pageButton}
								onClick={() => onPageChange?.(1)}
								disabled={page <= 1 || loading}
								title="First page"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
								>
									<polyline points="11 17 6 12 11 7" />
									<polyline points="18 17 13 12 18 7" />
								</svg>
							</button>
							<button
								className={styles.pageButton}
								onClick={() => onPageChange?.(page - 1)}
								disabled={page <= 1 || loading}
								title="Previous page"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
								>
									<polyline points="15 18 9 12 15 6" />
								</svg>
							</button>
							<span className={styles.pageIndicator}>
								{page} / {totalPages}
							</span>
							<button
								className={styles.pageButton}
								onClick={() => onPageChange?.(page + 1)}
								disabled={page >= totalPages || loading}
								title="Next page"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
								>
									<polyline points="9 18 15 12 9 6" />
								</svg>
							</button>
							<button
								className={styles.pageButton}
								onClick={() => onPageChange?.(totalPages)}
								disabled={page >= totalPages || loading}
								title="Last page"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
								>
									<polyline points="13 17 18 12 13 7" />
									<polyline points="6 17 11 12 6 7" />
								</svg>
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export const DataTable = memo(DataTableInner) as typeof DataTableInner;

export { applyColumnFilters };
export type { Column, PaginationInfo, DataTableProps, ColumnFilterState };
