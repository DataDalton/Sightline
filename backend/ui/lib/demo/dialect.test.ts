import assert from "node:assert/strict";
import { test } from "node:test";
import { toPostgres } from "./dialect";

test("backtick identifiers become double quoted", () => {
	assert.equal(
		toPostgres("SELECT `Order Date`, `a``b` FROM t").text,
		'SELECT "Order Date", "a`b" FROM t',
	);
});

test("named markers become numbered ones and a repeat reuses its number", () => {
	const { text, values } = toPostgres(
		"SELECT * FROM t WHERE a = :f0 AND b IN (:f1_0, :f0)",
		{ f0: "x", f1_0: 2 },
	);
	assert.equal(text, "SELECT * FROM t WHERE a = $1 AND b IN ($2, $1)");
	assert.deepEqual(values, ["x", 2]);
});

test("casts, strings and unknown names are left alone", () => {
	const { text, values } = toPostgres(
		"SELECT '{}'::jsonb, 'a :f0 b', \"x:f0\", :other FROM t WHERE c = :f0",
		{ f0: 1 },
	);
	assert.equal(
		text,
		"SELECT '{}'::jsonb, 'a :f0 b', \"x:f0\", :other FROM t WHERE c = $1",
	);
	assert.deepEqual(values, [1]);
});

test("an escaped quote does not end a string", () => {
	assert.equal(
		toPostgres("SELECT 'it''s :f0' AS s, :f0", { f0: 1 }).text,
		"SELECT 'it''s :f0' AS s, $1",
	);
});

test("null safe equality and generated bins are rewritten", () => {
	assert.equal(
		toPostgres("SELECT 1 FROM q JOIN d ON d.`a` <=> q.`a`").text,
		'SELECT 1 FROM q JOIN d ON d."a" IS NOT DISTINCT FROM q."a"',
	);
	assert.equal(
		toPostgres("SELECT explode(sequence(1, 30)) AS `__bucket`").text,
		'SELECT generate_series(1, 30) AS "__bucket"',
	);
});
