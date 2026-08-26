// How a typed query is matched against something reachable.
//
// Pure, and separate from the palette that uses it, because ranking is the part
// worth being sure about: a palette that puts the right answer second is worse
// than one that puts it nowhere, since somebody presses Enter before they have
// read the list.

// Ordered strongest to weakest, so a caller can reason about the bands rather
// than the numbers.
export const matchBands = {
	// The query is how the thing starts.
	prefix: 1000,
	// The query appears in it whole, further in.
	substring: 500,
} as const;

// Every character of the query, in order, somewhere in the text.
//
// Substring matching alone misses how people type into a palette, which is a
// few letters from each word rather than one contiguous run. Returns null for
// no match, and a higher number for a better one, so an earlier and tighter
// match sorts above a scattered one.
export function scoreMatch(text: string, query: string): number | null {
	if (!query) return 0;
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase();

	const exact = haystack.indexOf(needle);
	if (exact === 0) return matchBands.prefix;
	// Further in is worth less, but never less than a scattered match, which is
	// bounded by the length of the query.
	if (exact > 0)
		return Math.max(matchBands.substring - exact, needle.length + 1);

	let at = 0;
	let run = 0;
	let best = 0;
	for (const char of needle) {
		const found = haystack.indexOf(char, at);
		if (found === -1) return null;
		run = found === at ? run + 1 : 1;
		if (run > best) best = run;
		at = found + 1;
	}
	return best;
}

// A title match is what somebody meant. Matching only a description or a slug
// keeps a thing findable without letting it outrank something actually called
// that, so the two are scored separately and the title band sits above.
const titleBand = 2000;

export function rankTarget(
	title: string,
	other: string,
	query: string,
): number | null {
	const onTitle = scoreMatch(title, query);
	if (onTitle !== null) return onTitle + titleBand;
	return scoreMatch(other, query);
}
