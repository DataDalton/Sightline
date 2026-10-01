import type { SemanticField } from "./types";

// Whether a measure is a plain sum or count of its rows.
//
// Rows that have not arrived yet can only make such a figure smaller, so a
// low reading of one may be data still loading. A rate, an average or a ratio
// can move either way when rows are missing, so a low reading of one says
// nothing about loading. Only an expression that is one SUM or COUNT over the
// whole of it counts. Anything else, and any measure whose expression is not
// known, does not.
//
// Pure, so it can be tested with expressions written out by hand.

// The index just past the bracket that closes the one opening at start, or -1
// when it never closes. Brackets inside quotes do not count.
function closingBracket(text: string, start: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

export function isAdditiveExpression(
	expression: string | null | undefined,
): boolean {
	const text = (expression ?? "").trim();
	const call = /^(sum|count)\s*\(/i.exec(text);
	if (!call) return false;
	const inner = text.slice(call[0].length).trimStart();
	// A sum of distinct values drops duplicates, so it is not a plain sum.
	if (call[1].toLowerCase() === "sum" && /^distinct\b/i.test(inner))
		return false;
	const end = closingBracket(text, call[0].length - 1);
	if (end < 0) return false;
	const rest = text.slice(end).trim();
	if (rest === "") return true;
	// A filter keeps some rows out of the sum and still only adds up the rest.
	const filter = /^filter\s*\(/i.exec(rest);
	if (!filter) return false;
	return closingBracket(rest, filter[0].length - 1) === rest.length;
}

// A registered measure's own expression, or the one its metric view holds.
export function isAdditiveMeasure(
	field: Pick<SemanticField, "sqlExpr" | "expression"> | null | undefined,
): boolean {
	if (!field) return false;
	return isAdditiveExpression(field.sqlExpr ?? field.expression ?? null);
}
