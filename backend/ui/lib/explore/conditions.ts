// Conditions typed into the explore bar, and how a row of them becomes a query.
//
// Somebody types "Division = Hardware" or "or Revenue > 1000000" or "not Region
// in West, East" and gets a condition. The field names contain spaces, so the
// field is found by matching the known names against the start of the text,
// longest first, rather than by splitting on whitespace.
//
// Kept free of browser and network imports so it can be tested on its own.

export type ConditionOp =
	| "eq"
	| "neq"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "contains"
	| "starts_with"
	| "ends_with"
	| "is_empty"
	| "is_not_empty";

export interface Condition {
	field: string;
	op: ConditionOp;
	value?: string;
	values?: string[];
	negate: boolean;
	// How this condition joins the one before it. Ignored on the first.
	join: "and" | "or";
}

export interface KnownField {
	name: string;
	kind: "dimension" | "measure";
}

// Spelled the way people type them, longest first so ">=" is not read as ">"
// followed by a value starting "=".
const operatorWords: [string, ConditionOp, "one" | "many" | "none"][] = [
	["is not empty", "is_not_empty", "none"],
	["is empty", "is_empty", "none"],
	["starts with", "starts_with", "one"],
	["ends with", "ends_with", "one"],
	["not in", "neq", "many"],
	["contains", "contains", "one"],
	["is not", "neq", "one"],
	["in", "eq", "many"],
	["is", "eq", "one"],
	[">=", "gte", "one"],
	["<=", "lte", "one"],
	["!=", "neq", "one"],
	["<>", "neq", "one"],
	["==", "eq", "one"],
	["=", "eq", "one"],
	[">", "gt", "one"],
	["<", "lt", "one"],
	["~", "contains", "one"],
];

export const operatorLabel: Record<ConditionOp, string> = {
	eq: "is",
	neq: "is not",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
	contains: "contains",
	starts_with: "starts with",
	ends_with: "ends with",
	is_empty: "is empty",
	is_not_empty: "is not empty",
};

export interface ParsedCondition {
	condition: Condition;
	// The value is still being typed. Offered as a suggestion, and used to
	// look up matching values, but not applied until it is chosen.
	partial: boolean;
	// The text after the operator, for value lookups.
	typedValue: string;
}

function splitValues(text: string): string[] {
	return text
		.split(",")
		.map((v) => v.trim().replace(/^["']|["']$/g, ""))
		.filter((v) => v.length > 0);
}

// Reads a condition out of what has been typed so far, or null when the text
// does not start with a known field. A field with no operator yet is not a
// condition: it is somebody typing a column name.
export function parseCondition(
	text: string,
	fields: KnownField[],
): ParsedCondition | null {
	let rest = text.trimStart();
	let join: "and" | "or" = "and";
	let negate = false;

	const joinWord = /^(and|or)\s+/i.exec(rest);
	if (joinWord) {
		join = joinWord[1].toLowerCase() as "and" | "or";
		rest = rest.slice(joinWord[0].length);
	}
	const notWord = /^not\s+/i.exec(rest);
	if (notWord) {
		negate = true;
		rest = rest.slice(notWord[0].length);
	}

	const lower = rest.toLowerCase();
	const field = [...fields]
		.sort((a, b) => b.name.length - a.name.length)
		.find((f) => {
			const name = f.name.toLowerCase();
			if (!lower.startsWith(name)) return false;
			const next = rest.charAt(name.length);
			return next === "" || /[\s=!<>~]/.test(next);
		});
	if (!field) return null;

	const afterField = rest.slice(field.name.length).trimStart();
	const afterLower = afterField.toLowerCase();

	for (const [word, op, arity] of operatorWords) {
		const symbol = /^[^a-z]/.test(word);
		if (!afterLower.startsWith(word)) continue;
		const next = afterField.charAt(word.length);
		// A word operator has to end at a word boundary, so "Region isolated"
		// is not read as "Region is olated".
		if (!symbol && next !== "" && !/\s/.test(next)) continue;

		const typed = afterField.slice(word.length).trim();
		if (arity === "none") {
			return {
				condition: { field: field.name, op, negate, join },
				partial: false,
				typedValue: "",
			};
		}
		if (arity === "many") {
			const values = splitValues(typed);
			return {
				condition: { field: field.name, op, values, negate, join },
				partial: values.length === 0,
				typedValue: typed.split(",").pop()?.trim() ?? "",
			};
		}
		const value = typed.replace(/^["']|["']$/g, "");
		return {
			condition: { field: field.name, op, value, negate, join },
			partial: value.length === 0,
			typedValue: value,
		};
	}

	return null;
}

// Written in the same words the bar reads, so a chip put back into the box to
// edit parses into the condition it came from.
export function describeCondition(condition: Condition): string {
	const body = condition.values?.length
		? `${condition.field} ${condition.op === "neq" ? "not in" : "in"} ${condition.values.join(", ")}`
		: `${condition.field} ${operatorLabel[condition.op]}${
				condition.value !== undefined && condition.value !== ""
					? ` ${condition.value}`
					: ""
			}`;
	return condition.negate ? `not ${body}` : body;
}

interface SpecFilter {
	field: string;
	op: ConditionOp;
	value?: string;
	values?: string[];
	negate?: boolean;
}

function toFilter(condition: Condition): SpecFilter {
	return {
		field: condition.field,
		op: condition.op,
		...(condition.values?.length
			? { values: condition.values }
			: condition.value !== undefined
				? { value: condition.value }
				: {}),
		...(condition.negate ? { negate: true } : {}),
	};
}

export interface FilterLogic {
	filters: SpecFilter[];
	anyOf?: SpecFilter[][];
	// Set when the row cannot be run as written, with the reason in words.
	problem?: string;
}

// A row of conditions joined by AND and OR, read the way it is read aloud: AND
// binds tighter than OR, so "A and B or C" is either both A and B, or C.
//
// That is the shape the query takes: a list of groups, each a set of conditions
// that all hold, any one of which lets a row through. With no OR in the row
// there is one group and it is sent as plain filters, which is the same query a
// report would send and so shares its cache.
export function toFilterLogic(
	conditions: Condition[],
	kinds: Map<string, "dimension" | "measure">,
): FilterLogic {
	if (conditions.length === 0) return { filters: [] };

	const groups: Condition[][] = [[]];
	conditions.forEach((condition, i) => {
		if (i > 0 && condition.join === "or") groups.push([]);
		groups[groups.length - 1].push(condition);
	});

	if (groups.length === 1) {
		return { filters: groups[0].map(toFilter) };
	}

	const seen = new Set(conditions.map((c) => kinds.get(c.field)));
	if (seen.size > 1) {
		return {
			filters: [],
			problem:
				"An OR can't mix a column that groups rows with one that totals them. Keep both sides of the OR to one kind.",
		};
	}

	return { filters: [], anyOf: groups.map((g) => g.map(toFilter)) };
}
