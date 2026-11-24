// Searching and filtering as a reader types it: free text across several
// columns, and conditions on a figure such as "revenue > 50k".
//
// Pure, so the search box, the column filters and the page filters agree on
// what a word or a condition means, and so each can be tested on its own.

export type ConditionOp =
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "eq"
	| "neq"
	| "between"
	| "is_empty"
	| "is_not_empty";

// A condition on one column, as a column filter or a page filter holds it.
// Values are kept as typed, such as "50k", and read when the query is built.
export interface ColumnCondition {
	op: ConditionOp;
	value?: string;
	value2?: string;
}

// One clause of a query's filter list, in the shape the query layer reads.
export interface SearchClause {
	field: string;
	op: string;
	value?: string;
	negate?: boolean;
}

// A node of a query's condition tree.
export type SearchNode =
	| SearchClause
	| { all: SearchNode[] }
	| { any: SearchNode[] };

export const conditionLabels: Record<ConditionOp, string> = {
	gt: "greater than",
	gte: "at least",
	lt: "less than",
	lte: "at most",
	eq: "equal to",
	neq: "not equal to",
	between: "between",
	is_empty: "is blank",
	is_not_empty: "is not blank",
};

const symbols: Partial<Record<ConditionOp, string>> = {
	gt: ">",
	gte: "≥",
	lt: "<",
	lte: "≤",
	eq: "=",
	neq: "≠",
};

// An amount as people write one: "50k", "1.2m", "$3,000", "-4.5", "12%".
// Null when it is not a number.
export function parseAmount(text: string): number | null {
	const cleaned = text
		.trim()
		.toLowerCase()
		.replace(/[$,\s]/g, "")
		.replace(/%$/, "");
	const match = /^(-?\d+(?:\.\d+)?|-?\.\d+)([kmb])?$/.exec(cleaned);
	if (!match) return null;
	const base = Number(match[1]);
	const scale =
		match[2] === "k"
			? 1e3
			: match[2] === "m"
				? 1e6
				: match[2] === "b"
					? 1e9
					: 1;
	const value = base * scale;
	return Number.isFinite(value) ? value : null;
}

// Whether a condition has what its operator needs, so a half typed one is not
// applied.
export function conditionComplete(
	condition: ColumnCondition,
	numeric: boolean,
): boolean {
	const ok = (value: string | undefined) =>
		value !== undefined &&
		value.trim() !== "" &&
		(!numeric || parseAmount(value) !== null);
	if (condition.op === "is_empty" || condition.op === "is_not_empty")
		return true;
	if (condition.op === "between")
		return ok(condition.value) && ok(condition.value2);
	return ok(condition.value);
}

// The value as the query reads it: an amount as a plain number, anything else
// as typed, such as a date.
function queryValue(value: string, numeric: boolean): string {
	if (!numeric) return value.trim();
	const amount = parseAmount(value);
	return amount === null ? value.trim() : String(amount);
}

// The query clauses a condition stands for. Between is the two ends, both
// included.
export function conditionClauses(
	field: string,
	condition: ColumnCondition,
	numeric: boolean,
): SearchClause[] {
	if (!conditionComplete(condition, numeric)) return [];
	if (condition.op === "is_empty" || condition.op === "is_not_empty") {
		return [{ field, op: condition.op }];
	}
	if (condition.op === "between") {
		const low = queryValue(condition.value ?? "", numeric);
		const high = queryValue(condition.value2 ?? "", numeric);
		// Either way round, since a reader may type the larger first.
		const swap =
			numeric && Number(low) > Number(high) ? [high, low] : [low, high];
		return [
			{ field, op: "gte", value: swap[0] },
			{ field, op: "lte", value: swap[1] },
		];
	}
	return [
		{
			field,
			op: condition.op,
			value: queryValue(condition.value ?? "", numeric),
		},
	];
}

// How a condition reads on a chip, such as "Revenue 1yr > 50K".
export function describeCondition(
	label: string,
	condition: ColumnCondition,
): string {
	if (condition.op === "is_empty") return `${label} is blank`;
	if (condition.op === "is_not_empty") return `${label} is not blank`;
	const show = (value: string | undefined) =>
		(value ?? "").trim().toUpperCase().replace(/^\$/, "$");
	if (condition.op === "between") {
		return `${label} ${show(condition.value)} to ${show(condition.value2)}`;
	}
	return `${label} ${symbols[condition.op] ?? conditionLabels[condition.op]} ${show(condition.value)}`;
}

