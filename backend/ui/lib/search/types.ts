// The filter operators a query spec may carry, and what they are called.
//
// This was once a generic structured-filter engine: column definitions supplied
// by the caller, a recursive clause-and-group tree, depth and node limits, and
// the helpers a filter builder would need to render one. None of that was ever
// reached. The only filter shape the platform actually sends is the flat one
// QuerySpec carries, so what is left here is the operator vocabulary that shape
// is validated against, and nothing else.
//
// The nested tree is recoverable from history if a filter builder is picked up
// again. It is not kept here in the meantime, because an exported type reads as
// a supported shape and the server never accepted one.

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

// Operators that carry no value, so a filter using one is complete without it.
export const valuelessOperators = new Set<SearchOperator>([
	"is_empty",
	"is_not_empty",
]);

export function isValidOperator(op: string): op is SearchOperator {
	return op in operatorLabels;
}
