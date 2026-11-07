import { test } from "node:test";
import assert from "node:assert/strict";
import {
	compileFailingRows,
	compileRule,
	isDue,
	judge,
	nextIncident,
	quoteColumn,
	quoteTable,
	RuleError,
	sourceScore,
	suggestRules,
	type DataRule,
	columnOfField,
	columnsOfRule,
} from "./rules";

const rule = (extra: Partial<DataRule> = {}): DataRule => ({
	ruleId: "r1",
	sourceKey: "orders",
	table: "main.sales.orders",
	name: "Rule",
	kind: "notBlank",
	params: { column: "region" },
	severity: "warning",
	owner: null,
	groupBy: null,
	recentColumn: null,
	recentDays: null,
	schedule: "afterLoad",
	budgetSeconds: 300,
	allowFailing: 0,
	isActive: true,
	...extra,
});

test("a name cannot break out of its quotes", () => {
	assert.equal(quoteColumn("a`; DROP TABLE x"), "`a``; DROP TABLE x`");
	assert.equal(quoteTable("main.sales.orders"), "`main`.`sales`.`orders`");
	assert.throws(() => quoteTable("a.b.c.d"), RuleError);
	assert.throws(() => quoteColumn("  "), RuleError);
});

test("allowed values go as parameters, never as text", () => {
	const check = compileRule(
		rule({
			kind: "allowedValues",
			params: { column: "region", values: ["West'; DROP TABLE x;--"] },
		}),
	);
	assert.ok(!check.sql.includes("DROP"));
	assert.equal(check.params.v0, "West'; DROP TABLE x;--");
});

test("a comparison has to be one of the known ones", () => {
	assert.throws(
		() =>
			compileRule(
				rule({
					kind: "crossField",
					params: { left: "a", op: "=1 OR 1", right: "b" },
				}),
			),
		RuleError,
	);
	const check = compileRule(
		rule({
			kind: "crossField",
			params: { left: "start_on", op: "<=", right: "end_on" },
		}),
	);
	assert.ok(check.sql.includes("NOT (`start_on` <= `end_on`)"));
});

test("a check selects counts rather than values", () => {
	for (const made of [
		rule(),
		rule({ kind: "unique", params: { columns: ["id"] } }),
		rule({ kind: "range", params: { column: "n", min: 0 } }),
		rule({
			kind: "matchesTable",
			params: { column: "id", otherTable: "a.b.c" },
		}),
	]) {
		const { sql } = compileRule(made);
		assert.ok(sql.startsWith("SELECT COALESCE(SUM("), sql);
		assert.ok(!sql.startsWith("SELECT *"));
	}
});

test("only recent rows are checked when asked", () => {
	const check = compileRule(
		rule({ recentColumn: "order_date", recentDays: 7 }),
	);
	assert.ok(check.sql.includes("`order_date` >= :recentSince"));
	assert.match(String(check.params.recentSince), /^\d{4}-\d{2}-\d{2}$/);
});

test("a grouped rule answers per group, worst first", () => {
	const check = compileRule(rule({ groupBy: "region" }));
	assert.ok(check.sql.includes("GROUP BY `region` ORDER BY failing DESC"));
	const result = judge(
		rule({ groupBy: "region" }),
		[
			{ failing: 3, checked: 10, group_label: "West" },
			{ failing: 0, checked: 5, group_label: "East" },
		],
		null,
	);
	assert.equal(result.failing, 3);
	assert.equal(result.checked, 15);
	assert.deepEqual(result.groups, [
		{ label: "West", failing: 3, checked: 10 },
	]);
});

test("failing up to the allowance still passes", () => {
	const made = rule({ allowFailing: 5 });
	assert.equal(
		judge(made, [{ failing: 5, checked: 9 }], null).status,
		"pass",
	);
	assert.equal(
		judge(made, [{ failing: 6, checked: 9 }], null).status,
		"fail",
	);
});

test("row count shift compares with the last run, and the first run passes", () => {
	const made = rule({
		kind: "rowCountShift",
		params: { shiftPercent: 20 },
	});
	const first = judge(made, [{ checked: 100 }], null);
	assert.equal(first.status, "pass");
	assert.equal(first.measures.checked, 100);
	assert.equal(
		judge(made, [{ checked: 119 }], first.measures).status,
		"pass",
	);
	assert.equal(judge(made, [{ checked: 50 }], first.measures).status, "fail");
});

test("a distribution shift notices blanks and distinct values", () => {
	const made = rule({
		kind: "distributionShift",
		params: { column: "region", shiftPercent: 10 },
	});
	const before = judge(
		made,
		[{ checked: 100, distinct_values: 4, blanks: 10 }],
		null,
	).measures;
	const after = judge(
		made,
		[{ checked: 100, distinct_values: 4, blanks: 40 }],
		before,
	);
	assert.equal(after.status, "fail");
	assert.match(after.detail ?? "", /Share of blanks/);
});

test("reconciling keeps how far apart, never the totals", () => {
	const made = rule({
		kind: "reconcile",
		params: { column: "a", otherTable: "x.y.z", tolerancePercent: 1 },
	});
	const result = judge(made, [{ left_total: 100, right_total: 110 }], null);
	assert.equal(result.status, "fail");
	assert.ok(!(result.detail ?? "").includes("110"));
	assert.deepEqual(result.measures, {});
	assert.equal(
		judge(made, [{ left_total: 100, right_total: 100.5 }], null).status,
		"pass",
	);
});

