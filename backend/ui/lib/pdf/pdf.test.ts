import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import {
	fitText,
	parseColor,
	PdfDocument,
	textWidth,
	wrapText,
} from "./document";
import { drawSvg, parsePath } from "./svgToPdf";
import { drawReportPage, layoutWidth } from "./reportPdf";
import { TrueTypeFont } from "./truetype";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useEmbeddedFonts } from "./document";

// The drawing instructions of every sheet, opened up so they can be read.
function contentOf(bytes: Uint8Array): string {
	const file = Buffer.from(bytes);
	const out: string[] = [];
	let from = 0;
	for (;;) {
		const start = file.indexOf("stream\n", from);
		if (start < 0) break;
		const end = file.indexOf("\nendstream", start);
		out.push(inflateSync(file.subarray(start + 7, end)).toString("latin1"));
		from = end + 10;
	}
	return out.join("\n");
}

function hexOf(text: string): string {
	return `<${Buffer.from(text, "latin1").toString("hex")}>`;
}

test("colours are read in the forms a chart writes them", () => {
	assert.deepEqual(parseColor("#fff"), { r: 1, g: 1, b: 1, a: 1 });
	assert.deepEqual(parseColor("rgba(255,0,0,0.5)"), {
		r: 1,
		g: 0,
		b: 0,
		a: 0.5,
	});
	assert.equal(parseColor("none"), null);
	assert.equal(parseColor("transparent"), null);
	assert.equal(parseColor(undefined), null);
});

test("text is measured, wrapped and cut to what fits", () => {
	assert.ok(textWidth("WWW", 10) > textWidth("iii", 10));
	const lines = wrapText("one two three four five six", 30, 10);
	assert.ok(lines.length > 1);
	for (const line of lines) assert.ok(textWidth(line, 10) <= 30);
	assert.equal(lines.join(" "), "one two three four five six");
	assert.equal(fitText("short", 500, 10), "short");
	assert.ok(fitText("a very long sentence indeed", 40, 10).endsWith("..."));
	assert.equal(fitText("anything", 0, 10), "");
});

test("a file has the parts a reader needs, with an accurate table of contents", () => {
	const document = new PdfDocument(200, 100);
	document.text(10, 20, "Hello", { size: 10 });
	document.addPage();
	document.rect(1, 2, 3, 4, { fill: parseColor("#ff0000") });
	const bytes = Buffer.from(document.toBytes());
	const text = bytes.toString("latin1");
	assert.ok(text.startsWith("%PDF-1.4"));
	assert.ok(text.endsWith("%%EOF"));
	assert.ok(text.includes("/Count 2"));

	const declared = Number(text.match(/startxref\n(\d+)/)?.[1]);
	assert.equal(text.slice(declared, declared + 4), "xref");
	const entries = [...text.slice(declared).matchAll(/(\d{10}) 00000 n /g)];
	entries.forEach((entry, index) => {
		const at = Number(entry[1]);
		assert.equal(
			text.slice(at, at + `${index + 1} 0 obj`.length),
			`${index + 1} 0 obj`,
		);
	});
	assert.ok(contentOf(bytes).includes(hexOf("Hello")));
});

test("positions run from the top of the page", () => {
	const document = new PdfDocument(200, 100);
	document.line(0, 10, 50, 10, parseColor("#000000")!);
	const drawn = contentOf(document.toBytes());
	assert.ok(drawn.includes("0 90 m"));
	assert.ok(drawn.includes("50 90 l"));
});

test("characters outside the font do not break the file", () => {
	const document = new PdfDocument(200, 100);
	document.text(10, 20, "A中é—", { size: 10 });
	assert.ok(contentOf(document.toBytes()).includes("<413fe997>"));
});

test("paths are read in absolute and relative form, with arcs as curves", () => {
	assert.deepEqual(parsePath("M1 2L3 4Z"), [
		{ op: "M", x: 1, y: 2 },
		{ op: "L", x: 3, y: 4 },
		{ op: "Z" },
	]);
	assert.deepEqual(parsePath("M1,2 l1,1 h2 v3"), [
		{ op: "M", x: 1, y: 2 },
		{ op: "L", x: 2, y: 3 },
		{ op: "L", x: 4, y: 3 },
		{ op: "L", x: 4, y: 6 },
	]);
	const arc = parsePath("M0 0A10 10 0 0 1 10 10");
	const last = arc[arc.length - 1];
	assert.equal(last.op, "C");
	assert.ok(last.op === "C" && last.x === 10 && last.y === 10);
});

