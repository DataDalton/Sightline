// Finding published reports that show the same measure in a way that can disagree, and
// saying why. Pure, so what counts as the same figure can be tested.

export interface ComparedVisual {
	visualId: string;
	reportId: string;
	reportTitle: string;
	reportSlug: string;
	pageTitle: string;
	// How to open that page, and who may change that report.
	pageIsFirst?: boolean;
	categoryId?: string | null;
	reportTags?: string[] | null;
	title: string | null;
	sourceKey: string;
	measure: string;
	dimensions: string[];
	filters: unknown[];
	// What its page narrows everything to on opening.
	pageFilters?: unknown[];
	options: Record<string, unknown>;
}

export interface Candidate {
	key: string;
	sourceKey: string;
	measure: string;
	left: ComparedVisual;
	right: ComparedVisual;
	differences: string[];
}

function clauseKey(clause: unknown): string {
	const held = (clause ?? {}) as Record<string, unknown>;
	const values = Array.isArray(held.values)
		? [...held.values].map(String).sort()
		: held.value;
	return JSON.stringify([held.field, held.op, values]);
}

function clauseWords(clause: unknown): string {
	const held = (clause ?? {}) as Record<string, unknown>;
	const values = Array.isArray(held.values)
		? held.values.join(", ")
		: String(held.value ?? "");
	const op = String(held.op ?? "");
	if (op === "eq" || op === "in") return `${held.field} is ${values}`;
	if (op === "is_empty") return `${held.field} is blank`;
	if (op === "is_not_empty") return `${held.field} is not blank`;
	const dated: Record<string, string> = {
		gte: "from",
		lte: "up to",
		gt: "after",
		lt: "before",
	};
	if (dated[op]) return `${held.field} ${dated[op]} ${values}`;
	return `${held.field} ${op} ${values}`.trim();
}

// What could make two figures differ, in plain words. Empty means they ask the same
// question, so they cannot disagree unless the data does.
export function differencesBetween(
	left: ComparedVisual,
	right: ComparedVisual,
): string[] {
	const out: string[] = [];
	// Whichever way a figure came to be narrowed, it is the same narrowing, so a page's
	// opening filter and another report's visual filter on the same value do not differ.
	const narrowing = (visual: ComparedVisual) => {
		const held = new Map<string, { clause: unknown; atOpening: boolean }>();
		for (const clause of visual.pageFilters ?? []) {
			held.set(clauseKey(clause), { clause, atOpening: true });
		}
		for (const clause of visual.filters) {
			held.set(clauseKey(clause), { clause, atOpening: false });
		}
		return held;
	};
	const leftKeys = narrowing(left);
	const rightKeys = narrowing(right);
	const say = (
		visual: ComparedVisual,
		held: { clause: unknown; atOpening: boolean },
	) =>
		held.atOpening
			? `${visual.reportTitle} opens showing only ${clauseWords(held.clause)}`
			: `${visual.reportTitle} only counts ${clauseWords(held.clause)}`;
	for (const [key, held] of leftKeys) {
		if (!rightKeys.has(key)) out.push(say(left, held));
	}
	for (const [key, held] of rightKeys) {
		if (!leftKeys.has(key)) out.push(say(right, held));
	}
	const topN = (visual: ComparedVisual) => visual.options.topN;
	if (topN(left) !== topN(right)) {
		const limited = topN(left) ? left : right;
		out.push(
			`${limited.reportTitle} keeps only the top ${topN(limited)} rows, so its total leaves the rest out`,
		);
	}
	return out;
}

// Pairs on different reports showing one measure on one source by the same breakdown.
// Two that ask the same question are left out, since the data alone decides those.
export function findCandidates(visuals: ComparedVisual[]): Candidate[] {
	const groups = new Map<string, ComparedVisual[]>();
	for (const visual of visuals) {
		const key = JSON.stringify([
			visual.sourceKey,
			visual.measure,
			[...visual.dimensions].sort(),
		]);
		groups.set(key, [...(groups.get(key) ?? []), visual]);
	}
	const out: Candidate[] = [];
	for (const [key, members] of groups) {
		for (let i = 0; i < members.length; i += 1) {
			for (let j = i + 1; j < members.length; j += 1) {
				const left = members[i];
				const right = members[j];
				if (left.reportId === right.reportId) continue;
				const differences = differencesBetween(left, right);
				if (differences.length === 0) continue;
				out.push({
					key: `${key}:${left.visualId}:${right.visualId}`,
					sourceKey: left.sourceKey,
					measure: left.measure,
					left,
					right,
					differences,
				});
			}
		}
	}
	return out;
}

// Added up over whatever rows came back, so a breakdown compares as a total.
export function totalOf(
	rows: Record<string, unknown>[],
	measure: string,
): number {
	return rows.reduce((sum, row) => {
		const value = Number(row[measure]);
		return Number.isFinite(value) ? sum + value : sum;
	}, 0);
}

// One line for two reports that differ the same way on a measure, however many visuals show
// it, since the fix and the answer are the same for all of them. Says how many it stands for.
export function collapseCandidates(
	candidates: Candidate[],
): (Candidate & { alsoOn: number })[] {
	const held = new Map<string, Candidate & { alsoOn: number }>();
	for (const candidate of candidates) {
		const key = JSON.stringify([
			candidate.left.reportId,
			candidate.right.reportId,
			candidate.measure,
			[...candidate.differences].sort(),
		]);
		const first = held.get(key);
		if (first) first.alsoOn += 1;
		else held.set(key, { ...candidate, alsoOn: 0 });
	}
	return [...held.values()];
}

// A pair's name across restarts, which does not depend on the order they were found in.
export function pairKey(
	leftVisualId: string,
	rightVisualId: string,
	measure: string,
): string {
	return `${[leftVisualId, rightVisualId].sort().join(":")}:${measure}`;
}

// Whether two totals disagree, with room for rounding.
export function disagree(left: number, right: number): boolean {
	const largest = Math.max(Math.abs(left), Math.abs(right));
	if (largest === 0) return false;
	return Math.abs(left - right) / largest > 0.0005;
}
