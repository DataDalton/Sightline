"use client";

import { useEffect, useState } from "react";

// Whether a wait has gone on long enough to be worth showing.
//
// A placeholder that appears and disappears inside a couple of frames is not a
// placeholder, it is a flash. Most things here now answer from cache in single
// digit milliseconds, so showing a skeleton the moment a request starts means
// the page blinks on every navigation while nobody ever actually waits.
//
// Below the threshold the content simply arrives. Above it, the reader was
// going to notice the wait anyway, and a skeleton shaped like what is coming is
// better than an empty panel.
//
// A quarter of a second is about where a delay stops reading as instant.
const defaultDelayMs = 250;

// Once shown, kept up briefly. Otherwise a response landing just after the
// threshold produces the flash this exists to prevent, at the other end.
const minimumVisibleMs = 400;

export function useDeferredLoading(
	loading: boolean,
	delayMs = defaultDelayMs,
): boolean {
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		if (loading) {
			const timer = setTimeout(() => setVisible(true), delayMs);
			return () => clearTimeout(timer);
		}

		if (!visible) return;

		const timer = setTimeout(() => setVisible(false), minimumVisibleMs);
		return () => clearTimeout(timer);
	}, [loading, delayMs, visible]);

	return loading && visible;
}