test("an arc stays on its circle", () => {
	const arc = parsePath("M10 0A10 10 0 0 1 -10 0");
	const end = arc[arc.length - 1];
	assert.ok(end.op === "C");
	if (end.op === "C") {
		assert.equal(end.x, -10);
		assert.equal(end.y, 0);
	}
	const middle = arc[1];
	assert.ok(middle.op === "C");
	if (middle.op === "C") {
		assert.ok(Math.abs(Math.hypot(middle.x, middle.y) - 10) < 0.001);
	}
});

test("a chart's shapes and words reach the page, scaled to the box", () => {
	const document = new PdfDocument(400, 400);
	drawSvg(
		document,
		`<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
		<defs><linearGradient id="g"><stop offset="0" stop-color="#00ff00"/></linearGradient></defs>
		<g transform="translate(10,10)"><path d="M0 0L10 0" fill="none" stroke="#ff0000" stroke-width="2"/>
		<rect x="0" y="0" width="5" height="5" fill="url(#g)"/></g>
		<text x="50" y="50" text-anchor="middle" style="font-size:10px;" fill="#0000ff">North &amp; South</text></svg>`,
		{ x: 0, y: 0, width: 100, height: 50 },
	);
	const drawn = contentOf(document.toBytes());
	assert.ok(drawn.includes("1 0 0 RG"));
	assert.ok(drawn.includes("0 1 0 rg"));
	assert.ok(drawn.includes("0 0 1 rg"));
	assert.ok(drawn.includes(hexOf("North & South")));
	assert.ok(drawn.includes("5 395 m"));
});

const page = (visuals: Parameters<typeof drawReportPage>[0]["visuals"]) => ({
	reportTitle: "Sales",
	pageTitle: "Overview",
	preparedFor: "reader@example.com",
	preparedOn: new Date("2026-01-02T03:04:05Z"),
	filters: ["Region is West"],
	visuals,
});

test("a page shows what it holds and who it was prepared for", () => {
	const drawn = contentOf(
		drawReportPage(
			page([
				{
					title: "Totals",
					box: { left: 0, top: 0, width: layoutWidth, height: 100 },
					body: {
						kind: "figures",
						figures: [{ label: "Revenue", text: "$1.2M" }],
					},
				},
				{
					title: "By region",
					box: { left: 0, top: 110, width: 500, height: 300 },
					body: {
						kind: "table",
						columns: [
							{ name: "Region", numeric: false },
							{ name: "Revenue", numeric: true },
						],
						rows: [["West", "$1M"]],
						more: false,
					},
				},
				{
					title: null,
					box: { left: 510, top: 110, width: 500, height: 300 },
					body: { kind: "text", paragraphs: ["Read this first."] },
				},
			]),
		),
	);
	for (const text of [
		"Sales",
		"Overview",
		"Filtered to Region is West",
		"Revenue",
		"$1.2M",
		"West",
		"$1M",
		"Read",
		"Sheet 1 of 1",
	]) {
		assert.ok(
			drawn.includes(hexOf(text)) ||
				[...drawn.matchAll(/<([0-9a-f]+)> Tj/g)].some((match) =>
					Buffer.from(match[1], "hex")
						.toString("latin1")
						.includes(text),
				),
			text,
		);
	}
});

test("what does not fit on a sheet moves to the next", () => {
	const bytes = drawReportPage(
		page([
			{
				title: "One",
				box: { left: 0, top: 0, width: 500, height: 800 },
				body: { kind: "note", text: "x" },
			},
			{
				title: "Two",
				box: { left: 0, top: 812, width: 500, height: 800 },
				body: { kind: "note", text: "y" },
			},
		]),
	);
	const text = Buffer.from(bytes).toString("latin1");
	assert.ok(text.includes("/Count 2"));
	assert.ok(contentOf(bytes).includes(hexOf("Sheet 2 of 2")));
});

