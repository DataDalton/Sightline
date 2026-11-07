import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyFix,
	examinePage,
	gradeFor,
	slowAfterMs,
	speedRanking,
	verySlowAfterMs,
	type DoctorVisual,
	reportGrade,
	untimedVisuals,
} from "./reportDoctor";

const bar = (extra: Partial<DoctorVisual> = {}): DoctorVisual => ({
	visualId: "v1",
	title: "Revenue",
	visualType: "barChart",
	config: { dimensions: ["Region"], measures: ["Revenue"] },
	...extra,
});
const keys = (visuals: DoctorVisual[], rest = {}) =>
	examinePage({ visuals, ...rest }).map((f) => f.key.split(":")[0]);

test("a clean page has nothing to say", () => {
	assert.deepEqual(keys([bar()]), []);
	assert.equal(gradeFor([]), "A");
});

test("a bar axis above zero is a problem with a fix", () => {
	const visual = bar({
		config: {
			dimensions: ["Region"],
			measures: ["Revenue"],
			style: { yAxis: { min: 50, max: 100 } },
		},
	});
	const [finding] = examinePage({ visuals: [visual] });
	assert.equal(finding.severity, "problem");
	const fixed = applyFix(visual, finding.fix!);
	assert.equal(fixed.config.style?.yAxis?.min, undefined);
	assert.equal(fixed.config.style?.yAxis?.max, 100);
	assert.deepEqual(keys([fixed]), []);
});

test("a line axis above zero is fine, since position rather than length is read", () => {
	assert.deepEqual(
		keys([
			bar({
				visualType: "lineChart",
				config: {
					dimensions: ["Month"],
					measures: ["Revenue"],
					style: { yAxis: { min: 50 } },
				},
			}),
		]),
		[],
	);
});

test("a pie with too many slices becomes a ranked bar", () => {
	const pie = bar({ visualType: "pieChart" });
	const timings = { v1: { warehouseMs: 100, rowCount: 20 } };
	const [finding] = examinePage({ visuals: [pie], timings });
	assert.equal(finding.key, "slices:v1");
	assert.equal(applyFix(pie, finding.fix!).visualType, "horizontalBarChart");
});

test("a pie is not judged until its rows are known", () => {
	assert.deepEqual(keys([bar({ visualType: "pieChart" })]), []);
});

test("too many bars suggests keeping the top, unless it already does", () => {
	const timings = { v1: { warehouseMs: 100, rowCount: 200 } };
	assert.deepEqual(keys([bar()], { timings }), ["categories"]);
	assert.deepEqual(
		keys(
			[
				bar({
					config: {
						dimensions: ["Region"],
						measures: ["Revenue"],
						options: { topN: 10 },
					},
				}),
			],
			{ timings },
		),
		[],
	);
});

test("slowness is graded from the timing", () => {
	const at = (warehouseMs: number) =>
		examinePage({
			visuals: [bar()],
			timings: { v1: { warehouseMs, rowCount: 5 } },
		});
	assert.deepEqual(at(slowAfterMs - 1), []);
	assert.equal(at(slowAfterMs)[0].severity, "suggestion");
	assert.equal(at(verySlowAfterMs)[0].severity, "problem");
});

test("nobody using a visual only counts with enough readers", () => {
	const unused = (pageReaders: number) =>
		keys([bar()], { usage: { pageReaders, visuals: {} } });
	assert.deepEqual(unused(3), []);
	assert.deepEqual(unused(40), ["unused"]);
	assert.deepEqual(
		keys([bar()], {
			usage: {
				pageReaders: 40,
				visuals: { v1: { actions: 2, readers: 1 } },
			},
		}),
		[],
	);
});

test("a filter is not judged as a visual", () => {
	assert.deepEqual(
		keys([bar({ title: null, visualType: "dropdownFilter" })], {
			usage: { pageReaders: 40, visuals: {} },
		}),
		[],
	);
});

test("an untitled chart and a crowded page are mentioned", () => {
	assert.deepEqual(keys([bar({ title: " " })]), ["title"]);
	const many = Array.from({ length: 13 }, (_, i) =>
		bar({ visualId: `v${i}` }),
	);
	assert.deepEqual(keys(many), ["crowded"]);
});

test("problems come first, and the grade falls with them", () => {
	const findings = examinePage({
		visuals: [
			bar({ title: "" }),
			bar({
				visualId: "v2",
				config: {
					dimensions: ["Region"],
					measures: ["Revenue"],
					style: { yAxis: { min: 5 } },
				},
			}),
		],
	});
	assert.equal(findings[0].severity, "problem");
	assert.equal(gradeFor(findings), "C");
});

test("the speed ranking is slowest first, with each share", () => {
	const ranked = speedRanking(
		[
			bar(),
			bar({ visualId: "v2", title: "Margin" }),
			bar({ visualId: "v3" }),
		],
		{
			v1: { warehouseMs: 100, rowCount: 1 },
			v2: { warehouseMs: 300, rowCount: 2 },
			v3: { warehouseMs: null, rowCount: null },
		},
	);
	assert.deepEqual(
		ranked.map((row) => [row.visualId, row.share]),
		[
			["v2", 75],
			["v1", 25],
		],
	);
});

test("a visual with a query and no timing leaves the page not fully checked", () => {
	const visuals = [
		{
			visualId: "a",
			title: "A",
			visualType: "barChart",
			config: { measures: ["Revenue"] },
		},
		{
			visualId: "b",
			title: "B",
			visualType: "textPanel",
			config: {},
		},
	];
	assert.equal(untimedVisuals(visuals, {}), 1);
	assert.equal(
		untimedVisuals(visuals, { a: { warehouseMs: 10, rowCount: 1 } }),
		0,
	);
});

test("a report is graded by its weakest page", () => {
	assert.equal(reportGrade(["A", "C", "B"]), "C");
	assert.equal(reportGrade([]), "A");
});
