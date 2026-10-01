// Formula columns on a sheet.
//
// A small spreadsheet language evaluated per row: references to columns by
// name in square brackets, arithmetic, comparison, text joining with &, and a
// set of functions. Parsed into a tree once and evaluated for every row, never
// through eval, so a formula can only do what the functions below do.
//
// A few functions look across the whole column rather than one row, because
// that is most of what people build a spreadsheet for on top of an extract:
// share of the total, a rank, the change from the row before.
//
// Pure, so the browser and the server compute the same values. A download
// recomputes on the server rather than trusting the page's numbers.

export type Value = number | string | boolean | null | FormulaError;

export class FormulaError {
	constructor(
		readonly code: "#DIV/0!" | "#REF!" | "#VALUE!" | "#NAME?" | "#CYCLE!",
		readonly detail = "",
	) {}
	toString() {
		return this.code;
	}
}

export function isError(v: unknown): v is FormulaError {
	return v instanceof FormulaError;
}

// --- Tokens ----------------------------------------------------------------

type Token =
	| { t: "num"; v: number }
	| { t: "str"; v: string }
	| { t: "ref"; v: string }
	| { t: "name"; v: string }
	| { t: "op"; v: string }
	| { t: "(" }
	| { t: ")" }
	| { t: "," };

export class FormulaSyntaxError extends Error {
	constructor(
		message: string,
		readonly at: number,
	) {
		super(message);
	}
}

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (/[0-9.]/.test(c)) {
			const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
			if (!m) throw new FormulaSyntaxError("A number is malformed.", i);
			out.push({ t: "num", v: Number(m[0]) });
			i += m[0].length;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let text = "";
			for (;;) {
				if (j >= src.length) {
					throw new FormulaSyntaxError("A quote is not closed.", i);
				}
				if (src[j] === '"') {
					// Two quotes in a row are one quote inside the text.
					if (src[j + 1] === '"') {
						text += '"';
						j += 2;
						continue;
					}
					break;
				}
				text += src[j++];
			}
			out.push({ t: "str", v: text });
			i = j + 1;
			continue;
		}
		if (c === "[") {
			const j = src.indexOf("]", i + 1);
			if (j < 0) {
				throw new FormulaSyntaxError("A [ is not closed with ].", i);
			}
			out.push({ t: "ref", v: src.slice(i + 1, j).trim() });
			i = j + 1;
			continue;
		}
		if (/[A-Za-z_]/.test(c)) {
			const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
			out.push({ t: "name", v: m[0].toUpperCase() });
			i += m[0].length;
			continue;
		}
		const two = src.slice(i, i + 2);
		if (two === "<=" || two === ">=" || two === "<>" || two === "!=") {
			out.push({ t: "op", v: two === "!=" ? "<>" : two });
			i += 2;
			continue;
		}
		if ("+-*/^&=<>%".includes(c)) {
			out.push({ t: "op", v: c });
			i++;
			continue;
		}
		if (c === "(" || c === ")" || c === ",") {
			out.push({ t: c });
			i++;
			continue;
		}
		throw new FormulaSyntaxError(
			`"${c}" is not something a formula can use.`,
			i,
		);
	}
	return out;
}

// --- Tree ------------------------------------------------------------------

export type Node =
	| { k: "lit"; v: Value }
	| { k: "ref"; name: string }
	| { k: "un"; op: string; a: Node }
	| { k: "bin"; op: string; a: Node; b: Node }
	| { k: "call"; fn: string; args: Node[] };

// Lowest to highest. Comparison binds loosest, then joining text, then the
// arithmetic, as in every spreadsheet.
const precedence: Record<string, number> = {
	"=": 1,
	"<>": 1,
	"<": 1,
	">": 1,
	"<=": 1,
	">=": 1,
	"&": 2,
	"+": 3,
	"-": 3,
	"*": 4,
	"/": 4,
	"^": 5,
};

