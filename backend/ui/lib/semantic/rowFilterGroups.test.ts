import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractFilterGroups,
	mergeFilterGroups,
	parseMetricViewTables,
} from "./rowFilterGroups";

// These decide how the result cache is partitioned. A group this misses means
// two people who see different rows can share a cached answer, so the cases
// below are the ones that must not regress.

const filter = `(
  CASE
    WHEN is_member('Platform Admins') THEN TRUE
    WHEN is_member('Region East Consumers') THEN (\`REGION\` IN ('East'))
    WHEN is_account_group_member('Finance Reporting') THEN TRUE
    ELSE FALSE
  END
)`;

test("every group a filter branches on is found", () => {
	const groups = extractFilterGroups(filter);
	assert.deepEqual(groups.workspaceGroups, [
		"Platform Admins",
		"Region East Consumers",
	]);
	assert.deepEqual(groups.accountGroups, ["Finance Reporting"]);
});

test("the two membership functions are kept apart", () => {
	// They resolve against different directories and can disagree for the same
	// person, so a probe has to ask the same way the filter did.
	const groups = extractFilterGroups(
		"WHEN is_member('A') THEN TRUE WHEN is_account_group_member('A') THEN TRUE",
	);
	assert.deepEqual(groups.workspaceGroups, ["A"]);
	assert.deepEqual(groups.accountGroups, ["A"]);
});

test("a group named twice is listed once", () => {
	const groups = extractFilterGroups(
		"is_member('Ops') OR is_member('Ops') OR is_member('Ops')",
	);
	assert.deepEqual(groups.workspaceGroups, ["Ops"]);
});

test("double quotes and spaces in a name survive", () => {
	const groups = extractFilterGroups(
		'is_member("Field Sales - North America")',
	);
	assert.deepEqual(groups.workspaceGroups, ["Field Sales - North America"]);
});

test("a filter that names nobody yields nothing rather than guessing", () => {
	assert.deepEqual(extractFilterGroups("(`REGION` IS NOT NULL)"), {
		accountGroups: [],
		workspaceGroups: [],
	});
	assert.deepEqual(extractFilterGroups(""), {
		accountGroups: [],
		workspaceGroups: [],
	});
});

test("groups from several filters combine without duplicates", () => {
	const merged = mergeFilterGroups([
		extractFilterGroups("is_member('A') is_account_group_member('X')"),
		extractFilterGroups("is_member('B') is_member('A')"),
	]);
	assert.deepEqual(merged.workspaceGroups, ["A", "B"]);
	assert.deepEqual(merged.accountGroups, ["X"]);
});

// --- Which tables a view reads --------------------------------------------

const view = `CREATE VIEW cat.views.sales
WITH METRICS LANGUAGE YAML AS $$
version: 1.1

source: cat.raw.orders

joins:
  - name: dim_customer
    source: cat.raw.customers
    on: orders.CUSTOMER_ID = dim_customer.ID
  - name: alias_only
    on: something

dimensions:
  - name: Region
    expr: REGION
$$`;

test("the source and every joined table are found", () => {
	assert.deepEqual(parseMetricViewTables(view), [
		"cat.raw.customers",
		"cat.raw.orders",
	]);
});

test("a join alias is not mistaken for a table", () => {
	const tables = parseMetricViewTables(view);
	assert.ok(!tables.includes("alias_only"));
	assert.ok(!tables.some((t) => t.split(".").length < 2));
});

test("a statement with no metrics body yields nothing", () => {
	assert.deepEqual(parseMetricViewTables("CREATE VIEW x AS SELECT 1"), []);
});
