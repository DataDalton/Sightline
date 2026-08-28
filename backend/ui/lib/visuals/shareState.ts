// What the address bar carries about a page somebody is reading.
//
// Which page is open, what the filters are set to and which saved view is
// applied all used to live in React state, so a link shared the report and
// never the thing the sender meant, and the way round that was a screenshot.
//
// This has been got wrong once already, and the way it was wrong is worth
// writing down. The first attempt packed the whole state into one opaque
// parameter, which came to seven hundred characters for an ordinary page: a
// wall of base64 that wraps badly, cannot be read, cannot be edited, and sits
// on top of the one thing an address bar is for.
//
// So it is written the way somebody would write it by hand:
//
//   ?page=detail&businessUnit=Endoscopy,Instruments&orderDate=2026-01-01..2026-03-31
//
// One parameter per field, named after the field, holding what a person would
// type. Three things follow from that and all three are the point. It is short.
// It can be read at a glance, so somebody can see what a link they were sent
// will do before opening it. And it can be typed: changing a date in the
// address bar is a legitimate way to use this.
//
// Cross-filtering and drill position are deliberately left out. Both are
// momentary: a reader clicks a bar, reads the page, clicks it again.

export interface ShareClause {
	field: string;
	op: string;
	value?: string;
	values?: string[];
}

export interface SharedPageState {
	page?: string;
	// What each filter widget is set to, keyed by the widget's visual id.
	filters?: Record<string, ShareClause[]>;
	dimension?: string;
	grain?: string;
	view?: string;
}

// What the encoding needs in order to name things after what they are rather
// than after their identifiers.
export interface ShareContext {
	pages: { pageId: string; title: string }[];
	// Every filter widget on the open page and the field it filters.
	//
	// One field each, always. A filter group looks like an exception and is
	// not: it renders one dropdown per field, each its own widget with its own
	// id, which is what makes a parameter per field enough to put the state
	// back where it came from.
	widgets: { visualId: string; field: string }[];
	// Dimension names, for the breakdown and time grain switchers.
	dimensions: string[];
	views: { viewId: string; name: string }[];
}

// Parameter names this owns, so a field called "View" cannot quietly become the
// saved view.
const reserved = new Set(["page", "by", "grain", "view", "edit"]);

// A name as a parameter: camel case, letters and digits only.
//
// "Business Unit" becomes businessUnit and "Net Sales (USD)" becomes
// netSalesUsd. Lossy on purpose, because the point is to be readable rather
// than to round trip: the decode matches it back against the fields the page
// actually has, and refuses anything matching more than one.
export function slug(name: string): string {
	const words = name
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean);

	if (words.length === 0) return "";

	return words
		.map((word, index) => {
			const lower = word.toLowerCase();
			if (index === 0) return lower;
			return lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join("");
}

// The parameter a field is written under, kept clear of the names this owns.
function fieldParam(field: string): string {
	const key = slug(field);
	return reserved.has(key) ? `${key}_` : key;
}

// The one thing in a name that has to survive: a comma separates values, so a
// value containing one has to say that it is not a separator.
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
			continue;
		}
		if (char === ",") {
			out.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	out.push(current);
	return out.filter((v) => v !== "");
}

// How each operator is spelled in a value.
//
// A bare value is equality, which is the overwhelming majority of filters and
// deserves the shortest form. A range is written the way a person writes one.
// The rest take a leading mark, chosen to look like what they mean.
const marks: Record<string, string> = {
	neq: "!",
	contains: "~",
	starts_with: "^",
	ends_with: "$",
	like: "%",
	gt: ">",
	lt: "<",
};
const markToOp = new Map(Object.entries(marks).map(([op, mark]) => [mark, op]));

// One widget's clauses as a value.
//
// Returns null for a set this cannot express, which is left out of the URL
// rather than half written. Everything the filter widgets actually produce is
// covered; the fallback exists so a clause shape added later fails visibly by
// being absent rather than by being wrong.
export function packClauses(clauses: ShareClause[]): string | null {
	if (clauses.length === 0) return null;

	// A range, which is two clauses on one field and is written as one value.
	const from = clauses.find((c) => c.op === "gte");
	const to = clauses.find((c) => c.op === "lte");
	if (
		(from || to) &&
		clauses.every((c) => c.op === "gte" || c.op === "lte")
	) {
		const lo = from?.value ?? "";
		const hi = to?.value ?? "";
		if (lo === "" && hi === "") return null;
		return `${escapeValue(lo)}..${escapeValue(hi)}`;
	}

	if (clauses.length !== 1) return null;
	const clause = clauses[0];

	if (clause.op === "is_empty") return "-";
	if (clause.op === "is_not_empty") return "*";

	if (clause.op === "eq") {
		const values = clause.values ?? (clause.value ? [clause.value] : []);
		if (values.length === 0) return null;
		return values.map(escapeValue).join(",");
	}

	const mark = marks[clause.op];
	if (mark && clause.value !== undefined) {
		return mark + escapeValue(clause.value);
	}

	return null;
}