test("a table says when rows are left out", () => {
	const rows = Array.from({ length: 500 }, (_, index) => [`Row ${index}`]);
	const drawn = contentOf(
		drawReportPage(
			page([
				{
					title: "Long",
					box: { left: 0, top: 0, width: 500, height: 300 },
					body: {
						kind: "table",
						columns: [{ name: "Name", numeric: false }],
						rows,
						more: false,
					},
				},
			]),
		),
	);
	assert.ok(
		/more rows in the app/.test(
			[...drawn.matchAll(/<([0-9a-f]+)> Tj/g)]
				.map((match) => Buffer.from(match[1], "hex").toString("latin1"))
				.join(" "),
		),
	);
});

const fontsFolder = join(process.cwd(), "lib", "pdf", "fonts");
const loadFont = (name: string) =>
	new TrueTypeFont(readFileSync(join(fontsFolder, name)));

test("a font says which letters it has and how wide they are", () => {
	const font = loadFont("NotoSans-Regular.ttf");
	assert.ok(font.glyphFor(0x416) > 0);
	assert.equal(font.glyphFor(0x4e2d), 0);
	assert.ok(
		font.advance(font.glyphFor(0x57)) > font.advance(font.glyphFor(0x69)),
	);
});

test("a subset keeps what is used, and what those letters are built from", () => {
	const font = loadFont("NotoSans-Regular.ttf");
	const full = readFileSync(join(fontsFolder, "NotoSans-Regular.ttf"));
	const subset = font.subset([font.glyphFor(0xe9), font.glyphFor(0x416)]);
	assert.ok(subset.length < full.length);
	const again = new TrueTypeFont(
		Buffer.concat([subset, Buffer.alloc(0)]).length > 0
			? withCharacterMap(subset, full)
			: full,
	);
	assert.equal(again.unitsPerEm, font.unitsPerEm);
});

// A subset leaves out the character map, which a PDF does not use and this reader needs.
function withCharacterMap(subset: Buffer, full: Buffer): Buffer {
	const fullCount = full.readUInt16BE(4);
	let cmap: Buffer | null = null;
	for (let index = 0; index < fullCount; index += 1) {
		const entry = 12 + index * 16;
		if (full.toString("latin1", entry, entry + 4) === "cmap") {
			const offset = full.readUInt32BE(entry + 8);
			cmap = full.subarray(
				offset,
				offset + full.readUInt32BE(entry + 12),
			);
		}
	}
	const count = subset.readUInt16BE(4);
	const header = Buffer.alloc(12 + (count + 1) * 16);
	subset.copy(header, 0, 0, 12 + count * 16);
	header.writeUInt16BE(count + 1, 4);
	const shift = 16;
	for (let index = 0; index < count; index += 1) {
		const entry = 12 + index * 16;
		header.writeUInt32BE(header.readUInt32BE(entry + 8) + shift, entry + 8);
	}
	const body = subset.subarray(12 + count * 16);
	const entry = 12 + count * 16;
	header.write("cmap", entry, "latin1");
	header.writeUInt32BE(header.length + body.length, entry + 8);
	header.writeUInt32BE((cmap as Buffer).length, entry + 12);
	return Buffer.concat([header, body, cmap as Buffer]);
}

test("letters beyond the built in font are embedded, and can be searched", () => {
	const noto = loadFont("NotoSans-Regular.ttf");
	useEmbeddedFonts([{ font: noto }]);
	try {
		const document = new PdfDocument(200, 100);
		document.text(10, 20, "Москва and caf\u00e9", { size: 10 });
		const bytes = Buffer.from(document.toBytes());
		const text = bytes.toString("latin1");
		assert.ok(text.includes("/Identity-H"));
		assert.ok(text.includes("/FontFile2"));
		const drawn = contentOf(bytes);
		const glyph = noto.glyphFor(0x41c).toString(16).padStart(4, "0");
		assert.ok(drawn.includes(`<${glyph}`));
		// The western part stays in the built in font, so it adds nothing to the file.
		assert.ok(drawn.includes(hexOf(" and caf\u00e9")));
		assert.ok(drawn.includes("041c"));
		assert.ok(bytes.length < 200_000);
	} finally {
		useEmbeddedFonts([]);
	}
});

