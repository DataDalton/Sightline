import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMetricViewFields } from "./metricViewDefinition";

// The kind split decides whether a field lands in a GROUP BY or in MEASURE().
// Getting it wrong changes what a query means rather than only how it looks,
// so the parse is pinned against the shapes a real definition uses.

const definition = `CREATE VIEW cat.views.sales (
  Order Date COMMENT 'Order Date'
)
WITH METRICS
LANGUAGE YAML
COMMENT 'Sales'
AS $$
version: 1.1

source: cat.raw.orders

joins:
  - name: dim_contract
    source: cat.raw.contracts
    on: orders.CONTRACT_ID = dim_contract.ID

comment: |-
  A long note about the view.

dimensions:
  - name: Order Date
    expr: ORDER_DATE
    comment: Order Date

  - name: Ordered UoM
    expr: SALES_UNIT
    comment: "The unit of measure the line was ordered in. Mentions - name: not a field"

measures:
  - name: Net Sales
    expr: SUM(EXTENDED_AMT)
    comment: "Sum of extended amount"

  - name: "Units In Eaches"
    expr: "SUM(QTY * CONVERSION)"
    comment: Volume restated in eaches
$$`;

test("reads the dimension and measure lists", () => {
	const parsed = parseMetricViewFields(definition);
	assert.deepEqual(parsed.dimensions, ["Order Date", "Ordered UoM"]);
	assert.deepEqual(parsed.measures, ["Net Sales", "Units In Eaches"]);
});

test("a join is not mistaken for a dimension", () => {
	const parsed = parseMetricViewFields(definition);
	assert.ok(!parsed.dimensions.includes("dim_contract"));
	assert.ok(!parsed.measures.includes("dim_contract"));
});

test("a quoted name loses its quotes", () => {
	const parsed = parseMetricViewFields(definition);
	assert.ok(parsed.measures.includes("Units In Eaches"));
	assert.ok(!parsed.measures.includes('"Units In Eaches"'));
});

test("a comment mentioning a list item does not become a field", () => {
	const parsed = parseMetricViewFields(definition);
	assert.equal(parsed.dimensions.length, 2);
});

test("a definition with no metrics body yields nothing rather than guessing", () => {
	const parsed = parseMetricViewFields("CREATE VIEW x AS SELECT 1");
	assert.deepEqual(parsed.dimensions, []);
	assert.deepEqual(parsed.measures, []);
});
