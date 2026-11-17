import assert from "node:assert/strict";
import { test } from "node:test";
import {
	contrastOn,
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

test("text on the accent is white on a dark accent and dark on a light one", () => {
	assert.equal(contrastOn("#123456"), "#ffffff");
	assert.equal(contrastOn("#ffb500"), "#16181d");
	assert.equal(themeTokens(valid)["--brand-contrast"], "#ffffff");
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

// Relative luminance and the contrast ratio, as the accessibility guidelines
// define them.
function luminance(hex: string): number {
	const channel = (offset: number) => {
		const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928
			? value / 12.92
			: ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrastRatio(a: string, b: string): number {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}

// Distance between two colours as the eye judges it, in CIE Lab.
function lab(hex: string): [number, number, number] {
	const linear = (offset: number) => {
		const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.04045
			? value / 12.92
			: ((value + 0.055) / 1.055) ** 2.4;
	};
	const [r, g, b] = [linear(1), linear(3), linear(5)];
	const f = (t: number) =>
		t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
	const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
	const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
	const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
	return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function colourDistance(a: string, b: string): number {
	const [p, q] = [lab(a), lab(b)];
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

test("every built-in chart colour shows on the light and the dark ground", () => {
	for (const theme of builtinThemes) {
		for (const colour of theme.chart) {
			assert.ok(
				contrastRatio(colour, "#ffffff") >= 2,
				`${theme.id} ${colour} is faint on light`,
			);
			assert.ok(
				contrastRatio(colour, "#1a1d22") >= 2,
				`${theme.id} ${colour} is faint on dark`,
			);
		}
	}
});

test("the colours within a built-in theme can be told apart", () => {
	for (const theme of builtinThemes) {
		theme.chart.forEach((a, i) => {
			for (const b of theme.chart.slice(i + 1)) {
				assert.ok(
					colourDistance(a, b) >= 9,
					`${theme.id} ${a} and ${b} are too alike`,
				);
			}
		});
	}
});

test("built-in theme ids are unique", () => {
	const ids = builtinThemes.map((theme) => theme.id);
	assert.equal(new Set(ids).size, ids.length);
});
