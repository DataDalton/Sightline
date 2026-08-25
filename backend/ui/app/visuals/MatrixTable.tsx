"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatValue, type FormatHint } from "../../lib/format";
import type { VisualStyle } from "../../lib/visuals/style";
import { VisualError } from "./VisualFrame";
import { VisualLoadingState } from "./LoadingState";
import { createResultMemo, resultMaxAgeMs } from "./resultMemo";
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
	// Values keyed by "columnValue||measure", or by measure alone when there is
	// no pivoted column.
	values: Record<string, unknown>;
	hasChildren: boolean;
}

function cellKey(columnValue: string | null, measure: string): string {
	return columnValue === null ? measure : `${columnValue}||${measure}`;
}

function pathKey(path: string[]): string {
	return path.join("||");
}

// The top level of each matrix, kept across mounts, so returning to a report
// does not re-ask for the rows the reader just waited for.
interface TopLevel {
	rows: MatrixRow[];
	columnValues: string[];
}

const topLevels = createResultMemo<TopLevel>(40, resultMaxAgeMs);

export function MatrixTable({
	sourceKey,
	rowDimensions,
	columnDimension,
	measures,
	baseFilters = [],
	fields,
	height = 520,
	style,
}: MatrixProps) {
	const [rows, setRows] = useState<MatrixRow[]>([]);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
	const [columnValues, setColumnValues] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<(Error & { status?: number }) | null>(
		null,
	);

	const baseKey = JSON.stringify(baseFilters);

	// Fetches one level: the children of `path`, or the top level when empty.
	const fetchLevel = useCallback(
		async (path: string[]): Promise<MatrixRow[]> => {
			const depth = path.length;
			const dimension = rowDimensions[depth];
			if (!dimension) return [];

			// Scope to the ancestors, so expanding "2025 / Medical" asks only
			// for business units inside it.
			const scope: FilterClause[] = [
				...(baseFilters as FilterClause[]),
				...path.map((value, i) => ({
					field: rowDimensions[i],
					op: "eq",
					values: [value],
				})),
			];

			const response = await fetch("/api/query", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sourceKey,
					dimensions: columnDimension
						? [dimension, columnDimension]
						: [dimension],
					measures,
					filters: scope,
					sort: [{ field: dimension, direction: "asc" }],
					limit: 2000,
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
			const raw: Record<string, unknown>[] = data.rows ?? [];

			// Collapse the pivoted dimension into one row per row-value, with
			// the measures spread across the column groups.
			const byLabel = new Map<string, MatrixRow>();
			const seenColumns = new Set<string>();

			for (const record of raw) {
				const label = String(record[dimension] ?? "");
				const columnValue = columnDimension
					? String(record[columnDimension] ?? "")
					: null;
				if (columnValue !== null) seenColumns.add(columnValue);

				let row = byLabel.get(label);
				if (!row) {
					row = {
						path: [...path, label],
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
					row.values[cellKey(columnValue, measure)] = record[measure];
				}
			}

			if (columnDimension && seenColumns.size > 0) {
				// Column groups accumulate across expansions, so a child that
				// introduces a period the parent lacked still lines up.
				setColumnValues((prev) =>
					Array.from(new Set([...prev, ...seenColumns])).sort(),
				);
			}

			return Array.from(byLabel.values());
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
		setError(null);
		setExpanded(new Set());

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

		fetchLevel([])
			.then((top) => {
				if (cancelled) return;
				setRows(top);
				setLoading(false);
				// Read back from state rather than from the closure, because
				// fetchLevel accumulates the column groups as it goes.
				setColumnValues((current) => {
					topLevels.set(topKey, {
						rows: top,
						columnValues: current,
					});
					return current;
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
			// expansion refetches and cannot show stale figures.
			setExpanded((prev) => {
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
			setRows((prev) =>
				prev.filter(
					(r) =>
						!(
							r.path.length > row.path.length &&
							pathKey(r.path.slice(0, row.path.length)) === key
						),
				),
			);
			return;
		}

		setLoadingPaths((prev) => new Set(prev).add(key));
		try {
			const children = await fetchLevel(row.path);
			setRows((prev) => {
				const index = prev.findIndex((r) => pathKey(r.path) === key);
				if (index < 0) return prev;
				const next = [...prev];
				next.splice(index + 1, 0, ...children);
				return next;
			});
			setExpanded((prev) => new Set(prev).add(key));
		} catch (e) {
			setError(e as Error & { status?: number });
		} finally {
			setLoadingPaths((prev) => {
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
		}
	};

	const collapseAll = () => {
		setExpanded(new Set());
		setRows((prev) => prev.filter((r) => r.depth === 0));
	};

	const hints = useMemo(() => {
		const map = new Map<string, FormatHint>();
		for (const measure of measures) {
			map.set(
				measure,
				(fields.get(measure)?.formatHint as FormatHint) ?? "decimal",
			);
		}
		return map;
	}, [measures, fields]);

	// Column groups: one per pivoted value, or a single unnamed group.
	const groups =
		columnDimension && columnValues.length > 0 ? columnValues : [null];

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

			<div className={styles.scroller}>
				<table className={styles.table}>
					<thead>
						{columnDimension && (
							<tr className={styles.groupHeader}>
								<th className={styles.rowHeader} rowSpan={2}>
									{rowDimensions[0]}
								</th>
								{groups.map((group) => (
									<th
										key={group ?? "all"}
										colSpan={measures.length}
										className={styles.groupStart}
									>
										{group}
									</th>
								))}
							</tr>
						)}
						<tr className={styles.measureHeader}>
							{!columnDimension && (
								<th className={styles.rowHeader}>
									{rowDimensions[0]}
								</th>
							)}
							{groups.map((group) =>
								measures.map((measure, i) => (
									<th
										key={`${group ?? "all"}-${measure}`}
										className={
											i === 0 ? styles.groupStart : ""
										}
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
					<tbody>
						{rows.map((row) => {
							const key = pathKey(row.path);
							const isOpen = expanded.has(key);
							const isLoading = loadingPaths.has(key);

							return (
								<tr
									key={key}
									className={`${styles.row} ${
										styles[
											`level${Math.min(row.depth, 3)}`
										] ?? ""
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
												className={`${styles.expander} ${
													isOpen
														? styles.expanderOpen
														: ""
												}`}
												onClick={() => void toggle(row)}
												aria-expanded={isOpen}
												aria-label={`${isOpen ? "Collapse" : "Expand"} ${row.label}`}
											>
												{isLoading ? (
													<span
														className={styles.hint}
													>
														·
													</span>
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
											<span
												className={styles.leafSpacer}
											/>
										)}
										{row.label}
									</td>

									{groups.map((group) =>
										measures.map((measure, i) => (
											<td
												key={`${group ?? "all"}-${measure}`}
												className={`${styles.cell} ${
													i === 0
														? styles.groupStart
														: ""
												}`}
											>
												{formatValue(
													row.values[
														cellKey(group, measure)
													],
													hints.get(measure) ??
														"decimal",
												)}
											</td>
										)),
									)}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
