import {
	fitText,
	parseColor,
	PdfDocument,
	textWidth,
	wrapText,
	type PathCommand,
	type Rgba,
} from "./document";
import { drawSvg } from "./svgToPdf";
import type { NativeChart } from "../pptx/nativeChart";

// One report page laid out on paper, placed the way the page places it. Takes what each
// visual shows, already read, so it can be tested with no data behind it.

export type Tone = "good" | "warn" | "bad" | null;

export interface PdfFigure {
	label: string;
	text: string;
	// A band of tiles this one sits in, named by its author.
	band?: string | null;
	color?: string | null;
	background?: string | null;
	bold?: boolean;
	change?: { text: string; tone: Tone } | null;
	target?: { text: string; tone: Tone } | null;
	trend?: (number | null)[];
}

export type PdfBody =
	| { kind: "figures"; figures: PdfFigure[] }
	| {
			kind: "chart";
			svg: string;
			caption?: string | null;
			// The same chart as PowerPoint's own, where it has one.
			native?: NativeChart | null;
	  }
	| {
			kind: "table";
			columns: { name: string; numeric: boolean }[];
			rows: string[][];
			// More rows than were read.
			more: boolean;
	  }
	| { kind: "text"; paragraphs: string[] }
	| { kind: "heading"; text: string }
	| { kind: "note"; text: string }
	// A label and a value on each line, for one record.
	| {
			kind: "pairs";
			pairs: { label: string; text: string }[];
			notice?: string | null;
	  }
	| {
			kind: "lines";
			lines: { text: string; tone?: Tone; large?: boolean }[];
			// How far along, from zero to one, drawn as a bar under the lines.
			bar?: { share: number; tone: Tone } | null;
	  }
	// One small chart per value, on one scale.
	| {
			kind: "multiples";
			panels: { label: string; values: (number | null)[] }[];
			min: number;
			max: number;
	  };

export interface PdfVisual {
	title: string | null;
	// In the page's own pixels at the width the page is laid out at.
	box: { left: number; top: number; width: number; height: number };
	body: PdfBody;
}

export interface PdfPageInput {
	reportTitle: string;
	pageTitle: string;
	preparedFor: string;
	preparedOn: Date;
	// Filters in effect, in words.
	filters: string[];
	visuals: PdfVisual[];
	// The report's theme, for the rule under the heading and anything drawn here rather
	// than by the chart library.
	accent?: string | null;
	series?: string | null;
}

// US Letter on its side, since report pages are wider than they are tall.
const pageWidth = 792;
const pageHeight = 612;
const margin = 36;
const headerHeight = 54;
const footerHeight = 22;

// The width the page is laid out at before being scaled onto paper.
export const layoutWidth = 1180;

const colors = {
	ink: parseColor("#16181d") as Rgba,
	muted: parseColor("#767d87") as Rgba,
	line: parseColor("#dfe3e8") as Rgba,
	band: parseColor("#f4f6f8") as Rgba,
	good: parseColor("#1a7f45") as Rgba,
	warn: parseColor("#b5740b") as Rgba,
	bad: parseColor("#c22b2b") as Rgba,
};

function toneColor(tone: Tone | undefined): Rgba {
	return tone ? colors[tone] : colors.muted;
}

// A small line through the values. A gap in the values leaves a gap in the line.
function drawTrend(
	document: PdfDocument,
	values: (number | null)[],
	range: { min: number; max: number },
	box: { x: number; y: number; width: number; height: number },
	stroke: Rgba,
): void {
	if (values.length < 2) return;
	const span = range.max - range.min || 1;
	const commands: PathCommand[] = [];
	let drawing = false;
	values.forEach((value, index) => {
		if (value === null) {
			drawing = false;
			return;
		}
		const x = box.x + (index / (values.length - 1)) * box.width;
		const y =
			box.y + box.height - ((value - range.min) / span) * box.height;
		commands.push({ op: drawing ? "L" : "M", x, y });
		drawing = true;
	});
	document.path(commands, { stroke, lineWidth: 0.8 });
}

