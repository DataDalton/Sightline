import assert from "node:assert/strict";
import { test } from "node:test";
import { addsUp, breakdown, rankBreakdowns } from "./drivers";

const current = [
	{ Region: "Europe", Revenue: 300 },
	{ Region: "Asia", Revenue: 200 },
	{ Region: "Americas", Revenue: 500 },
];
const previous = [
	{ Region: "Europe", Revenue: 700 },
	{ Region: "Asia", Revenue: 190 },
	{ Region: "Americas", Revenue: 510 },
];

test("a figure that adds up splits its change exactly between its parts", () => {
	assert.equal(addsUp(1000, current, "Revenue"), true);
	const split = breakdown("Region", current, previous, "Revenue", -400, true);
	assert.equal(split.members[0].value, "Europe");
	assert.equal(split.members[0].change, -400);
	assert.equal(split.members[0].share, 1);
	const total = split.members.reduce((acc, m) => acc + m.change, 0);
	assert.equal(total, -400);
	assert.equal(split.strength, 1);
});

test("a part that is new or gone moved from or to nothing", () => {
	const split = breakdown(
		"Channel",
		[
			{ Channel: "Online", Revenue: 50 },
			{ Channel: "Retail", Revenue: 10 },
		],
		[
			{ Channel: "Retail", Revenue: 30 },
			{ Channel: "Wholesale", Revenue: 40 },
		],
		"Revenue",
		-10,
		true,
	);
	const online = split.members.find((m) => m.value === "Online");
	const wholesale = split.members.find((m) => m.value === "Wholesale");
	assert.equal(online?.change, 50);
	assert.equal(online?.previous, null);
	assert.equal(wholesale?.change, -40);
});

test("a rate does not add up, so its parts carry no share of the whole", () => {
	const rates = [
		{ Region: "Europe", Margin: 30 },
		{ Region: "Asia", Margin: 40 },
	];
	assert.equal(addsUp(35, rates, "Margin"), false);
	const split = breakdown(
		"Region",
		rates,
		[
			{ Region: "Europe", Margin: 36 },
			{ Region: "Asia", Margin: 41 },
		],
		"Margin",
		-4,
		false,
	);
	assert.equal(split.members[0].value, "Europe");
	assert.equal(split.members[0].share, null);
});

test("only the biggest movers are listed, and the rest are summed", () => {
	const many = Array.from({ length: 9 }, (_, i) => ({ P: `p${i}`, V: i }));
	const split = breakdown(
		"P",
		many,
		many.map((r) => ({ ...r, V: 0 })),
		"V",
		36,
		true,
	);
	assert.equal(split.members.length, 5);
	assert.equal(split.othersCount, 4);
	assert.equal(split.othersChange, 0 + 1 + 2 + 3);
});

test("the dimension where one part carries the change ranks first", () => {
	const concentrated = breakdown(
		"Region",
		current,
		previous,
		"Revenue",
		-400,
		true,
	);
	const spread = breakdown(
		"Channel",
		[
			{ Channel: "A", Revenue: 500 },
			{ Channel: "B", Revenue: 500 },
		],
		[
			{ Channel: "A", Revenue: 700 },
			{ Channel: "B", Revenue: 700 },
		],
		"Revenue",
		-400,
		true,
	);
	const single = breakdown(
		"Country",
		[{ Country: "X", Revenue: 1000 }],
		[{ Country: "X", Revenue: 1400 }],
		"Revenue",
		-400,
		true,
	);
	const ranked = rankBreakdowns([spread, single, concentrated]);
	assert.deepEqual(
		ranked.map((b) => b.dimension),
		["Region", "Channel"],
	);
});
