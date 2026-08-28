"use client";

import { useEffect, useState } from "react";
import styles from "./Visual.module.css";

// The two things a reader wants to do with a chart other than read it: take the
// picture, and see the numbers.
//
// CSV export already exists and is well built, so what was missing was the
// picture. Every chart headed for a deck was screenshotted, which crops badly,
// carries whatever the operating system's scaling did to it, and arrives at a
// resolution nobody chose. ECharts renders onto a canvas and can hand back its
// own pixels, so this is the chart at twice the size with the page's own
// background behind it.

const confirmMs = 2400;

interface ChartActionsProps {
	// Returns the chart as a data URL, or null when the chart has not drawn
	// yet. Supplied by the chart rather than read out of the DOM, because the
	// canvas is an implementation detail of the renderer and reaching into it
	// would break the moment the renderer changed.
	getImage: (() => string | null) | null;
	onShowTable?: () => void;
}

// A data URL turned into something the clipboard will take.
//
// The clipboard takes a Blob rather than a string for anything that is not
// text, and the image clipboard is PNG only, which is what the chart produces.
function toBlob(dataUrl: string): Blob | null {
	const comma = dataUrl.indexOf(",");
	if (comma < 0) return null;
	try {
		const binary = atob(dataUrl.slice(comma + 1));
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		return new Blob([bytes], { type: "image/png" });
	} catch {
		return null;
	}
}

export function ChartActions({ getImage, onShowTable }: ChartActionsProps) {
	const [state, setState] = useState<
		"idle" | "copied" | "failed" | "notDrawn"
	>("idle");

	useEffect(() => {
		if (state === "idle") return;
		const timer = setTimeout(() => setState("idle"), confirmMs);
		return () => clearTimeout(timer);
	}, [state]);

	const copyImage = async () => {
		const url = getImage?.();
		// Nothing drawn yet is a different thing from a browser that refused
		// the clipboard, and telling somebody their browser is at fault when
		// the chart is still loading sends them to the wrong place.
		if (!url) {
			setState("notDrawn");
			return;
		}

		const blob = toBlob(url);
		if (!blob) {
			setState("failed");
			return;
		}

		try {
			// ClipboardItem is not in every browser, and writing an image is
			// refused outright in some. Reported rather than swallowed: a
			// button that appears to work and puts nothing on the clipboard
			// is worse than one that says it could not.
			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": blob }),
			]);
			setState("copied");
		} catch {
			setState("failed");
		}
	};

	return (
		<>
			{onShowTable && (
				<button
					type="button"
					className={styles.frameAction}
					onClick={onShowTable}
					title="Show the figures behind this chart"
					aria-label="Show the figures behind this chart"
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
						<rect x="3" y="4" width="18" height="16" rx="2" />
						<path d="M3 10h18M9 10v10M15 10v10" />
					</svg>
				</button>
			)}

			{getImage && (
				<button
					type="button"
					className={styles.frameAction}
					onClick={copyImage}
					title={
						state === "copied"
							? "Copied"
							: state === "notDrawn"
								? "The chart has not finished drawing yet"
								: state === "failed"
									? "This browser would not take the image"
									: "Copy this chart as a picture"
					}
					aria-label="Copy this chart as a picture"
				>
					{state === "copied" ? (
						<svg
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="m20 6-11 11-5-5" />
						</svg>
					) : (
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
							<rect x="3" y="3" width="14" height="14" rx="2" />
							<path d="M8 21h11a2 2 0 0 0 2-2V8" />
						</svg>
					)}
				</button>
			)}
		</>
	);
}