function drawHeader(document: PdfDocument, input: PdfPageInput): void {
	document.text(margin, margin + 8, input.reportTitle, {
		size: 14,
		bold: true,
	});
	const usable = pageWidth - margin * 2;
	if (input.pageTitle !== input.reportTitle) {
		document.text(margin, margin + 22, input.pageTitle, {
			size: 10,
			color: colors.muted,
		});
	}
	if (input.filters.length > 0) {
		document.text(
			margin,
			margin + 34,
			fitText(`Filtered to ${input.filters.join(", ")}`, usable, 8),
			{ size: 8, color: colors.muted },
		);
	}
	document.line(
		margin,
		margin + headerHeight - 12,
		pageWidth - margin,
		margin + headerHeight - 12,
		parseColor(input.accent) ?? colors.line,
		input.accent ? 1.25 : 0.5,
	);
}

function drawFigures(
	document: PdfDocument,
	figures: PdfFigure[],
	x: number,
	y: number,
	width: number,
	height: number,
	series: Rgba,
): void {
	if (figures.length === 0) return;
	const bands: { label: string | null; figures: PdfFigure[] }[] = [];
	for (const figure of figures) {
		const label = figure.band ?? null;
		const last = bands[bands.length - 1];
		if (last && last.label === label) last.figures.push(figure);
		else bands.push({ label, figures: [figure] });
	}
	const bandHeight = height / bands.length;
	bands.forEach((band, bandIndex) => {
		let top = y + bandIndex * bandHeight;
		let room = bandHeight;
		if (band.label) {
			document.text(
				x + 4,
				top + 8,
				fitText(band.label, width - 8, 7, true),
				{
					size: 7,
					bold: true,
					color: colors.muted,
				},
			);
			top += 10;
			room -= 10;
		}
		const tileWidth = width / band.figures.length;
		band.figures.forEach((figure, index) => {
			const left = x + index * tileWidth;
			const inner = tileWidth - 8;
			if (figure.background) {
				const fill = parseColor(figure.background);
				if (fill) {
					document.rect(left + 1, top, tileWidth - 2, room - 1, {
						fill,
					});
				}
			}
			document.text(left + 4, top + 10, fitText(figure.label, inner, 7), {
				size: 7,
				color: colors.muted,
			});
			const size = Math.min(16, Math.max(8, room * 0.32));
			let line = top + 10 + size + 2;
			document.text(
				left + 4,
				line,
				fitText(figure.text, inner, size, true),
				{
					size,
					bold: true,
					color: parseColor(figure.color) ?? colors.ink,
				},
			);
			for (const extra of [figure.change, figure.target]) {
				if (!extra) continue;
				line += 9;
				document.text(left + 4, line, fitText(extra.text, inner, 7), {
					size: 7,
					color: toneColor(extra.tone),
				});
			}
			const trend = (figure.trend ?? []).filter(
				(value): value is number => value !== null,
			);
			const trendRoom = top + room - line - 4;
			if (trend.length > 1 && trendRoom > 6) {
				drawTrend(
					document,
					figure.trend ?? [],
					{ min: Math.min(...trend), max: Math.max(...trend) },
					{
						x: left + 4,
						y: line + 3,
						width: inner,
						height: Math.min(trendRoom, 22),
					},
					parseColor(figure.color) ?? series,
				);
			}
		});
	});
}

function drawPairs(
	document: PdfDocument,
	body: Extract<PdfBody, { kind: "pairs" }>,
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	const size = 8;
	const leading = 12;
	let top = y + size;
	if (body.notice) {
		document.text(x, top, fitText(body.notice, width, 7), {
			size: 7,
			color: colors.warn,
		});
		top += leading;
	}
	const labelWidth = Math.min(width * 0.4, 140);
	for (const pair of body.pairs) {
		if (top > y + height) return;
		document.text(x, top, fitText(pair.label, labelWidth - 4, size), {
			size,
			color: colors.muted,
		});
		document.text(
			x + labelWidth,
			top,
			fitText(pair.text, width - labelWidth, size),
			{ size },
		);
		top += leading;
	}
}

function drawLines(
	document: PdfDocument,
	body: Extract<PdfBody, { kind: "lines" }>,
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	let top = y;
	for (const line of body.lines) {
		const size = line.large ? 14 : 8;
		for (const piece of wrapText(line.text, width, size, line.large)) {
			top += size + 3;
			if (top > y + height) return;
			document.text(x, top, piece, {
				size,
				bold: line.large,
				color: line.tone
					? toneColor(line.tone)
					: line.large
						? colors.ink
						: colors.muted,
			});
		}
	}
	if (body.bar && top + 10 <= y + height) {
		const barTop = top + 5;
		document.rect(x, barTop, width, 4, { fill: colors.band });
		document.rect(x, barTop, width * Math.min(1, body.bar.share), 4, {
			fill: toneColor(body.bar.tone),
		});
	}
}

