"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	groupContentBox,
	measureCanvas,
	type CanvasMetrics,
} from "../../lib/visuals/layout";
import styles from "./GroupFrame.module.css";

// A visual that holds other visuals.
//
// Two shapes, because grouping answers two different questions. A box on the
// page says "these belong together", and keeps them together when the group
// moves. A button says "these are here when you want them": ten toggles laid
// out on a page are ten things to read past, and behind a button they are one,
// with the button saying how many are set so a reader never wonders why the
// page is narrowed.
//
// What it holds is not passed in as elements. The caller is handed the metrics
// of the content box and draws its own children into it, because the editor
// needs them selectable and draggable and the reader needs them plain, and the
// only thing the two have in common is where the box is.

export function GroupFrame({
	title,
	presentation,
	openLabel,
	showBorder,
	width,
	height,
	alwaysOpen = false,
	activeCount = 0,
	note,
	renderChildren,
}: {
	title: string | null;
	presentation: "frame" | "popup";
	openLabel: string | null;
	showBorder: boolean;
	width: number;
	height: number;
	// The editor draws a popup open, because a visual inside a shut one is a
	// visual that cannot be selected.
	alwaysOpen?: boolean;
	// How many of the controls inside are doing something. Hiding a control
	// hides the fact that it is set, and a reader looking at a narrowed page
	// with no visible reason concludes the data is wrong rather than filtered.
	activeCount?: number;
	note?: ReactNode;
	renderChildren: (
		metrics: CanvasMetrics,
		box: { height: number },
	) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const heading = title?.trim() || null;

	if (presentation === "popup" && !alwaysOpen) {
		// The panel is sized for reading rather than to the button, which is
		// usually only a few columns wide. Children lay out across the panel on
		// the same twelve columns they would use anywhere else.
		const panelWidth = Math.max(320, Math.min(560, width * 2));
		const content = groupContentBox(
			{ width: panelWidth, height: 0 },
			false,
		);
		const metrics = measureCanvas(content.width);

		return (
			<div className={styles.popupWrap} ref={wrapRef}>
				<button
					type="button"
					className={`${styles.trigger} ${
						activeCount > 0 ? styles.triggerActive : ""
					}`}
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
				>
					<span className={styles.triggerText}>
						{openLabel?.trim() || heading || "Options"}
					</span>
					{activeCount > 0 && (
						<span className={styles.count}>{activeCount}</span>
					)}
					<svg
						className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M6 9l6 6 6-6" />
					</svg>
				</button>

				{open && (
					<div
						className={styles.popup}
						role="dialog"
						aria-label={heading ?? "Options"}
						style={{ width: panelWidth }}
					>
						{heading && (
							<div className={styles.popupTitle}>{heading}</div>
						)}
						{renderChildren(metrics, { height: 0 })}
					</div>
				)}
			</div>
		);
	}

	const content = groupContentBox({ width, height }, Boolean(heading));
	const metrics = measureCanvas(content.width);

	return (
		<div
			className={`${styles.frame} ${showBorder ? "" : styles.frameBare}`}
		>
			{heading && (
				<div className={styles.frameTitle}>
					{heading}
					{note}
				</div>
			)}
			{!heading && note}
			<div className={styles.frameBody}>
				{renderChildren(metrics, { height: content.height })}
			</div>
		</div>
	);
}
