import { isFilterVisual, isPageControl } from "./catalog";

// A visual or a page that waits for a filter before it asks for anything.
//
// A detail table over millions of rows answers nobody's question until somebody
// has said which customer, and left to load on arrival it costs a large query
// every time the page opens. An author can name the fields it waits for, and until
// each has a value the visual says what to choose and asks the warehouse nothing.
//
// Pure, because the page and the server's warming must agree. Warming a query the
// page will not make would spend the warehouse on exactly what this exists to save.

interface Clause {
	field?: unknown;
	op?: unknown;
	value?: unknown;
	values?: unknown;
}

function names(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string" && v !== "")
		: [];
}

// The fields a visual waits for, its own and its page's together.
export function requiredFields(
	visualType: string,
	visualOptions: Record<string, unknown> | undefined,
	pageConfig: { requireFilter?: unknown } | undefined,
): string[] {
	// A control is how the reader answers, so it can never wait for the answer.
	if (isFilterVisual(visualType) || isPageControl(visualType)) return [];
	return [
		...new Set([
			...names(pageConfig?.requireFilter),
			...names(visualOptions?.requireFilter),
		]),
	];
}

function isSet(clause: Clause): boolean {
	if (clause.op === "is_empty" || clause.op === "is_not_empty") return true;
	if (clause.op === "is_latest") return true;
	if (Array.isArray(clause.values)) return clause.values.length > 0;
	return clause.value !== undefined && clause.value !== "";
}

// Which of those fields still have no value under these filters. Empty means the
// visual can draw.
export function waitingFor(required: string[], clauses: unknown[]): string[] {
	if (required.length === 0) return [];
	const set = new Set(
		(clauses as Clause[])
			.filter((clause) => clause && isSet(clause))
			.map((clause) => clause.field),
	);
	return required.filter((field) => !set.has(field));
}
