import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clampCheckSeconds,
	commitsSinceSeen,
	describeInterval,
	isDataChange,
	readHistory,
	toHistory,
} from "./history";

test("writes and merges change data, housekeeping does not", () => {
	for (const op of [
		"WRITE",
		"MERGE",
		"DELETE",
		"STREAMING UPDATE",
		"TRUNCATE",
	]) {
		assert.equal(isDataChange(op), true, op);
	}
	for (const op of [
		"OPTIMIZE",
		"VACUUM END",
		"SET TBLPROPERTIES",
		"CHANGE COLUMN",
	]) {
		assert.equal(isDataChange(op), false, op);
	}
	// An operation nobody listed refreshes rather than leaving old figures.
	assert.equal(isDataChange("SOMETHING NEW"), true);
});

test("the first look learns the version without calling it a change", () => {
	const entries = toHistory([
		{
			version: "12",
			operation: "WRITE",
			timestamp: "2026-09-01T10:00:00Z",
		},
		{ version: 11, operation: "MERGE", timestamp: "2026-09-01T09:00:00Z" },
	]);
	const read = readHistory(entries, null);
	assert.equal(read.changed, false);
	assert.equal(read.latest?.version, 12);
});

test("a later data commit is a change, a later property commit is not", () => {
	const entries = toHistory([
		{ version: 14, operation: "SET TBLPROPERTIES" },
		{ version: 13, operation: "OPTIMIZE" },
		{ version: 12, operation: "WRITE" },
	]);
	assert.equal(
		readHistory(entries, { version: 12, timestamp: null }).changed,
		false,
	);
	assert.equal(
		readHistory(entries, { version: 11, timestamp: null }).changed,
		true,
	);
});

test("a table dropped and made again is a change, whatever its version", () => {
	const recreated = toHistory([
		{ version: 1, operation: "WRITE", timestamp: "2026-09-02T10:00:00Z" },
		{
			version: 0,
			operation: "CREATE TABLE",
			timestamp: "2026-09-02T09:59:00Z",
		},
	]);
	// Version 401 last time, version 1 now.
	assert.equal(
		readHistory(recreated, {
			version: 401,
			timestamp: Date.parse("2026-09-01T10:00:00Z"),
		}).changed,
		true,
	);
	// The same version number as last time, made at a different time.
	assert.equal(
		readHistory(recreated, {
			version: 1,
			timestamp: Date.parse("2026-08-01T10:00:00Z"),
		}).changed,
		true,
	);
	// The same version at the same time is the same table, unchanged.
	assert.equal(
		readHistory(recreated, {
			version: 1,
			timestamp: Date.parse("2026-09-02T10:00:00Z"),
		}).changed,
		false,
	);
});

test("commits the page of history did not reach count as a change", () => {
	// Only the newest page is read. Version 10 was seen last time, and 11 to
	// 19 fell outside what was read now.
	const page = toHistory([
		{ version: 21, operation: "OPTIMIZE" },
		{ version: 20, operation: "SET TBLPROPERTIES" },
	]);
	assert.equal(
		readHistory(page, { version: 10, timestamp: null }).changed,
		true,
	);
	assert.equal(
		readHistory(page, { version: 19, timestamp: null }).changed,
		false,
	);
});

test("intervals are held to a minute at least and a week at most", () => {
	assert.equal(clampCheckSeconds(5), 60);
	assert.equal(clampCheckSeconds(10 * 24 * 3600), 7 * 24 * 3600);
	assert.equal(clampCheckSeconds(0), 0);
	assert.equal(describeInterval(1800), "Every 30 minutes");
	assert.equal(describeInterval(2 * 3600), "Every 2 hours");
	assert.equal(describeInterval(45 * 60), "Every 45 minutes");
});

test("a load hidden behind housekeeping commits is read back to", () => {
	// A load at version 101, then a comment set on each of many columns.
	const page = Array.from({ length: 25 }, (_, i) => ({
		version: 180 - i,
		operation: "CHANGE COLUMN",
		timestamp: 1_000 + (180 - i),
	}));
	const seen = { version: 100, timestamp: 900 };
	assert.equal(readHistory(page, seen).changed, true);
	assert.equal(commitsSinceSeen(page, seen), 80);
});

test("a page that reaches the version last seen needs nothing more", () => {
	const page = [
		{ version: 103, operation: "CHANGE COLUMN", timestamp: 3 },
		{ version: 102, operation: "WRITE", timestamp: 2 },
		{ version: 101, operation: "SET TBLPROPERTIES", timestamp: 1 },
	];
	assert.equal(commitsSinceSeen(page, { version: 100, timestamp: 0 }), null);
	assert.equal(commitsSinceSeen(page, null), null);
	assert.equal(commitsSinceSeen(page, { version: 103, timestamp: 3 }), null);
});