// Free text as a condition tree: every word has to be found, and each one in
// any of the columns. Null for empty text.
export function searchTree(text: string, fields: string[]): SearchNode | null {
	const words = text
		.trim()
		.split(/\s+/)
		.filter((word) => word !== "");
	if (words.length === 0 || fields.length === 0) return null;
	const perWord = words.map((word): SearchNode => {
		const tests = fields.map(
			(field): SearchNode => ({ field, op: "contains", value: word }),
		);
		return tests.length === 1 ? tests[0] : { any: tests };
	});
	return perWord.length === 1 ? perWord[0] : { all: perWord };
}

export interface NamedField {
	name: string;
	label: string;
	numeric: boolean;
}

const typedOps: [RegExp, ConditionOp][] = [
	[/^>=|^≥/, "gte"],
	[/^<=|^≤/, "lte"],
	[/^!=|^<>|^≠/, "neq"],
	[/^>/, "gt"],
	[/^</, "lt"],
	[/^==?/, "eq"],
];

// A condition typed into a search box, such as "revenue > 50k" or "orders
// >= 10". The column is matched on its name or label, ignoring case, and the
// closest match wins. Null when the text is not a condition on a number
// column, so it is searched for as text instead.
export function parseTypedCondition(
	text: string,
	fields: NamedField[],
): { field: string; condition: ColumnCondition } | null {
	const trimmed = text.trim();
	const at = trimmed.search(/>=|<=|!=|<>|[<>=≥≤≠]/);
	if (at <= 0) return null;
	const name = trimmed.slice(0, at).trim().toLowerCase();
	const rest = trimmed.slice(at);
	const found = typedOps.find(([pattern]) => pattern.test(rest));
	if (!found || !name) return null;
	const value = rest.replace(found[0], "").trim();
	if (parseAmount(value) === null) return null;

	const numeric = fields.filter((field) => field.numeric);
	const score = (field: NamedField): number => {
		const label = field.label.toLowerCase();
		const key = field.name.toLowerCase();
		if (label === name || key === name) return 3;
		if (label.startsWith(name) || key.startsWith(name)) return 2;
		if (label.includes(name) || key.includes(name)) return 1;
		return 0;
	};
	const ranked = numeric
		.map((field) => ({ field, score: score(field) }))
		.filter((entry) => entry.score > 0)
		// Best match first, and the shorter name among equals, so "revenue"
		// finds "Revenue" before "Revenue on contract".
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.field.label.length - b.field.label.length,
		);
	const best = ranked[0]?.field;
	return best
		? { field: best.name, condition: { op: found[1], value } }
		: null;
}

export type ColumnKind = "text" | "number" | "date";

// What kind of filter a column takes. A measure is always a figure, and a
// dimension is judged by its data type.
export function columnKind(
	dataType: string | null | undefined,
	isMeasure: boolean,
): ColumnKind {
	if (isMeasure) return "number";
	const type = (dataType ?? "").toLowerCase();
	if (/^(date|timestamp)/.test(type)) return "date";
	if (
		/^(int|integer|bigint|smallint|tinyint|long|short|byte|double|float|real|decimal|numeric|number)/.test(
			type,
		)
	)
		return "number";
	return "text";
}

// The conditions a column of each kind offers, in the order they are listed.
export const conditionsFor: Record<ColumnKind, ConditionOp[]> = {
	number: [
		"gt",
		"gte",
		"lt",
		"lte",
		"between",
		"eq",
		"neq",
		"is_empty",
		"is_not_empty",
	],
	date: ["gte", "lte", "between", "eq", "is_empty", "is_not_empty"],
	text: ["is_empty", "is_not_empty"],
};

// How each condition is offered for a date, where earlier and later read more
// plainly than less and greater.
export const dateConditionLabels: Partial<Record<ConditionOp, string>> = {
	gte: "on or after",
	lte: "on or before",
	between: "between",
	eq: "on",
};
