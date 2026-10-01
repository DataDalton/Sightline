import { defaultTableExpr } from "./types";

// Fields defined in the app rather than published by the source.
//
// A sync compares what the source publishes with what is registered, and a
// registered name the source does not publish reads as a field that went
// away. That holds for a field registration wrote for a column, whose
// expression is the column itself. It does not hold for a field somebody
// defined as a calculation over columns, such as a distinct count or a month
// taken from a date, whose name was never a column. Such a field is present
// for as long as every column its expression reads is present.

// The columns an expression reads, taken from its quoted names. A doubled
// backtick inside a name is one backtick.
export function referencedColumns(expression: string): string[] {
	const found = new Set<string>();
	const quoted = /`((?:[^`]|``)+)`/g;
	let match: RegExpExecArray | null;
	while ((match = quoted.exec(expression)) !== null) {
		found.add(match[1].replace(/``/g, "`"));
	}
	return [...found];
}

// Whether a registered field is a calculation defined in the app, which is
// any expression other than the one registration writes for a column of that
// name. A metric view field carries no expression and is a published field.
export function isAuthored(name: string, expression: string | null): boolean {
	if (!expression) return false;
	return (
		expression !== defaultTableExpr(name, "dimension") &&
		expression !== defaultTableExpr(name, "measure")
	);
}

// Whether a registered field is still there, given the names the source
// publishes now. A calculation that reads no column, such as a row count,
// holds for as long as the source does.
export function isPresent(
	name: string,
	expression: string | null,
	published: Set<string>,
): boolean {
	if (published.has(name)) return true;
	if (!isAuthored(name, expression)) return false;
	return referencedColumns(expression ?? "").every((c) => published.has(c));
}
