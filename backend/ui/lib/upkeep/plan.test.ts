import { test } from "node:test";
import assert from "node:assert/strict";
import {
	actionKey,
	autoRenameConfidence,
	planFromAbout,
	planFromSync,
} from "./plan";

test("an update's subject becomes one action per change", () => {
	const actions = planFromAbout([
		{
			kind: "field",
			id: "Sales Region",
			sourceKey: "orders",
			change: "renamed",
			from: "Region",
		},
		{
			kind: "field",
			id: "Channel",
			sourceKey: "orders",
			change: "removed",
		},
		{ kind: "field", id: "Discount", sourceKey: "orders", change: "added" },
		{
			kind: "field",
			id: "Revenue",
			sourceKey: "orders",
			change: "changed",
		},
		{ kind: "source", id: "returns", change: "added" },
		{ kind: "page", id: "p1", change: "added" },
		// No change named, or no source for a field: nothing to act on.
		{ kind: "field", id: "Margin", sourceKey: "orders" },
		{ kind: "field", id: "Cost", change: "removed" },
		{ kind: "report", id: "r1", change: "added" },
	]);
	assert.deepEqual(actions.map(actionKey), [
		"rename:orders:Region:Sales Region",
		"remove:orders:Channel",
		"newField:orders:Discount",
		"definition:orders:Revenue",
		"newSource:returns",
		"pageAdded:p1",
	]);
});

test("a rename without its old name, or onto itself, is not acted on", () => {
	assert.deepEqual(
		planFromAbout([
			{
				kind: "field",
				id: "Region",
				sourceKey: "orders",
				change: "renamed",
			},
			{
				kind: "field",
				id: "Region",
				sourceKey: "orders",
				change: "renamed",
				from: "Region",
			},
		]),
		[],
	);
});

test("the same change told twice is one action", () => {
	const item = {
		kind: "field",
		id: "Channel",
		sourceKey: "orders",
		change: "removed",
	};
	assert.equal(planFromAbout([item, item]).length, 1);
});

test("a sync's likely rename is followed only when the evidence is strong", () => {
	const actions = planFromSync({
		sourceKey: "orders",
		added: ["Sales Region", "Area", "Discount"],
		renames: [
			{
				from: "Region",
				to: "Sales Region",
				confidence: autoRenameConfidence,
			},
			{
				from: "Zone",
				to: "Area",
				confidence: autoRenameConfidence - 0.1,
			},
		],
		redefined: [{ name: "Revenue" }],
	});
	assert.deepEqual(actions.map(actionKey), [
		"rename:orders:Region:Sales Region",
		// A weak match is treated as what the sync saw, a field arriving.
		"newField:orders:Area",
		"newField:orders:Discount",
		"definition:orders:Revenue",
	]);
});