test("a schema rule names what went and what changed", () => {
	const made = rule({
		kind: "schema",
		params: {
			expectedColumns: [
				{ name: "id", type: "bigint" },
				{ name: "gone", type: "string" },
				{ name: "amount", type: "int" },
			],
		},
	});
	const result = judge(
		made,
		[
			{ column_name: "ID", full_data_type: "BIGINT" },
			{ column_name: "amount", full_data_type: "double" },
		],
		null,
	);
	assert.equal(result.failing, 2);
	assert.match(result.detail ?? "", /Gone: gone/);
	assert.match(result.detail ?? "", /Changed type: amount/);
});

test("a catalogue that could not be read is not called a failure", () => {
	const made = rule({
		kind: "schema",
		params: { expectedColumns: [{ name: "id", type: "bigint" }] },
	});
	assert.equal(judge(made, [], null).status, "pass");
});

test("failing rows are limited, and only exist for rules about rows", () => {
	const sample = compileFailingRows(rule(), 50);
	assert.match(sample?.sql ?? "", /LIMIT 50$/);
	assert.equal(
		compileFailingRows(rule({ kind: "rowCountShift", params: {} }), 50),
		null,
	);
	assert.match(
		compileFailingRows(
			rule({ kind: "unique", params: { columns: ["id"] } }),
			50,
		)?.sql ?? "",
		/HAVING count\(\*\) > 1/,
	);
});

test("when a rule is due", () => {
	const hour = 60 * 60 * 1000;
	const now = 100 * hour;
	const after = rule();
	assert.equal(isDue(after, null, null, now), true);
	assert.equal(isDue(after, now - hour, now - 2 * hour, now), false);
	assert.equal(isDue(after, now - 2 * hour, now - hour, now), true);
	assert.equal(isDue(after, now - 25 * hour, null, now), true);
	assert.equal(
		isDue(rule({ schedule: "hourly" }), now - hour, null, now),
		true,
	);
	assert.equal(
		isDue(rule({ schedule: "daily" }), now - 2 * hour, null, now),
		false,
	);
	assert.equal(isDue(rule({ isActive: false }), null, null, now), false);
});

test("an incident opens once, closes on a pass, and a mute stays quiet", () => {
	const fail = { status: "fail" as const };
	const pass = { status: "pass" as const };
	const now = 1000;
	assert.deepEqual(nextIncident(null, fail, now), {
		action: "open",
		notify: true,
	});
	assert.deepEqual(nextIncident(null, pass, now), {
		action: "none",
		notify: false,
	});
	assert.deepEqual(
		nextIncident({ status: "open", mutedUntil: null }, fail, now),
		{ action: "none", notify: false },
	);
	assert.deepEqual(
		nextIncident({ status: "acknowledged", mutedUntil: null }, pass, now),
		{ action: "resolve", notify: false },
	);
	assert.deepEqual(
		nextIncident({ status: "resolved", mutedUntil: 2000 }, fail, now),
		{ action: "open", notify: false },
	);
	assert.deepEqual(
		nextIncident({ status: "resolved", mutedUntil: 500 }, fail, now),
		{ action: "open", notify: true },
	);
});

test("a score weighs critical rules heavier and ignores errors", () => {
	assert.equal(sourceScore([]), null);
	assert.equal(sourceScore([{ severity: "warning", status: "error" }]), null);
	assert.equal(
		sourceScore([
			{ severity: "critical", status: "fail" },
			{ severity: "warning", status: "pass" },
		]),
		25,
	);
	assert.equal(
		sourceScore([
			{ severity: "critical", status: "pass" },
			{ severity: "warning", status: "error" },
		]),
		100,
	);
});

test("suggestions start from a declared key", () => {
	const suggestions = suggestRules({
		table: "a.b.c",
		primaryKey: ["id"],
		rowCount: 10,
		columns: [
			{ name: "id", type: "bigint", blanks: 0, distinct: 10 },
			{ name: "region", type: "string", blanks: 0, distinct: 3 },
			{ name: "note", type: "string", blanks: 4, distinct: 2 },
			{ name: "code", type: "string", blanks: 0, distinct: 10 },
		],
	});
	assert.equal(suggestions[0].kind, "unique");
	assert.deepEqual(suggestions[0].params.columns, ["id"]);
	const names = suggestions.map((s) => s.name);
	assert.ok(names.includes("region is not blank"));
	assert.ok(names.includes("code is unique"));
	assert.ok(!names.some((name) => name.startsWith("note")));
	assert.ok(names.includes("Columns stay as they are"));
});

test("a field's column is read from a plain name or one aggregate", () => {
	assert.equal(columnOfField("order_date"), "order_date");
	assert.equal(columnOfField("SUM(revenue)"), "revenue");
	assert.equal(columnOfField("COUNT(DISTINCT order_id)"), "order_id");
	assert.equal(columnOfField("SUM(revenue - cost)"), null);
	assert.equal(columnOfField(null), null);
});

test("a rule names every column it checks", () => {
	assert.deepEqual(columnsOfRule({ column: "Region" }), ["region"]);
	assert.deepEqual(columnsOfRule({ left: "a", right: "b" }), ["a", "b"]);
	assert.deepEqual(columnsOfRule({ columns: ["x", "y"] }), ["x", "y"]);
});
