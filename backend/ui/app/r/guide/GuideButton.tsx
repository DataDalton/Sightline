"use client";

import { useEffect, useState } from "react";
import { GuidePanel } from "./GuidePanel";

// Opens a report's guide beside it. Arriving from a search result about the
// guide, which carries guide=1 in the address, opens it straight away.
export function GuideButton({
	slug,
	reportTitle,
	className,
	onSaved,
}: {
	slug: string;
	reportTitle: string;
	className?: string;
	onSaved: () => void;
}) {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (new URLSearchParams(window.location.search).get("guide") === "1") {
			setOpen(true);
		}
	}, []);

	return (
		<>
			<button
				type="button"
				className={className}
				aria-expanded={open}
				data-guide-toggle
				onClick={() => setOpen((held) => !held)}
				title="What this report is for, its terms and where its data comes from"
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z" />
				</svg>
				Guide
			</button>
			<GuidePanel
				slug={slug}
				reportTitle={reportTitle}
				open={open}
				onClose={() => setOpen(false)}
				onSaved={onSaved}
			/>
		</>
	);
}
