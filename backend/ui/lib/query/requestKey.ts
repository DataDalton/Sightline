// A stable string for a query request.
//
// This is the cache key two visuals share when they ask the same question, and
// it is also the key the server seeds an answer under before the page has
// rendered. Both sides have to produce the same string from the same question,
// so there is one implementation and both import it.
//
// Property order decides the key, and an object literal written in two places
// is eventually written in two orders. Sorting makes the same question produce
// the same key however it was spelled. Undefined members are dropped rather
// than encoded, so a caller that leaves an optional field out and one that
// passes undefined agree.
export function canonicalRequest(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalRequest).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([k, v]) => `${JSON.stringify(k)}:${canonicalRequest(v)}`)
		.join(",")}}`;
}

// The key a read sent as a POST is held under. See app/hooks/usePostResource.
export function postKey(url: string, body: unknown): string {
	return `${url}\u0000${canonicalRequest(body)}`;
}

// The key a page's late data notice asks under, for the sources the page
// reads. See app/visuals/LateDataNotice.
export function lateKey(sourceKeys: string[]): string | null {
	const keys = [...new Set(sourceKeys)].sort();
	return keys.length
		? `/api/query/late/?sources=${encodeURIComponent(keys.join(","))}`
		: null;
}

// The answer every page's update banner, pop-up and notices read, which the shell hands
// over with each document. See app/updates/UpdateSurfaces and app/layout.
export const liveUpdatesKey = "/api/changes?live=1";

// The key a page's chart markers ask under, for the sources the page reads, or null when it
// reads none. See UpdateMarkersProvider in app/updates/UpdateSurfaces.
export function markersKey(sourceKeys: string[]): string | null {
	const keys = [...new Set(sourceKeys)].sort().join(",");
	return keys ? `/api/changes?markers=${encodeURIComponent(keys)}` : null;
}

// The key a page's data rule notice asks under, for the sources the page reads. See
// app/status/QualityNotice.
export function qualityKey(sourceKeys: string[]): string | null {
	const keys = [...new Set(sourceKeys)].sort();
	return keys.length
		? `/api/data-rules?sources=${encodeURIComponent(keys.join(","))}`
		: null;
}

// The keys a report page's goals, figures last seen, decks and suggestions ask under.
export function goalsKey(pageId: string): string {
	return `/api/goals?pageId=${encodeURIComponent(pageId)}`;
}

export function lastSeenKey(pageId: string): string {
	return `/api/last-seen?pageId=${encodeURIComponent(pageId)}`;
}

export function decksKey(slug: string): string {
	return `/api/report/${encodeURIComponent(slug)}/decks`;
}

export function suggestionsKey(slug: string): string {
	return `/api/report/${encodeURIComponent(slug)}/suggestions`;
}