export function unpackClauses(field: string, text: string): ShareClause[] {
	if (text === "") return [];
	if (text === "-") return [{ field, op: "is_empty" }];
	if (text === "*") return [{ field, op: "is_not_empty" }];

	// A range, before anything else: its separator cannot be mistaken for a
	// mark, and a bare value is never allowed to contain one.
	const range = /^(.*?)\.\.(.*)$/.exec(text);
	if (range) {
		const out: ShareClause[] = [];
		if (range[1] !== "") {
			out.push({ field, op: "gte", value: splitValues(range[1])[0] });
		}
		if (range[2] !== "") {
			out.push({ field, op: "lte", value: splitValues(range[2])[0] });
		}
		return out;
	}

	const op = markToOp.get(text.charAt(0));
	if (op) {
		const value = splitValues(text.slice(1))[0];
		return value === undefined ? [] : [{ field, op, value }];
	}

	const values = splitValues(text);
	if (values.length === 0) return [];
	return [{ field, op: "eq", values }];
}

// The parameters describing this state, named after what they hold.
export function encodeShareParams(
	state: SharedPageState,
	context: ShareContext,
): URLSearchParams {
	const params = new URLSearchParams();

	// Only when it is not the page the report opens on, so an ordinary link
	// carries nothing about a report with one page.
	if (state.page && context.pages[0]?.pageId !== state.page) {
		const page = context.pages.find((p) => p.pageId === state.page);
		if (page) params.set("page", slug(page.title));
	}

	const fieldOf = new Map(
		context.widgets.map((w) => [w.visualId, w.field] as const),
	);
	for (const [widgetId, clauses] of Object.entries(state.filters ?? {})) {
		const field = fieldOf.get(widgetId);
		if (!field || !Array.isArray(clauses)) continue;
		const packed = packClauses(clauses);
		if (packed !== null) params.set(fieldParam(field), packed);
	}

	if (state.dimension) params.set("by", slug(state.dimension));
	if (state.grain) params.set("grain", slug(state.grain));

	if (state.view) {
		const view = context.views.find((v) => v.viewId === state.view);
		if (view) params.set("view", slug(view.name));
	}

	return params;
}

// The one name a slug refers to, or null when it is not exactly one.
//
// Ambiguity is refused rather than resolved. Two fields slugging the same way
// would put somebody's filter on the wrong control, and a filter on the wrong
// control is a wrong number presented as a right one.
function resolve<T>(
	key: string,
	candidates: T[],
	nameOf: (item: T) => string,
): T | null {
	const matches = candidates.filter((item) => slug(nameOf(item)) === key);
	return matches.length === 1 ? matches[0] : null;
}

export function decodeShareParams(
	params: URLSearchParams,
	context: ShareContext,
): SharedPageState | null {
	const state: SharedPageState = {};

	const page = params.get("page");
	if (page) {
		// A link naming a page the report no longer has opens it at the first
		// page, which is the only remaining honest answer.
		const found = resolve(page, context.pages, (p) => p.title);
		if (found) state.page = found.pageId;
	}

	const by = params.get("by");
	if (by) {
		const found = resolve(by, context.dimensions, (d) => d);
		if (found) state.dimension = found;
	}

	const grain = params.get("grain");
	if (grain) {
		const found = resolve(grain, context.dimensions, (d) => d);
		if (found) state.grain = found;
	}

	const view = params.get("view");
	if (view) {
		const found = resolve(view, context.views, (v) => v.name);
		if (found) state.view = found.viewId;
	}

	const filters: Record<string, ShareClause[]> = {};
	for (const [key, value] of params.entries()) {
		if (reserved.has(key)) continue;

		// A widget filtering this field, by the name the parameter is written
		// under. A parameter naming a field no page control owns is dropped:
		// applying it anyway would narrow the page with nothing on screen able
		// to show or clear it.
		const widget = context.widgets.find((w) => fieldParam(w.field) === key);
		const ambiguous =
			context.widgets.filter((w) => fieldParam(w.field) === key).length >
			1;
		if (!widget || ambiguous) continue;

		const clauses = unpackClauses(widget.field, value);
		if (clauses.length > 0) filters[widget.visualId] = clauses;
	}

	if (Object.keys(filters).length > 0) state.filters = filters;

	return Object.keys(state).length > 0 ? state : null;
}
