"use client";

import { SWRConfig } from "swr";
import { swrDefaults } from "../../lib/swr";

// Seeded with what the server already knew.
//
// Every key here is one request the browser does not have to make before it can
// render. SWR treats fallback data as the first value rather than as a cache
// entry, so the component renders with it immediately and revalidates in the
// background if it is configured to.
export default function SWRProvider({
	fallback,
	children,
}: {
	fallback?: Record<string, unknown>;
	children: React.ReactNode;
}) {
	return (
		<SWRConfig value={{ ...swrDefaults, fallback: fallback ?? {} }}>
			{children}
		</SWRConfig>
	);
}
