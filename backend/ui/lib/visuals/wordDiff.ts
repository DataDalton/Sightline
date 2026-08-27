// Which words changed between two pieces of text.
//
// A version comparison draws both pages, which answers what moved and what
// arrived. It cannot answer what a paragraph now says that it did not say
// before: at the size two pages fit side by side, prose is a grey shape. The
// only form that answers it is the one a text diff has always used, the old
// words with the removed ones struck out and the new words with the added ones
// picked out.
//
// Compared word by word rather than character by character. A character diff of
// a reworded sentence marks the letters two words happen to share and reads as
// confetti. Whitespace is kept as its own token so joining the pieces back up
// returns the text exactly, which is what lets the result be rendered as the
// text rather than as a description of it.

export type PieceState = "same" | "gone" | "new";

export interface Piece {
	text: string;
	state: PieceState;
}

export interface WordDiff {
	before: Piece[];
	after: Piece[];
	// False where the two are the same, so a caller can skip drawing anything.
	changed: boolean;
}

// Beyond this the quadratic table costs more than the answer is worth, and a
// difference that large is not one anybody reads word by word anyway. Both
// sides are then reported whole, which is still true, just less precise.
const tooLong = 2500;

function tokenize(text: string): string[] {
	// The separators are kept, so the pieces joined back together are the text.
	return text.split(/(\s+)/).filter((token) => token !== "");
}

// Longest common subsequence over the two token lists, walked back into runs.
function common(before: string[], after: string[]): number[][] {
	const table: number[][] = Array.from({ length: before.length + 1 }, () =>
		new Array<number>(after.length + 1).fill(0),
	);

	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			table[i][j] =
				before[i] === after[j]
					? table[i + 1][j + 1] + 1
					: Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	return table;
}

// Runs of the same state joined into one piece, so a rendered diff is a few
// spans rather than one per word.
function merge(pieces: Piece[]): Piece[] {
	const out: Piece[] = [];
	for (const piece of pieces) {
		const last = out[out.length - 1];
		if (last && last.state === piece.state) {
			last.text += piece.text;
			continue;
		}
		out.push({ ...piece });
	}
	return out.filter((piece) => piece.text !== "");
}

export function wordDiff(before: string, after: string): WordDiff {
	if (before === after) {
		return {
			before: before === "" ? [] : [{ text: before, state: "same" }],
			after: after === "" ? [] : [{ text: after, state: "same" }],
			changed: false,
		};
	}

	// One side empty is the whole of the other side arriving or going. Running
	// the table for that says the same thing more slowly.
	if (before === "" || after === "") {
		return {
			before: before === "" ? [] : [{ text: before, state: "gone" }],
			after: after === "" ? [] : [{ text: after, state: "new" }],
			changed: true,
		};
	}

	const oldWords = tokenize(before);
	const newWords = tokenize(after);

	if (oldWords.length > tooLong || newWords.length > tooLong) {
		return {
			before: [{ text: before, state: "gone" }],
			after: [{ text: after, state: "new" }],
			changed: true,
		};
	}

	const table = common(oldWords, newWords);
	const left: Piece[] = [];
	const right: Piece[] = [];

	let i = 0;
	let j = 0;
	while (i < oldWords.length && j < newWords.length) {
		if (oldWords[i] === newWords[j]) {
			left.push({ text: oldWords[i], state: "same" });
			right.push({ text: newWords[j], state: "same" });
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			left.push({ text: oldWords[i], state: "gone" });
			i++;
		} else {
			right.push({ text: newWords[j], state: "new" });
			j++;
		}
	}
	while (i < oldWords.length) {
		left.push({ text: oldWords[i], state: "gone" });
		i++;
	}
	while (j < newWords.length) {
		right.push({ text: newWords[j], state: "new" });
		j++;
	}

	return { before: merge(left), after: merge(right), changed: true };
}

// Prose out of the rich text a text panel stores.
//
// The stored value is markup, and marking up the markup would report a diff in
// tags nobody wrote by hand. Tags become nothing, block ends become a space so
// two paragraphs do not run their last and first words together, and entities
// that carry text become the text they stand for.
export function textOf(html: string): string {
	return html
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, " ")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}
