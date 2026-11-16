import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyLabel, toLabel } from "./fieldLabel";

test("joining words are written as words, not capitals", () => {
	assert.equal(
		toLabel("revenue_on_web_order_1yr"),
		"Revenue on Web Order 1yr",
	);
	assert.equal(toLabel("total_units_as_sold_1yr"), "Total Units as Sold 1yr");
});

test("a label starting with a joining word capitalises it", () => {
	assert.equal(
		toLabel("no_charge_units_as_sold_1yr"),
		"No Charge Units as Sold 1yr",
	);
});

test("a short code is kept in capitals", () => {
	assert.equal(toLabel("order_id"), "Order ID");
	assert.equal(toLabel("sku_count"), "SKU Count");
});

test("ordinary short words and figures with units read as words", () => {
	assert.equal(toLabel("avg_order_value_30d"), "Avg Order Value 30d");
	assert.equal(toLabel("net_revenue_pct"), "Net Revenue Pct");
	assert.equal(toLabel("totalRevenue"), "Total Revenue");
});

test("the old label is recognised so it can be replaced", () => {
	assert.equal(
		legacyLabel("total_units_as_sold_1yr"),
		"Total Units AS Sold 1YR",
	);
	assert.notEqual(
		legacyLabel("total_units_as_sold_1yr"),
		toLabel("total_units_as_sold_1yr"),
	);
	assert.equal(legacyLabel("total_revenue"), toLabel("total_revenue"));
});

test("a column written in capitals reads as words", () => {
	assert.equal(toLabel("PRODUCT_KEY"), "Product Key");
	assert.equal(toLabel("OVERRIDE_STD_COST"), "Override Std Cost");
	assert.equal(toLabel("UP_FRONT_TAX"), "Up Front Tax");
	assert.equal(toLabel("SKU_ID"), "SKU ID");
});

test("codes with figures and one word names in capitals are kept", () => {
	assert.equal(toLabel("LEVEL_CODE_L2"), "Level Code L2");
	assert.equal(toLabel("SKUREF"), "SKUREF");
});

test("capitals beside ordinary words are kept as an initialism", () => {
	assert.equal(toLabel("ABCD_Contract_Number"), "ABCD Contract Number");
});
