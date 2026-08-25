"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
	type SearchClause,
	type SearchColumn,
	type SearchCombinator,
	type SearchFilter,
	type SearchOperator,
	columnsByKey,
	isClause,
	operatorLabels,
	operatorsForColumn,
	valuelessOperators,
} from "../../../lib/search/types";
import styles from "./AdvancedSearchBar.module.css";

interface AdvancedSearchBarProps {
	// Filterable columns, supplied by the caller. The component holds no
	// knowledge of any particular schema.
	columns: SearchColumn[];
	// Endpoint queried for distinct values when the picked column is not an
	// enum. Receives column, q and limit query parameters. Omit to disable
	// value suggestions entirely.
	valuesEndpoint?: string;
	// Free-text cross-column LIKE search.
	query: string;
	onQueryChange: (q: string) => void;
	// Structured filters.
	filters: SearchFilter[];
	combinator: SearchCombinator;
	onChange: (filters: SearchFilter[], combinator: SearchCombinator) => void;
	placeholder?: string;
}

// All operators in the order they should appear in the locked top bar.
const operatorOrder: SearchOperator[] = [
	"eq",
	"neq",
	"contains",
	"starts_with",
	"ends_with",
	"like",
	"gt",
	"gte",
	"lt",
	"lte",
	"is_empty",
	"is_not_empty",
];

function defaultOperatorFor(col: SearchColumn | null): SearchOperator {
	if (!col) return "contains";
	const allowed = operatorsForColumn(col);
	if (allowed.includes("contains")) return "contains";
	return allowed[0];
}

function clauseChip(
	clause: SearchClause,
	searchColumnByKey: Record<string, SearchColumn>,
): {
	col: string;
	op: string;
	val: string;
} {
	const colDef = searchColumnByKey[clause.column];
	return {
		col: colDef?.label ?? clause.column,
		op: operatorLabels[clause.op],
		val: valuelessOperators.has(clause.op) ? "" : (clause.value ?? ""),
	};
}

function columnTypeIcon(type: SearchColumn["type"]) {
	if (type === "number") {
		return (
			<svg
				width="11"
				height="11"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2.5"
			>
				<line x1="4" y1="9" x2="20" y2="9" />
				<line x1="4" y1="15" x2="20" y2="15" />
				<line x1="10" y1="3" x2="8" y2="21" />
				<line x1="16" y1="3" x2="14" y2="21" />
			</svg>
		);
	}
	if (type === "date") {
		return (
			<svg
				width="11"
				height="11"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
			>
				<rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
				<line x1="16" y1="2" x2="16" y2="6" />
				<line x1="8" y1="2" x2="8" y2="6" />
				<line x1="3" y1="10" x2="21" y2="10" />
			</svg>
		);
	}
	if (type === "enum") {
		return (
			<svg
				width="11"
				height="11"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
			>
				<polyline points="9 11 12 14 22 4" />
				<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
			</svg>
		);
	}
	return (
		<svg
			width="11"
			height="11"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
		>
			<polyline points="4 7 4 4 20 4 20 7" />
			<line x1="9" y1="20" x2="15" y2="20" />
			<line x1="12" y1="4" x2="12" y2="20" />
		</svg>
	);
}

type Mode = "columns" | "value";

