import assert from "node:assert/strict";
import { test } from "node:test";
import {
	allThemes,
	builtinThemes,
	parseCustomThemes,
	seriesCount,
	themeTokens,
} from "./themes";

const valid = {
	id: "brand",
	name: "Brand",
	accent: "#123456",
	chart: ["#111111", "#222222"],
};

test("every built-in theme gives every series a colour", () => {
	for (const theme of builtinThemes) {
		assert.equal(theme.chart.length, seriesCount, theme.id);
	}
});

test("a short list of colours repeats across the series", () => {
	const tokens = themeTokens(valid);
	assert.equal(tokens["--chart-1"], "#111111");
	assert.equal(tokens["--chart-2"], "#222222");
	assert.equal(tokens["--chart-3"], "#111111");
	assert.equal(tokens["--chart-8"], "#222222");
	assert.equal(tokens["--brand"], "#123456");
});

test("stored themes are read back", () => {
	assert.deepEqual(parseCustomThemes(JSON.stringify([valid])), [valid]);
});

test("malformed stored themes are dropped rather than applied", () => {
	assert.deepEqual(parseCustomThemes(""), []);
	assert.deepEqual(parseCustomThemes("not json"), []);
	assert.deepEqual(parseCustomThemes(JSON.stringify({ a: 1 })), []);
	assert.deepEqual(
		parseCustomThemes(
			JSON.stringify([
				{ ...valid, accent: "red" },
				{ ...valid, name: " " },
				{ ...valid, chart: ["nope"] },
			]),
		),
		[],
	);
});

test("an administrator's theme replaces a built-in with the same id", () => {
	const custom = { ...valid, id: "ocean" };
	const themes = allThemes([custom]);
	assert.equal(themes.filter((t) => t.id === "ocean").length, 1);
	assert.equal(themes.find((t) => t.id === "ocean")?.accent, "#123456");
});