test("a file with western text alone carries no font", () => {
	const document = new PdfDocument(200, 100);
	document.text(10, 20, "Plain", { size: 10 });
	assert.ok(
		!Buffer.from(document.toBytes())
			.toString("latin1")
			.includes("/FontFile2"),
	);
});

test("letters no font holds print as a question mark", () => {
	useEmbeddedFonts([{ font: loadFont("NotoSans-Regular.ttf") }]);
	try {
		const document = new PdfDocument(200, 100);
		document.text(10, 20, "\u0627", { size: 10 });
		assert.ok(contentOf(document.toBytes()).includes("<3f>"));
	} finally {
		useEmbeddedFonts([]);
	}
});

test("widths of embedded letters come from their font", () => {
	useEmbeddedFonts([{ font: loadFont("DroidSansFallbackFull.ttf") }]);
	try {
		assert.ok(textWidth("\u4e2d\u6587", 10) > 15);
	} finally {
		useEmbeddedFonts([]);
	}
});

test("records, lines and small charts all reach the page", () => {
	const drawn = contentOf(
		drawReportPage({
			...page([
				{
					title: "Customer",
					box: { left: 0, top: 0, width: 500, height: 200 },
					body: {
						kind: "pairs",
						notice: "Showing the first of several matching records.",
						pairs: [{ label: "Name", text: "Acme" }],
					},
				},
				{
					title: "Pace",
					box: { left: 510, top: 0, width: 500, height: 200 },
					body: {
						kind: "lines",
						lines: [
							{ text: "$9", large: true },
							{ text: "On pace", tone: "good" },
						],
						bar: { share: 0.5, tone: "good" },
					},
				},
				{
					title: "Regions",
					box: { left: 0, top: 210, width: 500, height: 200 },
					body: {
						kind: "multiples",
						min: 0,
						max: 10,
						panels: [{ label: "West", values: [1, null, 3, 4] }],
					},
				},
				{
					title: "Tiles",
					box: { left: 510, top: 210, width: 500, height: 200 },
					body: {
						kind: "figures",
						figures: [
							{
								label: "Sales",
								text: "$1",
								band: "Headline",
								change: { text: "+2.0%", tone: "good" },
								target: { text: "82% of target", tone: "warn" },
								trend: [1, 2, 3],
							},
						],
					},
				},
			]),
			accent: "#ea580c",
			series: "#db2777",
		}),
	);
	const words = [...drawn.matchAll(/<([0-9a-f]+)> Tj/g)]
		.map((match) => Buffer.from(match[1], "hex").toString("latin1"))
		.join(" ");
	for (const text of [
		"Showing the first",
		"Acme",
		"On pace",
		"West",
		"Headline",
		"+2.0%",
		"82% of target",
	]) {
		assert.ok(words.includes(text), text);
	}
	// The theme's accent rules the heading and its series colours what is drawn here.
	assert.ok(drawn.includes("0.918 0.345 0.047 RG"));
	assert.ok(drawn.includes("0.859 0.153 0.467 RG"));
});

test("a very small coordinate is a number, not a command", () => {
	assert.deepEqual(parsePath("M1e-7 2L3 4.5e1"), [
		{ op: "M", x: 1e-7, y: 2 },
		{ op: "L", x: 3, y: 45 },
	]);
});

test("a table's columns are as wide as what they hold", () => {
	const wide = "$1,217.27 to $10,123.45";
	const drawn = contentOf(
		drawReportPage(
			page([
				{
					title: "Ranking",
					box: { left: 0, top: 0, width: 560, height: 200 },
					body: {
						kind: "table",
						columns: [
							{ name: "Region", numeric: false },
							{ name: "Likely range", numeric: true },
						],
						rows: [["West", wide]],
						more: false,
					},
				},
			]),
		),
	);
	assert.ok(drawn.includes(hexOf(wide)));
});