export const AdvancedSearchBar = memo(function AdvancedSearchBar({
	columns,
	valuesEndpoint,
	query,
	onQueryChange,
	filters,
	combinator,
	onChange,
	placeholder = "Search or filter...",
}: AdvancedSearchBarProps) {
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<Mode>("columns");
	const [pendingOp, setPendingOp] = useState<SearchOperator>("contains");
	const [pendingColumn, setPendingColumn] = useState<SearchColumn | null>(
		null,
	);
	const [pendingValue, setPendingValue] = useState("");

	const searchColumns = columns;
	const searchColumnByKey = useMemo(
		() => columnsByKey(searchColumns),
		[searchColumns],
	);

	const [localQuery, setLocalQuery] = useState(query);
	const queryDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const valueInputRef = useRef<HTMLInputElement | null>(null);

	// Keep local input synced if parent resets the query (e.g. clear button).
	useEffect(() => {
		setLocalQuery(query);
	}, [query]);

	useEffect(() => {
		return () => {
			if (queryDebounceRef.current)
				clearTimeout(queryDebounceRef.current);
		};
	}, []);

	// Debounced filter for the column-values fetch so the endpoint is not hit
	// on every keystroke.
	const [valueFilter, setValueFilter] = useState("");
	useEffect(() => {
		const t = setTimeout(() => setValueFilter(pendingValue), 200);
		return () => clearTimeout(t);
	}, [pendingValue]);

	// Fetch available values for the picked column. Skip the fetch for enum
	// columns (their options are static) and valueless operators.
	const shouldFetchValues =
		open &&
		mode === "value" &&
		pendingColumn !== null &&
		pendingColumn.type !== "enum" &&
		Boolean(valuesEndpoint) &&
		!valuelessOperators.has(pendingOp);
	const valuesKey =
		shouldFetchValues && pendingColumn
			? `${valuesEndpoint}?column=${encodeURIComponent(
					pendingColumn.key,
				)}&q=${encodeURIComponent(valueFilter)}&limit=20`
			: null;
	const { data: valuesData, isLoading: valuesLoading } = useSWR<{
		values: string[];
	}>(valuesKey);
	const fetchedValues = valuesData?.values ?? [];

	const closeDropdown = useCallback(() => {
		setOpen(false);
		setMode("columns");
		setPendingColumn(null);
		setPendingValue("");
	}, []);

	const openDropdown = useCallback(() => {
		setOpen(true);
		setMode("columns");
		setPendingColumn(null);
		setPendingValue("");
	}, []);

	// Close on outside click / Escape.
	useEffect(() => {
		if (!open) return;
		const handleClick = (e: MouseEvent) => {
			if (
				wrapperRef.current &&
				!wrapperRef.current.contains(e.target as Node)
			) {
				closeDropdown();
			}
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeDropdown();
		};
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKey);
		};
	}, [open, closeDropdown]);

	// Focus value input on entering value mode.
	useEffect(() => {
		if (open && mode === "value" && valueInputRef.current) {
			valueInputRef.current.focus();
		}
	}, [open, mode]);

	// Free-text input handler - debounce into parent.
	const handleQueryInput = useCallback(
		(next: string) => {
			setLocalQuery(next);
			if (queryDebounceRef.current)
				clearTimeout(queryDebounceRef.current);
			queryDebounceRef.current = setTimeout(() => {
				onQueryChange(next);
			}, 300);
		},
		[onQueryChange],
	);

	// Pressing Enter runs the typed text as the free-text search it already is,
	// matching across every searchable column. It flushes the pending debounce
	// so the search fires immediately instead of waiting out the 300ms, and
	// closes the dropdown so the results are visible. The text stays in the
	// input: it is the active query, not a committed chip.
	const commitFreeText = useCallback(() => {
		const trimmed = localQuery.trim();
		if (!trimmed) return;
		if (queryDebounceRef.current) clearTimeout(queryDebounceRef.current);
		onQueryChange(trimmed);
		closeDropdown();
	}, [localQuery, onQueryChange, closeDropdown]);

	// Clicking the bar only focuses the input. The filter picker is opened
	// deliberately from the Filter button, so typing a search never puts a
	// panel over the results.
	const handleBarClick = useCallback(() => {
		inputRef.current?.focus();
	}, []);

	const pickColumn = useCallback(
		(col: SearchColumn) => {
			const allowed = operatorsForColumn(col);
			const op = allowed.includes(pendingOp)
				? pendingOp
				: defaultOperatorFor(col);
			setPendingColumn(col);
			setPendingOp(op);
			setPendingValue("");
			setMode("value");
		},
		[pendingOp],
	);

	const goBackToColumns = useCallback(() => {
		setMode("columns");
		setPendingColumn(null);
		setPendingValue("");
	}, []);

	const commitFilter = useCallback(
		(valueOverride?: string) => {
			if (!pendingColumn) return;
			const value = valueOverride ?? pendingValue;
			const valueless = valuelessOperators.has(pendingOp);
			if (!valueless && value.trim() === "") return;
			const clause: SearchClause = {
				kind: "clause",
				column: pendingColumn.key,
				op: pendingOp,
				value: valueless ? undefined : value,
			};
			onChange([...filters, clause], combinator);
			// Close the dropdown after committing. User reopens by clicking
			// the bar again to add another filter.
			closeDropdown();
		},
		[
			pendingColumn,
			pendingValue,
			pendingOp,
			filters,
			combinator,
			onChange,
			closeDropdown,
		],
	);

	const removeFilter = useCallback(
		(index: number) => {
			const next = filters.filter((_, i) => i !== index);
			onChange(next, combinator);
		},
		[filters, combinator, onChange],
	);

	const toggleCombinator = useCallback(() => {
		onChange(filters, combinator === "and" ? "or" : "and");
	}, [filters, combinator, onChange]);

	const clearAll = useCallback(() => {
		onChange([], combinator);
		if (localQuery) {
			setLocalQuery("");
			onQueryChange("");
		}
	}, [combinator, onChange, localQuery, onQueryChange]);

	// Add an empty nested group whose internal combinator is the opposite of
	// the top-level one. The group is read-only in this UI for now (delete-only);
	// the data model accepts arbitrary nesting on the server.
	const addGroup = useCallback(() => {
		const inner: SearchCombinator = combinator === "and" ? "or" : "and";
		onChange(
			[...filters, { kind: "group", combinator: inner, filters: [] }],
			combinator,
		);
		closeDropdown();
	}, [filters, combinator, onChange, closeDropdown]);

	// Operators allowed for the currently-picked column.
	const allowedOps = useMemo<Set<SearchOperator>>(
		() =>
			new Set(
				pendingColumn
					? operatorsForColumn(pendingColumn)
					: operatorOrder,
			),
		[pendingColumn],
	);

	const chips = useMemo(() => {
		const nodes: React.ReactNode[] = [];
		filters.forEach((f, i) => {
			if (i > 0) {
				nodes.push(
					<button
						key={`conn-${i}`}
						type="button"
						className={styles.connector}
						onClick={(e) => {
							e.stopPropagation();
							toggleCombinator();
						}}
						title={`Toggle to ${combinator === "and" ? "OR" : "AND"}`}
					>
						{combinator.toUpperCase()}
					</button>,
				);
			}
			if (!isClause(f)) {
				nodes.push(
					<span key={`group-${i}`} className={styles.chip}>
						<span className={styles.chipCol}>Group</span>
						<span className={styles.chipOp}>
							({f.filters.length})
						</span>
						<button
							type="button"
							className={styles.chipRemove}
							onClick={(e) => {
								e.stopPropagation();
								removeFilter(i);
							}}
							title="Remove group"
						>
							<svg
								width="10"
								height="10"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="3"
							>
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</span>,
				);
				return;
			}
			const c = clauseChip(f, searchColumnByKey);
			nodes.push(
				<span key={`chip-${i}`} className={styles.chip}>
					<span className={styles.chipCol}>{c.col}</span>
					<span className={styles.chipOp}>{c.op}</span>
					{c.val && <span className={styles.chipVal}>{c.val}</span>}
					<button
						type="button"
						className={styles.chipRemove}
						onClick={(e) => {
							e.stopPropagation();
							removeFilter(i);
						}}
						title="Remove filter"
					>
						<svg
							width="10"
							height="10"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="3"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</span>,
			);
		});
		return nodes;
	}, [filters, combinator, removeFilter, toggleCombinator]);

	const hasAnyState = filters.length > 0 || localQuery.length > 0;

	return (
		<div ref={wrapperRef} className={styles.wrapper}>
			<div
				className={`${styles.bar} ${open ? styles.barOpen : ""}`}
				onClick={handleBarClick}
			>
				<svg
					className={styles.searchIcon}
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
				>
					<circle cx="11" cy="11" r="8" />
					<line x1="21" y1="21" x2="16.65" y2="16.65" />
				</svg>
				<input
					ref={inputRef}
					type="text"
					className={styles.input}
					value={localQuery}
					placeholder={filters.length === 0 ? placeholder : ""}
					onChange={(e) => handleQueryInput(e.target.value)}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commitFreeText();
						}
					}}
				/>
				{filters.length > 0 && (
					<div className={styles.chips}>{chips}</div>
				)}
				{hasAnyState && (
					<button
						type="button"
						className={styles.chevron}
						onClick={(e) => {
							e.stopPropagation();
							clearAll();
						}}
						title="Clear all"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				)}
				<button
					type="button"
					className={`${styles.filterButton} ${open ? styles.filterButtonOpen : ""}`}
					onClick={(e) => {
						e.stopPropagation();
						if (open) closeDropdown();
						else openDropdown();
					}}
					title={open ? "Close filter picker" : "Add a column filter"}
				>
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
					>
						<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
					</svg>
					Filter
				</button>
			</div>

			{open && (
				<div className={styles.dropdown}>
					<div className={styles.operatorBar}>
						<span className={styles.operatorLabel}>Operator</span>
						{operatorOrder.map((op) => {
							const enabled = allowedOps.has(op);
							const active = pendingOp === op;
							return (
								<button
									key={op}
									type="button"
									className={`${styles.operatorPill} ${active ? styles.operatorPillActive : ""}`}
									onClick={() => setPendingOp(op)}
									disabled={!enabled}
									title={
										enabled
											? operatorLabels[op]
											: "Not valid for this column type"
									}
								>
									{operatorLabels[op]}
								</button>
							);
						})}
					</div>

					{mode === "columns" ? (
						<div className={styles.body}>
							<div className={styles.sectionTitle}>
								Filter by column
							</div>
							<div className={styles.columnList}>
								{searchColumns.length === 0 ? (
									<div className={styles.empty}>
										No filterable columns
									</div>
								) : (
									searchColumns.map((col) => (
										<button
											key={col.key}
											type="button"
											className={styles.columnItem}
											onClick={() => pickColumn(col)}
										>
											<span
												className={
													styles.columnItemIcon
												}
											>
												{columnTypeIcon(col.type)}
											</span>
											<span
												className={
													styles.columnItemLabel
												}
											>
												{col.label}
											</span>
											<span
												className={
													styles.columnItemType
												}
											>
												{col.type}
											</span>
										</button>
									))
								)}
								<button
									type="button"
									className={styles.columnItem}
									onClick={addGroup}
									title="Add a nested group of filters"
								>
									<span className={styles.columnItemIcon}>
										<svg
											width="11"
											height="11"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
										>
											<path d="M8 3H5a2 2 0 0 0-2 2v3" />
											<path d="M21 8V5a2 2 0 0 0-2-2h-3" />
											<path d="M3 16v3a2 2 0 0 0 2 2h3" />
											<path d="M16 21h3a2 2 0 0 0 2-2v-3" />
										</svg>
									</span>
									<span className={styles.columnItemLabel}>
										Add group
									</span>
									<span className={styles.columnItemType}>
										nested
									</span>
								</button>
							</div>
						</div>
					) : (
						<div className={styles.body}>
							<div className={styles.valueHeader}>
								<button
									type="button"
									className={styles.backButton}
									onClick={goBackToColumns}
									title="Back to columns"
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
								<span className={styles.valueHeaderLabel}>
									<span className={styles.valueHeaderCol}>
										{pendingColumn?.label}
									</span>
									<span className={styles.valueHeaderOp}>
										{operatorLabels[pendingOp]}
									</span>
								</span>
							</div>
							{(() => {
								if (!pendingColumn) return null;
								const valueless =
									valuelessOperators.has(pendingOp);
								if (valueless) {
									return (
										<div className={styles.valueArea}>
											<span
												className={styles.valuelessHint}
											>
												No value needed for this
												operator.
											</span>
											<div
												className={styles.valueInputRow}
											>
												<button
													type="button"
													className={styles.addButton}
													onClick={() =>
														commitFilter()
													}
												>
													Add filter
												</button>
											</div>
										</div>
									);
								}
								if (
									pendingColumn.type === "enum" &&
									pendingColumn.options
								) {
									return (
										<div className={styles.valueList}>
											{pendingColumn.options.map(
												(opt) => (
													<button
														key={opt.value}
														type="button"
														className={
															styles.valueItem
														}
														onClick={() =>
															commitFilter(
																opt.value,
															)
														}
													>
														{opt.label}
													</button>
												),
											)}
										</div>
									);
								}
								const inputType =
									pendingColumn.type === "number"
										? "number"
										: pendingColumn.type === "date"
											? "date"
											: "text";
								return (
									<div className={styles.valueArea}>
										<div className={styles.valueInputRow}>
											<input
												ref={valueInputRef}
												type={inputType}
												className={styles.valueInput}
												value={pendingValue}
												placeholder={`Filter or type a value for ${pendingColumn.label}`}
												onChange={(e) =>
													setPendingValue(
														e.target.value,
													)
												}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														e.preventDefault();
														commitFilter();
													}
												}}
											/>
											<button
												type="button"
												className={styles.addButton}
												onClick={() => commitFilter()}
												disabled={
													pendingValue.trim() === ""
												}
											>
												Add
											</button>
										</div>
										<div className={styles.valueList}>
											{valuesLoading &&
												fetchedValues.length === 0 && (
													<div
														className={styles.empty}
													>
														Loading values...
													</div>
												)}
											{!valuesLoading &&
												fetchedValues.length === 0 && (
													<div
														className={styles.empty}
													>
														{pendingValue
															? "No matching values. Press Enter to use what you typed."
															: "No values yet."}
													</div>
												)}
											{fetchedValues.map((v, idx) => (
												<button
													key={`${idx}-${v}`}
													type="button"
													className={styles.valueItem}
													onClick={() =>
														commitFilter(v)
													}
													title={v}
												>
													{v}
												</button>
											))}
										</div>
									</div>
								);
							})()}
						</div>
					)}
				</div>
			)}
		</div>
	);
});