function drawMultiples(
	document: PdfDocument,
	body: Extract<PdfBody, { kind: "multiples" }>,
	x: number,
	y: number,
	width: number,
	height: number,
	series: Rgba,
): void {
	const count = body.panels.length;
	if (count === 0) return;
	// As square as the box allows, so the panels stay comparable shapes.
	const columns = Math.max(
		1,
		Math.min(count, Math.ceil(Math.sqrt((count * width) / height))),
	);
	const rows = Math.ceil(count / columns);
	const panelWidth = width / columns;
	const panelHeight = height / rows;
	const range = { min: body.min, max: body.max };
	body.panels.forEach((panel, index) => {
		const left = x + (index % columns) * panelWidth;
		const top = y + Math.floor(index / columns) * panelHeight;
		document.text(
			left + 2,
			top + 8,
			fitText(panel.label, panelWidth - 6, 7),
			{
				size: 7,
				color: colors.muted,
			},
		);
		drawTrend(
			document,
			panel.values,
			range,
			{
				x: left + 2,
				y: top + 11,
				width: panelWidth - 6,
				height: Math.max(4, panelHeight - 15),
			},
			series,
		);
	});
}

function drawTable(
	document: PdfDocument,
	body: Extract<PdfBody, { kind: "table" }>,
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	const count = Math.max(1, body.columns.length);
	const rowHeight = 12;
	const size = 7;
	const fits = Math.max(0, Math.floor((height - rowHeight) / rowHeight));
	const shown = body.rows.slice(0, fits);
	const hidden = body.rows.length - shown.length;
	const lastLine = hidden > 0 || body.more ? rowHeight : 0;
	const usableRows = lastLine ? shown.slice(0, Math.max(0, fits - 1)) : shown;

	// Figure columns take what their widest entry needs, as far as they can, and word columns
	// share the room left over.
	const padding = 6;
	const needed = body.columns.map((column, index) =>
		column.numeric
			? Math.max(
					textWidth(column.name, size, true),
					...usableRows.map((row) =>
						textWidth(row[index] ?? "", size),
					),
				) + padding
			: 0,
	);
	const figureTotal = needed.reduce((sum, value) => sum + value, 0);
	const wordy = body.columns.filter((column) => !column.numeric).length;
	const figureRoom = width * (wordy > 0 ? 0.75 : 1);
	const shrink = figureTotal > figureRoom ? figureRoom / figureTotal : 1;
	const wordWidth = wordy > 0 ? (width - figureTotal * shrink) / wordy : 0;
	const widths = body.columns.map((column, index) =>
		column.numeric ? needed[index] * shrink : wordWidth,
	);

	const cell = (
		text: string,
		column: number,
		top: number,
		bold: boolean,
		color: Rgba,
	) => {
		const left = widths.slice(0, column).reduce((sum, w) => sum + w, 0);
		const room = widths[column] - 4;
		const numericColumn = body.columns[column].numeric;
		document.text(
			x + left + (numericColumn ? widths[column] - 2 : 2),
			top + 9,
			fitText(text, room, size, bold),
			{
				size,
				bold,
				color,
				align: numericColumn ? "right" : "left",
			},
		);
	};

	document.rect(x, y, width, rowHeight, { fill: colors.band });
	body.columns.forEach((column, index) =>
		cell(column.name, index, y, true, colors.ink),
	);
	usableRows.forEach((row, rowIndex) => {
		const top = y + rowHeight * (rowIndex + 1);
		row.forEach((value, index) => {
			if (index < count) cell(value, index, top, false, colors.ink);
		});
		document.line(
			x,
			top + rowHeight,
			x + width,
			top + rowHeight,
			colors.line,
			0.25,
		);
	});
	if (lastLine) {
		const left = body.rows.length - usableRows.length;
		document.text(
			x + 2,
			y + rowHeight * (usableRows.length + 1) + 9,
			body.more || left <= 0
				? "More rows in the app."
				: `${left} more row${left === 1 ? "" : "s"} in the app.`,
			{ size, color: colors.muted },
		);
	}
}

function drawParagraphs(
	document: PdfDocument,
	paragraphs: string[],
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	const size = 8.5;
	const leading = 11;
	let top = y + size;
	for (const paragraph of paragraphs) {
		for (const line of wrapText(paragraph, width, size)) {
			if (top > y + height) return;
			document.text(x, top, line, { size });
			top += leading;
		}
		top += 4;
	}
}