export function parse(src: string): Node {
	const text = src.trim().replace(/^=/, "");
	if (!text) throw new FormulaSyntaxError("The formula is empty.", 0);
	const tokens = tokenize(text);
	let pos = 0;

	const peek = () => tokens[pos];
	const expect = (t: Token["t"], what: string) => {
		const tok = tokens[pos];
		if (!tok || tok.t !== t) {
			throw new FormulaSyntaxError(`Expected ${what}.`, pos);
		}
		pos++;
		return tok;
	};

	const primary = (): Node => {
		const tok = tokens[pos++];
		if (!tok)
			throw new FormulaSyntaxError("The formula ends too soon.", pos);
		switch (tok.t) {
			case "num":
			case "str":
				return postfix({ k: "lit", v: tok.v });
			case "ref":
				return postfix({ k: "ref", name: tok.v });
			case "(": {
				const inner = expression(0);
				expect(")", "a closing )");
				return postfix(inner);
			}
			case "op":
				if (tok.v === "-" || tok.v === "+") {
					// Binds tighter than * and /, looser than ^, so -2^2 is -4.
					return { k: "un", op: tok.v, a: expression(5) };
				}
				break;
			case "name": {
				if (tok.v === "TRUE" || tok.v === "FALSE") {
					return { k: "lit", v: tok.v === "TRUE" };
				}
				if (peek()?.t !== "(") {
					throw new FormulaSyntaxError(
						`${tok.v} is not a function. Put a column name in square brackets, like [${tok.v}].`,
						pos,
					);
				}
				pos++;
				const args: Node[] = [];
				if (peek()?.t !== ")") {
					for (;;) {
						args.push(expression(0));
						if (peek()?.t === ",") {
							pos++;
							continue;
						}
						break;
					}
				}
				expect(")", "a closing ) after the arguments");
				return postfix({ k: "call", fn: tok.v, args });
			}
		}
		throw new FormulaSyntaxError("Something is missing here.", pos - 1);
	};

	// A trailing % divides by a hundred, so 15% means 0.15.
	const postfix = (node: Node): Node => {
		let n = node;
		while (peek()?.t === "op" && (peek() as { v: string }).v === "%") {
			pos++;
			n = { k: "bin", op: "/", a: n, b: { k: "lit", v: 100 } };
		}
		return n;
	};

	const expression = (min: number): Node => {
		let left = primary();
		for (;;) {
			const tok = peek();
			if (!tok || tok.t !== "op") break;
			const p = precedence[tok.v];
			if (p === undefined || p < min) break;
			pos++;
			// ^ groups to the right, everything else to the left.
			const right = expression(tok.v === "^" ? p : p + 1);
			left = { k: "bin", op: tok.v, a: left, b: right };
		}
		return left;
	};

	const tree = expression(0);
	if (pos < tokens.length) {
		throw new FormulaSyntaxError(
			"There is more after the formula ends.",
			pos,
		);
	}
	return tree;
}

// Every column a formula reads, for ordering formulas and spotting cycles.
export function references(node: Node): string[] {
	const out = new Set<string>();
	const walk = (n: Node) => {
		if (n.k === "ref") out.add(n.name);
		else if (n.k === "un") walk(n.a);
		else if (n.k === "bin") {
			walk(n.a);
			walk(n.b);
		} else if (n.k === "call") n.args.forEach(walk);
	};
	walk(node);
	return [...out];
}

// --- Values ----------------------------------------------------------------

function toNum(v: Value): number | FormulaError {
	if (isError(v)) return v;
	if (v === null || v === "") return 0;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "number") return v;
	const n = Number(v);
	return Number.isFinite(n)
		? n
		: new FormulaError("#VALUE!", `"${v}" is not a number`);
}

function toText(v: Value): string {
	if (v === null) return "";
	if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
	if (typeof v === "number") return String(Math.round(v * 1e10) / 1e10);
	return String(v);
}

function truthy(v: Value): boolean | FormulaError {
	if (isError(v)) return v;
	if (typeof v === "boolean") return v;
	if (v === null || v === "") return false;
	const n = toNum(v);
	return isError(n) ? true : n !== 0;
}

// The longest text a formula may produce, which is the most one spreadsheet
// cell holds. Joining is the only way text grows, and formulas can join
// formulas that join, so without a ceiling a handful of short formulas
// multiply into text too large for the server to hold.
export const maxTextLength = 32767;

function joined(text: string): string | FormulaError {
	return text.length > maxTextLength
		? new FormulaError(
				"#VALUE!",
				`the text is longer than ${maxTextLength} characters`,
			)
		: text;
}

