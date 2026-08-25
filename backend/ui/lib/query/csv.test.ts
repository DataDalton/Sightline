import assert from "node:assert/strict";
import { test } from "node:test";
import { byteOrderMark, csvHeader, csvRows, escapeCell } from "./csv";
import { maxExportRows } from "./exportLimits";
import { maxLimit } from "./spec";

// The encoder is written in batches and read back as one document, so the
// property that matters is not "each batch is valid" but "the batches
// concatenate into one valid file". A separator-joined batch passes the first
// test and fails the second, which is the bug worth pinning down.

test("a batch ends with a terminator, so two of them do not run together", () => {
	const columns = ["region", "revenue"];
	const first = csvRows(columns, [{ region: "North", revenue: 1 }]);
	const second = csvRows(columns, [{ region: "South", revenue: 2 }]);

	const document = csvHeader(columns) + first + second;
	const lines = document.split("\r\n").filter((l) => l !== "");

	assert.equal(lines.length, 3);
	assert.equal(lines[1], "North,1");
	assert.equal(lines[2], "South,2");
});

test("the document opens with the mark that makes Excel read it as text", () => {
	const document = csvHeader(["name"]);
	assert.ok(document.startsWith(byteOrderMark));
	assert.equal(document, `${byteOrderMark}name\r\n`);
});

test("an empty batch contributes nothing rather than a blank line", () => {
	assert.equal(csvRows(["a"], []), "");
});

test("a delimiter inside a value does not become a new column", () => {
	const encoded = csvRows(["name"], [{ name: "Smith, Jane" }]);
	assert.equal(encoded, '"Smith, Jane"\r\n');
});

test("a quote inside a value is doubled rather than ending the field", () => {
	assert.equal(escapeCell('He said "no"'), '"He said ""no"""');
});

test("a newline inside a value does not become a new row", () => {
	const encoded = csvRows(["note"], [{ note: "line one\nline two" }]);
	// One row, because the value is quoted, and the terminator is outside it.
	assert.ok(encoded.endsWith("\r\n"));
	assert.equal(encoded, '"line one\nline two"\r\n');
});

test("an absent value is empty rather than the word undefined", () => {
	assert.equal(escapeCell(undefined), "");
	assert.equal(escapeCell(null), "");
	assert.equal(csvRows(["a", "b"], [{ a: 1 }]), "1,\r\n");
});

test("a value is written under the column asked for, not the one it sorts to", () => {
	// Column order is the caller's, and a row is an unordered object. Reading
	// the row in its own key order would silently transpose a file.
	const encoded = csvRows(
		["revenue", "region"],
		[{ region: "North", revenue: 10 }],
	);
	assert.equal(encoded, "10,North\r\n");
});

test("a zero survives, since it is a figure and not an absence", () => {
	assert.equal(escapeCell(0), "0");
	assert.equal(escapeCell(false), "false");
});

// The export asks for one row past its ceiling so it can tell a result that
// stopped on its own from one that was cut short. The request guard has to
// allow that, or the extra row is clipped away and every full export reports
// itself as complete.
test("the request guard allows the row the export uses to detect truncation", () => {
	assert.ok(
		maxLimit >= maxExportRows,
		`maxLimit ${maxLimit} is below the export ceiling ${maxExportRows}`,
	);
});
