// What a data rule is, the query that checks it, and how an answer is judged.
//
// A check runs with nobody signed in, so it runs as the app, on the real tables behind
// a source, and may keep counts only. Nothing here selects a value out of a table
// except a group label on a source with no row filter, and a request for failing rows,
// which always runs as the person asking.
//
// Pure, so every kind of rule can be tested without a warehouse. No text an author
// typed reaches a statement as anything but a checked name or a bound parameter.

export const ruleKinds = [
	"unique",
	"notBlank",
	"range",
	"allowedValues",
	"crossField",
	"matchesTable",
	"rowCountShift",
	"distributionShift",
	"reconcile",
	"schema",
] as const;

export type RuleKind = (typeof ruleKinds)[number];
export type Severity = "warning" | "critical";
export type RuleSchedule = "afterLoad" | "hourly" | "daily";

export interface RuleParams {
	columns?: string[];
	column?: string;
	min?: number | null;
	max?: number | null;
	values?: string[];
	left?: string;
	op?: string;
	right?: string;
	otherTable?: string;
	otherColumn?: string;
	// How far a figure can move between runs before it fails, in percentage points.
	shiftPercent?: number;
	// How far apart two totals can be, in percentage points.
	tolerancePercent?: number;
	// What the table is expected to have, recorded when a schema rule is made.
	expectedColumns?: { name: string; type: string }[];
}

export interface DataRule {
	ruleId: string;
	sourceKey: string;
	table: string;
	name: string;
	kind: RuleKind;
	params: RuleParams;
	severity: Severity;
	owner: string | null;
	groupBy: string | null;
	// A date or timestamp column, so only rows from the last so many days are checked.
	recentColumn: string | null;
	recentDays: number | null;
	schedule: RuleSchedule;
	budgetSeconds: number;
	allowFailing: number;
	isActive: boolean;
}

export class RuleError extends Error {}

const comparisons = new Set(["<", "<=", "=", "!=", ">", ">="]);