function toDate(v: Value): Date | FormulaError {
	if (isError(v)) return v;
	if (v === null || v === "") return new FormulaError("#VALUE!", "no date");
	const d = new Date(typeof v === "number" ? v : String(v));
	return Number.isNaN(d.getTime())
		? new FormulaError("#VALUE!", `"${v}" is not a date`)
		: d;
}

// Values from the warehouse arrive as strings for decimals and dates. A string
// that is a number is compared and added as one.
export function fromCell(v: unknown): Value {
	if (v === null || v === undefined) return null;
	if (
		typeof v === "number" ||
		typeof v === "boolean" ||
		typeof v === "string"
	) {
		return v;
	}
	if (typeof v === "bigint") return Number(v);
	if (v instanceof Date) return v.toISOString();
	return String(v);
}

function compare(a: Value, b: Value): number {
	const an =
		typeof a === "number" ||
		(typeof a === "string" && a !== "" && Number.isFinite(Number(a)));
	const bn =
		typeof b === "number" ||
		(typeof b === "string" && b !== "" && Number.isFinite(Number(b)));
	if (an && bn) return Number(a) - Number(b);
	return toText(a).localeCompare(toText(b), undefined, {
		sensitivity: "base",
	});
}

// --- Evaluating ------------------------------------------------------------

export interface Context {
	// This row's value of a column, or undefined when there is no such column.
	get: (name: string) => Value | undefined;
	// Every row's value of a column, for the functions that look down it.
	column: (name: string) => Value[] | undefined;
	// Which row this is, counting from zero, in the order shown.
	index: number;
	today?: Date;
}

type Fn = (args: Node[], ctx: Context) => Value;

function evalArgs(args: Node[], ctx: Context): Value[] {
	return args.map((a) => evaluate(a, ctx));
}

function firstError(values: Value[]): FormulaError | null {
	return (values.find(isError) as FormulaError | undefined) ?? null;
}

function numeric(values: Value[]): number[] | FormulaError {
	const out: number[] = [];
	for (const v of values) {
		if (v === null || v === "") continue;
		const n = toNum(v);
		if (isError(n)) return n;
		out.push(n);
	}
	return out;
}

function arity(fn: string, args: Node[], min: number, max = min) {
	if (args.length < min || args.length > max) {
		return new FormulaError(
			"#VALUE!",
			`${fn} takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? "" : "s"}`,
		);
	}
	return null;
}

// The column a function that looks down a column is given. It has to be a
// reference, since "the column" of an arbitrary expression is not a thing.
function columnOf(
	fn: string,
	node: Node | undefined,
	ctx: Context,
): Value[] | FormulaError {
	if (!node || node.k !== "ref") {
		return new FormulaError(
			"#VALUE!",
			`${fn} needs a column, like ${fn}([Revenue])`,
		);
	}
	const col = ctx.column(node.name);
	return col ?? new FormulaError("#REF!", `no column named ${node.name}`);
}

// Figures about a whole column, worked out once per column rather than once
// per row. A column is the same array for every row of one formula, so it is
// the key, and a column computed again for a later formula is a new array.
interface ColumnStats {
	total?: number | FormulaError;
	// Running total at each row, or the first error met on the way down.
	running?: (number | FormulaError)[];
	// Every numeric value in the column, smallest first, for RANK.
	sorted?: number[];
}

const columnStats = new WeakMap<Value[], ColumnStats>();

function statsFor(col: Value[]): ColumnStats {
	let stats = columnStats.get(col);
	if (!stats) {
		stats = {};
		columnStats.set(col, stats);
	}
	return stats;
}

function columnTotal(col: Value[]): number | FormulaError {
	const stats = statsFor(col);
	if (stats.total === undefined) {
		const ns = numeric(col.filter((v) => !isError(v)));
		stats.total = isError(ns) ? ns : ns.reduce((a, b) => a + b, 0);
	}
	return stats.total;
}

function runningTotals(col: Value[]): (number | FormulaError)[] {
	const stats = statsFor(col);
	if (!stats.running) {
		const out: (number | FormulaError)[] = [];
		let sum: number | FormulaError = 0;
		for (const v of col) {
			if (!isError(sum)) {
				const n = toNum(v);
				sum = isError(n) ? n : sum + n;
			}
			out.push(sum);
		}
		stats.running = out;
	}
	return stats.running;
}