// Each visual goes on the sheet where it sits on the page. One that would cross the bottom
// starts a new sheet, and one taller than a sheet is shrunk to fit.
export function drawReportPage(input: PdfPageInput): Uint8Array {
	const document = new PdfDocument(pageWidth, pageHeight);
	const scale = (pageWidth - margin * 2) / layoutWidth;
	const seriesColor = parseColor(input.series) ?? colors.ink;
	const contentTop = margin + headerHeight;
	const contentHeight = pageHeight - contentTop - margin - footerHeight;
	const pixelsPerSheet = contentHeight / scale;

	drawHeader(document, input);

	const ordered = [...input.visuals].sort(
		(a, b) => a.box.top - b.box.top || a.box.left - b.box.left,
	);
	let sheetStart = ordered[0]?.box.top ?? 0;
	for (const visual of ordered) {
		const height = Math.min(visual.box.height, pixelsPerSheet);
		if (visual.box.top - sheetStart + height > pixelsPerSheet) {
			document.addPage();
			drawHeader(document, input);
			sheetStart = visual.box.top;
		}
		const x = margin + visual.box.left * scale;
		const y = contentTop + (visual.box.top - sheetStart) * scale;
		const width = visual.box.width * scale;
		const boxHeight = height * scale;

		if (visual.body.kind === "heading") {
			document.text(
				x,
				y + 12,
				fitText(visual.body.text, width, 11, true),
				{
					size: 11,
					bold: true,
				},
			);
			continue;
		}

		document.rect(x, y, width, boxHeight, {
			stroke: colors.line,
			lineWidth: 0.5,
		});
		let top = y + 4;
		if (visual.title) {
			document.text(
				x + 6,
				top + 8,
				fitText(visual.title, width - 12, 8, true),
				{
					size: 8,
					bold: true,
				},
			);
			top += 13;
		}
		const innerX = x + 6;
		const innerWidth = width - 12;
		const innerHeight = y + boxHeight - top - 4;
		const body = visual.body;
		if (body.kind === "figures") {
			drawFigures(
				document,
				body.figures,
				innerX,
				top,
				innerWidth,
				innerHeight,
				seriesColor,
			);
		} else if (body.kind === "chart") {
			const captionLines = body.caption
				? wrapText(body.caption, innerWidth, 7).slice(0, 3)
				: [];
			const captionRoom = captionLines.length * 9;
			drawSvg(document, body.svg, {
				x: innerX,
				y: top,
				width: innerWidth,
				height: innerHeight - captionRoom,
			});
			captionLines.forEach((line, index) => {
				document.text(
					innerX,
					top + innerHeight - captionRoom + (index + 1) * 9 - 2,
					line,
					{ size: 7, color: colors.muted },
				);
			});
		} else if (body.kind === "pairs") {
			drawPairs(document, body, innerX, top, innerWidth, innerHeight);
		} else if (body.kind === "lines") {
			drawLines(document, body, innerX, top, innerWidth, innerHeight);
		} else if (body.kind === "multiples") {
			drawMultiples(
				document,
				body,
				innerX,
				top,
				innerWidth,
				innerHeight,
				seriesColor,
			);
		} else if (body.kind === "table") {
			drawTable(document, body, innerX, top, innerWidth, innerHeight);
		} else if (body.kind === "text") {
			drawParagraphs(
				document,
				body.paragraphs,
				innerX,
				top,
				innerWidth,
				innerHeight,
			);
		} else {
			drawParagraphs(
				document,
				[body.text],
				innerX,
				top,
				innerWidth,
				innerHeight,
			);
		}
	}

	const sheets = document.pageCount;
	const stamp = input.preparedOn.toLocaleString("en-US", {
		dateStyle: "medium",
		timeStyle: "short",
	});
	for (let index = 0; index < sheets; index += 1) {
		document.onPage(index, () => {
			document.text(
				margin,
				pageHeight - margin + 4,
				fitText(`Prepared for ${input.preparedFor}, ${stamp}`, 500, 7),
				{ size: 7, color: colors.muted },
			);
			document.text(
				pageWidth - margin,
				pageHeight - margin + 4,
				`Sheet ${index + 1} of ${sheets}`,
				{ size: 7, color: colors.muted, align: "right" },
			);
		});
	}
	return document.toBytes();
}
