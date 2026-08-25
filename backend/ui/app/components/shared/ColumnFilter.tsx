"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./ColumnFilter.module.css";

// A distinct value found in a column, with how many rows carry it.
export interface ColumnFilterOption {
	value: string;
	count: number;
}

interface ColumnFilterProps {
	// Column header text, used in the popover title and button tooltip.
	label: string;
	// Every distinct value in the column, derived from the unfiltered rows so
	// the list doesn't shrink as selections are made.
	options: ColumnFilterOption[];
	// Currently checked values. Empty means the column isn't filtered.
	selected: string[];
	onChange: (values: string[]) => void;
}

// Label shown for rows whose value is null or an empty string.
export const blankFilterLabel = "(Blank)";

// Popover width, used to keep the panel inside the viewport.
const panelWidth = 240;

export function ColumnFilter({
	label,
	options,
	selected,
	onChange,
}: ColumnFilterProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [position, setPosition] = useState<{ top: number; left: number }>({
		top: 0,
		left: 0,
	});
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);

	const selectedSet = useMemo(() => new Set(selected), [selected]);
	const active = selected.length > 0;

	// The panel is fixed-positioned so the table container's horizontal scroll
	// can't clip it. Position is measured from the button and refreshed while
	// the popover is open.
	const updatePosition = useCallback(() => {
		const rect = buttonRef.current?.getBoundingClientRect();
		if (!rect) return;
		const left = Math.max(
			8,
			Math.min(rect.left, window.innerWidth - panelWidth - 8),
		);
		setPosition({ top: rect.bottom + 4, left });
	}, []);

	const closePanel = useCallback(() => {
		setOpen(false);
		setSearch("");
	}, []);

	useEffect(() => {
		if (!open) return;
		updatePosition();
		searchRef.current?.focus();

		const handleClick = (e: MouseEvent) => {
			const target = e.target as Node;
			if (
				panelRef.current?.contains(target) ||
				buttonRef.current?.contains(target)
			) {
				return;
			}
			closePanel();
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closePanel();
		};
		// Capture-phase scroll so the panel tracks the button when any ancestor
		// scrolls, not just the window.
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKey);
		window.addEventListener("scroll", updatePosition, true);
		window.addEventListener("resize", updatePosition);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKey);
			window.removeEventListener("scroll", updatePosition, true);
			window.removeEventListener("resize", updatePosition);
		};
	}, [open, updatePosition, closePanel]);

	const visibleOptions = useMemo(() => {
		const needle = search.trim().toLowerCase();
		if (!needle) return options;
		return options.filter((opt) => {
			const text = opt.value === "" ? blankFilterLabel : opt.value;
			return text.toLowerCase().includes(needle);
		});
	}, [options, search]);

	const toggleValue = useCallback(
		(value: string) => {
			if (selectedSet.has(value)) {
				onChange(selected.filter((v) => v !== value));
			} else {
				onChange([...selected, value]);
			}
		},
		[selected, selectedSet, onChange],
	);

	// Adds every value currently listed (respecting the search box) to the
	// selection, leaving values hidden by the search untouched.
	const selectVisible = useCallback(() => {
		const next = new Set(selected);
		for (const opt of visibleOptions) next.add(opt.value);
		onChange([...next]);
	}, [selected, visibleOptions, onChange]);

	const clearAll = useCallback(() => {
		onChange([]);
	}, [onChange]);

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={`${styles.filterButton} ${active ? styles.filterButtonActive : ""}`}
				onClick={(e) => {
					e.stopPropagation();
					setOpen((o) => !o);
				}}
				title={
					active
						? `${label}: ${selected.length} value${selected.length === 1 ? "" : "s"} selected`
						: `Filter ${label}`
				}
				aria-label={`Filter ${label}`}
				aria-expanded={open}
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill={active ? "currentColor" : "none"}
					stroke="currentColor"
					strokeWidth="2"
				>
					<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
				</svg>
				{active && (
					<span className={styles.filterCount}>
						{selected.length}
					</span>
				)}
			</button>

			{open && (
				<div
					ref={panelRef}
					className={styles.panel}
					style={{ top: position.top, left: position.left }}
					onClick={(e) => e.stopPropagation()}
				>
					<div className={styles.panelHeader}>
						<span className={styles.panelTitle}>{label}</span>
						<button
							type="button"
							className={styles.panelClose}
							onClick={closePanel}
							aria-label="Close filter"
						>
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.5"
							>
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>

					<input
						ref={searchRef}
						type="text"
						className={styles.searchInput}
						value={search}
						placeholder="Type to find values..."
						onChange={(e) => setSearch(e.target.value)}
						onKeyDown={(e) => {
							// Enter checks everything the search narrowed to.
							if (e.key === "Enter") {
								e.preventDefault();
								selectVisible();
							}
						}}
					/>

					<div className={styles.actions}>
						<button
							type="button"
							className={styles.actionLink}
							onClick={selectVisible}
							disabled={visibleOptions.length === 0}
						>
							Select all
						</button>
						<button
							type="button"
							className={styles.actionLink}
							onClick={clearAll}
							disabled={!active}
						>
							Clear
						</button>
					</div>

					<div className={styles.optionList}>
						{visibleOptions.length === 0 ? (
							<div className={styles.empty}>
								No matching values
							</div>
						) : (
							visibleOptions.map((opt) => {
								const text =
									opt.value === ""
										? blankFilterLabel
										: opt.value;
								return (
									<label
										key={opt.value}
										className={styles.option}
										title={text}
									>
										<input
											type="checkbox"
											className={styles.optionCheckbox}
											checked={selectedSet.has(opt.value)}
											onChange={() =>
												toggleValue(opt.value)
											}
										/>
										<span className={styles.optionLabel}>
											{text}
										</span>
										<span className={styles.optionCount}>
											{opt.count}
										</span>
									</label>
								);
							})
						)}
					</div>

					<div className={styles.footer}>
						{active
							? `${selected.length} of ${options.length} selected`
							: `${options.length} values`}
					</div>
				</div>
			)}
		</>
	);
}
