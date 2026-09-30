import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractFilterGroups,
	mergeFilterGroups,
	metricViewSourcesComplete,
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

// --- Filters no group list can stand for ---------------------------------

test("a filter on the reader's own name decides per reader", () => {
	const groups = extractFilterGroups(
		"region IN (SELECT region FROM sec.entitlements WHERE email = current_user())",
	);
	assert.equal(groups.perReader, true);
});

test("a membership test on a computed name decides per reader", () => {
	assert.equal(extractFilterGroups("is_member(g.name)").perReader, true);
	assert.equal(
		extractFilterGroups("is_account_group_member(concat('r_', region))")
			.perReader,
		true,
	);
});

test("a call to another routine decides per reader", () => {
	assert.equal(
		extractFilterGroups("RETURN sec.can_see(region)").perReader,
		true,
	);
});

test("a call to a routine in the current schema decides per reader", () => {
	assert.equal(extractFilterGroups("RETURN can_see(region)").perReader, true);
	assert.equal(
		extractFilterGroups("RETURN `can_see`(region, 'East')").perReader,
		true,
	);
});

test("built in functions and bracketed keywords are not routines", () => {
	assert.equal(
		extractFilterGroups(
			"RETURN lower(region) IN ('east', 'west') AND NOT (coalesce(flag, FALSE)) OR is_member('Finance')",
		).perReader,
		undefined,
	);
	assert.equal(
		extractFilterGroups("RETURN region = 'can_see(x)'").perReader,
		undefined,
	);
});

test("a filter naming only literal groups is not per reader", () => {
	assert.equal(extractFilterGroups(filter).perReader, undefined);
});

test("a doubled quote inside a group name is read as one quote", () => {
	const groups = extractFilterGroups("is_member('O''Brien Team')");
	assert.deepEqual(groups.workspaceGroups, ["O'Brien Team"]);
});

test("per reader survives a merge", () => {
	const merged = mergeFilterGroups([
		extractFilterGroups("is_member('A')"),
		extractFilterGroups("current_user() = owner"),
	]);
	assert.equal(merged.perReader, true);
	assert.deepEqual(merged.workspaceGroups, ["A"]);
});

// --- Whether every source of a view was read ------------------------------

test("a view over full table names is complete", () => {
	assert.equal(metricViewSourcesComplete(view), true);
});

test("a hyphenated catalogue name is read as a table", () => {
	const hyphen = `$$
source: sales-prod.core.orders
$$`;
	assert.deepEqual(parseMetricViewTables(hyphen), ["sales-prod.core.orders"]);
	assert.equal(metricViewSourcesComplete(hyphen), true);
});

test("a join over a query leaves the view incomplete", () => {
	const joined = `$$
source: cat.raw.orders
joins:
  - name: region_map
    source: SELECT * FROM cat.raw.regions
$$`;
	assert.equal(metricViewSourcesComplete(joined), false);
});

test("a name without its catalogue leaves the view incomplete", () => {
	const partial = `$$
source: raw.orders
$$`;
	assert.equal(metricViewSourcesComplete(partial), false);
});
