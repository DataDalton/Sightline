import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cutAtDateLine, withoutDateLineJumps } from "./worldGeo";

test("a ring that stays on one side is left alone", () => {
	const ring = [
		[0, 0],
		[10, 0],
		[10, 10],
		[0, 0],
	];
	assert.deepEqual(cutAtDateLine(ring), [ring]);
});

test("a ring crossing the date line becomes one closed piece per side", () => {
	const pieces = cutAtDateLine([
		[170, 0],
		[179, 0],
		[-179, 0],
		[-170, 0],
		[-170, 5],
		[-179, 5],
		[179, 5],
		[170, 5],
		[170, 0],
	]);
	assert.equal(pieces.length, 2);
	for (const piece of pieces) {
		assert.deepEqual(piece[0], piece[piece.length - 1]);
		for (let at = 1; at < piece.length; at += 1) {
			assert.ok(Math.abs(piece[at][0] - piece[at - 1][0]) <= 180);
		}
	}
});

test("no country in the boundaries file jumps across the map once cleaned", () => {
	const geo = JSON.parse(
		readFileSync(
			join(process.cwd(), "public", "geo", "world-countries.json"),
			"utf-8",
		),
	);
	const cleaned = withoutDateLineJumps(geo);
	for (const feature of cleaned.features) {
		for (const polygon of feature.geometry?.coordinates ?? []) {
			for (const ring of polygon) {
				for (let at = 1; at < ring.length; at += 1) {
					// Along the pole is the bottom edge of the map, not a band across it.
					const alongPole =
						Math.abs(ring[at][1]) === 90 &&
						Math.abs(ring[at - 1][1]) === 90;
					assert.ok(
						alongPole ||
							Math.abs(ring[at][0] - ring[at - 1][0]) <= 180,
						feature.properties?.name,
					);
				}
			}
		}
	}
});
