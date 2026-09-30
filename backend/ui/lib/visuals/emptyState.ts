import {
	describeValue,
	selectionValue,
	type SelectionClause,
} from "./selection";

// What an empty visual says about why it is empty.
//
// A visual with no rows under the page's filters is usually a filter
// combination that matches nothing rather than missing data, and the reader
// can only act on that if the visual names the filters in play. A query that
// names a field its source has since dropped is a different failure, and it
// is told apart from a fault so the reader knows who can fix it.

interface Clause extends Partial<SelectionClause> {
	negate?: boolean;
}

function record(value: unknown): Clause {
	return value && typeof value === "object" ? (value as Clause) : {};
}

function valuesOf(clause: Clause): string[] {
	if (Array.isArray(clause.values)) {
		return clause.values.map((value) => selectionValue(value));
	}
	return clause.value === undefined ? [] : [selectionValue(clause.value)];
}

// Worded the way selectionLabel words a chip, so a value reads the same in the
// filter bar and in an empty visual.
function joined(values: string[]): string {
	return values.length > 3
		? `${values.length} selected`
		: values.map(describeValue).join(" or ");
}

// One field's clauses as a reader would say them, such as "Region: North",
// "Order date: 01/01/2026 to 03/31/2026" or "Amount: at least 500".
function describeField(
	field: string,
	clauses: Clause[],
	nameOf: (field: string) => string,
): string | null {
	const name = nameOf(field);
	const lower = clauses.find((c) => c.op === "gte" || c.op === "gt");
	const upper = clauses.find((c) => c.op === "lte" || c.op === "lt");
	const rest = clauses.filter((c) => c !== lower && c !== upper);
	const parts: string[] = [];

	if (lower && upper) {
		parts.push(`${joined(valuesOf(lower))} to ${joined(valuesOf(upper))}`);
	} else if (lower) {
		parts.push(
			`${lower.op === "gt" ? "above" : "at least"} ${joined(valuesOf(lower))}`,
		);
	} else if (upper) {
		parts.push(
			`${upper.op === "lt" ? "below" : "at most"} ${joined(valuesOf(upper))}`,
		);
	}

	for (const clause of rest) {
		const values = valuesOf(clause);
		const not = clause.negate === true;
		switch (clause.op) {
			case "eq":
				if (values.length === 0) break;
				parts.push(not ? `not ${joined(values)}` : joined(values));
				break;
			case "neq":
				parts.push(`not ${joined(values)}`);
				break;
			case "is_empty":
				parts.push(not ? "not blank" : "blank");
				break;
			case "is_not_empty":
				parts.push(not ? "blank" : "not blank");
				break;
			case "contains":
			case "starts_with":
			case "ends_with":
			case "like":
				parts.push(
					`${not ? "not " : ""}${clause.op.replace("_", " ")} "${values.join(" or ")}"`,
				);
				break;
			default:
				break;
		}
	}

	return parts.length > 0 ? `${name}: ${parts.join(", ")}` : null;
}

// The filters applied to a visual, one line per field, in the order the
// fields first appear.
export function describeFilters(
	clauses: unknown[],
	nameOf: (field: string) => string = (field) => field,
): string[] {
	const byField = new Map<string, Clause[]>();
	for (const raw of clauses) {
		const clause = record(raw);
		if (typeof clause.field !== "string" || typeof clause.op !== "string") {
			continue;
		}
		const held = byField.get(clause.field) ?? [];
		held.push(clause);
		byField.set(clause.field, held);
	}
	const out: string[] = [];
	for (const [field, held] of byField) {
		const line = describeField(field, held, nameOf);
		if (line) out.push(line);
	}
	return out;
}

const missingPattern = /no longer exists/i;
const quoted = /["'`“‘]([^"'`”’]+)["'`”’]/;
const named = /\b(?:field|measure|dimension|column)\s+(?!no\b)([\w.$-]+)/i;

// The field a query failed on because its source no longer defines it, or
// null when the failure was something else. An empty string means the message
// said a field was gone without saying which.
export function missingFieldIn(
	message: string | undefined | null,
): string | null {
	if (!message || !missingPattern.test(message)) return null;
	const match = quoted.exec(message) ?? named.exec(message);
	return match ? match[1] : "";
}
