import assert from "node:assert/strict";
import { test } from "node:test";
import { decideProtection } from "./protection";

// A source wrongly marked unfiltered hands one reader's rows to the next, so
// the cases below pin down that detection can only ever add protection unless
// it has read everything and found nothing.

const off = { hasRowFilter: false, hasColumnMask: false };
const on = { hasRowFilter: true, hasColumnMask: false };

test("a row filter found turns protection on", () => {
	const decision = decideProtection(off, false, {
		rowFilter: true,
		columnMask: false,
		complete: true,
	});
	assert.deepEqual(decision.next, on);
	assert.equal(decision.turnedOn, true);
	assert.equal(decision.changed, true);
});

test("a column mask alone turns protection on and records the mask", () => {
	const decision = decideProtection(off, false, {
		rowFilter: false,
		columnMask: true,
		complete: false,
	});
	assert.deepEqual(decision.next, {
		hasRowFilter: true,
		hasColumnMask: true,
	});
	assert.equal(decision.turnedOn, true);
});

test("a filter found on a partial read still turns protection on", () => {
	const decision = decideProtection(off, false, {
		rowFilter: true,
		columnMask: false,
		complete: false,
	});
	assert.equal(decision.next.hasRowFilter, true);
});

test("a failed detection leaves the flags as they were", () => {
	for (const current of [off, on]) {
		const decision = decideProtection(current, false, null);
		assert.deepEqual(decision.next, current);
		assert.equal(decision.changed, false);
		assert.equal(decision.turnedOn, false);
	}
});

test("finding nothing on a partial read does not turn protection off", () => {
	const decision = decideProtection(
		{ hasRowFilter: true, hasColumnMask: true },
		false,
		{ rowFilter: false, columnMask: false, complete: false },
	);
	assert.deepEqual(decision.next, {
		hasRowFilter: true,
		hasColumnMask: true,
	});
	assert.equal(decision.changed, false);
});

test("a complete read that finds nothing turns protection off", () => {
	const decision = decideProtection(
		{ hasRowFilter: true, hasColumnMask: true },
		false,
		{ rowFilter: false, columnMask: false, complete: true },
	);
	assert.deepEqual(decision.next, off);
	assert.equal(decision.turnedOn, false);
	assert.equal(decision.changed, true);
});

test("protection asked for by hand survives a complete read of nothing", () => {
	const decision = decideProtection(on, true, {
		rowFilter: false,
		columnMask: false,
		complete: true,
	});
	assert.equal(decision.next.hasRowFilter, true);
	assert.equal(decision.changed, false);
});

test("protection asked for by hand is applied even without a detection", () => {
	const decision = decideProtection(off, true, null);
	assert.equal(decision.next.hasRowFilter, true);
	assert.equal(decision.turnedOn, true);
});

test("a complete read clears a mask that is gone but keeps the filter", () => {
	const decision = decideProtection(
		{ hasRowFilter: true, hasColumnMask: true },
		false,
		{ rowFilter: true, columnMask: false, complete: true },
	);
	assert.deepEqual(decision.next, on);
});
