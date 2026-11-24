"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePostResource } from "../hooks/usePostResource";
import {
	conditionComplete,
	conditionLabels,
	conditionsFor,
	dateConditionLabels,
	parseAmount,
	type ColumnCondition,
	type ColumnKind,
	type ConditionOp,
} from "../../lib/query/searchText";
import styles from "./DataGrid.module.css";

// Per-column sort and filter.
//
// A column of words is filtered by picking values, kept or left out. A column
// of figures or dates is filtered by a condition, such as greater than 50k or
// on or after a date. A figure that is also a field people group by, such as
// a year, offers both.
//
// The value list comes from the warehouse rather than from the loaded page,
// because with infinite scroll the loaded rows are only a window: filtering on
// what happens to be in memory would silently hide values the user has not
// scrolled to yet. The list also respects the other active filters, so it
// narrows as the grid narrows.

export interface ColumnFilterState {
	field: string;
	values: string[];
}

interface ColumnFilterProps {
	field: string;
	// What a reader calls the column, where it differs from the field.
	label?: string;
	sourceKey: string;
	// Filters already applied elsewhere in the grid, so this list cascades.
	otherFilters: unknown[];
	selected: string[];
	sortDirection: "asc" | "desc" | null;
	// Off where sorting by this field means nothing on its own, such as one
	// level of a matrix, which is sorted from its headings instead.
	sortable?: boolean;
	anchor: { x: number; y: number };
	onSort: (direction: "asc" | "desc" | null) => void;
	onApply: (values: string[], exclude?: boolean) => void;
	onClose: () => void;
	// What the column holds, which decides the conditions offered.
	kind?: ColumnKind;
	// Off for a figure worked out per row, such as a total, which has no list
	// of values to pick from.
	allowValues?: boolean;
	// Whether picked values can be left out rather than kept.
	canExclude?: boolean;
	excluded?: boolean;
	// Given, a condition can be set. Called with null to clear it.
	condition?: ColumnCondition | null;
	onCondition?: (condition: ColumnCondition | null) => void;
}

interface ValuesResponse {
	values: string[];
	truncated: boolean;
}

function conditionLabel(op: ConditionOp, kind: ColumnKind): string {
	return kind === "date"
		? (dateConditionLabels[op] ?? conditionLabels[op])
		: conditionLabels[op];
}

