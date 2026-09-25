// Conditions typed into the explore bar, and how a row of them becomes a query.
//
// Somebody types "Category = Hardware" or "or Revenue > 1000000" or "not Region
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
	// Brackets opened just before this condition and closed just after it, so
	// "West and (Hardware or Software)" is West, then Hardware opening one, then Software
	// closing it. Absent means none.
	open?: number;
	close?: number;
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

// Closing brackets at the end of what was typed, taken off the value. Only
// the ones the value does not account for itself: "ACME (US)" is a customer
// name, while "Software)" is Software closing a bracket.
function closingBrackets(text: string): [string, number] {
	let body = text.trimEnd();
	let close = 0;
	while (body.endsWith(")")) {
		const opens = (body.match(/\(/g) ?? []).length;
		const closes = (body.match(/\)/g) ?? []).length;
		if (closes <= opens) break;
		body = body.slice(0, -1).trimEnd();
		close++;
	}
	return [body, close];
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
	// Brackets can come before or after "not": "(not Region = West" and
	// "not (Region = West" both read as a bracket opening on a negated
	// condition.
	let open = 0;
	const takeOpens = () => {
		const opens = /^\(+\s*/.exec(rest);
		if (opens) {
			open += (opens[0].match(/\(/g) ?? []).length;
			rest = rest.slice(opens[0].length);
		}
	};
	takeOpens();
	const notWord = /^not\s+/i.exec(rest);
	if (notWord) {
		negate = true;
		rest = rest.slice(notWord[0].length);
	}
	takeOpens();
	const brackets = (close: number) => ({
		...(open ? { open } : {}),
		...(close ? { close } : {}),
	});

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

		const [typed, close] = closingBrackets(
			afterField.slice(word.length).trim(),
		);
		if (arity === "none") {
			return {
				condition: {
					field: field.name,
					op,
					negate,
					join,
					...brackets(close),
				},
				partial: false,
				typedValue: "",
			};
		}
		if (arity === "many") {
			const values = splitValues(typed);
			return {
				condition: {
					field: field.name,
					op,
					values,
					negate,
					join,
					...brackets(close),
				},
				partial: values.length === 0,
				typedValue: typed.split(",").pop()?.trim() ?? "",
			};
		}
		const value = typed.replace(/^["']|["']$/g, "");
		return {
			condition: {
				field: field.name,
				op,
				value,
				negate,
				join,
				...brackets(close),
			},
			partial: value.length === 0,
			typedValue: value,
		};
	}

	return null;
}

// Written in the same words the bar reads, so a chip put back into the box to
// edit parses into the condition it came from. Brackets are included only when
// asked for: a chip draws them as marks of their own either side of it.
export function describeCondition(
	condition: Condition,
	withBrackets = false,
): string {
	const body = condition.values?.length
		? `${condition.field} ${condition.op === "neq" ? "not in" : "in"} ${condition.values.join(", ")}`
		: `${condition.field} ${operatorLabel[condition.op]}${
				condition.value !== undefined && condition.value !== ""
					? ` ${condition.value}`
					: ""
			}`;
	const text = condition.negate ? `not ${body}` : body;
	if (!withBrackets) return text;
	return `${"(".repeat(condition.open ?? 0)}${text}${")".repeat(condition.close ?? 0)}`;
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

// A condition tree in the shape the query takes.
export type SpecNode =
	| SpecFilter
	| { all: SpecNode[] }
	| { any: SpecNode[] }
	| { not: SpecNode };

export interface FilterLogic {
	filters: SpecFilter[];
	anyOf?: SpecFilter[][];
	where?: SpecNode;
	// Set when the row cannot be run as written, with the reason in words.
	problem?: string;
}

// Where the brackets in a row do not pair up, in words, or null when they do.
export function bracketProblem(conditions: Condition[]): string | null {
	let depth = 0;
	for (const c of conditions) {
		depth += c.open ?? 0;
		depth -= c.close ?? 0;
		if (depth < 0) return "A bracket is closed before one was opened.";
	}
	if (depth > 0) {
		return depth === 1
			? "A bracket is opened and not closed."
			: `${depth} brackets are opened and not closed.`;
	}
	return null;
}

// Reads a row of conditions into a tree: brackets first, then AND before OR,
// the way the row is read aloud. "A and B or C" is either both A and B, or C,
// and "A and (B or C)" is A with either B or C.
//
// Written as a small recursive reader over the row, one level per bracket.
function toTree(conditions: Condition[]): SpecNode {
	let at = 0;
	// Brackets still to open before the condition at `at`, and still to close
	// after the one before it, since one condition can carry several.
	let opensLeft = conditions[0]?.open ?? 0;
	let closesOwed = 0;

	const leaf = (): SpecNode => {
		if (opensLeft > 0) {
			opensLeft--;
			const inner = disjunction();
			// The bracket this opened is closed by one owed from the last
			// condition read inside it.
			if (closesOwed > 0) closesOwed--;
			return inner;
		}
		const c = conditions[at];
		at++;
		closesOwed += c.close ?? 0;
		opensLeft = conditions[at]?.open ?? 0;
		return toFilter(c);
	};

	// Stops at the end of the row, or where a bracket closes.
	const more = () => at < conditions.length && closesOwed === 0;

	const conjunction = (): SpecNode => {
		const parts = [leaf()];
		while (more() && conditions[at].join === "and") parts.push(leaf());
		return parts.length === 1 ? parts[0] : { all: parts };
	};

	const disjunction = (): SpecNode => {
		const parts = [conjunction()];
		while (more() && conditions[at].join === "or")
			parts.push(conjunction());
		return parts.length === 1 ? parts[0] : { any: parts };
	};

	return disjunction();
}

// What kind each part of a tree tests, or "mixed" where an OR inside it holds
// both. Mirrors the rule the query applies, so the problem is shown as the row
// is typed rather than when the table fails to load.
function kindOf(
	node: SpecNode,
	kinds: Map<string, "dimension" | "measure">,
): "dimension" | "measure" | "mixed" {
	if ("all" in node || "any" in node) {
		const seen = new Set(
			("all" in node ? node.all : node.any).map((n) => kindOf(n, kinds)),
		);
		return seen.size === 1 ? [...seen][0] : "mixed";
	}
	if ("not" in node) return kindOf(node.not, kinds);
	return kinds.get(node.field) ?? "dimension";
}

function placeable(
	node: SpecNode,
	kinds: Map<string, "dimension" | "measure">,
): boolean {
	// A top-level AND is split into its parts, so only they need to be whole.
	if ("all" in node) return node.all.every((n) => placeable(n, kinds));
	return kindOf(node, kinds) !== "mixed";
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

	const unpaired = bracketProblem(conditions);
	if (unpaired) return { filters: [], problem: unpaired };

	const grouped = conditions.some((c) => c.open || c.close);
	const alternatives = conditions.some((c, i) => i > 0 && c.join === "or");

	// No brackets and no OR is a plain list, the same query a report would
	// send, so it shares the report's cache.
	if (!grouped && !alternatives) {
		return { filters: conditions.map(toFilter) };
	}

	const where = toTree(conditions);
	if (!placeable(where, kinds)) {
		return {
			filters: [],
			problem:
				"An OR can't mix a column that groups rows with one that totals them. Keep everything inside one OR to one kind, or join them with AND.",
		};
	}
	return { filters: [], where };
}

// Removes one condition without leaving its brackets unpaired. A bracket it
// opened moves to the condition after it, which also takes over how the group
// joins what came before. A bracket it closed moves to the one before it. A
// bracket it both opened and closed held only it, and goes with it.
export function withoutCondition(
	conditions: Condition[],
	index: number,
): Condition[] {
	const gone = conditions[index];
	if (!gone) return conditions;
	let open = gone.open ?? 0;
	let close = gone.close ?? 0;
	const both = Math.min(open, close);
	open -= both;
	close -= both;

	const rest = conditions.map((c) => ({ ...c }));
	const next = rest[index + 1];
	const prev = rest[index - 1];
	if (open > 0 && next) {
		next.open = (next.open ?? 0) + open;
		next.join = gone.join;
	}
	if (close > 0 && prev) prev.close = (prev.close ?? 0) + close;
	return tidy(rest.filter((_, i) => i !== index));
}

// Takes away one bracket and the one it pairs with.
//
// A condition can carry several brackets on one side, so which one was meant
// is given by its position among them, counted from the left: the first "(" is
// the outermost, the first ")" the innermost.
export function withoutBracket(
	conditions: Condition[],
	index: number,
	side: "open" | "close",
	position = 0,
): Condition[] {
	const rest = conditions.map((c) => ({ ...c }));
	const at = rest[index];
	if (!at) return conditions;

	let pair = -1;
	if (side === "open") {
		// This bracket and every one inside it opened at the same condition,
		// less those the condition closes again itself.
		let depth = (at.open ?? 0) - position - (at.close ?? 0);
		if (depth <= 0) pair = index;
		for (let i = index + 1; pair < 0 && i < rest.length; i++) {
			depth += (rest[i].open ?? 0) - (rest[i].close ?? 0);
			if (depth <= 0) pair = i;
		}
		at.open = (at.open ?? 0) - 1;
		if (pair >= 0) rest[pair].close = (rest[pair].close ?? 0) - 1;
	} else {
		let depth = position + 1 - (at.open ?? 0);
		if (depth <= 0) pair = index;
		for (let i = index - 1; pair < 0 && i >= 0; i--) {
			depth += (rest[i].close ?? 0) - (rest[i].open ?? 0);
			if (depth <= 0) pair = i;
		}
		at.close = (at.close ?? 0) - 1;
		if (pair >= 0) rest[pair].open = (rest[pair].open ?? 0) - 1;
	}
	return tidy(rest);
}

// Brackets not yet closed at the end of the row.
export function openDepth(conditions: Condition[]): number {
	return conditions.reduce(
		(depth, c) => depth + (c.open ?? 0) - (c.close ?? 0),
		0,
	);
}

// Counts at zero are left off, so a row with no brackets is spelled exactly as
// it was before brackets existed.
function tidy(conditions: Condition[]): Condition[] {
	return conditions.map((c) => {
		const { open, close, ...rest } = c;
		return {
			...rest,
			...(open && open > 0 ? { open } : {}),
			...(close && close > 0 ? { close } : {}),
		};
	});
}
