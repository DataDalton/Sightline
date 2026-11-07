import { test } from "node:test";
import assert from "node:assert/strict";
import { pageSourceKeys, pdfMayDrawWhileAway } from "./pdfSources";

const visual = (visualType: string, sourceKey: string | null) => ({
	visualType,
	sourceKey,
});

test("a page's sources leave out what is not drawn on paper", () => {
	assert.deepEqual(
		pageSourceKeys(
			{
				sourceKey: "pageSource",
				visuals: [
					visual("barChart", "sales"),
					visual("barChart", "sales"),
					visual("lineChart", null),
					visual("navLinks", "links"),
				],
			},
			"reportSource",
		).sort(),
		["pageSource", "sales"],
	);
});

const open = {
	pageSources: ["sales"],
	confirmedSources: ["sales"],
	unattended: ["sales"],
	restrictable: [],
	recorded: [],
};

test("a PDF is drawn when each source shows everybody the same rows", () => {
	assert.equal(pdfMayDrawWhileAway(open), true);
});

test("a source added since the owner was last here makes the PDF wait", () => {
	assert.equal(
		pdfMayDrawWhileAway({
			...open,
			pageSources: ["sales", "people"],
			unattended: ["sales", "people"],
		}),
		false,
	);
});

test("a row-filtered source needs a recording of what the owner sees", () => {
	const filtered = {
		...open,
		unattended: [],
		restrictable: ["sales"],
	};
	assert.equal(pdfMayDrawWhileAway(filtered), false);
	assert.equal(
		pdfMayDrawWhileAway({ ...filtered, recorded: ["sales"] }),
		true,
	);
});

test("a source that can neither be shared nor narrowed makes the PDF wait", () => {
	assert.equal(pdfMayDrawWhileAway({ ...open, unattended: [] }), false);
});
