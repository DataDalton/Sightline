// Generic structured-filter engine. Column definitions are supplied by the
// caller (from the dataset registry at runtime, or a static list in a test),
// so this module carries no knowledge of any particular schema.

export type SearchColumnType = "text" | "number" | "date" | "enum" | "boolean";

export interface SearchColumn {
	key: string;
	label: string;
	type: SearchColumnType;
	// Options for enum columns. When absent, the value picker falls back to
	// fetching distinct values from the dataset.
	options?: { value: string; label: string }[];
	// Optional grouping label used to section the column picker.
	group?: string;
}

export type SearchOperator =
	| "eq"
	| "neq"
	| "contains"
	| "starts_with"
	| "ends_with"
	| "like"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "is_empty"
	| "is_not_empty";

export const operatorLabels: Record<SearchOperator, string> = {
	eq: "=",
	neq: "!=",
	contains: "contains",
	starts_with: "starts with",
	ends_with: "ends with",
	like: "like",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
	is_empty: "is empty",
	is_not_empty: "is not empty",
};

export const valuelessOperators = new Set<SearchOperator>([
	"is_empty",
	"is_not_empty",
]);

// Operators valid for each column type. Used by the UI to hide nonsensical
// combinations and by the server to reject malformed input.
const textOps: SearchOperator[] = [
	"contains",
	"eq",
	"neq",
	"starts_with",
	"ends_with",
	"like",
	"is_empty",
	"is_not_empty",
];
const numberOps: SearchOperator[] = [
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"is_empty",
	"is_not_empty",
];
const dateOps: SearchOperator[] = numberOps;
const enumOps: SearchOperator[] = ["eq", "neq", "is_empty", "is_not_empty"];
const booleanOps: SearchOperator[] = ["eq", "neq"];

export function operatorsForColumn(col: SearchColumn): SearchOperator[] {
	switch (col.type) {
		case "number":
			return numberOps;
		case "date":
			return dateOps;
		case "enum":
			return enumOps;
		case "boolean":
			return booleanOps;
		default:
			return textOps;
	}
}

// A leaf filter clause. `kind` is required so the discriminated union narrows
// reliably under structural inference.
export interface SearchClause {
	kind: "clause";
	column: string;
	op: SearchOperator;
	value?: string;
}

export type SearchCombinator = "and" | "or";

export interface SearchGroup {
	kind: "group";
	combinator: SearchCombinator;
	filters: SearchFilter[];
}

export type SearchFilter = SearchClause | SearchGroup;

export function isGroup(filter: SearchFilter): filter is SearchGroup {
	return (filter as SearchGroup).kind === "group";
}

export function isClause(filter: SearchFilter): filter is SearchClause {
	return !isGroup(filter);
}

export function isValidOperator(op: string): op is SearchOperator {
	return op in operatorLabels;
}

// Bounds on a filter tree, so a crafted request cannot generate an unbounded
// query. Enforced server-side during parsing.
export const maxFilterDepth = 5;
export const maxFilterNodes = 30;
export const maxSearchTerms = 50;

export function columnsByKey(
	columns: SearchColumn[],
): Record<string, SearchColumn> {
	return Object.fromEntries(columns.map((c) => [c.key, c]));
}

// Splits a free-text query on commas so "alpha, beta" matches either term.
// Blank segments are dropped, so trailing and doubled commas are harmless.
export function splitSearchTerms(raw: string): string[] {
	return raw
		.split(",")
		.map((term) => term.trim())
		.filter((term) => term.length > 0);
}
