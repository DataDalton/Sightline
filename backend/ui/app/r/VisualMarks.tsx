"use client";

import styles from "./Deck.module.css";

// Marks an author has left on a visual for good. See lib/visuals/deck.

export function VisualMarks({
	marks,
}: {
	marks: { id: string; kind: string; text: string }[];
}) {
	if (marks.length === 0) return null;
	return (
		<>
			{marks.map((mark) =>
				mark.kind === "highlight" ? (
					<div
						key={mark.id}
						className={styles.markRing}
						title={mark.text || undefined}
						aria-hidden="true"
					/>
				) : (
					<div key={mark.id} className={styles.markLabel}>
						{mark.kind === "arrow" && (
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.6"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M12 4v16M5 13l7 7 7-7" />
							</svg>
						)}
						{mark.text}
					</div>
				),
			)}
		</>
	);
}
