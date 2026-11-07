import { deflateSync } from "node:zlib";
import type { TrueTypeFont } from "./truetype";

// A PDF written by hand, so a server with no browser and no extra package can draw a report.
//
// Positions are in points from the top left of the page, the way the rest of the app thinks
// about a page. Western text uses the built in Helvetica, which every reader has, so most
// files carry no font of their own. Other letters come from the fonts given to
// useEmbeddedFonts, with only the letters used written into the file. Scripts those fonts do
// not hold, and scripts whose letters change shape or run right to left, which would need a
// shaping engine to be right, print as question marks rather than as wrong words.

export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const named: Record<string, string> = {
	black: "#000000",
	white: "#ffffff",
	red: "#ff0000",
	green: "#008000",
	blue: "#0000ff",
	gray: "#808080",
	grey: "#808080",
};

export function parseColor(spec: string | null | undefined): Rgba | null {
	if (!spec) return null;
	const value = spec.trim().toLowerCase();
	if (value === "none" || value === "transparent" || value === "")
		return null;
	const hex = (named[value] ?? value).match(/^#([0-9a-f]{3,8})$/);
	if (hex) {
		const digits =
			hex[1].length <= 4
				? [...hex[1]].map((digit) => digit + digit).join("")
				: hex[1];
		const part = (at: number) => parseInt(digits.slice(at, at + 2), 16);
		return {
			r: part(0) / 255,
			g: part(2) / 255,
			b: part(4) / 255,
			a: digits.length >= 8 ? part(6) / 255 : 1,
		};
	}
	const fn = value.match(/^rgba?\(([^)]+)\)$/);
	if (fn) {
		const parts = fn[1]
			.split(/[\s,/]+/)
			.filter(Boolean)
			.map(Number);
		if (parts.length < 3 || parts.some(Number.isNaN)) return null;
		return {
			r: parts[0] / 255,
			g: parts[1] / 255,
			b: parts[2] / 255,
			a: parts[3] ?? 1,
		};
	}
	return null;
}

// Helvetica's advance widths for the printable ASCII range, in thousandths of the size.
const helveticaWidths = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
	278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
	584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
	833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
	278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
	500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
	500, 334, 260, 334, 584,
];
const boldWiden = 1.07;

const windows1252: Record<number, number> = {
	0x20ac: 0x80,
	0x2018: 0x91,
	0x2019: 0x92,
	0x201c: 0x93,
	0x201d: 0x94,
	0x2022: 0x95,
	0x2013: 0x96,
	0x2014: 0x97,
	0x2026: 0x85,
};

function windowsByte(code: number): number | null {
	if (windows1252[code] !== undefined) return windows1252[code];
	if ((code >= 32 && code <= 126) || (code >= 0xa0 && code <= 0xff)) {
		return code;
	}
	return null;
}

export interface EmbeddedFont {
	font: TrueTypeFont;
	boldOnly?: boolean;
	regularOnly?: boolean;
}

let embedded: EmbeddedFont[] = [];

// Held for the life of the process, since the same fonts serve every drawing.
export function useEmbeddedFonts(fonts: EmbeddedFont[]): void {
	embedded = fonts;
}

// A run of text in one font. Null means Helvetica.
interface TextRun {
	source: EmbeddedFont | null;
	codes: number[];
}

function fontFor(code: number, bold: boolean): EmbeddedFont | null {
	return (
		embedded.find(
			(candidate) =>
				!(bold ? candidate.regularOnly : candidate.boldOnly) &&
				candidate.font.glyphFor(code) !== 0,
		) ?? null
	);
}

function runsOf(text: string, bold: boolean): TextRun[] {
	const runs: TextRun[] = [];
	for (const character of text) {
		let code = character.codePointAt(0) as number;
		let source: EmbeddedFont | null = null;
		if (windowsByte(code) === null) {
			source = fontFor(code, bold);
			if (!source) code = 0x3f;
		}
		const last = runs[runs.length - 1];
		if (last && last.source === source) last.codes.push(code);
		else runs.push({ source, codes: [code] });
	}
	return runs;
}

