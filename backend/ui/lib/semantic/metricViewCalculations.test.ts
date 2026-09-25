import assert from "node:assert/strict";
import { test } from "node:test";
import {
	measuresReferenced,
	parseMetricViewCalculations,
} from "./metricViewCalculations";

// Shapes taken from a real metric view definition. Every one of them appears
// in the same file, so a reader that handles only the plain spelling shows
// half of the expressions with backslashes in them.

const definition = `CREATE VIEW c.s.orders (
  Order ID COMMENT 'Identifier'
)
WITH METRICS
LANGUAGE YAML
AS $$
version: 1.1

source: c.gold.order_lines

filter: ROW_TYPE IS NOT NULL

joins:
  - name: dim_order
    source: c.gold.orders
    "on": source.ORDER_ID = dim_order.ORDER_ID
    cardinality: many_to_one

comment: |-
  A long comment
  over two lines.

dimensions:
  - name: Order ID
    expr: ORDER_ID
    comment: Identifier of the order

  - name: Order Status
    expr: dim_order.STATUS
    comment: "Where the order sits in the workflow, DRAFT on one still being\\
      \\ built"

measures:
  - name: Revenue
    expr: SUM(REVENUE)
    comment: Sum of modelled revenue

  - name: Margin Pct
    expr: "100 * (MEASURE(\`Margin\`) / NULLIF(MEASURE(\`Revenue\`), 0))"
    comment: "Margin divided by Revenue"

  - name: Budget To Date
    expr: "SUM(CASE WHEN DATEKEY <= last_day(add_months(current_date(), -1)) THEN\\
      \\ BUDGET END)"
    comment: "Budget to date"

  - name: Revenue YTD
    expr: SUM(REVENUE)
    window:
      - order: Order Year
        semiadditive: last
        range: current
      - order: Order Month
        semiadditive: last
        range: cumulative
    comment: "Accumulated across Order Month"

  - name: Quoted With Apostrophe
    expr: 'COUNT(CASE WHEN BCS = ''BASE'' THEN 1 END)'
    comment: Single quoted

  - name: Block Literal
    expr: |
      SUM(
        REVENUE
      )
    comment: A block scalar
$$`;

const parsed = parseMetricViewCalculations(definition);

test("a plain expression is read as written", () => {
	assert.equal(parsed.fields.get("Revenue")?.expr, "SUM(REVENUE)");
	assert.equal(parsed.fields.get("Order ID")?.expr, "ORDER_ID");
	assert.equal(parsed.fields.get("Order Status")?.expr, "dim_order.STATUS");
});

test("a double quoted expression loses its quotes and keeps its backticks", () => {
	assert.equal(
		parsed.fields.get("Margin Pct")?.expr,
		"100 * (MEASURE(`Margin`) / NULLIF(MEASURE(`Revenue`), 0))",
	);
});

// The spelling the YAML writer uses for anything past its line width. Read
// wrongly it comes back as the first half with a trailing backslash.
test("an escaped line continuation joins with the space it kept", () => {
	assert.equal(
		parsed.fields.get("Budget To Date")?.expr,
		"SUM(CASE WHEN DATEKEY <= last_day(add_months(current_date(), -1)) THEN BUDGET END)",
	);
});

test("a single quoted expression unescapes doubled quotes", () => {
	assert.equal(
		parsed.fields.get("Quoted With Apostrophe")?.expr,
		"COUNT(CASE WHEN BCS = 'BASE' THEN 1 END)",
	);
});

test("a literal block keeps its lines", () => {
	assert.equal(
		parsed.fields.get("Block Literal")?.expr,
		"SUM(\n  REVENUE\n)",
	);
});

test("a windowed measure carries its window as written", () => {
	const ytd = parsed.fields.get("Revenue YTD");
	assert.equal(ytd?.expr, "SUM(REVENUE)");
	assert.ok(ytd?.window?.includes("order: Order Month"));
	assert.ok(ytd?.window?.includes("range: cumulative"));
	assert.equal(parsed.fields.get("Revenue")?.window, null);
});

// The comment key comes after expr on every field. A reader that lets a
// quoted comment run on would fold it into the next field.
test("a multi line comment does not bleed into the next field", () => {
	assert.equal(parsed.fields.get("Revenue")?.expr, "SUM(REVENUE)");
	assert.equal(parsed.fields.size, 8);
});

test("the view's source, filter and joins are read", () => {
	assert.equal(parsed.source, "c.gold.order_lines");
	assert.equal(parsed.filter, "ROW_TYPE IS NOT NULL");
	assert.deepEqual(parsed.joins, [
		{
			name: "dim_order",
			source: "c.gold.orders",
			on: "source.ORDER_ID = dim_order.ORDER_ID",
		},
	]);
});

test("a view level block comment is not read as a field", () => {
	assert.equal(parsed.fields.has("A long comment"), false);
});

test("measures built from other measures are named", () => {
	assert.deepEqual(
		measuresReferenced(
			"100 * (MEASURE(`Margin`) / NULLIF(MEASURE(`Revenue`), 0))",
		),
		["Margin", "Revenue"],
	);
	assert.deepEqual(measuresReferenced("SUM(REVENUE)"), []);
});

test("a statement with no definition reads as empty rather than throwing", () => {
	const empty = parseMetricViewCalculations("CREATE TABLE t (a INT)");
	assert.equal(empty.fields.size, 0);
	assert.equal(empty.source, null);
});
