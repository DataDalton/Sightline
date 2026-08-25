"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./Filters.module.css";

// A two-handle range slider.
//
// Built on pointer events rather than two stacked native inputs, because the
// native approach cannot stop the handles crossing and gives no control over
// which one a click near the middle grabs. Both of those are the whole
// interaction.
//
// Values are expressed as numbers. A date range converts to and from epoch
// milliseconds outside this component, so one slider serves both.

interface RangeSliderProps {
	min: number;
	max: number;
	value: [number, number];
	step?: number;
	// Rendered under each handle, so a reader sees what they are selecting
	// rather than only where the handle sits.
	format?: (value: number) => string;
	onChange: (next: [number, number]) => void;
	// Fired when the gesture ends, so a caller can defer an expensive query
	// until the reader stops dragging.
	onCommit?: (next: [number, number]) => void;
	disabled?: boolean;
	label?: string;
}

export function RangeSlider({
	min,
	max,
	value,
	step = 1,
	format,
	onChange,
	onCommit,
	disabled,
	label,
}: RangeSliderProps) {
	const trackRef = useRef<HTMLDivElement | null>(null);
	const [dragging, setDragging] = useState<"low" | "high" | null>(null);
	const valueRef = useRef(value);
	valueRef.current = value;

	const span = max - min || 1;
	const toPercent = (v: number) => ((v - min) / span) * 100;

	const fromClientX = useCallback(
		(clientX: number): number => {
			const track = trackRef.current;
			if (!track) return min;
			const rect = track.getBoundingClientRect();
			const ratio = Math.min(
				1,
				Math.max(0, (clientX - rect.left) / rect.width),
			);
			const raw = min + ratio * span;
			// Snapped to the step so the value is one the caller can act on,
			// not an arbitrary fraction of a pixel.
			return Math.round(raw / step) * step;
		},
		[min, span, step],
	);

	const onPointerDown = (
		event: React.PointerEvent,
		handle: "low" | "high",
	) => {
		if (disabled || event.button !== 0) return;
		event.preventDefault();
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
		setDragging(handle);
	};

	const onPointerMove = (event: React.PointerEvent) => {
		if (!dragging) return;
		const next = fromClientX(event.clientX);
		const [low, high] = valueRef.current;

		// Handles are clamped against each other rather than allowed to cross.
		// Crossing would invert the range silently, and a reader who dragged
		// past the other handle means "as far as it goes", not "swap them".
		if (dragging === "low") {
			onChange([Math.min(next, high), high]);
		} else {
			onChange([low, Math.max(next, low)]);
		}
	};

	const endDrag = (event: React.PointerEvent) => {
		if (!dragging) return;
		const element = event.currentTarget as Element;
		if (element.hasPointerCapture(event.pointerId)) {
			element.releasePointerCapture(event.pointerId);
		}
		setDragging(null);
		onCommit?.(valueRef.current);
	};

	// A click on the track moves whichever handle is nearer, which is what a
	// reader expects from clicking a point on a range.
	const onTrackDown = (event: React.PointerEvent) => {
		if (disabled) return;
		if (event.target !== event.currentTarget) return;
		const point = fromClientX(event.clientX);
		const [low, high] = value;
		const next: [number, number] =
			Math.abs(point - low) <= Math.abs(point - high)
				? [Math.min(point, high), high]
				: [low, Math.max(point, low)];
		onChange(next);
		onCommit?.(next);
	};

	// Keyboard support, because a slider that only takes a pointer is
	// unreachable for anyone navigating by keyboard.
	const onKeyDown = (
		event: React.KeyboardEvent,
		handle: "low" | "high",
	) => {
		const [low, high] = value;
		const large = span / 10;
		let delta = 0;

		if (event.key === "ArrowLeft" || event.key === "ArrowDown") delta = -step;
		else if (event.key === "ArrowRight" || event.key === "ArrowUp") delta = step;
		else if (event.key === "PageDown") delta = -large;
		else if (event.key === "PageUp") delta = large;
		else if (event.key === "Home") delta = -span;
		else if (event.key === "End") delta = span;
		else return;

		event.preventDefault();
		const next: [number, number] =
			handle === "low"
				? [Math.max(min, Math.min(low + delta, high)), high]
				: [low, Math.min(max, Math.max(high + delta, low))];
		onChange(next);
		onCommit?.(next);
	};

	useEffect(() => {
		if (!dragging) return;
		// A pointer released outside the window would otherwise leave the
		// slider stuck in a drag.
		const stop = () => setDragging(null);
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
		return () => {
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
		};
	}, [dragging]);

	const [low, high] = value;
	const display = format ?? ((v: number) => String(v));

	return (
		<div className={styles.slider}>
			<div
				className={`${styles.sliderTrack} ${disabled ? styles.sliderDisabled : ""}`}
				ref={trackRef}
				onPointerDown={onTrackDown}
			>
				<div
					className={styles.sliderFill}
					style={{
						left: `${toPercent(low)}%`,
						width: `${Math.max(0, toPercent(high) - toPercent(low))}%`,
					}}
				/>
				<button
					type="button"
					className={`${styles.sliderHandle} ${dragging === "low" ? styles.sliderHandleActive : ""}`}
					style={{ left: `${toPercent(low)}%` }}
					onPointerDown={(e) => onPointerDown(e, "low")}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
					onKeyDown={(e) => onKeyDown(e, "low")}
					role="slider"
					aria-label={`${label ?? "Range"} lower bound`}
					aria-valuemin={min}
					aria-valuemax={high}
					aria-valuenow={low}
					aria-valuetext={display(low)}
					disabled={disabled}
				/>
				<button
					type="button"
					className={`${styles.sliderHandle} ${dragging === "high" ? styles.sliderHandleActive : ""}`}
					style={{ left: `${toPercent(high)}%` }}
					onPointerDown={(e) => onPointerDown(e, "high")}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
					onKeyDown={(e) => onKeyDown(e, "high")}
					role="slider"
					aria-label={`${label ?? "Range"} upper bound`}
					aria-valuemin={low}
					aria-valuemax={max}
					aria-valuenow={high}
					aria-valuetext={display(high)}
					disabled={disabled}
				/>
			</div>
			<div className={styles.sliderLabels}>
				<span>{display(low)}</span>
				<span>{display(high)}</span>
			</div>
		</div>
	);
}
