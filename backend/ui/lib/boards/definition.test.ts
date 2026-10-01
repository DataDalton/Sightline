import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanDefinition, placeBelow } from "./definition";

const visual = {
	kind: "visual",
	id: "a",
	x: 10,
	y: 20,
	w: 500,
	h: 300,
	visual: {
		visualType: "lineChart",
		title: "Revenue",
		sourceKey: "sales",
		config: {
			dimensions: ["Order Date"],
			measures: ["Revenue"],
			filters: [{ field: "Region", op: "eq", value: "East" }],
		},
	},
	origin: {
		reportId: "00000000-0000-4000-8000-000000000001",
		slug: "rev",
		title: "Revenue",
	},
};

test("a board keeps what it can draw and drops the rest", () => {
	const board = cleanDefinition({
		items: [
			visual,
			{
				kind: "note",
				id: "b",
				x: 0,
				y: 0,
				text: "Look here",
				color: "purple",
			},
			{ kind: "chart", id: "c" },
			{ kind: "visual", id: "d", visual: { visualType: "barChart" } },
			{ kind: "text", id: "a", x: 1e9, y: -5, w: 5, h: 99999 },
		],
		links: [
			{ id: "l1", from: "a", to: "b" },
			{ id: "l2", from: "a", to: "b" },
			{ id: "l3", from: "a", to: "gone" },
			{ id: "l4", from: "b", to: "b" },
		],
	});
	assert.deepEqual(
		board.items.map((i) => i.kind),
		["visual", "note", "text"],
	);
	// An unknown colour is the default, a clashing id is made unique, and a
	// position or size past the board's reach is brought back within it.
	assert.equal(board.items[1].color, "yellow");
	assert.notEqual(board.items[2].id, "a");
	assert.equal(board.items[2].x, 100_000);
	assert.equal(board.items[2].w, 60);
	assert.equal(board.items[2].h, 3000);
	assert.deepEqual(
		board.items[0].visual?.config.filters,
		visual.visual.config.filters,
	);
	// One arrow each way between two items still on the board.
	assert.deepEqual(
		board.links.map((l) => [l.from, l.to]),
		[["a", "b"]],
	);
});

test("an arrow keeps its look and drops what is not one", () => {
	const board = cleanDefinition({
		items: [
			visual,
			{
				kind: "shape",
				id: "s",
				shape: "blob",
				style: { fill: "chartreuse", bold: true },
			},
		],
		links: [
			{
				id: "l",
				from: "a",
				to: "s",
				route: "curved",
				line: "dashed",
				flow: true,
				width: 99,
				color: "mauve",
			},
		],
	});
	assert.equal(board.items[1].shape, "rectangle");
	assert.deepEqual(board.items[1].style, { bold: true });
	assert.deepEqual(board.links[0], {
		id: "l",
		from: "a",
		to: "s",
		route: "curved",
		line: "dashed",
		width: 8,
		flow: true,
	});
});

test("an origin that is not a report address is not linked", () => {
	const board = cleanDefinition({
		items: [
			{
				...visual,
				origin: { reportId: "x", slug: "../admin", title: "T" },
			},
		],
	});
	assert.deepEqual(board.items[0].origin, {
		reportId: null,
		slug: null,
		title: "T",
	});
});

test("items added from elsewhere go below what is there", () => {
	const board = cleanDefinition({ items: [visual] });
	assert.deepEqual(
		placeBelow(board, [
			{ w: 100, h: 50 },
			{ w: 100, h: 50 },
		]),
		[
			{ x: 10, y: 352 },
			{ x: 10, y: 434 },
		],
	);
	assert.deepEqual(placeBelow(cleanDefinition({}), [{ w: 1, h: 1 }]), [
		{ x: 0, y: 0 },
	]);
});
