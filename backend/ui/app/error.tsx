"use client";

import { useEffect } from "react";
import { ErrorState } from "./components/shared/ErrorState";

// Anything that escapes a page, caught while the shell stays up.
//
// The header and the sidebar are rendered by the layout above this, so a page
// that throws leaves navigation working and somebody can go somewhere else
// rather than reloading a blank document.

export default function PageError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("Page render failed:", error);
	}, [error]);

	return (
		<ErrorState
			title="This page could not be shown"
			body="Nothing was changed. Trying again usually works, and the rest of the app is still available from the navigation."
			digest={error.digest}
			onRetry={reset}
		/>
	);
}
