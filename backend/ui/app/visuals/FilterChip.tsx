"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Filters.module.css";

// One shape for every filter on a page.
//
// The strip used to lay each widget out in full: a label above a control, each
// control whatever height it needed. A date range is three times the height of
// a dropdown, so one tall control set the row height and the short ones hung
// off its bottom edge, and past about six the whole thing wrapped into ragged
// bands. On a page carrying twelve it was the largest thing on screen.
//
// A chip is the label until it is set and the value once it is, so the strip
// reads as a sentence about what the page is showing rather than as eight boxes
// saying All. The control itself moves into a popover, which is the only way a
// date range and a dropdown can be the same height.
//
// The popover is portalled to the body, so nothing between the chip and the
// page can clip it, and it is measured against the viewport so it stays on the
// chip wherever the strip has wrapped to.

export function FilterChip({
	label,
	// What the filter is set to, or null when it is not set. Shown on the chip.
	value,
	onClear,
	// Told whenever the popover opens or closes, so a filter that has to fetch
	// its values can wait until somebody asks to see them. A page carrying a
	// dozen of these would otherwise run a dozen warehouse queries nobody
	// looked at.
	onOpenChange,
	// The width the popover opens at. A list of values wants more room than a
	// pair of numbers.
	width = 260,
	children,
}: {
	label: string;
	value?: string | null;
	onClear?: () => void;
	onOpenChange?: (open: boolean) => void;
	width?: number;
	children: (close: () => void) => React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [box, setBox] = useState<{
		left: number;
		top?: number;
		bottom?: number;
	} | null>(null);

	const wrapRef = useRef<HTMLDivElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);

	const close = useCallback(() => setOpen(false), []);

	useEffect(() => {
		onOpenChange?.(open);
		// The callback is read at call time rather than depended on, so a fresh
		// arrow from the parent on every render does not re-announce the same
		// state.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	const set = value !== null && value !== undefined && value !== "";

	useEffect(() => {
		if (!open) return;
		const away = (e: MouseEvent) => {
			const target = e.target as Node;
			if (
				!wrapRef.current?.contains(target) &&
				!panelRef.current?.contains(target)
			) {
				close();
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				close();
				wrapRef.current?.querySelector("button")?.focus();
			}
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, close]);

	const place = useCallback(() => {
		const trigger = wrapRef.current?.getBoundingClientRect();
		if (!trigger) return;
		const below = window.innerHeight - trigger.bottom;
		// Opens upward where there is no room below, which is where a strip at
		// the foot of a short page always is.
		const upward = below < 320 && trigger.top > below;
		setBox({
			left: Math.max(
				8,
				Math.min(trigger.left, window.innerWidth - width - 8),
			),
			...(upward
				? { bottom: window.innerHeight - trigger.top + 6 }
				: { top: trigger.bottom + 6 }),
		});
	}, [width]);

	useEffect(() => {
		if (!open) return;
		place();
		// Capture, so a scroll inside a panel is seen as well as one on the
		// page. A fixed popover does not move with what it is anchored to.
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => {
			window.removeEventListener("scroll", place, true);
			window.removeEventListener("resize", place);
		};
	}, [open, place]);

	return (
		<div className={styles.chipWrap} ref={wrapRef}>
			<button
				type="button"
				className={`${styles.chip} ${set ? styles.chipSet : ""}`}
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => setOpen((v) => !v)}
			>
				<span className={styles.chipLabel}>{label}</span>
				{set && <span className={styles.chipValue}>{value}</span>}
				<svg
					className={styles.chipChevron}
					width="11"
					height="11"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<path d="M6 9l6 6 6-6" />
				</svg>
			</button>

			{/* Outside the trigger rather than inside it, because a button
			    inside a button is not a button either browsers or screen
			    readers make sense of. */}
			{set && onClear && (
				<button
					type="button"
					className={styles.chipClear}
					aria-label={`Clear ${label}`}
					onClick={onClear}
				>
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M6 6l12 12M18 6L6 18" />
					</svg>
				</button>
			)}

			{open &&
				box &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						ref={panelRef}
						className={styles.chipPanel}
						// Which way it opened, so it grows from the edge it is
						// anchored to rather than sliding away from the chip.
						data-placement={
							box.bottom === undefined ? "below" : "above"
						}
						role="dialog"
						aria-label={label}
						style={{
							left: box.left,
							top: box.top,
							bottom: box.bottom,
							width,
						}}
					>
						{children(close)}
					</div>,
					document.body,
				)}
		</div>
	);
}
