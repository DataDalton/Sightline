"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePostResource } from "../hooks/usePostResource";
import styles from "./DataGrid.module.css";

// Per-column sort and value filter.
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
	sourceKey: string;
	// Filters already applied elsewhere in the grid, so this list cascades.
	otherFilters: unknown[];
	selected: string[];
	sortDirection: "asc" | "desc" | null;
	anchor: { x: number; y: number };
	onSort: (direction: "asc" | "desc" | null) => void;
	onApply: (values: string[]) => void;
	onClose: () => void;
}

interface ValuesResponse {
	values: string[];
	truncated: boolean;
}

export function ColumnFilter({
	field,
	sourceKey,
	otherFilters,
	selected,
	sortDirection,
	anchor,
	onSort,
	onApply,
	onClose,
}: ColumnFilterProps) {
	const [search, setSearch] = useState("");
	const [debounced, setDebounced] = useState("");
	const [draft, setDraft] = useState<string[]>(selected);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

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
	}, [onClose]);

	// The panel reopens on the same column constantly, and the answer does not
	// change between one opening and the next. Held by the question rather than
	// by this component, so reopening it costs nothing.
	const { data, error, isLoading } = usePostResource<ValuesResponse>(
		"/api/query/values",
		{
			sourceKey,
			field,
			search: debounced,
			filters: otherFilters,
			limit: 200,
		},
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

	const toggle = (value: string) => {
		setDraft((prev) =>
			prev.includes(value)
				? prev.filter((v) => v !== value)
				: [...prev, value],
		);
	};

	// Keep the panel on screen when the column is near the right edge.
	const left = Math.min(
		anchor.x,
		(typeof window !== "undefined" ? window.innerWidth : 1200) - 296,
	);

	return (
		<div
			ref={panelRef}
			className={styles.popover}
			style={{ left: Math.max(8, left), top: anchor.y }}
			role="dialog"
			aria-label={`Filter and sort ${field}`}
		>
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

			<div className={styles.popoverSearch}>
				<input
					ref={inputRef}
					type="text"
					className={styles.searchInput}
					style={{ paddingLeft: "var(--space-3)" }}
					placeholder={`Search ${field}`}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</div>

			<div className={styles.popoverList}>
				{loading ? (
					<div className={styles.sentinel}>Loading values</div>
				) : error ? (
					<div className={`${styles.sentinel} ${styles.stateError}`}>
						{error.message}
					</div>
				) : listed.length === 0 ? (
					<div className={styles.sentinel}>No matching values</div>
				) : (
					listed.map((value) => {
						const isSelected = draft.includes(value);
						return (
							<button
								key={value}
								type="button"
								className={styles.valueItem}
								onClick={() => toggle(value)}
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
									{value}
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

			<div className={styles.popoverFooter}>
				<button
					type="button"
					className={styles.popoverButton}
					onClick={() => {
						setDraft([]);
						onApply([]);
					}}
				>
					Clear
				</button>
				<button
					type="button"
					className={`${styles.popoverButton} ${styles.popoverPrimary}`}
					onClick={() => onApply(draft)}
				>
					Apply
				</button>
			</div>
		</div>
	);
}
