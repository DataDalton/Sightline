// Recognising a renamed field from what a sync saw of it.
//
// A field is referenced by name everywhere, so a rename upstream reads to the
// sync as one field gone and another arrived. Telling the two cases apart
// matters. A field that was removed leaves its items broken until somebody
// rebuilds them, where a field that was renamed can be repaired in one step by
// pointing every item at the new name.
//
// The evidence is what the name leaves behind. A metric view field carries its
// expression, which a rename does not touch, so an identical expression is the
// strongest signal there is. The comment, the kind, the data type and the
// position in the definition usually survive too, and the two names are often
// close. None of it is proof, so a match is only ever offered for somebody to
// confirm, never applied.
//
// Kept free of database and network imports so it can be tested on its own.

export interface FieldPrint {
	name: string;
	kind: "dimension" | "measure";
	dataType: string | null;
	comment: string | null;
	// Position in the source's own field order.
	ordinal: number | null;
	// The metric view expression, where the source is one.
	expression: string | null;
}

export interface RenameCandidate {
	from: string;
	to: string;
	// Between zero and one.
	confidence: number;
	// What matched, in words, for whoever confirms it.
	reasons: string[];
}

// The least a pair has to score before it is offered.
export const renameThreshold = 0.5;

// How far the best pair for a field has to lead the next best before it is
// taken as the match rather than a coin toss between two.
const clearLead = 0.1;

const weights = {
	expression: 0.6,
	comment: 0.25,
	dataType: 0.1,
	ordinal: 0.1,
	name: 0.2,
};

// An expression as a comparison sees it, so quoting and spacing that the view
// author changed alongside the rename do not hide an identical calculation.
export function normaliseExpression(expr: string | null): string | null {
	if (!expr) return null;
	const flat = expr
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	return flat || null;
}

function normaliseText(text: string | null): string | null {
	if (!text) return null;
	const flat = text.replace(/\s+/g, " ").trim().toLowerCase();
	return flat || null;
}

function normaliseType(dataType: string | null): string | null {
	return dataType ? dataType.replace(/\s+/g, "").toLowerCase() : null;
}

// The name reduced to its letters and digits, so "Net_Sales" and "net sales"
// compare as the same word.
function nameKey(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length];
}

// How alike two names are, between zero and one.
export function nameSimilarity(a: string, b: string): number {
	const x = nameKey(a);
	const y = nameKey(b);
	if (!x || !y) return 0;
	const longest = Math.max(x.length, y.length);
	const byEdits = 1 - editDistance(x, y) / longest;
	// One name inside the other, as when a word is added to it, counts for as
	// much as the shorter name covers of the longer.
	const contained =
		x.includes(y) || y.includes(x)
			? Math.min(x.length, y.length) / longest
			: 0;
	return Math.max(byEdits, contained);
}

// How strongly one missing field and one new field look like the same field
// under two names.
//
// A pair of different kinds scores nothing. Remapping a measure onto a
// dimension would move it into a GROUP BY and change what every query means,
// which no amount of other agreement makes safe.
export function scorePair(
	missing: FieldPrint,
	added: FieldPrint,
): { score: number; reasons: string[] } {
	if (missing.kind !== added.kind) return { score: 0, reasons: [] };

	let score = 0;
	const reasons: string[] = [];

	const exprA = normaliseExpression(missing.expression);
	const exprB = normaliseExpression(added.expression);
	if (exprA && exprB && exprA === exprB) {
		score += weights.expression;
		reasons.push("same calculation");
	}

	const commentA = normaliseText(missing.comment);
	const commentB = normaliseText(added.comment);
	if (commentA && commentB && commentA === commentB) {
		score += weights.comment;
		reasons.push("same description");
	}

	const typeA = normaliseType(missing.dataType);
	const typeB = normaliseType(added.dataType);
	if (typeA && typeB && typeA === typeB) {
		score += weights.dataType;
		reasons.push("same data type");
	}

	if (
		missing.ordinal !== null &&
		added.ordinal !== null &&
		missing.ordinal === added.ordinal
	) {
		score += weights.ordinal;
		reasons.push("same position");
	}

	const similarity = nameSimilarity(missing.name, added.name);
	if (similarity > 0) {
		score += weights.name * similarity;
		if (similarity >= 0.5) reasons.push("similar name");
	}

	return { score: Math.min(1, score), reasons };
}

// The renames worth offering from one sync's missing and added fields.
//
// Only a pair that is each side's clear best is offered, so no field is ever
// offered two replacements and no new field is offered as the replacement for
// two old ones. Anything ambiguous is left for a person to judge by name.
export function detectRenames(
	missing: FieldPrint[],
	added: FieldPrint[],
	threshold = renameThreshold,
): RenameCandidate[] {
	if (missing.length === 0 || added.length === 0) return [];

	const scores = missing.map((m) => added.map((a) => scorePair(m, a)));

	// The best and runner up score in a list, by index.
	const ranked = (values: number[]) => {
		let best = -1;
		let second = 0;
		values.forEach((value, index) => {
			if (best < 0 || value > values[best]) {
				if (best >= 0) second = Math.max(second, values[best]);
				best = index;
			} else {
				second = Math.max(second, value);
			}
		});
		return { best, second };
	};

	const out: RenameCandidate[] = [];
	missing.forEach((m, i) => {
		const row = scores[i].map((s) => s.score);
		const { best: j, second } = ranked(row);
		if (j < 0) return;
		const top = row[j];
		if (top < threshold || top - second < clearLead) return;

		const column = scores.map((r) => r[j].score);
		const { best: back, second: columnSecond } = ranked(column);
		if (back !== i || top - columnSecond < clearLead) return;

		out.push({
			from: m.name,
			to: added[j].name,
			confidence: Math.round(top * 100) / 100,
			reasons: scores[i][j].reasons,
		});
	});
	return out;
}