// A column or table part. Anything unusual goes in backticks, with backticks doubled,
// so a name can never end the identifier and start a statement.
export function quoteColumn(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new RuleError("A column name is required.");
	return "`" + trimmed.replace(/`/g, "``") + "`";
}

export function quoteTable(table: string): string {
	const parts = table
		.split(".")
		.map((part) => part.trim().replace(/^`|`$/g, ""))
		.filter(Boolean);
	if (parts.length === 0 || parts.length > 3) {
		throw new RuleError(`"${table}" is not a table name.`);
	}
	return parts.map(quoteColumn).join(".");
}

export interface CompiledCheck {
	sql: string;
	params: Record<string, unknown>;
	// Each row answers one group, or the whole table when there is no grouping.
	shape: "counts" | "profile" | "totals" | "metadata";
}

function recentClause(
	rule: DataRule,
	params: Record<string, unknown>,
): string | null {
	if (!rule.recentColumn || !rule.recentDays) return null;
	params.recentSince = new Date(
		Date.now() - rule.recentDays * 24 * 60 * 60 * 1000,
	)
		.toISOString()
		.slice(0, 10);
	return `${quoteColumn(rule.recentColumn)} >= :recentSince`;
}

function whereOf(clauses: (string | null)[]): string {
	const kept = clauses.filter(Boolean);
	return kept.length > 0 ? ` WHERE ${kept.join(" AND ")}` : "";
}

// Failing rows as a condition, for the kinds a single row can fail.
function failingCondition(
	rule: DataRule,
	params: Record<string, unknown>,
): string | null {
	const p = rule.params;
	switch (rule.kind) {
		case "notBlank": {
			const column = quoteColumn(p.column ?? "");
			return `(${column} IS NULL OR TRIM(CONCAT(${column}, '')) = '')`;
		}
		case "range": {
			const column = quoteColumn(p.column ?? "");
			const parts: string[] = [];
			if (typeof p.min === "number") {
				params.min = p.min;
				parts.push(`${column} < :min`);
			}
			if (typeof p.max === "number") {
				params.max = p.max;
				parts.push(`${column} > :max`);
			}
			if (parts.length === 0) {
				throw new RuleError("A range needs a lowest or highest value.");
			}
			return `(${parts.join(" OR ")})`;
		}
		case "allowedValues": {
			const column = quoteColumn(p.column ?? "");
			const values = p.values ?? [];
			if (values.length === 0) {
				throw new RuleError("List at least one allowed value.");
			}
			const names = values.map((value, index) => {
				params[`v${index}`] = value;
				return `:v${index}`;
			});
			return `(${column} IS NOT NULL AND ${column} NOT IN (${names.join(", ")}))`;
		}
		case "crossField": {
			const op = p.op ?? "";
			if (!comparisons.has(op)) {
				throw new RuleError("That is not a comparison.");
			}
			const left = quoteColumn(p.left ?? "");
			const right = quoteColumn(p.right ?? "");
			return `(${left} IS NOT NULL AND ${right} IS NOT NULL AND NOT (${left} ${op} ${right}))`;
		}
		default:
			return null;
	}
}

export function compileRule(rule: DataRule): CompiledCheck {
	const table = quoteTable(rule.table);
	const params: Record<string, unknown> = {};
	const recent = recentClause(rule, params);
	const group = rule.groupBy ? quoteColumn(rule.groupBy) : null;
	const groupSelect = group ? `, ${group} AS group_label` : "";
	const groupTail = group
		? ` GROUP BY ${group} ORDER BY failing DESC LIMIT 50`
		: "";
	const p = rule.params;

	switch (rule.kind) {
		case "unique": {
			const columns = (p.columns ?? []).map(quoteColumn);
			if (columns.length === 0) {
				throw new RuleError(
					"Choose the columns that should be unique.",
				);
			}
			const keys = [...(group ? [group] : []), ...columns].join(", ");
			const inner = `SELECT ${group ? `${group} AS group_label, ` : ""}count(*) AS row_total FROM ${table}${whereOf([recent])} GROUP BY ${keys}`;
			return {
				sql: `SELECT COALESCE(SUM(row_total - 1), 0) AS failing, COALESCE(SUM(row_total), 0) AS checked${group ? ", group_label" : ""} FROM (${inner}) grouped${group ? " GROUP BY group_label ORDER BY failing DESC LIMIT 50" : ""}`,
				params,
				shape: "counts",
			};
		}
		case "notBlank":
		case "range":
		case "allowedValues":
		case "crossField": {
			const condition = failingCondition(rule, params);
			return {
				sql: `SELECT COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0) AS failing, count(*) AS checked${groupSelect} FROM ${table}${whereOf([recent])}${groupTail}`,
				params,
				shape: "counts",
			};
		}
		case "matchesTable": {
			const column = quoteColumn(p.column ?? "");
			const other = quoteTable(p.otherTable ?? "");
			const otherColumn = quoteColumn(p.otherColumn ?? p.column ?? "");
			return {
				sql: `SELECT COALESCE(SUM(CASE WHEN o.match_key IS NULL THEN 1 ELSE 0 END), 0) AS failing, count(*) AS checked FROM (SELECT ${column} AS check_key FROM ${table}${whereOf([recent, `${column} IS NOT NULL`])}) t LEFT JOIN (SELECT DISTINCT ${otherColumn} AS match_key FROM ${other}) o ON t.check_key = o.match_key`,
				params,
				shape: "counts",
			};
		}
		case "rowCountShift":
			return {
				sql: `SELECT count(*) AS checked FROM ${table}${whereOf([recent])}`,
				params,
				shape: "profile",
			};
		case "distributionShift": {
			const column = quoteColumn(p.column ?? "");
			return {
				sql: `SELECT count(*) AS checked, count(DISTINCT ${column}) AS distinct_values, SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END) AS blanks FROM ${table}${whereOf([recent])}`,
				params,
				shape: "profile",
			};
		}
		case "reconcile": {
			const column = quoteColumn(p.column ?? "");
			const other = quoteTable(p.otherTable ?? "");
			const otherColumn = quoteColumn(p.otherColumn ?? p.column ?? "");
			return {
				sql: `SELECT (SELECT SUM(${column}) FROM ${table}${whereOf([recent])}) AS left_total, (SELECT SUM(${otherColumn}) FROM ${other}) AS right_total`,
				params,
				shape: "totals",
			};
		}
		case "schema": {
			const parts = rule.table
				.split(".")
				.map((part) => part.trim().replace(/^`|`$/g, ""));
			if (parts.length !== 3) {
				throw new RuleError(
					"A schema rule needs a three part table name.",
				);
			}
			params.schemaName = parts[1];
			params.tableName = parts[2];
			return {
				sql: `SELECT column_name, full_data_type FROM ${quoteColumn(parts[0])}.information_schema.columns WHERE table_schema = :schemaName AND table_name = :tableName`,
				params,
				shape: "metadata",
			};
		}
	}
}

// Rows failing the rule, for somebody allowed to look, as themselves. Row filters on
// the table apply because the statement runs under their own token.
export function compileFailingRows(
	rule: DataRule,
	limit: number,
): CompiledCheck | null {
	const table = quoteTable(rule.table);
	const params: Record<string, unknown> = {};
	const recent = recentClause(rule, params);
	const condition = failingCondition(rule, params);
	if (condition) {
		return {
			sql: `SELECT * FROM ${table}${whereOf([recent, condition])} LIMIT ${limit}`,
			params,
			shape: "counts",
		};
	}
	if (rule.kind === "unique") {
		const columns = (rule.params.columns ?? []).map(quoteColumn);
		const list = columns.join(", ");
		return {
			sql: `SELECT ${list}, count(*) AS row_total FROM ${table}${whereOf([recent])} GROUP BY ${list} HAVING count(*) > 1 ORDER BY row_total DESC LIMIT ${limit}`,
			params,
			shape: "counts",
		};
	}
	return null;
}

export interface RuleResult {
	status: "pass" | "fail";
	failing: number;
	checked: number;
	// Per group, worst first, when the rule groups.
	groups: { label: string; failing: number; checked: number }[];
	// Plain words for anything that is not simply a count of rows.
	detail: string | null;
	// Carried to the next run, so a shift has something to compare with.
	measures: Record<string, number>;
}

function numberOf(value: unknown): number {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

function percentChange(before: number, now: number): number {
	if (before === 0) return now === 0 ? 0 : 100;
	return (Math.abs(now - before) / Math.abs(before)) * 100;
}

// Reads an answer against the rule, and against the last answer for rules about change.
export function judge(
	rule: DataRule,
	rows: Record<string, unknown>[],
	previous: Record<string, number> | null,
): RuleResult {
	const p = rule.params;

	if (rule.kind === "rowCountShift" || rule.kind === "distributionShift") {
		const row = rows[0] ?? {};
		const measures: Record<string, number> = {
			checked: numberOf(row.checked),
		};
		if (rule.kind === "distributionShift") {
			measures.distinctValues = numberOf(row.distinct_values);
			measures.blankShare =
				measures.checked > 0
					? (numberOf(row.blanks) / measures.checked) * 100
					: 0;
		}
		const limit = p.shiftPercent ?? 20;
		const words: Record<string, string> = {
			checked: "Row count",
			distinctValues: "Distinct values",
			blankShare: "Share of blanks",
		};
		const moved = previous
			? Object.keys(measures).filter(
					(name) =>
						previous[name] !== undefined &&
						percentChange(previous[name], measures[name]) > limit,
				)
			: [];
		return {
			status: moved.length > 0 ? "fail" : "pass",
			failing: moved.length,
			checked: measures.checked,
			groups: [],
			detail:
				moved.length > 0
					? `${moved.map((name) => words[name]).join(" and ")} moved by more than ${limit} points since the last check.`
					: previous
						? null
						: "First check, so this is what later checks are compared with.",
			measures,
		};
	}

	if (rule.kind === "reconcile") {
		const row = rows[0] ?? {};
		const left = numberOf(row.left_total);
		const right = numberOf(row.right_total);
		const apart = percentChange(left, right);
		const tolerance = p.tolerancePercent ?? 0;
		const failed = apart > tolerance;
		// The totals themselves are data, so only how far apart they are is kept.
		return {
			status: failed ? "fail" : "pass",
			failing: failed ? 1 : 0,
			checked: 1,
			groups: [],
			detail: failed
				? `The two totals are ${apart.toFixed(1)} points apart, past the ${tolerance} allowed.`
				: null,
			measures: {},
		};
	}

	if (rule.kind === "schema") {
		// An empty answer means the catalogue could not be read, not that the table
		// lost every column.
		if (rows.length === 0) {
			return {
				status: "pass",
				failing: 0,
				checked: 0,
				groups: [],
				detail: "The catalogue could not be read, so this was not checked.",
				measures: {},
			};
		}
		const actual = new Map(
			rows.map((row) => [
				String(row.column_name).toLowerCase(),
				String(row.full_data_type).toLowerCase(),
			]),
		);
		const expected = p.expectedColumns ?? [];
		const gone = expected.filter((c) => !actual.has(c.name.toLowerCase()));
		const retyped = expected.filter((c) => {
			const now = actual.get(c.name.toLowerCase());
			return now !== undefined && now !== c.type.toLowerCase();
		});
		const said = [
			gone.length > 0
				? `Gone: ${gone.map((c) => c.name).join(", ")}.`
				: null,
			retyped.length > 0
				? `Changed type: ${retyped.map((c) => c.name).join(", ")}.`
				: null,
		].filter(Boolean);
		const failing = gone.length + retyped.length;
		return {
			status: failing > 0 ? "fail" : "pass",
			failing,
			checked: expected.length,
			groups: [],
			detail: said.length > 0 ? said.join(" ") : null,
			measures: {},
		};
	}

	const groups = rule.groupBy
		? rows.map((row) => ({
				label: String(row.group_label ?? "(blank)"),
				failing: numberOf(row.failing),
				checked: numberOf(row.checked),
			}))
		: [];
	const failing = rows.reduce((sum, row) => sum + numberOf(row.failing), 0);
	const checked = rows.reduce((sum, row) => sum + numberOf(row.checked), 0);
	return {
		status: failing > rule.allowFailing ? "fail" : "pass",
		failing,
		checked,
		groups: groups.filter((group) => group.failing > 0),
		detail: null,
		measures: {},
	};
}

const hourMs = 60 * 60 * 1000;

// Whether a rule should run now. After a load, it runs once for each load, with a daily
// check as a backstop for a source whose loads cannot be seen.
export function isDue(
	rule: Pick<DataRule, "schedule" | "isActive">,
	lastRunAt: number | null,
	lastLoadAt: number | null,
	now: number,
): boolean {
	if (!rule.isActive) return false;
	if (lastRunAt === null) return true;
	const since = now - lastRunAt;
	if (rule.schedule === "hourly") return since >= hourMs;
	if (rule.schedule === "daily") return since >= 24 * hourMs;
	if (lastLoadAt !== null && lastLoadAt > lastRunAt) return true;
	return since >= 24 * hourMs;
}

export interface IncidentState {
	status: "open" | "acknowledged" | "resolved";
	mutedUntil: number | null;
}

// What a new result does to the incident on a rule, and whether anyone should be told.
export function nextIncident(
	current: IncidentState | null,
	result: Pick<RuleResult, "status">,
	now: number,
): { action: "open" | "resolve" | "none"; notify: boolean } {
	const live = current && current.status !== "resolved";
	if (result.status === "pass") {
		return live
			? { action: "resolve", notify: false }
			: { action: "none", notify: false };
	}
	if (live) return { action: "none", notify: false };
	const muted = current?.mutedUntil != null && current.mutedUntil > now;
	return { action: "open", notify: !muted };
}

// Out of a hundred, with critical rules counting for three.
export function sourceScore(
	results: { severity: Severity; status: "pass" | "fail" | "error" }[],
): number | null {
	const judged = results.filter((result) => result.status !== "error");
	if (judged.length === 0) return null;
	const weightOf = (severity: Severity) => (severity === "critical" ? 3 : 1);
	const total = judged.reduce((sum, r) => sum + weightOf(r.severity), 0);
	const passed = judged
		.filter((result) => result.status === "pass")
		.reduce((sum, r) => sum + weightOf(r.severity), 0);
	return Math.round((passed / total) * 100);
}

// Rules worth suggesting from a look at a table. Declared keys are the strongest hint,
// and columns that are never blank are likely meant to stay that way.
export function suggestRules(input: {
	table: string;
	primaryKey: string[];
	columns: {
		name: string;
		type: string;
		blanks: number;
		distinct: number;
	}[];
	rowCount: number;
}): { name: string; kind: RuleKind; params: RuleParams; why: string }[] {
	const out: {
		name: string;
		kind: RuleKind;
		params: RuleParams;
		why: string;
	}[] = [];
	if (input.primaryKey.length > 0) {
		out.push({
			name: `${input.primaryKey.join(", ")} is unique`,
			kind: "unique",
			params: { columns: input.primaryKey },
			why: "Declared as this table's primary key, which the warehouse does not enforce.",
		});
	}
	for (const column of input.columns) {
		if (input.primaryKey.includes(column.name)) continue;
		if (input.rowCount > 0 && column.distinct === input.rowCount) {
			out.push({
				name: `${column.name} is unique`,
				kind: "unique",
				params: { columns: [column.name] },
				why: "Every row has a different value today.",
			});
		} else if (input.rowCount > 0 && column.blanks === 0) {
			out.push({
				name: `${column.name} is not blank`,
				kind: "notBlank",
				params: { column: column.name },
				why: "No row is blank today.",
			});
		}
	}
	out.push({
		name: "Row count does not jump",
		kind: "rowCountShift",
		params: { shiftPercent: 20 },
		why: "Catches a load that lost or doubled rows.",
	});
	if (input.columns.length > 0) {
		out.push({
			name: "Columns stay as they are",
			kind: "schema",
			params: {
				expectedColumns: input.columns.map((column) => ({
					name: column.name,
					type: column.type,
				})),
			},
			why: "Catches a column disappearing or changing type.",
		});
	}
	return out;
}

// The columns a rule checks, for showing it against a field.
export function columnsOfRule(params: RuleParams): string[] {
	return [
		params.column,
		...(params.columns ?? []),
		params.left,
		params.right,
	].flatMap((column) => (column ? [column.toLowerCase()] : []));
}

// The one column a field reads, such as order_date or SUM(revenue). Null when it works from
// more than one, since a rule on any of them says nothing certain about the field.
export function columnOfField(expression: string | null): string | null {
	if (!expression) return null;
	const match =
		/^"?(\w+)"?$/.exec(expression.trim()) ??
		/^\w+\(\s*(?:DISTINCT\s+)?"?(\w+)"?\s*\)$/i.exec(expression.trim());
	return match ? match[1].toLowerCase() : null;
}
