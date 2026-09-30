// Whether the person's own message asks the assistant to keep something for
// later conversations.
//
// The remember tool is offered only when it does. Report descriptions, field
// descriptions and query results all reach the model as text written by
// somebody other than the person asking, and without this any of them could
// word an instruction that saves a lasting preference to that person's
// profile. Read from the question alone, so only the person's own words can
// open it.

const askedToKeep =
	/\b(?:remember|memori[sz]e|don'?t forget|do not forget|keep in mind|from now on|going forward|in (?:the )?future|next time|every time|my preference|i prefer|i'?d prefer|i would prefer)\b/i;

// "Always" or "never" opening a sentence reads as a standing instruction,
// such as "always show figures in millions". Inside a sentence it is more
// often part of a question about the data.
const standingInstruction = /(?:^|[.!?\n]\s*)(?:please\s+)?(?:always|never)\b/i;

export function asksToRemember(question: string): boolean {
	return askedToKeep.test(question) || standingInstruction.test(question);
}
