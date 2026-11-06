"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Visual.module.css";

// A label with an explanation behind it, marked by a dashed underline.
//
// The browser's own title text waits about a second, cannot be found until it
// appears and never appears on a phone. This opens on hover, on keyboard focus
// and on a tap, and is drawn on the page rather than inside the tile, so a tile
// at the edge of a scrolling panel does not clip it.

// Long enough that moving across a row of tiles does not flash each one.
const openDelayMs = 120;
const popoverWidth = 320;
const edgeGap = 8;

export function LabelHint({
	label,
	text,
	className,
}: {
	label: string;
	text: string | null | undefined;
	className: string;
}) {
	const hint = text?.trim();
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [place, setPlace] = useState<{
		left: number;
		top?: number;
		bottom?: number;
	} | null>(null);

	const cancelOpen = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	};

	const show = () => {
		const box = anchorRef.current?.getBoundingClientRect();
		if (!box) return;
		const left = Math.max(
			edgeGap,
			Math.min(box.left, window.innerWidth - popoverWidth - edgeGap),
		);
		// Below the label, or above it when the label sits low on the screen.
		setPlace(
			box.bottom > window.innerHeight * 0.7
				? { left, bottom: window.innerHeight - box.top + 4 }
				: { left, top: box.bottom + 4 },
		);
	};

	const hide = () => {
		cancelOpen();
		setPlace(null);
	};

	useEffect(() => cancelOpen, []);

	// Scrolling moves the label out from under a popover fixed to the screen.
	useEffect(() => {
		if (!place) return;
		const close = () => setPlace(null);
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
		};
		window.addEventListener("scroll", close, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [place]);

	// Nothing to explain, so the only thing worth hovering for is a name the
	// tile may have cut short.
	if (!hint) {
		return (
			<span className={className} title={label}>
				{label}
			</span>
		);
	}

	return (
		<>
			<button
				type="button"
				ref={anchorRef}
				className={`${className} ${styles.hintLabel}`}
				aria-expanded={place !== null}
				onMouseEnter={() => {
					cancelOpen();
					timer.current = setTimeout(show, openDelayMs);
				}}
				onMouseLeave={hide}
				onFocus={show}
				onBlur={hide}
				onClick={() => (place ? hide() : show())}
			>
				{label}
			</button>
			{place &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						className={styles.hintPopover}
						role="tooltip"
						style={place}
					>
						<div className={styles.hintName}>{label}</div>
						{hint}
					</div>,
					document.body,
				)}
		</>
	);
}