function sortedNumbers(col: Value[]): number[] {
	const stats = statsFor(col);
	if (!stats.sorted) {
		const out: number[] = [];
		for (const other of col) {
			if (other === null) continue;
			const n = toNum(other);
			if (isError(n) || Number.isNaN(n)) continue;
			out.push(n);
		}
		stats.sorted = out.sort((a, b) => a - b);
	}
	return stats.sorted;
}

// How many entries of a sorted list are below v, or at most v when inclusive.
function countBelow(sorted: number[], v: number, inclusive: boolean): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (inclusive ? sorted[mid] <= v : sorted[mid] < v) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

const math =
	(f: (n: number) => number): Fn =>
	(args, ctx) => {
		const bad = arity("function", args, 1);
		if (bad) return bad;
		const n = toNum(evaluate(args[0], ctx));
		if (isError(n)) return n;
		const r = f(n);
		return Number.isFinite(r) ? r : new FormulaError("#VALUE!");
	};

const functions: Record<string, Fn> = {
	IF: (args, ctx) => {
		const bad = arity("IF", args, 2, 3);
		if (bad) return bad;
		const c = truthy(evaluate(args[0], ctx));
		if (isError(c)) return c;
		// Only the branch taken is evaluated, so IF([Units] = 0, 0, [Revenue] / [Units])
		// does not fail on the rows it guards.
		if (c) return evaluate(args[1], ctx);
		return args[2] ? evaluate(args[2], ctx) : false;
	},
	IFERROR: (args, ctx) => {
		const bad = arity("IFERROR", args, 2);
		if (bad) return bad;
		const v = evaluate(args[0], ctx);
		return isError(v) ? evaluate(args[1], ctx) : v;
	},
	AND: (args, ctx) => {
		for (const a of args) {
			const t = truthy(evaluate(a, ctx));
			if (isError(t)) return t;
			if (!t) return false;
		}
		return true;
	},
	OR: (args, ctx) => {
		for (const a of args) {
			const t = truthy(evaluate(a, ctx));
			if (isError(t)) return t;
			if (t) return true;
		}
		return false;
	},
	NOT: (args, ctx) => {
		const bad = arity("NOT", args, 1);
		if (bad) return bad;
		const t = truthy(evaluate(args[0], ctx));
		return isError(t) ? t : !t;
	},
	ISBLANK: (args, ctx) => {
		const bad = arity("ISBLANK", args, 1);
		if (bad) return bad;
		const v = evaluate(args[0], ctx);
		return v === null || v === "";
	},
	COALESCE: (args, ctx) => {
		for (const a of args) {
			const v = evaluate(a, ctx);
			if (v !== null && v !== "") return v;
		}
		return null;
	},
	SUM: (args, ctx) => {
		const ns = numeric(evalArgs(args, ctx));
		return isError(ns) ? ns : ns.reduce((a, b) => a + b, 0);
	},
	AVERAGE: (args, ctx) => {
		const ns = numeric(evalArgs(args, ctx));
		if (isError(ns)) return ns;
		return ns.length
			? ns.reduce((a, b) => a + b, 0) / ns.length
			: new FormulaError("#DIV/0!");
	},
	MIN: (args, ctx) => {
		const ns = numeric(evalArgs(args, ctx));
		if (isError(ns)) return ns;
		return ns.length ? Math.min(...ns) : null;
	},
	MAX: (args, ctx) => {
		const ns = numeric(evalArgs(args, ctx));
		if (isError(ns)) return ns;
		return ns.length ? Math.max(...ns) : null;
	},
	ROUND: (args, ctx) => {
		const bad = arity("ROUND", args, 1, 2);
		if (bad) return bad;
		const [v, d] = evalArgs(args, ctx);
		const n = toNum(v);
		const places = d === undefined ? 0 : toNum(d);
		if (isError(n)) return n;
		if (isError(places)) return places;
		const f = 10 ** Math.trunc(places);
		return Math.round(n * f) / f;
	},
	ABS: math(Math.abs),
	FLOOR: math(Math.floor),
	CEILING: math(Math.ceil),
	SQRT: (args, ctx) => {
		const bad = arity("SQRT", args, 1);
		if (bad) return bad;
		const n = toNum(evaluate(args[0], ctx));
		if (isError(n)) return n;
		return n < 0
			? new FormulaError("#VALUE!", "square root of a negative")
			: Math.sqrt(n);
	},
	POWER: (args, ctx) => {
		const bad = arity("POWER", args, 2);
		if (bad) return bad;
		const [a, b] = evalArgs(args, ctx).map(toNum);
		if (isError(a)) return a;
		if (isError(b)) return b;
		const r = a ** b;
		return Number.isFinite(r) ? r : new FormulaError("#VALUE!");
	},
	MOD: (args, ctx) => {
		const bad = arity("MOD", args, 2);
		if (bad) return bad;
		const [a, b] = evalArgs(args, ctx).map(toNum);
		if (isError(a)) return a;
		if (isError(b)) return b;
		if (b === 0) return new FormulaError("#DIV/0!");
		return ((a % b) + b) % b;
	},
	LEN: (args, ctx) => {
		const bad = arity("LEN", args, 1);
		if (bad) return bad;
		const v = evaluate(args[0], ctx);
		return isError(v) ? v : toText(v).length;
	},
	UPPER: (args, ctx) => {
		const bad = arity("UPPER", args, 1);
		if (bad) return bad;
		const v = evaluate(args[0], ctx);
		return isError(v) ? v : toText(v).toUpperCase();
	},
	LOWER: (args, ctx) => {
		const bad = arity("LOWER", args, 1);
		if (bad) return bad;
		const v = evaluate(args[0], ctx);
		return isError(v) ? v : toText(v).toLowerCase();
	},
	TRIM: (args, ctx) => {
		const bad = arity("TRIM", args, 1);
		if (bad) return bad;
		const v = evaluate(args[0], ctx);
		return isError(v) ? v : toText(v).trim().replace(/\s+/g, " ");
	},
	LEFT: (args, ctx) => {
		const bad = arity("LEFT", args, 1, 2);
		if (bad) return bad;
		const [v, n] = evalArgs(args, ctx);
		const count = n === undefined ? 1 : toNum(n);
		if (isError(v)) return v;
		if (isError(count)) return count;
		return toText(v).slice(0, Math.max(0, count));
	},
	RIGHT: (args, ctx) => {
		const bad = arity("RIGHT", args, 1, 2);
		if (bad) return bad;
		const [v, n] = evalArgs(args, ctx);
		const count = n === undefined ? 1 : toNum(n);
		if (isError(v)) return v;
		if (isError(count)) return count;
		const t = toText(v);
		return count <= 0 ? "" : t.slice(-count);
	},
	CONCAT: (args, ctx) => {
		const vs = evalArgs(args, ctx);
		return firstError(vs) ?? joined(vs.map(toText).join(""));
	},
	CONTAINS: (args, ctx) => {
		const bad = arity("CONTAINS", args, 2);
		if (bad) return bad;
		const [a, b] = evalArgs(args, ctx);
		const e = firstError([a, b]);
		if (e) return e;
		return toText(a).toLowerCase().includes(toText(b).toLowerCase());
	},
	TODAY: (args, ctx) => {
		const bad = arity("TODAY", args, 0);
		if (bad) return bad;
		return (ctx.today ?? new Date()).toISOString().slice(0, 10);
	},
	YEAR: (args, ctx) => {
		const bad = arity("YEAR", args, 1);
		if (bad) return bad;
		const d = toDate(evaluate(args[0], ctx));
		return isError(d) ? d : d.getUTCFullYear();
	},
	MONTH: (args, ctx) => {
		const bad = arity("MONTH", args, 1);
		if (bad) return bad;
		const d = toDate(evaluate(args[0], ctx));
		return isError(d) ? d : d.getUTCMonth() + 1;
	},
	DAY: (args, ctx) => {
		const bad = arity("DAY", args, 1);
		if (bad) return bad;
		const d = toDate(evaluate(args[0], ctx));
		return isError(d) ? d : d.getUTCDate();
	},
	// Whole days from the first date to the second.
	DAYS: (args, ctx) => {
		const bad = arity("DAYS", args, 2);
		if (bad) return bad;
		const [a, b] = evalArgs(args, ctx).map(toDate);
		if (isError(a)) return a;
		if (isError(b)) return b;
		return Math.round((b.getTime() - a.getTime()) / 86400000);
	},

	// Down the column.
	TOTAL: (args, ctx) => {
		const bad = arity("TOTAL", args, 1);
		if (bad) return bad;
		const col = columnOf("TOTAL", args[0], ctx);
		if (isError(col)) return col;
		return columnTotal(col);
	},
	// Share of the column's total, as a fraction: [Revenue] / TOTAL([Revenue]).
	SHARE: (args, ctx) => {
		const bad = arity("SHARE", args, 1);
		if (bad) return bad;
		const total = functions.TOTAL(args, ctx);
		if (isError(total)) return total;
		const v = toNum(evaluate(args[0], ctx));
		if (isError(v)) return v;
		return total === 0
			? new FormulaError("#DIV/0!")
			: v / (total as number);
	},
	// 1 for the largest value in the column. Ties share a rank.
	RANK: (args, ctx) => {
		const bad = arity("RANK", args, 1, 2);
		if (bad) return bad;
		const col = columnOf("RANK", args[0], ctx);
		if (isError(col)) return col;
		const ascending = args[1] ? truthy(evaluate(args[1], ctx)) : false;
		if (isError(ascending)) return ascending;
		const v = toNum(evaluate(args[0], ctx));
		if (isError(v)) return v;
		if (Number.isNaN(v)) return 1;
		const sorted = sortedNumbers(col);
		const above = ascending
			? countBelow(sorted, v, false)
			: sorted.length - countBelow(sorted, v, true);
		return above + 1;
	},
	// The value in the row above, in the order shown, or blank on the first.
	PREVIOUS: (args, ctx) => {
		const bad = arity("PREVIOUS", args, 1);
		if (bad) return bad;
		const col = columnOf("PREVIOUS", args[0], ctx);
		if (isError(col)) return col;
		return ctx.index > 0 ? (col[ctx.index - 1] ?? null) : null;
	},
	// The running total down the column, in the order shown.
	RUNNING: (args, ctx) => {
		const bad = arity("RUNNING", args, 1);
		if (bad) return bad;
		const col = columnOf("RUNNING", args[0], ctx);
		if (isError(col)) return col;
		if (col.length === 0) return 0;
		const running = runningTotals(col);
		return running[Math.min(ctx.index, col.length - 1)];
	},
};

