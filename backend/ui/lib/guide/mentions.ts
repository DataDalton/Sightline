// Which fields a guide talks about, and renaming one in its text.
//
// A field is mentioned where its name appears as whole words, in any case.
// Longer names are matched first and their text set aside, so "Opportunity"
// is not counted inside "Weighted Opportunity" when both are fields.

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordPattern(name: string): RegExp {
	return new RegExp(
		`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`,
		"gi",
	);
}

// Spans of the text each name takes, longest names first, with no span
// claimed twice.
function claim(
	text: string,
	names: string[],
): { name: string; start: number; end: number }[] {
	const ordered = [...new Set(names.filter((name) => name.trim()))].sort(
		(a, b) => b.length - a.length,
	);
	const taken: boolean[] = new Array(text.length).fill(false);
	const spans: { name: string; start: number; end: number }[] = [];
	for (const name of ordered) {
		for (const match of text.matchAll(wordPattern(name))) {
			const start = match.index ?? 0;
			const end = start + match[0].length;
			let free = true;
			for (let i = start; i < end; i++) {
				if (taken[i]) {
					free = false;
					break;
				}
			}
			if (!free) continue;
			for (let i = start; i < end; i++) taken[i] = true;
			spans.push({ name, start, end });
		}
	}
	return spans.sort((a, b) => a.start - b.start);
}

// The fields the text mentions, from those given, in the order first named.
export function mentionedFields(text: string, names: string[]): string[] {
	const found: string[] = [];
	for (const span of claim(text, names)) {
		if (!found.includes(span.name)) found.push(span.name);
	}
	return found;
}

// The text with every mention of one field changed to another name. Names in
// allNames that contain the old one are left alone, so renaming a short field
// does not reach into a longer one.
export function renameField(
	text: string,
	from: string,
	to: string,
	allNames: string[],
): string {
	const spans = claim(text, [from, ...allNames]).filter(
		(span) => span.name === from,
	);
	if (spans.length === 0) return text;
	let out = "";
	let last = 0;
	for (const span of spans) {
		out += text.slice(last, span.start) + to;
		last = span.end;
	}
	return out + text.slice(last);
}