export function textWidth(text: string, size: number, bold = false): number {
	let total = 0;
	for (const run of runsOf(text, bold)) {
		for (const code of run.codes) {
			if (run.source) {
				total += run.source.font.advance(
					run.source.font.glyphFor(code),
				);
			} else {
				const width =
					code >= 32 && code <= 126
						? helveticaWidths[code - 32]
						: 556;
				total += width * (bold ? boldWiden : 1);
			}
		}
	}
	return (total / 1000) * size;
}

// Words on lines no wider than the given width. A word wider than that is cut.
export function wrapText(
	text: string,
	width: number,
	size: number,
	bold = false,
): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const attempt = line ? `${line} ${word}` : word;
		if (textWidth(attempt, size, bold) <= width) {
			line = attempt;
			continue;
		}
		if (line) lines.push(line);
		line = word;
		while (textWidth(line, size, bold) > width && line.length > 1) {
			let fit = line.length - 1;
			while (
				fit > 1 &&
				textWidth(line.slice(0, fit), size, bold) > width
			) {
				fit -= 1;
			}
			lines.push(line.slice(0, fit));
			line = line.slice(fit);
		}
	}
	if (line) lines.push(line);
	return lines;
}

// The text cut to fit, with three dots saying so.
export function fitText(
	text: string,
	width: number,
	size: number,
	bold = false,
): string {
	if (textWidth(text, size, bold) <= width) return text;
	let keep = text.length;
	while (
		keep > 0 &&
		textWidth(`${text.slice(0, keep)}...`, size, bold) > width
	) {
		keep -= 1;
	}
	return keep > 0 ? `${text.slice(0, keep)}...` : "";
}

const number = (value: number) =>
	Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";

export type PathCommand =
	| { op: "M" | "L"; x: number; y: number }
	| {
			op: "C";
			x1: number;
			y1: number;
			x2: number;
			y2: number;
			x: number;
			y: number;
	  }
	| { op: "Z" };

export interface PaintStyle {
	fill?: Rgba | null;
	stroke?: Rgba | null;
	lineWidth?: number;
	dash?: number[];
}

export interface TextStyle {
	size: number;
	color?: Rgba;
	bold?: boolean;
	align?: "left" | "center" | "right";
	// Radians, turning the text about where it is placed.
	angle?: number;
}

const ink: Rgba = { r: 0.1, g: 0.1, b: 0.12, a: 1 };

export class PdfDocument {
	private readonly pages: string[][] = [];
	private readonly alphas = new Map<string, string>();
	// Each embedded font in use, with the letters drawn in it.
	private readonly used = new Map<
		EmbeddedFont,
		{ name: string; glyphs: Map<number, number> }
	>();

	constructor(
		readonly width: number,
		readonly height: number,
	) {
		this.addPage();
	}

	addPage(): void {
		this.pages.push([]);
	}

	get pageCount(): number {
		return this.pages.length;
	}

	private put(line: string): void {
		this.pages[this.pages.length - 1].push(line);
	}

	// Writes onto a page other than the last, for numbering once the count is known.
	onPage(index: number, draw: () => void): void {
		const last = this.pages.length - 1;
		const held = this.pages[last];
		this.pages[last] = this.pages[index];
		draw();
		this.pages[index] = this.pages[last];
		this.pages[last] = held;
	}

	private alphaState(fill: number, stroke: number): string {
		const key = `${number(fill)}/${number(stroke)}`;
		let name = this.alphas.get(key);
		if (!name) {
			name = `G${this.alphas.size}`;
			this.alphas.set(key, name);
		}
		return name;
	}

	private setPaint(style: PaintStyle): void {
		if (style.fill) {
			const { r, g, b } = style.fill;
			this.put(`${number(r)} ${number(g)} ${number(b)} rg`);
		}
		if (style.stroke) {
			const { r, g, b } = style.stroke;
			this.put(`${number(r)} ${number(g)} ${number(b)} RG`);
			this.put(`${number(style.lineWidth ?? 1)} w`);
			this.put(
				style.dash?.length
					? `[${style.dash.map(number).join(" ")}] 0 d`
					: "[] 0 d",
			);
		}
		const fillAlpha = style.fill?.a ?? 1;
		const strokeAlpha = style.stroke?.a ?? 1;
		if (fillAlpha < 1 || strokeAlpha < 1) {
			this.put(`/${this.alphaState(fillAlpha, strokeAlpha)} gs`);
		}
	}

