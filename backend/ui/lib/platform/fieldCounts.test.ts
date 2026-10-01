import { test } from "node:test";
import assert from "node:assert/strict";
import { countsBySource, mergeCounts, type FieldMention } from "./fieldCounts";

const keyOf = (sourceKey: string, field: string) => `${sourceKey}/${field}`;

const mentions: FieldMention[] = [
	{ sourceKey: "sales", field: "amount", kind: "visual", id: "v1" },
	// The same visual naming the same field twice counts once.
	{ sourceKey: "sales", field: "amount", kind: "visual", id: "v1" },
	{ sourceKey: "sales", field: "amount", kind: "alert", id: "a1" },
	{ sourceKey: "sales", field: "region", kind: "visual", id: "v1" },
	{ sourceKey: "stock", field: "units", kind: "sheet", id: "s1" },
];

test("splits counts by the source each field is on", () => {
	const bySource = countsBySource(mentions, ["sales", "stock"], keyOf);
	assert.deepEqual(
		[...(bySource.get("sales") ?? [])],
		[
			["sales/amount", 2],
			["sales/region", 1],
		],
	);
	assert.deepEqual([...(bySource.get("stock") ?? [])], [["stock/units", 1]]);
});

test("gives a source with no mentions an empty entry", () => {
	const bySource = countsBySource(mentions, ["empty"], keyOf);
	assert.equal(bySource.get("empty")?.size, 0);
	assert.equal(bySource.has("sales"), false);
});

test("per source counts add up to the counts of one walk", () => {
	const together = countsBySource(mentions, ["sales", "stock"], keyOf);
	const apart = mergeCounts([
		countsBySource(mentions, ["sales"], keyOf).get("sales")!,
		countsBySource(mentions, ["stock"], keyOf).get("stock")!,
	]);
	assert.deepEqual(
		apart,
		mergeCounts([together.get("sales")!, together.get("stock")!]),
	);
});
