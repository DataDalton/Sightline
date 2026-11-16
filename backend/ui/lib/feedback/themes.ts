// What to do about one theme of reader feedback.
//
// The model says what kind of change a theme calls for and whether it is sure.
// The rules for acting on that are here, so they can be read and tested apart
// from the model:
//
//   A presentation change is one that keeps the same dimensions and measures.
//   Whatever the model calls it, a proposal that adds or drops a field changes
//   what the visual shows, and is treated as a change of meaning.
//   It is made without anybody approving it only when the model is sure,
//   nobody asked for the opposite, enough different people asked, and the
//   page is not protected.
//   Otherwise a change with enough people behind it goes to the maintainers as
//   a suggestion.
//   Figures that look wrong, where somebody was left without an answer, go to
//   the maintainers as a conversation.
//   Everything else waits for more feedback.
//
// Kept free of database and network imports so it can be tested on its own.

export interface ThemeProposal {
	visualType: string;
	title: string;
	dimensions: string[];
	measures: string[];
}

// How many different people must ask before a change is made unasked, and
// before one is suggested.
export const applyAt = 3;
export const suggestAt = 2;

export type ThemeAct = "apply" | "suggest" | "escalate" | "wait";

function sameFields(a: string[], b: string[]): boolean {
	return (
		a.length === b.length &&
		[...a].sort().join("\u0000") === [...b].sort().join("\u0000")
	);
}

export function decideTheme(input: {
	changeKind: string;
	confident: boolean;
	contradicted: boolean;
	people: number;
	unanswered: boolean;
	protectedPage: boolean;
	before: { dimensions: string[]; measures: string[] };
	proposal: ThemeProposal | null;
}): {
	act: ThemeAct;
	changeKind: "presentation" | "meaning" | "data" | "none";
} {
	if (input.changeKind === "data") {
		return {
			act: input.unanswered ? "escalate" : "wait",
			changeKind: "data",
		};
	}
	if (
		(input.changeKind !== "presentation" &&
			input.changeKind !== "meaning") ||
		!input.proposal
	) {
		return { act: "wait", changeKind: "none" };
	}
	const presentation =
		input.changeKind === "presentation" &&
		sameFields(input.proposal.dimensions, input.before.dimensions) &&
		sameFields(input.proposal.measures, input.before.measures);
	if (
		presentation &&
		input.confident &&
		!input.contradicted &&
		input.people >= applyAt &&
		!input.protectedPage
	) {
		return { act: "apply", changeKind: "presentation" };
	}
	return {
		act: input.people >= suggestAt ? "suggest" : "wait",
		changeKind: presentation ? "presentation" : "meaning",
	};
}