	path(commands: PathCommand[], style: PaintStyle): void {
		if (commands.length === 0 || (!style.fill && !style.stroke)) return;
		const flip = (y: number) => number(this.height - y);
		this.put("q");
		this.setPaint(style);
		for (const command of commands) {
			if (command.op === "M") {
				this.put(`${number(command.x)} ${flip(command.y)} m`);
			} else if (command.op === "L") {
				this.put(`${number(command.x)} ${flip(command.y)} l`);
			} else if (command.op === "C") {
				this.put(
					`${number(command.x1)} ${flip(command.y1)} ${number(command.x2)} ${flip(command.y2)} ${number(command.x)} ${flip(command.y)} c`,
				);
			} else {
				this.put("h");
			}
		}
		this.put(style.fill && style.stroke ? "B" : style.fill ? "f" : "S");
		this.put("Q");
	}

	rect(
		x: number,
		y: number,
		width: number,
		height: number,
		style: PaintStyle,
	): void {
		this.path(
			[
				{ op: "M", x, y },
				{ op: "L", x: x + width, y },
				{ op: "L", x: x + width, y: y + height },
				{ op: "L", x, y: y + height },
				{ op: "Z" },
			],
			style,
		);
	}

	line(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		stroke: Rgba,
		lineWidth = 0.5,
	): void {
		this.path(
			[
				{ op: "M", x: x1, y: y1 },
				{ op: "L", x: x2, y: y2 },
			],
			{ stroke, lineWidth },
		);
	}

	// Placed by its baseline.
	text(x: number, y: number, content: string, style: TextStyle): void {
		if (!content) return;
		const color = style.color ?? ink;
		const angle = style.angle ?? 0;
		const span = textWidth(content, style.size, style.bold);
		const lead =
			style.align === "right"
				? span
				: style.align === "center"
					? span / 2
					: 0;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const startX = x - lead * cos;
		const startY = y - lead * sin;
		this.put("q");
		this.setPaint({ fill: color });
		this.put("BT");
		this.put(
			`${number(cos)} ${number(-sin)} ${number(sin)} ${number(cos)} ${number(startX)} ${number(this.height - startY)} Tm`,
		);
		for (const run of runsOf(content, Boolean(style.bold))) {
			if (run.source) {
				const held = this.usedFont(run.source);
				this.put(`/${held.name} ${number(style.size)} Tf`);
				const hex = run.codes
					.map((code) => {
						const glyph = (
							run.source as EmbeddedFont
						).font.glyphFor(code);
						held.glyphs.set(glyph, code);
						return glyph.toString(16).padStart(4, "0");
					})
					.join("");
				this.put(`<${hex}> Tj`);
			} else {
				this.put(
					`/${style.bold ? "F2" : "F1"} ${number(style.size)} Tf`,
				);
				const hex = run.codes
					.map((code) =>
						(windowsByte(code) ?? 0x3f)
							.toString(16)
							.padStart(2, "0"),
					)
					.join("");
				this.put(`<${hex}> Tj`);
			}
		}
		this.put("ET");
		this.put("Q");
	}

	private usedFont(source: EmbeddedFont) {
		let held = this.used.get(source);
		if (!held) {
			held = { name: `E${this.used.size}`, glyphs: new Map() };
			this.used.set(source, held);
		}
		return held;
	}

