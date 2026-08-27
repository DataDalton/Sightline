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
