import { test } from "node:test";
import assert from "node:assert/strict";
import {
	missingHere,
	PackageError,
	packReport,
	readPackage,
	remapIds,
} from "./reportPackage";

const report = {
	title: "Sales",
	sourceKey: "orders",
	pages: [
		{
			title: "One",
			config: { marks: [{ visualId: "v1", text: "Look" }] },
			visuals: [
				{
					visualId: "v1",
					visualType: "barChart",
					title: "Revenue",
					config: {
						dimensions: ["Region"],
						measures: ["Revenue"],
						blockRef: { blockId: "b" },
					},
					layout: { x: 0, y: 0, w: 6, h: 4 },
				},
			],
		},
	],
};

test("a package drops links that only mean something here", () => {
	const pack = packReport(report);
	assert.equal(pack.pages[0].visuals[0].config.blockRef, undefined);
	assert.deepEqual(pack.pages[0].visuals[0].config.measures, ["Revenue"]);
});

test("a package reads back", () => {
	const pack = packReport(report);
	assert.deepEqual(readPackage(JSON.parse(JSON.stringify(pack))), pack);
});

test("anything else is refused with a reason", () => {
	assert.throws(() => readPackage(null), PackageError);
	assert.throws(() => readPackage({ pages: [] }), /format/);
	assert.throws(
		() => readPackage({ format: 99, title: "x", pages: [{}] }),
		/format 99/,
	);
	assert.throws(
		() => readPackage({ format: 1, title: "", pages: [{}] }),
		/no title/,
	);
});

test("what is missing here is named before anything is made", () => {
	const pack = packReport(report);
	assert.deepEqual(
		missingHere(
			pack,
			new Map([
				["orders", { dimensions: ["Region"], measures: ["Revenue"] }],
			]),
		),
		[],
	);
	assert.deepEqual(
		missingHere(
			pack,
			new Map([["orders", { dimensions: ["Region"], measures: [] }]]),
		),
		["orders has no field called Revenue here."],
	);
	assert.deepEqual(missingHere(pack, new Map()), [
		"The source orders is not registered here.",
	]);
});

test("placeholders are not mistaken for missing fields", () => {
	const pack = packReport({
		title: "x",
		sourceKey: "o",
		pages: [
			{
				title: "p",
				visuals: [
					{
						visualId: "v",
						visualType: "barChart",
						config: { dimensions: ["<selected>"] },
					},
				],
			},
		],
	});
	assert.deepEqual(
		missingHere(pack, new Map([["o", { dimensions: [], measures: [] }]])),
		[],
	);
});

test("ids inside a package are swapped wherever they appear", () => {
	assert.deepEqual(
		remapIds(
			{ marks: [{ visualId: "old", text: "old text" }], parent: "old" },
			new Map([["old", "new"]]),
		),
		{ marks: [{ visualId: "new", text: "old text" }], parent: "new" },
	);
});