export const functionNames = Object.keys(functions).sort();

export function evaluate(node: Node, ctx: Context): Value {
	switch (node.k) {
		case "lit":
			return node.v;
		case "ref": {
			const v = ctx.get(node.name);
			return v === undefined
				? new FormulaError("#REF!", `no column named ${node.name}`)
				: v;
		}
		case "un": {
			const n = toNum(evaluate(node.a, ctx));
			if (isError(n)) return n;
			return node.op === "-" ? -n : n;
		}
		case "bin": {
			const a = evaluate(node.a, ctx);
			const b = evaluate(node.b, ctx);
			const e = firstError([a, b]);
			if (e) return e;
			if (node.op === "&") return joined(toText(a) + toText(b));
			if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) {
				const c = compare(a, b);
				switch (node.op) {
					case "=":
						return c === 0;
					case "<>":
						return c !== 0;
					case "<":
						return c < 0;
					case ">":
						return c > 0;
					case "<=":
						return c <= 0;
					default:
						return c >= 0;
				}
			}
			const x = toNum(a);
			const y = toNum(b);
			if (isError(x)) return x;
			if (isError(y)) return y;
			switch (node.op) {
				case "+":
					return x + y;
				case "-":
					return x - y;
				case "*":
					return x * y;
				case "/":
					return y === 0 ? new FormulaError("#DIV/0!") : x / y;
				case "^": {
					const r = x ** y;
					return Number.isFinite(r) ? r : new FormulaError("#VALUE!");
				}
			}
			return new FormulaError("#VALUE!");
		}
		case "call": {
			const fn = functions[node.fn];
			return fn
				? fn(node.args, ctx)
				: new FormulaError("#NAME?", `${node.fn} is not a function`);
		}
	}
}

