import { test } from "node:test";
import assert from "node:assert/strict";
import { isCatalogRefusal } from "./catalogRefusal";

test("a catalogue refusing the caller is recognised by its SQLSTATE", () => {
	const error = Object.assign(new Error("Error running query"), {
		response: { sqlState: "42501" },
	});
	assert.equal(isCatalogRefusal(error), true);
});

test("a catalogue refusing the caller is recognised by its error class", () => {
	const error = new Error(
		"[INSUFFICIENT_PERMISSIONS] Insufficient privileges: Principal 'robot' does not have USE CATALOG on Catalog 'sales'.",
	);
	assert.equal(isCatalogRefusal(error), true);
	assert.equal(
		isCatalogRefusal(
			new Error("[PERMISSION_DENIED] User does not have USE SCHEMA."),
		),
		true,
	);
});

test("a warehouse failure is not a refusal", () => {
	assert.equal(isCatalogRefusal(new Error("socket hang up")), false);
	assert.equal(
		isCatalogRefusal(
			Object.assign(new Error("[TABLE_OR_VIEW_NOT_FOUND] missing"), {
				response: { sqlState: "42P01" },
			}),
		),
		false,
	);
	assert.equal(isCatalogRefusal(null), false);
	assert.equal(isCatalogRefusal("text"), false);
});
