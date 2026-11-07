import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import {
	axisFormat,
	chartWorkbook,
	chartXml,
	escapeXml,
	nativeChartFor,
} from "./nativeChart";
import { buildPresentation, PptxSlide } from "./presentation";
import { slidesForPage } from "./reportSlides";
import { crc32, zip } from "./zip";

// The named file out of a zip, by walking its central directory.
function unzip(file: Buffer): Map<string, string> {
	const out = new Map<string, string>();
	const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	let at = file.readUInt32LE(end + 16);
	const count = file.readUInt16LE(end + 10);
	for (let index = 0; index < count; index += 1) {
		const size = file.readUInt32LE(at + 20);
		const nameLength = file.readUInt16LE(at + 28);
		const local = file.readUInt32LE(at + 42);
		const name = file.toString("utf-8", at + 46, at + 46 + nameLength);
		const start = local + 30 + file.readUInt16LE(local + 26);
		out.set(
			name,
			inflateRawSync(file.subarray(start, start + size)).toString(
				"utf-8",
			),
		);
		at += 46 + nameLength;
	}
	return out;
}

test("the checksum is the standard one", () => {
	assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("a zip reads back", () => {
	const files = unzip(
		zip([
			{ name: "a/b.txt", data: "hello" },
			{ name: "c", data: "world" },
		]),
	);
	assert.equal(files.get("a/b.txt"), "hello");
	assert.equal(files.get("c"), "world");
});

test("text that would break the file is made safe", () => {
	assert.equal(escapeXml('a<b>&"c\u0001'), "a&lt;b&gt;&amp;&quot;c");
});

const rows = [
	{ Region: "West", Year: "2025", Revenue: 10 },
	{ Region: "West", Year: "2026", Revenue: 20 },
	{ Region: "East", Year: "2026", Revenue: 30 },
];

test("common charts become PowerPoint's own", () => {
	const one = nativeChartFor({
		visualType: "barChart",
		rows: rows.slice(1),
		dimensions: ["Region"],
		measures: ["Revenue"],
		hint: "currency",
	});
	assert.equal(one?.kind, "column");
	assert.deepEqual(one?.categories, ["West", "East"]);
	assert.deepEqual(one?.series[0].values, [20, 30]);
	assert.equal(one?.numberFormat, '"$"#,##0');
});

test("a second dimension becomes one series per value, with gaps kept", () => {
	const two = nativeChartFor({
		visualType: "barChart",
		rows,
		dimensions: ["Region", "Year"],
		measures: ["Revenue"],
	});
	assert.equal(two?.kind, "stackedColumn");
	assert.deepEqual(
		two?.series.map((s) => s.name),
		["2025", "2026"],
	);
	assert.deepEqual(two?.series[0].values, [10, null]);
});

test("what PowerPoint cannot draw the same way is left to be drawn as shapes", () => {
	const input = { rows, dimensions: ["Region"], measures: ["Revenue"] };
	assert.equal(nativeChartFor({ ...input, visualType: "sankeyChart" }), null);
	assert.equal(
		nativeChartFor({ ...input, visualType: "choroplethChart" }),
		null,
	);
	assert.equal(
		nativeChartFor({
			...input,
			visualType: "pieChart",
			measures: ["a", "b"],
		}),
		null,
	);
	assert.equal(
		nativeChartFor({ ...input, visualType: "barChart", rows: [] }),
		null,
	);
});

test("a chart's figures and its workbook agree", () => {
	const chart = nativeChartFor({
		visualType: "lineChart",
		rows: rows.slice(1),
		dimensions: ["Region"],
		measures: ["Revenue"],
	})!;
	const xml = chartXml(chart, ["FF0000"]);
	assert.ok(xml.includes("<c:lineChart>"));
	assert.ok(xml.includes("Sheet1!$B$2:$B$3"));
	assert.ok(xml.includes("<c:v>West</c:v>"));
	const sheet =
		unzip(chartWorkbook(chart)).get("xl/worksheets/sheet1.xml") ?? "";
	assert.ok(sheet.includes('<c r="B2"><v>20</v></c>'));
	assert.ok(sheet.includes("<t>East</t>"));
});

test("a file has every part PowerPoint needs, named consistently", () => {
	const slide = new PptxSlide("Sales & margin");
	slide.titleBox("Filtered", "#ea580c");
	slide.chart(
		0,
		0,
		100,
		100,
		{
			kind: "column",
			categories: ["A"],
			series: [{ name: "S", values: [1] }],
			numberFormat: "General",
		},
		["#ff0000"],
	);
	const files = unzip(
		buildPresentation({
			title: "T",
			author: "a@example.com",
			slides: [slide],
			accents: ["#ff0000"],
		}),
	);
	for (const part of [
		"[Content_Types].xml",
		"_rels/.rels",
		"ppt/presentation.xml",
		"ppt/slideMasters/slideMaster1.xml",
		"ppt/slideLayouts/slideLayout1.xml",
		"ppt/theme/theme1.xml",
		"ppt/slides/slide1.xml",
		"ppt/slides/_rels/slide1.xml.rels",
		"ppt/charts/chart1.xml",
		"ppt/charts/_rels/chart1.xml.rels",
	]) {
		assert.ok(files.has(part), part);
	}
	assert.ok(
		files.get("ppt/slides/slide1.xml")?.includes("Sales &amp; margin"),
	);
	assert.ok(
		files
			.get("[Content_Types].xml")
			?.includes('PartName="/ppt/charts/chart1.xml"'),
	);
	assert.ok(
		files
			.get("ppt/slides/_rels/slide1.xml.rels")
			?.includes("../charts/chart1.xml"),
	);
});

const theme = { accent: "#ea580c", colors: ["#ff0000", "#00ff00"] };
const visual = (top: number, height: number, text: string) => ({
	title: text,
	box: { left: 0, top, width: 500, height },
	body: { kind: "note" as const, text },
});

test("a page a little too tall is squeezed onto one slide", () => {
	const slides = slidesForPage(
		{
			title: "Page",
			subtitle: null,
			visuals: [visual(0, 400, "One"), visual(412, 200, "Two")],
		},
		theme,
	);
	assert.equal(slides.length, 1);
	assert.ok(slides[0].xml().includes("Two"));
});

test("a slide designed in the app stays one slide, with its words beside what it shows", () => {
	const slides = slidesForPage(
		{
			title: "Designed",
			subtitle: null,
			text: "Words",
			designed: true,
			textBeside: true,
			visuals: [visual(0, 3000, "One")],
		},
		theme,
	);
	assert.equal(slides.length, 1);
	assert.ok(slides[0].xml().includes("Words"));
});

test("a forecast continues the chart, as its own lines", () => {
	const chart = nativeChartFor({
		visualType: "lineChart",
		rows: [
			{ Day: "2026-01-01", Revenue: 1 },
			{ Day: "2026-01-02", Revenue: 2 },
		],
		dimensions: ["Day"],
		measures: ["Revenue"],
		forecast: {
			periods: ["2026-01-03"],
			series: [
				{ measure: "Revenue", values: [3], lower: [2], upper: [4] },
			],
		},
	})!;
	assert.deepEqual(chart.categories, [
		"2026-01-01",
		"2026-01-02",
		"2026-01-03",
	]);
	assert.deepEqual(
		chart.series.map((s) => s.name),
		["Revenue", "Forecast", "Likely low", "Likely high"],
	);
	assert.deepEqual(chart.series[0].values, [1, 2, null]);
	assert.deepEqual(chart.series[1].values, [null, null, 3]);
	const xml = chartXml(chart, ["FF0000"]);
	assert.ok(xml.includes('prstDash val="dash"'));
});

test("long axis figures are shortened, and a pie has no axis", () => {
	const chart = {
		kind: "column" as const,
		categories: ["A"],
		series: [{ name: "S", values: [4_000_000] }],
		numberFormat: '"$"#,##0',
	};
	assert.equal(axisFormat(chart), '"$"0.0,,"M"');
	assert.equal(
		axisFormat({ ...chart, series: [{ name: "S", values: [40_000_000] }] }),
		'"$"0,,"M"',
	);
	assert.equal(
		axisFormat({ ...chart, series: [{ name: "S", values: [50_000] }] }),
		'"$"0,"K"',
	);
	assert.equal(
		axisFormat({ ...chart, series: [{ name: "S", values: [50] }] }),
		'"$"#,##0',
	);
	assert.ok(
		!chartXml({ ...chart, kind: "pie" }, ["FF0000"]).includes("c:catAx"),
	);
});

test("what does not fit on a slide moves to the next", () => {
	const slides = slidesForPage(
		{
			title: "Page",
			subtitle: null,
			visuals: [visual(0, 500, "One"), visual(512, 500, "Two")],
		},
		theme,
	);
	assert.equal(slides.length, 2);
	assert.equal(slides[1].title, "Page (2)");
	assert.ok(slides[0].xml().includes("One"));
	assert.ok(!slides[0].xml().includes("Two"));
	assert.ok(slides[1].xml().includes("Two"));
});

test("tables are tables and a title slide is only its words", () => {
	const [table] = slidesForPage(
		{
			title: "P",
			subtitle: null,
			visuals: [
				{
					title: "T",
					box: { left: 0, top: 0, width: 800, height: 300 },
					body: {
						kind: "table",
						columns: [
							{ name: "Region", numeric: false },
							{ name: "Revenue", numeric: true },
						],
						rows: [["West", "$1"]],
						more: false,
					},
				},
			],
		},
		theme,
	);
	assert.ok(table.xml().includes("<a:tbl>"));
	assert.ok(table.xml().includes("West"));
	const [title] = slidesForPage(
		{
			title: "Welcome",
			subtitle: null,
			visuals: [],
			titleOnly: true,
			text: "Hello",
		},
		theme,
	);
	assert.ok(title.xml().includes("Hello"));
});
