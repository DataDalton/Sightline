"use client";

import styles from "./ErrorState.module.css";

// What an unhandled failure looks like, wherever it is caught.
//
// One component behind the route boundaries and the sub-tree boundary, so a
// failure in a visual and a failure in a whole page are recognisably the same
// event rather than two unrelated screens.

export function ErrorState({
	title = "Something went wrong",
	body,
	digest,
	inline,
	onRetry,
	retryLabel = "Try again",
	homeHref = "/",
}: {
	title?: string;
	// What failed, in terms of what the reader was doing. The message off the
	// exception is not shown: it is written for whoever wrote the code.
	body?: string;
	// Identifier the deployment logged alongside the stack, when there is one.
	digest?: string;
	// Set where this fills a visual or a pane rather than a page.
	inline?: boolean;
	onRetry?: () => void;
	retryLabel?: string;
	// Left out inline, where navigating away is not the right offer.
	homeHref?: string | null;
}) {
	const message =
		body ??
		"This part of the page could not be drawn. Nothing was changed, and trying again usually works.";

	return (
		<div
			className={`${styles.state} ${inline ? styles.inline : ""}`}
			role="alert"
		>
			<svg
				className={styles.icon}
				width="28"
				height="28"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="10" />
				<path d="M12 8v5M12 16h.01" />
			</svg>

			<div className={styles.title}>{title}</div>
			<p className={styles.body}>{message}</p>

			<div className={styles.actions}>
				{onRetry && (
					<button
						type="button"
						className={styles.primary}
						onClick={onRetry}
					>
						{retryLabel}
					</button>
				)}
				{!inline && homeHref && (
					// A plain anchor rather than a Link: the router is a
					// suspect whenever this screen is showing, and a full
					// document load is the one navigation that cannot fail
					// the same way twice.
					<a className={styles.secondary} href={homeHref}>
						Go to home
					</a>
				)}
			</div>

			{digest && <div className={styles.digest}>Reference {digest}</div>}
		</div>
	);
}
