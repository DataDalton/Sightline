"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { categoryIcons, NavIcon } from "../NavIcon";
import styles from "./IconPicker.module.css";

// Chooses a category's mark from the icon set.
//
// A field that looks like the app's other dropdowns and opens a grid of every
// mark, filtered by typing, so nobody has to know an icon's key.
export function IconPicker({
	value,
	onChange,
	ariaLabel = "Icon",
	disabled = false,
}: {
	value: string;
	onChange: (key: string) => void;
	ariaLabel?: string;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const gridId = useId();
	const chosen = categoryIcons.find((icon) => icon.key === value);

	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			if (!wrapRef.current?.contains(event.target as Node))
				setOpen(false);
		};
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, [open]);

	const shown = useMemo(() => {
		const words = query.trim().toLowerCase();
		if (!words) return categoryIcons;
		return categoryIcons.filter(
			(icon) =>
				icon.label.toLowerCase().includes(words) ||
				icon.key.includes(words),
		);
	}, [query]);

	const choose = (key: string) => {
		onChange(key);
		setOpen(false);
		setQuery("");
	};

	return (
		<div
			className={styles.wrap}
			ref={wrapRef}
			onKeyDown={(event) => {
				if (event.key === "Escape" && open) {
					event.stopPropagation();
					setOpen(false);
				}
			}}
		>
			<button
				type="button"
				className={`${styles.trigger} ${open ? styles.triggerOpen : ""}`}
				onClick={() => setOpen((was) => !was)}
				disabled={disabled}
				aria-label={ariaLabel}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? gridId : undefined}
			>
				<span className={styles.mark}>
					<NavIcon name={value || null} size={16} />
				</span>
				<span className={chosen ? styles.value : styles.placeholder}>
					{chosen ? chosen.label : "Default"}
				</span>
				<svg
					className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.4"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="m6 9 6 6 6-6" />
				</svg>
			</button>

			{open && (
				<div
					className={styles.panel}
					id={gridId}
					role="dialog"
					aria-label="Choose an icon"
				>
					<input
						className={styles.search}
						placeholder="Search icons"
						value={query}
						autoFocus
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && shown.length > 0) {
								event.preventDefault();
								choose(shown[0].key);
							}
						}}
					/>
					<div className={styles.grid}>
						{query.trim() === "" && (
							<button
								type="button"
								className={`${styles.cell} ${value === "" ? styles.cellChosen : ""}`}
								onClick={() => choose("")}
								title="Default"
								aria-label="Default"
								aria-pressed={value === ""}
							>
								<NavIcon name={null} size={20} />
							</button>
						)}
						{shown.map((icon) => (
							<button
								key={icon.key}
								type="button"
								className={`${styles.cell} ${value === icon.key ? styles.cellChosen : ""}`}
								onClick={() => choose(icon.key)}
								title={icon.label}
								aria-label={icon.label}
								aria-pressed={value === icon.key}
							>
								<NavIcon name={icon.key} size={20} />
							</button>
						))}
					</div>
					{shown.length === 0 && (
						<div className={styles.empty}>
							No icon matches that.
						</div>
					)}
				</div>
			)}
		</div>
	);
}
