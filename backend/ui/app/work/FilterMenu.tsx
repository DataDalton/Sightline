"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./Work.module.css";

// A Filters button with a count of what is set, opening a panel of the less
// used filters beneath it. The panel closes on Escape or a press outside it.
// A press in a dropdown list opened from inside the panel counts as inside,
// because those lists are drawn on the page body rather than in the panel.
export function FilterMenu({
	count,
	children,
}: {
	count: number;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (
				wrapRef.current?.contains(target) ||
				target?.closest('[role="listbox"]')
			)
				return;
			setOpen(false);
		};
		const key = (event: KeyboardEvent) => {
			// An open dropdown list takes the first Escape for itself.
			if (
				event.key === "Escape" &&
				!document.querySelector('[role="listbox"]')
			)
				setOpen(false);
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", key);
		};
	}, [open]);

	return (
		<div ref={wrapRef} className={styles.filterMenu}>
			<button
				type="button"
				className={styles.chip}
				aria-expanded={open}
				aria-pressed={count > 0}
				onClick={() => setOpen((held) => !held)}
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M22 3H2l8 9.46V19l4 2v-8.54z" />
				</svg>
				Filters
				{count > 0 && (
					<span className={styles.filterCount}>{count}</span>
				)}
			</button>
			{open && (
				<div
					className={styles.filterPanel}
					role="dialog"
					aria-label="Filters"
				>
					{children}
				</div>
			)}
		</div>
	);
}
