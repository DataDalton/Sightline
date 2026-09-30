import assert from "node:assert/strict";
import { test } from "node:test";
import {
	detectRenames,
	nameSimilarity,
	normaliseExpression,
	scorePair,
	type FieldPrint,
} from "./renames";

// A rename offered wrongly points every report at a different figure, and one
// missed leaves them broken. These cover both directions.

const print = (over: Partial<FieldPrint> & { name: string }): FieldPrint => ({
	kind: "measure",
	dataType: "decimal(18,2)",
	comment: null,
	ordinal: null,
	expression: null,
	...over,
});

test("an identical metric view expression is enough on its own", () => {
	const found = detectRenames(
		[print({ name: "Net Sales", expression: "SUM(net_amount)" })],
		[print({ name: "Revenue", expression: "SUM(`net_amount`)" })],
	);
	assert.equal(found.length, 1);
	assert.equal(found[0].from, "Net Sales");
	assert.equal(found[0].to, "Revenue");
	assert.ok(found[0].reasons.includes("same calculation"));
});

test("a plain column keeps its comment, type and place through a rename", () => {
	const found = detectRenames(
		[
			print({
				name: "cust_region",
				kind: "dimension",
				dataType: "string",
				comment: "Sales region of the customer",
				ordinal: 4,
			}),
		],
		[
			print({
				name: "customer_region",
				kind: "dimension",
				dataType: "string",
				comment: "Sales region of the customer",
				ordinal: 4,
			}),
		],
	);
	assert.equal(found.length, 1);
	assert.equal(found[0].to, "customer_region");
});

test("a measure is never offered as a dimension", () => {
	const scored = scorePair(
		print({ name: "Units", expression: "SUM(units)" }),
		print({ name: "Units", kind: "dimension", expression: "SUM(units)" }),
	);
	assert.equal(scored.score, 0);
});

test("nothing is offered when only the type matches", () => {
	const found = detectRenames(
		[print({ name: "Freight" })],
		[print({ name: "Discount" })],
	);
	assert.deepEqual(found, []);
});

test("two equally good replacements offer neither", () => {
	const found = detectRenames(
		[print({ name: "Net Sales", expression: "SUM(net_amount)" })],
		[
			print({ name: "Revenue A", expression: "SUM(net_amount)" }),
			print({ name: "Revenue B", expression: "SUM(net_amount)" }),
		],
	);
	assert.deepEqual(found, []);
});

test("one new field is not offered for two old ones", () => {
	const found = detectRenames(
		[
			print({ name: "Sales One", expression: "SUM(x)" }),
			print({ name: "Sales Two", expression: "SUM(x)" }),
		],
		[print({ name: "Sales", expression: "SUM(x)" })],
	);
	assert.deepEqual(found, []);
});

test("each missing field is paired with its own replacement", () => {
	const found = detectRenames(
		[
			print({ name: "Gross", expression: "SUM(gross)" }),
			print({ name: "Net", expression: "SUM(net)" }),
		],
		[
			print({ name: "Net Amount", expression: "SUM(net)" }),
			print({ name: "Gross Amount", expression: "SUM(gross)" }),
		],
	);
	const pairs = Object.fromEntries(found.map((c) => [c.from, c.to]));
	assert.deepEqual(pairs, { Gross: "Gross Amount", Net: "Net Amount" });
});

test("an empty side offers nothing", () => {
	assert.deepEqual(detectRenames([], [print({ name: "A" })]), []);
	assert.deepEqual(detectRenames([print({ name: "A" })], []), []);
});

test("names compare without regard to case, spacing or underscores", () => {
	assert.equal(nameSimilarity("Net_Sales", "net sales"), 1);
	assert.ok(nameSimilarity("Region", "Sales Region") > 0.5);
	assert.equal(nameSimilarity("", "Region"), 0);
});

test("quoting and spacing do not change an expression", () => {
	assert.equal(
		normaliseExpression("SUM( `Net Amount` )"),
		normaliseExpression("sum( Net   Amount )"),
	);
	assert.equal(normaliseExpression("   "), null);
});
