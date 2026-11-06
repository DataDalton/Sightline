// Whether a stored access answer speaks for every source registered now.
//
// An answer lists the sources a reader can read, which on its own cannot tell
// "asked, and refused" from "registered after the answer was given". Recording
// what was asked tells the two apart, so a new source is asked about instead of
// being refused until the answer ages out.
//
// An answer stored before this was recorded has no list and counts as covering
// everything, so a deploy does not send every reader back to the warehouse at
// once. It is replaced by the next refresh.
//
// Pure, so it can be tested without a catalogue.
export function answerCovers(
	asked: ReadonlySet<string> | null,
	registered: readonly string[],
): boolean {
	if (asked === null) return true;
	return registered.every((key) => asked.has(key));
}
