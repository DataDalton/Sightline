"use client";

import { useEffect, useState } from "react";
import styles from "./FavouriteButton.module.css";

// Copying a link to the page as it currently stands.
//
// The address bar already carries the filters, the open page and the saved
// view, as named parameters somebody could have typed. So this copies what is
// there rather than composing anything of its own.
//
// It exists because otherwise nobody knows that: a reader wanting to send
// "this report, EMEA, last quarter" reaches for a screenshot, and a button
// next to the title is what says they do not have to.
//
// Reports back rather than copying silently. The whole doubt this addresses is
// whether the link carries what is on screen, and a button that appears to do
// nothing does not answer it.

// Long enough to read, short enough not to sit there once the point is made.
const confirmMs = 2400;

export function ShareLinkButton() {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

	useEffect(() => {
		if (state === "idle") return;
		const timer = setTimeout(() => setState("idle"), confirmMs);
		return () => clearTimeout(timer);
	}, [state]);

	const copy = async () => {
		try {
			// The clipboard API needs a secure context and the permission that
			// comes with the gesture. Both hold here, but a browser can still
			// refuse, and the failure has to be visible or the reader sends
			// nothing and does not know it.
			await navigator.clipboard.writeText(window.location.href);
			setState("copied");
		} catch {
			setState("failed");
		}
	};

	const label =
		state === "copied"
			? "Link copied"
			: state === "failed"
				? "The browser would not take the link."
				: "Copy a link to this page as it is now, filters included";

	return (
		<button
			type="button"
			className={styles.button}
			onClick={copy}
			title={label}
			aria-label={label}
		>
			{state === "copied" ? (
				<svg
					width="15"
					height="15"
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
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
					<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
				</svg>
			)}
		</button>
	);
}