export function ColumnFilter({
	field,
	label,
	sourceKey,
	otherFilters,
	selected,
	sortDirection,
	sortable = true,
	anchor,
	onSort,
	onApply,
	onClose,
	kind = "text",
	allowValues = true,
	canExclude = false,
	excluded = false,
	condition = null,
	onCondition,
}: ColumnFilterProps) {
	const named = label ?? field;
	const offersCondition = Boolean(onCondition) && kind !== "text";
	const [mode, setMode] = useState<"values" | "condition">(
		!allowValues ||
			(offersCondition && (condition || selected.length === 0))
			? "condition"
			: "values",
	);
	const [search, setSearch] = useState("");
	const [debounced, setDebounced] = useState("");
	const [draft, setDraft] = useState<string[]>(selected);
	const [leaveOut, setLeaveOut] = useState(excluded);
	const ops = conditionsFor[kind];
	const [op, setOp] = useState<ConditionOp>(condition?.op ?? ops[0]);
	const [value, setValue] = useState(condition?.value ?? "");
	const [value2, setValue2] = useState(condition?.value2 ?? "");
	const panelRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const numeric = kind === "number";
	const drafted: ColumnCondition = {
		op,
		...(op === "is_empty" || op === "is_not_empty" ? {} : { value }),
		...(op === "between" ? { value2 } : {}),
	};
	const ready = conditionComplete(drafted, numeric);

	// Typing hits the warehouse, so the request waits for a pause rather than
	// firing per keystroke.
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(search), 250);
		return () => clearTimeout(timer);
	}, [search]);

	useEffect(() => {
		inputRef.current?.focus();
		const onClick = (e: MouseEvent) => {
			if (
				panelRef.current &&
				!panelRef.current.contains(e.target as Node)
			) {
				onClose();
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", onClick);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onClick);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose, mode]);

	// The panel reopens on the same column constantly, and the answer does not
	// change between one opening and the next. Held by the question rather than
	// by this component, so reopening it costs nothing. Not asked for at all
	// while a condition is being set.
	const { data, error, isLoading } = usePostResource<ValuesResponse>(
		"/api/query/values",
		mode === "values" && allowValues
			? {
					sourceKey,
					field,
					search: debounced,
					filters: otherFilters,
					limit: 200,
				}
			: null,
	);

	const values = useMemo(() => data?.values ?? [], [data]);
	const truncated = data?.truncated ?? false;
	const loading = isLoading;

	// Selected values stay visible even when a search would exclude them, so a
	// user can always see and undo what they picked.
	const listed = useMemo(() => {
		const set = new Set(values);
		const pinned = draft.filter((v) => !set.has(v));
		return [...pinned, ...values];
	}, [values, draft]);

	const toggle = (picked: string) => {
		setDraft((prev) =>
			prev.includes(picked)
				? prev.filter((v) => v !== picked)
				: [...prev, picked],
		);
	};

	// What an amount reads as, so "50k" is seen to mean 50,000 before it is
	// applied.
	const readAs = (text: string) => {
		const amount = numeric ? parseAmount(text) : null;
		return amount === null || text.trim() === ""
			? null
			: amount.toLocaleString("en-US");
	};

	const apply = () => {
		if (mode === "condition") {
			if (ready) onCondition?.(drafted);
			return;
		}
		onApply(draft, canExclude ? leaveOut : undefined);
	};

	const clear = () => {
		if (mode === "condition") onCondition?.(null);
		else {
			setDraft([]);
			onApply([]);
		}
	};

	// Keep the panel on screen when the column is near the right edge.
	const left = Math.min(
		anchor.x,
		(typeof window !== "undefined" ? window.innerWidth : 1200) - 296,
	);

	const inputType = kind === "date" ? "date" : "text";

	return (
		<div
			ref={panelRef}
			className={styles.popover}
			style={{ left: Math.max(8, left), top: anchor.y }}
			role="dialog"
			aria-label={`Filter and sort ${named}`}
		>
			{sortable && (
				<div className={styles.popoverSort}>
					<button
						type="button"
						className={`${styles.sortButton} ${
							sortDirection === "asc" ? styles.sortActive : ""
						}`}
						onClick={() =>
							onSort(sortDirection === "asc" ? null : "asc")
						}
					>
						↑ Asc
					</button>
					<button
						type="button"
						className={`${styles.sortButton} ${
							sortDirection === "desc" ? styles.sortActive : ""
						}`}
						onClick={() =>
							onSort(sortDirection === "desc" ? null : "desc")
						}
					>
						↓ Desc
					</button>
				</div>
			)}

			{offersCondition && allowValues && (
				<div
					className={styles.popoverModes}
					role="group"
					aria-label="How to filter"
				>
					<button
						type="button"
						className={
							mode === "condition"
								? styles.popoverModeOn
								: styles.popoverMode
						}
						aria-pressed={mode === "condition"}
						onClick={() => setMode("condition")}
					>
						{kind === "date" ? "Date range" : "Condition"}
					</button>
					<button
						type="button"
						className={
							mode === "values"
								? styles.popoverModeOn
								: styles.popoverMode
						}
						aria-pressed={mode === "values"}
						onClick={() => setMode("values")}
					>
						Values
					</button>
				</div>
			)}

			{mode === "condition" ? (
				<form
					className={styles.condition}
					onSubmit={(e) => {
						e.preventDefault();
						apply();
					}}
				>
					<select
						className={styles.conditionSelect}
						value={op}
						onChange={(e) => setOp(e.target.value as ConditionOp)}
						aria-label={`Condition on ${named}`}
					>
						{ops.map((choice) => (
							<option key={choice} value={choice}>
								{conditionLabel(choice, kind)}
							</option>
						))}
					</select>
					{op !== "is_empty" && op !== "is_not_empty" && (
						<div className={styles.conditionValues}>
							<input
								ref={inputRef}
								type={inputType}
								inputMode={numeric ? "decimal" : undefined}
								className={styles.conditionInput}
								value={value}
								onChange={(e) => setValue(e.target.value)}
								placeholder={
									numeric ? "50k, 1.2m, 300" : undefined
								}
								aria-label={op === "between" ? "From" : "Value"}
							/>
							{op === "between" && (
								<>
									<span className={styles.conditionAnd}>
										and
									</span>
									<input
										type={inputType}
										inputMode={
											numeric ? "decimal" : undefined
										}
										className={styles.conditionInput}
										value={value2}
										onChange={(e) =>
											setValue2(e.target.value)
										}
										placeholder={numeric ? "2m" : undefined}
										aria-label="To"
									/>
								</>
							)}
						</div>
					)}
					{numeric && (readAs(value) || readAs(value2)) && (
						<p className={styles.conditionHint}>
							{readAs(value)}
							{op === "between" && readAs(value2)
								? ` to ${readAs(value2)}`
								: ""}
						</p>
					)}
					{/* Enter applies. Hidden, since the footer holds the button. */}
					<button type="submit" hidden />
				</form>
			) : (
				<>
					<div className={styles.popoverSearch}>
						<input
							ref={inputRef}
							type="text"
							className={styles.searchInput}
							style={{ paddingLeft: "var(--space-3)" }}
							placeholder={`Search ${named}`}
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>

					<div className={styles.popoverList}>
						{loading ? (
							<div className={styles.sentinel}>
								Loading values
							</div>
						) : error ? (
							<div
								className={`${styles.sentinel} ${styles.stateError}`}
							>
								{error.message}
							</div>
						) : listed.length === 0 ? (
							<div className={styles.sentinel}>
								No matching values
							</div>
						) : (
							listed.map((item) => {
								const isSelected = draft.includes(item);
								return (
									<button
										key={item}
										type="button"
										className={styles.valueItem}
										onClick={() => toggle(item)}
										aria-pressed={isSelected}
									>
										<span
											className={`${styles.checkbox} ${
												isSelected ? styles.checked : ""
											}`}
											aria-hidden="true"
										>
											<svg
												width="9"
												height="9"
												viewBox="0 0 16 16"
												fill="none"
											>
												<path
													d="M3 8.5l3.5 3.5L13 5"
													stroke="currentColor"
													strokeWidth="2.5"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										</span>
										<span className={styles.valueLabel}>
											{item}
										</span>
									</button>
								);
							})
						)}
					</div>

					{truncated && (
						<div className={styles.truncatedNote}>
							Showing first 200. Type to narrow.
						</div>
					)}

					{canExclude && (
						<label className={styles.excludeToggle}>
							<input
								type="checkbox"
								checked={leaveOut}
								onChange={(e) => setLeaveOut(e.target.checked)}
							/>
							Leave out the picked values
						</label>
					)}
				</>
			)}

			<div className={styles.popoverFooter}>
				<button
					type="button"
					className={styles.popoverButton}
					onClick={clear}
				>
					Clear
				</button>
				<button
					type="button"
					className={`${styles.popoverButton} ${styles.popoverPrimary}`}
					onClick={apply}
					disabled={mode === "condition" && !ready}
				>
					Apply
				</button>
			</div>
		</div>
	);
}