// The functions that read every row of a column rather than the row they are
// on.
const wholeColumnFunctions = new Set([
	"TOTAL",
	"SHARE",
	"RANK",
	"PREVIOUS",
	"RUNNING",
]);

// Whether any of these formulas reads down a whole column, so its values can
// only be worked out once every row is in. A formula that cannot be parsed
// reads nothing.
export function readsWholeColumn(formulas: { formula: string }[]): boolean {
	const walk = (n: Node): boolean => {
		if (n.k === "call") {
			return wholeColumnFunctions.has(n.fn) || n.args.some(walk);
		}
		if (n.k === "un") return walk(n.a);
		if (n.k === "bin") return walk(n.a) || walk(n.b);
		return false;
	};
	return formulas.some((f) => {
		try {
			return walk(parse(f.formula));
		} catch {
			return false;
		}
	});
}

// --- A sheet's worth ---------------------------------------------------------

export interface FormulaColumn {
	id: string;
	name: string;
	formula: string;
}

export interface Computed {
	// One entry per row, keyed by formula column name.
	values: Record<string, Value>[];
	// Why a formula column could not be computed at all, by name.
	problems: Record<string, string>;
}

// Computes every formula column for every row.
//
// Formulas may read other formulas. They are computed in an order where each
// one comes after everything it reads, and a formula that reads itself, even
// through another, gets #CYCLE! rather than looping.
export function computeColumns(
	rows: Record<string, unknown>[],
	baseColumns: string[],
	formulas: FormulaColumn[],
	options: { today?: Date } = {},
): Computed {
	const problems: Record<string, string> = {};
	const parsed = new Map<string, Node>();
	for (const f of formulas) {
		try {
			parsed.set(f.name, parse(f.formula));
		} catch (error) {
			problems[f.name] =
				error instanceof Error
					? error.message
					: "The formula cannot be read.";
		}
	}

	// Case-insensitive lookup, so [revenue] finds Revenue.
	const canonical = new Map<string, string>();
	for (const c of baseColumns) canonical.set(c.toLowerCase(), c);
	for (const f of formulas) canonical.set(f.name.toLowerCase(), f.name);
	const resolve = (name: string) => canonical.get(name.toLowerCase());

	// Ordered so each formula comes after the formulas it reads.
	const order: string[] = [];
	const state = new Map<string, "visiting" | "done">();
	const cyclic = new Set<string>();
	const visit = (name: string): boolean => {
		if (state.get(name) === "done") return !cyclic.has(name);
		if (state.get(name) === "visiting") return false;
		state.set(name, "visiting");
		let ok = true;
		for (const ref of references(parsed.get(name)!)) {
			const target = resolve(ref);
			if (target && parsed.has(target) && !visit(target)) ok = false;
		}
		state.set(name, "done");
		if (!ok) cyclic.add(name);
		order.push(name);
		return ok;
	};
	for (const name of parsed.keys()) visit(name);

	const values: Record<string, Value>[] = rows.map(() => ({}));
	const columnCache = new Map<string, Value[]>();
	const columnValues = (name: string): Value[] | undefined => {
		const real = resolve(name);
		if (!real) return undefined;
		const cached = columnCache.get(real);
		if (cached) return cached;
		const col = parsed.has(real)
			? values.map((v) => v[real] ?? null)
			: rows.map((r) => fromCell(r[real]));
		columnCache.set(real, col);
		return col;
	};

	for (const name of order) {
		const tree = parsed.get(name)!;
		for (let i = 0; i < rows.length; i++) {
			if (cyclic.has(name)) {
				values[i][name] = new FormulaError(
					"#CYCLE!",
					"the formula reads itself",
				);
				continue;
			}
			const ctx: Context = {
				index: i,
				today: options.today,
				get: (ref) => {
					const real = resolve(ref);
					if (!real) return undefined;
					return parsed.has(real)
						? (values[i][real] ?? null)
						: fromCell(rows[i][real]);
				},
				column: columnValues,
			};
			values[i][name] = evaluate(tree, ctx);
		}
		// Later formulas that look down this column see its values.
		columnCache.delete(name);
	}

	for (const name of Object.keys(problems)) {
		for (const v of values)
			v[name] = new FormulaError("#VALUE!", problems[name]);
	}

	return { values, problems };
}
