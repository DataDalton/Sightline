// Global SWR fetcher used by SWRConfig in app/layout.tsx.
// Throws on non-2xx so SWR's `error` channel fires for failed responses.
export async function fetcher<T = any>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) {
		const err: Error & { status?: number; info?: any } = new Error(
			`Request failed: ${res.status}`,
		);
		err.status = res.status;
		try {
			err.info = await res.json();
		} catch {
			err.info = null;
		}
		throw err;
	}
	return res.json();
}

// What to tell somebody when a fetch failed.
//
// A refusal and an outage reach SWR the same way: both populate the error
// channel, and reading that channel alone cannot tell them apart. Every screen
// used to report both as a refusal, which during an incident tells people they
// have lost access. That sends them to ask for access rather than to report the
// outage, and points whoever is debugging at the permission model instead of at
// the failure.
//
// The routes answer 404 for a resource the caller may not open as well as for
// one that is not there, deliberately, so that asking for a report is not a way
// to learn it exists. That is the one status where "not available to you" is
// the honest answer.
//
// Everything else says what happened and stops. The status is the useful part,
// because it separates an app that answered badly from one that was not
// reached, and those have different people fixing them. Guessing at a cause and
// promising a retry adds length without adding anything a reader can use.
export function describeFetchError(error: unknown, subject: string): string {
	const status = (error as { status?: number } | null)?.status;

	if (status === 404 || status === 403) {
		return `This ${subject} is not available to you.`;
	}

	if (status === 401) {
		return "Your session has ended. Reload to sign in again.";
	}

	if (status === 429) {
		return "Too many requests. Please wait a moment and try again.";
	}

	if (status && status >= 500) {
		return `The app returned ${status} loading this ${subject}. An administrator can see the reason under Administration.`;
	}

	if (status) {
		return `The app returned ${status} loading this ${subject}.`;
	}

	// No status at all means the response never arrived.
	return "The app could not be reached. Please wait a moment or try again.";
}

export const swrDefaults = {
	fetcher,
	revalidateOnFocus: false,
	revalidateOnReconnect: true,
	// Two components asking the same question inside this window share one
	// request. Reporting answers do not change between one visual mounting and
	// the next, so five seconds was short enough that switching pages and back
	// refetched everything.
	dedupingInterval: 30000,
	keepPreviousData: true,
} as const;
