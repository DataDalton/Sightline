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
	search?: string;
}

const idLength = 8;

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
		Object.values(state.filters ?? {}).every((v) => v.length === 0)
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