	// One embedded font's objects, numbered from the first given, and the one to refer to.
	private fontObjects(
		source: EmbeddedFont,
		glyphs: Map<number, number>,
		first: number,
		objects: (string | Buffer)[],
	): void {
		const { font } = source;
		const scale = 1000 / font.unitsPerEm;
		const name = `AAAAAA+SightlineFont${first}`;
		const sorted = [...glyphs.keys()].sort((a, b) => a - b);
		const widths = sorted
			.map((glyph) => `${glyph} [${number(font.advance(glyph))}]`)
			.join(" ");
		const stream = (dictionary: string, body: Buffer) => {
			const packed = deflateSync(body);
			return Buffer.concat([
				Buffer.from(
					`<< ${dictionary} /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`,
					"latin1",
				),
				packed,
				Buffer.from("\nendstream", "latin1"),
			]);
		};
		objects[first] =
			`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H ` +
			`/DescendantFonts [${first + 1} 0 R] /ToUnicode ${first + 4} 0 R >>`;
		objects[first + 1] =
			`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} ` +
			`/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
			`/FontDescriptor ${first + 2} 0 R /CIDToGIDMap /Identity /W [${widths}] >>`;
		objects[first + 2] =
			`<< /Type /FontDescriptor /FontName /${name} /Flags 4 ` +
			`/FontBBox [${font.box.map((value) => number(value * scale)).join(" ")}] ` +
			`/ItalicAngle 0 /Ascent ${number(font.ascent * scale)} /Descent ${number(font.descent * scale)} ` +
			`/CapHeight ${number(font.ascent * scale)} /StemV 80 /FontFile2 ${first + 3} 0 R >>`;
		objects[first + 3] = stream("", font.subset(sorted));
		// So the words can still be searched and copied out of the file.
		const pairs = sorted.map((glyph) => {
			const utf16 = Buffer.from(
				String.fromCodePoint(glyphs.get(glyph) as number),
				"utf16le",
			).swap16();
			return `<${glyph.toString(16).padStart(4, "0")}> <${utf16.toString("hex")}>`;
		});
		const blocks: string[] = [];
		for (let at = 0; at < pairs.length; at += 100) {
			const block = pairs.slice(at, at + 100);
			blocks.push(
				`${block.length} beginbfchar\n${block.join("\n")}\nendbfchar`,
			);
		}
		objects[first + 4] = stream(
			"",
			Buffer.from(
				"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n" +
					"/CMapName /Sightline def /CMapType 2 def\n" +
					"1 begincodespacerange <0000> <ffff> endcodespacerange\n" +
					`${blocks.join("\n")}\n` +
					"endcmap CMapName currentdict /CMap defineresource pop end end",
				"latin1",
			),
		);
	}

	toBytes(): Uint8Array {
		// Objects 1 to 4 are fixed, each page takes two, and each embedded font five.
		const objects: (string | Buffer)[] = [];
		const firstPageObject = 5;
		const kids = this.pages
			.map((_, index) => `${firstPageObject + index * 2} 0 R`)
			.join(" ");
		const fontResources: string[] = [];
		let nextObject = firstPageObject + this.pages.length * 2;
		for (const [source, held] of this.used) {
			this.fontObjects(source, held.glyphs, nextObject, objects);
			fontResources.push(`/${held.name} ${nextObject} 0 R`);
			nextObject += 5;
		}
		const states = [...this.alphas.entries()]
			.map(([key, name]) => {
				const [fill, stroke] = key.split("/");
				return `/${name} << /ca ${fill} /CA ${stroke} >>`;
			})
			.join(" ");
		objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
		objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`;
		objects[3] =
			"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
		objects[4] =
			"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
		this.pages.forEach((lines, index) => {
			const pageObject = firstPageObject + index * 2;
			const contentObject = pageObject + 1;
			objects[pageObject] =
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(this.width)} ${number(this.height)}] ` +
				`/Resources << /Font << /F1 3 0 R /F2 4 0 R ${fontResources.join(" ")} >> /ExtGState << ${states} >> >> ` +
				`/Contents ${contentObject} 0 R >>`;
			const packed = deflateSync(Buffer.from(lines.join("\n"), "latin1"));
			objects[contentObject] = Buffer.concat([
				Buffer.from(
					`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`,
					"latin1",
				),
				packed,
				Buffer.from("\nendstream", "latin1"),
			]);
		});

		const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
		let offset = parts[0].length;
		const offsets: number[] = [];
		for (let id = 1; id < objects.length; id += 1) {
			const body = objects[id];
			const chunk = Buffer.concat([
				Buffer.from(`${id} 0 obj\n`, "latin1"),
				typeof body === "string" ? Buffer.from(body, "latin1") : body,
				Buffer.from("\nendobj\n", "latin1"),
			]);
			offsets[id] = offset;
			offset += chunk.length;
			parts.push(chunk);
		}
		const table = [
			"xref",
			`0 ${objects.length}`,
			"0000000000 65535 f ",
			...offsets
				.slice(1)
				.map((at) => `${String(at).padStart(10, "0")} 00000 n `),
			"trailer",
			`<< /Size ${objects.length} /Root 1 0 R >>`,
			"startxref",
			String(offset),
			"%%EOF",
		].join("\n");
		parts.push(Buffer.from(table, "latin1"));
		return Buffer.concat(parts);
	}
}
