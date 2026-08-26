"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import styles from "./FavouriteButton.module.css";

// Marks a report so it sits at the top of the navigation.
//
// Distinct from what the usage log records. That answers which reports somebody
// opened, which is evidence of habit, and the two disagree often enough to
// matter: the report opened most is frequently the one nobody chose, reached
// through a link somebody sends round every week.
//
// The mark is applied optimistically. It is a shortcut rather than a change to
// anything, so waiting for a round trip to redraw a star costs more than
// occasionally showing one that did not save.

export function FavouriteButton({
	reportId,
	initial,
}: {
	reportId: string;
	initial: boolean;
}) {
	const { mutate } = useSWRConfig();
	const [on, setOn] = useState(initial);
	const [busy, setBusy] = useState(false);

	const toggle = async () => {
		const next = !on;
		setOn(next);
		setBusy(true);
		try {
			const response = await fetch("/api/favourites", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reportId, favourite: next }),
			});
			if (!response.ok) {
				setOn(!next);
				return;
			}
			// The navigation carries the list, so it is told rather than left
			// showing the old one until something else refetches it.
			await mutate("/api/navigation");
			await mutate("/api/search");
		} catch {
			setOn(!next);
		} finally {
			setBusy(false);
		}
	};

	return (
		<button
			type="button"
			className={`${styles.button} ${on ? styles.on : ""}`}
			onClick={toggle}
			disabled={busy}
			aria-pressed={on}
			title={on ? "Remove from favourites" : "Add to favourites"}
			aria-label={on ? "Remove from favourites" : "Add to favourites"}
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill={on ? "currentColor" : "none"}
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />
			</svg>
		</button>
	);
}
