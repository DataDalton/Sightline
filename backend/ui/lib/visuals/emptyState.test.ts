import assert from "node:assert/strict";
import { test } from "node:test";
import { describeFilters, missingFieldIn } from "./emptyState";

const names: Record<string, string> = {
	region: "Region",
	order_date: "Order date",
	amount: "Amount",
};
const nameOf = (field: string) => names[field] ?? field;

// --- Filters -----------------------------------------------------------------

test("a value filter reads as the field and its values", () => {
	assert.deepEqual(
		describeFilters(
			[{ field: "region", op: "eq", values: ["North", "South"] }],
			nameOf,
		),
		["Region: North or South"],
	);
});

test("many values are counted rather than listed", () => {
	assert.deepEqual(
		describeFilters(
			[{ field: "region", op: "eq", values: ["a", "b", "c", "d"] }],
			nameOf,
		),
		["Region: 4 selected"],
	);
});

test("a date range reads as one span with readable dates", () => {
	const [line] = describeFilters(
		[
			{ field: "order_date", op: "gte", value: "2026-01-01" },
			{ field: "order_date", op: "lte", value: "2026-03-31" },
		],
		nameOf,
	);
	assert.match(line, /^Order date: .+ to .+$/);
	assert.ok(!line.includes("2026-01-01"), "dates are formatted");
});

test("a one sided bound says which side", () => {
	assert.deepEqual(
		describeFilters([{ field: "amount", op: "gte", value: "500" }], nameOf),
		["Amount: at least 500"],
	);
	assert.deepEqual(
		describeFilters([{ field: "amount", op: "lt", value: "10" }], nameOf),
		["Amount: below 10"],
	);
});

test("an excluded value and a blank read as such", () => {
	assert.deepEqual(
		describeFilters(
			[
				{ field: "region", op: "eq", values: ["North"], negate: true },
				{ field: "amount", op: "is_empty" },
			],
			nameOf,
		),
		["Region: not North", "Amount: blank"],
	);
});

test("a field without a display name falls back to its own name", () => {
	assert.deepEqual(
		describeFilters([{ field: "channel", op: "eq", value: "Online" }]),
		["channel: Online"],
	);
});

test("anything that is not a clause is ignored", () => {
	assert.deepEqual(describeFilters([null, 3, { op: "eq" }], nameOf), []);
});

// --- Missing fields ----------------------------------------------------------

test("a quoted field name is read out of the message", () => {
	assert.equal(
		missingFieldIn('Field "net_margin" no longer exists on source "sales"'),
		"net_margin",
	);
});

test("an unquoted field name is read after the word field", () => {
	assert.equal(
		missingFieldIn("The measure net_margin no longer exists"),
		"net_margin",
	);
});

test("a message naming no field gives an empty name", () => {
	assert.equal(missingFieldIn("A field no longer exists"), "");
});

test("any other failure is not a missing field", () => {
	assert.equal(missingFieldIn("Query failed (500)"), null);
	assert.equal(missingFieldIn(undefined), null);
});
