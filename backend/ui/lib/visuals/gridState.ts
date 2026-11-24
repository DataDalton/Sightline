import type { ColumnCondition, ConditionOp } from "../query/searchText";

// What a reader has chosen inside one table or matrix: its sort, its column
// filters and its search.
//
// Held by the page rather than by the table, so it can be written into the
// address and into a saved view. The address is what a reload reads back and what
// a link sends, so that alone is what makes these survive.
//
// Written the way the rest of the address is, as something a person can read:
//
//   ?1a2b3c4d.sort=Revenue:desc&1a2b3c4d.search=north&1a2b3c4d.f.Region=East,West
//
// The prefix is the start of the visual's id, because a page can hold several
// tables and a title is neither unique nor always there.

export interface GridState {
	// A field name, or the key of one cell in a matrix. Empty means the row
	// labels of a matrix.
	sort?: { key: string; direction: "asc" | "desc" };
	// Chosen values by field.
	filters?: Record<string, string[]>;
	// Fields whose chosen values are left out rather than kept.
	excluded?: string[];
	// Conditions by field, such as greater than 50k. A field has values or a
	// condition, not both.
	conditions?: Record<string, ColumnCondition>;
	search?: string;
	// The one column the search looks in. Absent searches every column.
	searchIn?: string;
}

const idLength = 8;

const conditionOps = new Set<ConditionOp>([
	"gt",
	"gte",
	"lt",
	"lte",
	"eq",
	"neq",
	"between",
	"is_empty",
	"is_not_empty",
]);

// A condition in the address, such as "gt:50k" or "between:10~20".
function encodeCondition(condition: ColumnCondition): string {
	if (condition.op === "between") {
		return `between:${condition.value ?? ""}~${condition.value2 ?? ""}`;
	}
	return condition.value === undefined
		? condition.op
		: `${condition.op}:${condition.value}`;
}

function decodeCondition(text: string): ColumnCondition | null {
	const at = text.indexOf(":");
	const op = (at < 0 ? text : text.slice(0, at)) as ConditionOp;
	if (!conditionOps.has(op)) return null;
	if (at < 0) return { op };
	const rest = text.slice(at + 1);
	if (op === "between") {
		const [value, value2] = rest.split("~");
		return { op, value, value2 };
	}
	return { op, value: rest };
}

function escapeValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,");
}

function splitValues(text: string): string[] {
	const out: string[] = [];
	let current = "";
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\\" && i + 1 < text.length) {
			current += text[i + 1];
			i++;
		} else if (char === ",") {
			out.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	out.push(current);
	return out.filter((value) => value !== "");
}

export function isEmptyGridState(state: GridState): boolean {
	return (
		!state.sort &&
		!state.search &&
		Object.values(state.filters ?? {}).every((v) => v.length === 0) &&
		Object.keys(state.conditions ?? {}).length === 0
	);
}

export function encodeGridParams(
	states: Record<string, GridState>,
): [string, string][] {
	const params: [string, string][] = [];
	for (const [visualId, state] of Object.entries(states)) {
		const prefix = visualId.slice(0, idLength);
		if (state.sort) {
			params.push([
				`${prefix}.sort`,
				`${state.sort.key}:${state.sort.direction}`,
			]);
		}
		if (state.search) params.push([`${prefix}.search`, state.search]);
		if (state.searchIn) params.push([`${prefix}.in`, state.searchIn]);
		const excluded = (state.excluded ?? []).filter(
			(field) => (state.filters?.[field]?.length ?? 0) > 0,
		);
		if (excluded.length > 0) {
			params.push([`${prefix}.x`, excluded.map(escapeValue).join(",")]);
		}
		for (const [field, condition] of Object.entries(
			state.conditions ?? {},
		)) {
			params.push([`${prefix}.c.${field}`, encodeCondition(condition)]);
		}
		for (const [field, values] of Object.entries(state.filters ?? {})) {
			if (values.length > 0) {
				params.push([
					`${prefix}.f.${field}`,
					values.map(escapeValue).join(","),
				]);
			}
		}
	}
	return params;
}

// Only for visuals the page holds. A parameter naming anything else, or matching
// two of them, is dropped rather than applied to the wrong table.
export function decodeGridParams(
	params: URLSearchParams,
	visualIds: string[],
): Record<string, GridState> {
	const states: Record<string, GridState> = {};
	for (const [key, value] of params.entries()) {
		const dot = key.indexOf(".");
		if (dot !== idLength) continue;
		const owners = visualIds.filter((id) =>
			id.startsWith(key.slice(0, dot)),
		);
		if (owners.length !== 1) continue;
		const state = (states[owners[0]] ??= {});
		const rest = key.slice(dot + 1);

		if (rest === "search") {
			state.search = value;
		} else if (rest === "in") {
			state.searchIn = value;
		} else if (rest === "x") {
			state.excluded = splitValues(value);
		} else if (rest.startsWith("c.")) {
			const condition = decodeCondition(value);
			if (condition) {
				state.conditions = {
					...state.conditions,
					[rest.slice(2)]: condition,
				};
			}
		} else if (rest === "sort") {
			const at = value.lastIndexOf(":");
			const direction = value.slice(at + 1);
			if (at >= 0 && (direction === "asc" || direction === "desc")) {
				state.sort = { key: value.slice(0, at), direction };
			}
		} else if (rest.startsWith("f.")) {
			const values = splitValues(value);
			if (values.length > 0) {
				state.filters = { ...state.filters, [rest.slice(2)]: values };
			}
		}
	}
	return states;
}
