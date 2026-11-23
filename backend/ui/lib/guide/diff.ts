// Two versions of a guide, line by line: which lines both keep, which the later
// one added and which it took out. For showing somebody what changed in a guide
// while they were editing it.

export interface DiffLine {
	kind: "same" | "added" | "removed";
	text: string;
}

// Lines of a guide, without the blank lines between blocks, which carry no
// change a reader would notice.
function linesOf(text: string): string[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.trim() !== "");
}

// The longest run of lines both share, worked out as a table of how many lines
// match from each pair of positions onward. A guide is capped well below the
// size where a table of its lines would be slow.
export function diffLines(before: string, after: string): DiffLine[] {
	const a = linesOf(before);
	const b = linesOf(after);
	const shared: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			shared[i][j] =
				a[i] === b[j]
					? shared[i + 1][j + 1] + 1
					: Math.max(shared[i + 1][j], shared[i][j + 1]);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] });
			i++;
			j++;
		} else if (shared[i + 1][j] >= shared[i][j + 1]) {
			out.push({ kind: "removed", text: a[i] });
			i++;
		} else {
			out.push({ kind: "added", text: b[j] });
			j++;
		}
	}
	while (i < a.length) out.push({ kind: "removed", text: a[i++] });
	while (j < b.length) out.push({ kind: "added", text: b[j++] });
	return out;
}
