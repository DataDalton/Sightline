"use client";

import { useEffect, useRef, useState } from "react";
import { PowerPointDialog } from "./PowerPointExport";
import styles from "./ExportMenu.module.css";

// Taking a report away, in one place on its header. A table's own Export is separate, since
// that one is rows from a single visual.
export function ExportMenu({
	slug,
	pageId,
	pageTitle,
	pageCount,
	filters,
	onPdf,
	className,
}: {
	slug: string;
	pageId: string | null;
	pageTitle: string;
	pageCount: number;
	filters: unknown[];
	onPdf: () => void;
	className: string;
}) {
	const [open, setOpen] = useState(false);
	const [powerPoint, setPowerPoint] = useState(false);
	const box = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", key);
		};
	}, [open]);

	return (
		<div ref={box} className={styles.wrap}>
			<button
				type="button"
				className={className}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((held) => !held)}
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
					<path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
				</svg>
				Export
			</button>
			{open && (
				<div className={styles.menu} role="menu">
					<button
						type="button"
						role="menuitem"
						className={styles.item}
						onClick={() => {
							setOpen(false);
							onPdf();
						}}
					>
						<strong>PDF</strong>
						<span>Print this page or save it as a file</span>
					</button>
					<button
						type="button"
						role="menuitem"
						className={styles.item}
						onClick={() => {
							setOpen(false);
							setPowerPoint(true);
						}}
					>
						<strong>PowerPoint</strong>
						<span>Slides with charts and tables you can edit</span>
					</button>
					<p className={styles.note}>
						Each export is recorded in Export audit.
					</p>
				</div>
			)}
			{powerPoint && (
				<PowerPointDialog
					slug={slug}
					pageId={pageId}
					pageTitle={pageTitle}
					pageCount={pageCount}
					filters={filters}
					onClose={() => setPowerPoint(false)}
				/>
			)}
		</div>
	);
}
