import { test } from "node:test";
import assert from "node:assert/strict";
import {
	groupByQuery,
	QueryMemo,
	queryScope,
	sharedQueryKey,
	stableJson,
} from "./shared";

const statement =
	"SELECT sum(revenue) AS revenue FROM sales WHERE region = :p0";

test("the app without a restriction is one scope for everybody", () => {
	assert.equal(queryScope({ app: true }), queryScope({ app: true }));
	assert.equal(queryScope({ app: true }, undefined), "app");
});

test("an owner's token is a scope of its own", () => {
	const a = queryScope({ app: false, ownerEmail: "a@example.com" });
	const b = queryScope({ app: false, ownerEmail: "b@example.com" });
	assert.notEqual(a, b);
	assert.notEqual(a, queryScope({ app: true }));
	assert.equal(
		a,
		queryScope({ app: false, ownerEmail: "A@Example.com" }),
		"the address is compared without case",
	);
});

test("restrictions share only when they are the same", () => {
	const north = { fields: ["region"], tuples: [["North"]] };
	const south = { fields: ["region"], tuples: [["South"]] };
	const both = { fields: ["region"], tuples: [["North"], ["South"]] };
	const app = { app: true } as const;
	assert.equal(
		queryScope(app, north),
		queryScope(app, { fields: ["region"], tuples: [["North"]] }),
	);
	assert.notEqual(queryScope(app, north), queryScope(app, south));
	assert.notEqual(queryScope(app, north), queryScope(app, both));
	assert.notEqual(queryScope(app, north), queryScope(app));
});

test("the same query under different scopes never shares a key", () => {
	const params = { p0: "North" };
	const keys = new Set([
		sharedQueryKey(queryScope({ app: true }), statement, params),
		sharedQueryKey(
			queryScope({ app: false, ownerEmail: "a@example.com" }),
			statement,
			params,
		),
		sharedQueryKey(
			queryScope({ app: true }, { fields: ["region"], tuples: [["N"]] }),
			statement,
			params,
		),
	]);
	assert.equal(keys.size, 3);
});

test("parameters match whatever order they were built in", () => {
	assert.equal(
		sharedQueryKey("app", statement, { p0: "North", p1: 2 }),
		sharedQueryKey("app", statement, { p1: 2, p0: "North" }),
	);
	assert.notEqual(
		sharedQueryKey("app", statement, { p0: "North" }),
		sharedQueryKey("app", statement, { p0: "South" }),
	);
	assert.notEqual(
		sharedQueryKey("app", statement, { p0: "1" }),
		sharedQueryKey("app", statement, { p0: 1 }),
		"a number and its text are different parameters",
	);
	assert.equal(
		stableJson({ b: [1, { d: 1, c: 2 }], a: null }),
		stableJson({ a: null, b: [1, { c: 2, d: 1 }] }),
	);
});

test("grouping keeps the first order each key was seen in", () => {
	const alerts = [
		{ id: 1, key: "x" },
		{ id: 2, key: "y" },
		{ id: 3, key: "x" },
	];
	const groups = groupByQuery(alerts, (a) => a.key);
	assert.deepEqual([...groups.keys()], ["x", "y"]);
	assert.deepEqual(
		groups.get("x")?.map((a) => a.id),
		[1, 3],
	);
});

test("a batch reads each distinct question once and fans the rows out", async () => {
	const memo = new QueryMemo();
	const calls: string[] = [];
	const run = async (sql: string, params: Record<string, unknown>) => {
		calls.push(`${sql}|${JSON.stringify(params)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
		return [{ revenue: 10 }];
	};
	const app = memo.runner(queryScope({ app: true }), run);
	const owner = memo.runner(
		queryScope({ app: false, ownerEmail: "a@example.com" }),
		run,
	);

	// Asked at the same time, as the workers do.
	const answers = await Promise.all([
		app(statement, { p0: "North" }),
		app(statement, { p0: "North" }),
		app(statement, { p0: "South" }),
		owner(statement, { p0: "North" }),
		owner(statement, { p0: "North" }),
	]);
	assert.equal(calls.length, 3);
	assert.equal(memo.reads, 3);
	for (const rows of answers) assert.deepEqual(rows, [{ revenue: 10 }]);
	assert.equal(answers[0], answers[1], "the same rows are handed to both");
});

test("a failed read fails each check waiting on it", async () => {
	const memo = new QueryMemo();
	let calls = 0;
	const run = memo.runner("app", async () => {
		calls++;
		throw new Error("warehouse stopped");
	});
	const results = await Promise.allSettled([
		run(statement, {}),
		run(statement, {}),
	]);
	assert.equal(calls, 1);
	assert.ok(results.every((r) => r.status === "rejected"));
});

test("a seeded answer is used without a read", async () => {
	const memo = new QueryMemo();
	const key = sharedQueryKey("app", statement, {});
	memo.seed(key, [{ revenue: 5 }]);
	let calls = 0;
	const rows = await memo.read(key, async () => {
		calls++;
		return [];
	});
	assert.equal(calls, 0);
	assert.deepEqual(rows, [{ revenue: 5 }]);
});
