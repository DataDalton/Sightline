"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FieldMeta, SourceMeta } from "../visuals/types";
import styles from "./FieldPicker.module.css";

// Add and remove columns on a page.
//
// The full field list is large by design: sales_bookings alone exposes 132
// dimensions and 63 measures. Filtering is therefore the primary interaction,
// not a nicety, and the list stays keyboard reachable rather than relying on
// hover.

interface FieldPickerProps {
	source: SourceMeta | undefined;
	selectedDimensions: string[];
	selectedMeasures: string[];
	onChange: (dimensions: string[], measures: string[]) => void;
}

export function FieldPicker({
	source,
	selectedDimensions,
	selectedMeasures,
	onChange,
}: FieldPickerProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) return;
		inputRef.current?.focus();

		const onClick = (e: MouseEvent) => {
			if (
				wrapperRef.current &&
				!wrapperRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onClick);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onClick);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const { dimensions, measures } = useMemo(() => {
		const term = search.trim().toLowerCase();
		const match = (f: FieldMeta) =>
			term === "" || f.name.toLowerCase().includes(term);
		return {
			dimensions: (source?.dimensions ?? []).filter(match),
			measures: (source?.measures ?? []).filter(match),
		};
	}, [source, search]);

	const toggle = (name: string, kind: "dimension" | "measure") => {
		if (kind === "dimension") {
			const next = selectedDimensions.includes(name)
				? selectedDimensions.filter((d) => d !== name)
				: [...selectedDimensions, name];
			onChange(next, selectedMeasures);
		} else {
			const next = selectedMeasures.includes(name)
				? selectedMeasures.filter((m) => m !== name)
				: [...selectedMeasures, name];
			onChange(selectedDimensions, next);
		}
	};

	const total = selectedDimensions.length + selectedMeasures.length;

	const renderItem = (field: FieldMeta, kind: "dimension" | "measure") => {
		const selected =
			kind === "dimension"
				? selectedDimensions.includes(field.name)
				: selectedMeasures.includes(field.name);
		return (
			<button
				key={`${kind}:${field.name}`}
				type="button"
				className={styles.item}
				onClick={() => toggle(field.name, kind)}
				aria-pressed={selected}
				title={field.description ?? field.name}
			>
				<span
					className={`${styles.checkbox} ${selected ? styles.checked : ""}`}
					aria-hidden="true"
				>
					<svg width="10" height="10" viewBox="0 0 16 16" fill="none">
						<path
							d="M3 8.5l3.5 3.5L13 5"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</span>
				<span className={styles.itemLabel}>{field.name}</span>
			</button>
		);
	};

	return (
		<div className={styles.wrapper} ref={wrapperRef}>
			<button
				type="button"
				className={styles.trigger}
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-haspopup="true"
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
				>
					<path d="M3 6h18M6 12h12M10 18h4" />
				</svg>
				Columns
				{total > 0 && <span className={styles.count}>{total}</span>}
			</button>

			{open && (
				<div className={styles.panel}>
					<div className={styles.search}>
						<input
							ref={inputRef}
							type="text"
							className={styles.searchInput}
							placeholder="Search fields"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>

					<div className={styles.list}>
						{dimensions.length === 0 && measures.length === 0 ? (
							<div className={styles.empty}>
								No fields match &quot;{search}&quot;
							</div>
						) : (
							<>
								{measures.length > 0 && (
									<>
										<div className={styles.groupTitle}>
											Measures ({measures.length})
										</div>
										{measures.map((f) =>
											renderItem(f, "measure"),
										)}
									</>
								)}
								{dimensions.length > 0 && (
									<>
										<div className={styles.groupTitle}>
											Dimensions ({dimensions.length})
										</div>
										{dimensions.map((f) =>
											renderItem(f, "dimension"),
										)}
									</>
								)}
							</>
						)}
					</div>

					<div className={styles.footer}>
						<button
							type="button"
							className={styles.footerButton}
							onClick={() => onChange([], [])}
						>
							Clear
						</button>
						<button
							type="button"
							className={`${styles.footerButton} ${styles.primary}`}
							onClick={() => setOpen(false)}
						>
							Done
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
