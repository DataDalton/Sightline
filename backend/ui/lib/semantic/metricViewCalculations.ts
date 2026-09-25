// How every field on a metric view is calculated.
//
// A field's comment says what it means. Its expression says what it actually
// does, and the two drift: a comment reading "revenue less cost" over an
// expression that also subtracts rebate is the kind of thing only the
// expression settles. Both live in the view definition, so this reads the
// expression out of the same YAML the field list comes from.
//
// Kept free of database and network imports so it can be tested on its own.
//
// The YAML a metric view emits uses three scalar spellings for an expression,
// and all three appear in the same definition: plain, double quoted with
// escaped line continuations, and block scalars. A reader that handles only the
// first shows a quoted expression with its backslashes and the leading half of
// every wrapped one.

export interface FieldCalculation {
	expr: string;
	// The window spec of a windowed measure, as written. Kept as text because
	// it reads well as it is and has no other use here.
	window: string | null;
}

export interface ViewJoin {
	name: string;
	source: string;
	on: string;
}

export interface ViewCalculations {
	// The table the view reads, and the filter it applies to every row.
	source: string | null;
	filter: string | null;
	joins: ViewJoin[];
	fields: Map<string, FieldCalculation>;
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

// A double quoted YAML scalar, which may run across lines.
//
// Between lines, a break folds to a single space, except where the line ends in
// a backslash, which escapes the break away entirely. A continuation line may
// then open with "\ " to keep a space the folding would otherwise eat.
function doubleQuoted(
	lines: string[],
	start: number,
	opening: string,
): { value: string; next: number } {
	let text = opening.slice(1);
	let i = start;
	const closed = (s: string) => {
		for (let n = 0; n < s.length; n++) {
			if (s[n] === "\\") {
				n++;
				continue;
			}
			if (s[n] === '"') return n;
		}
		return -1;
	};

	let end = closed(text);
	while (end < 0 && i + 1 < lines.length) {
		i++;
		const next = lines[i].trim();
		if (text.endsWith("\\")) {
			text = text.slice(0, -1) + next;
		} else {
			text = `${text} ${next}`;
		}
		end = closed(text);
	}

	const raw = end >= 0 ? text.slice(0, end) : text;
	const value = raw.replace(/\\(.)/g, (_, ch: string) => {
		if (ch === "n") return "\n";
		if (ch === "t") return "\t";
		return ch;
	});
	return { value, next: i + 1 };
}

// A single quoted scalar. The only escape is a doubled quote.
function singleQuoted(
	lines: string[],
	start: number,
	opening: string,
): { value: string; next: number } {
	let text = opening.slice(1);
	let i = start;
	const closed = (s: string) => {
		for (let n = 0; n < s.length; n++) {
			if (s[n] === "'") {
				if (s[n + 1] === "'") {
					n++;
					continue;
				}
				return n;
			}
		}
		return -1;
	};

	let end = closed(text);
	while (end < 0 && i + 1 < lines.length) {
		i++;
		text = `${text} ${lines[i].trim()}`;
		end = closed(text);
	}
	const raw = end >= 0 ? text.slice(0, end) : text;
	return { value: raw.replace(/''/g, "'"), next: i + 1 };
}

// Reads the scalar a key starts, wherever it ends.
function readScalar(
	lines: string[],
	start: number,
	keyIndent: number,
	rest: string,
): { value: string; next: number } {
	const opening = rest.trim();

	if (opening.startsWith('"')) return doubleQuoted(lines, start, opening);
	if (opening.startsWith("'")) return singleQuoted(lines, start, opening);

	// Block scalar: every following line indented past the key. A literal
	// keeps its line breaks, a folded one joins them.
	if (/^[|>][+-]?\d*$/.test(opening)) {
		const literal = opening.startsWith("|");
		const body: string[] = [];
		let i = start + 1;
		while (
			i < lines.length &&
			(lines[i].trim() === "" || indentOf(lines[i]) > keyIndent)
		) {
			body.push(lines[i]);
			i++;
		}
		while (body.length > 0 && body[body.length - 1].trim() === "") {
			body.pop();
		}
		const margin = Math.min(...body.filter((l) => l.trim()).map(indentOf));
		const trimmed = body.map((l) =>
			l.slice(Number.isFinite(margin) ? margin : 0),
		);
		return {
			value: literal
				? trimmed.join("\n")
				: trimmed.join(" ").replace(/\s+/g, " "),
			next: i,
		};
	}

	// Plain scalar, which may continue onto lines indented past the key that
	// do not open a key of their own.
	const parts = [opening];
	let i = start + 1;
	while (
		i < lines.length &&
		lines[i].trim() !== "" &&
		indentOf(lines[i]) > keyIndent &&
		!/^\s*(-\s|[A-Za-z_"][\w" ]*:\s|[A-Za-z_"][\w" ]*:$)/.test(lines[i])
	) {
		parts.push(lines[i].trim());
		i++;
	}
	return { value: parts.join(" "), next: i };
}

// The lines of a nested block under a key, as written, for the window spec.
function readBlock(
	lines: string[],
	start: number,
	keyIndent: number,
): { value: string; next: number } {
	const body: string[] = [];
	let i = start + 1;
	while (
		i < lines.length &&
		(lines[i].trim() === "" || indentOf(lines[i]) > keyIndent)
	) {
		body.push(lines[i]);
		i++;
	}
	while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
	const margin = Math.min(...body.filter((l) => l.trim()).map(indentOf));
	return {
		value: body
			.map((l) => l.slice(Number.isFinite(margin) ? margin : 0))
			.join("\n"),
		next: i,
	};
}

function unquoteKey(key: string): string {
	return key.replace(/^["']|["']$/g, "");
}

export function parseMetricViewCalculations(
	createStatement: string,
): ViewCalculations {
	const start = createStatement.indexOf("$$");
	const end = createStatement.lastIndexOf("$$");
	const body =
		start >= 0 && end > start
			? createStatement.slice(start + 2, end)
			: createStatement;
	const lines = body.split(/\r?\n/);

	const result: ViewCalculations = {
		source: null,
		filter: null,
		joins: [],
		fields: new Map(),
	};

	type Section = "dimensions" | "measures" | "joins" | null;
	let section: Section = null;
	// The list item being read, with the keys gathered so far.
	let item: Record<string, string> | null = null;

	const flush = () => {
		if (!item) return;
		if ((section === "dimensions" || section === "measures") && item.name) {
			result.fields.set(item.name, {
				expr: item.expr ?? "",
				window: item.window ?? null,
			});
		}
		if (section === "joins" && item.name) {
			result.joins.push({
				name: item.name,
				source: item.source ?? "",
				on: item.on ?? "",
			});
		}
		item = null;
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "" || line.trim().startsWith("#")) {
			i++;
			continue;
		}

		const indent = indentOf(line);

		// A key at the margin opens a section or sets a view level value.
		if (indent === 0) {
			flush();
			const top = /^("?[A-Za-z_][\w]*"?):\s*(.*)$/.exec(line);
			section = null;
			if (!top) {
				i++;
				continue;
			}
			const key = unquoteKey(top[1]);
			if (key === "dimensions" || key === "measures" || key === "joins") {
				section = key;
				i++;
				continue;
			}
			if (key === "source" || key === "filter") {
				const { value, next } = readScalar(lines, i, 0, top[2]);
				result[key] = value || null;
				i = next;
				continue;
			}
			// Any other top level key: skip whatever it holds.
			const { next } = top[2].trim()
				? readScalar(lines, i, 0, top[2])
				: readBlock(lines, i, 0);
			i = next;
			continue;
		}

		if (!section) {
			i++;
			continue;
		}

		// "  - name: X" opens the next item. Anything else on the dash line is
		// read as that item's first key.
		const dash = /^(\s*)-\s+("?[A-Za-z_][\w ]*"?):\s*(.*)$/.exec(line);
		if (dash) {
			flush();
			item = {};
			const keyIndent = dash[1].length + 2;
			const key = unquoteKey(dash[2]);
			const { value, next } = readScalar(lines, i, keyIndent, dash[3]);
			item[key] = value;
			i = next;
			continue;
		}

		const pair = /^(\s*)("?[A-Za-z_][\w ]*"?):\s*(.*)$/.exec(line);
		if (pair && item) {
			const keyIndent = pair[1].length;
			const key = unquoteKey(pair[2]);
			if (key === "window") {
				const { value, next } = readBlock(lines, i, keyIndent);
				item.window = value;
				i = next;
				continue;
			}
			const { value, next } = pair[3].trim()
				? readScalar(lines, i, keyIndent, pair[3])
				: readBlock(lines, i, keyIndent);
			item[key] = value;
			i = next;
			continue;
		}

		i++;
	}
	flush();

	return result;
}

// Other measures an expression is built from, named the way a metric view
// names them: MEASURE(`Revenue`). What lets a reader follow Margin Pct back
// to Margin and Revenue without reading SQL.
export function measuresReferenced(expr: string): string[] {
	const found = new Set<string>();
	const pattern = /MEASURE\(\s*`([^`]+)`\s*\)/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(expr))) found.add(match[1]);
	return [...found];
}
