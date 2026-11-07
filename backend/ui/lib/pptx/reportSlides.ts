import { fitText, parseColor, textWidth, type Rgba } from "../pdf/document";
import type { PdfBody, PdfFigure, PdfVisual, Tone } from "../pdf/reportPdf";
import { drawSvg } from "../pdf/svgToPdf";
import {
	PptxSlide,
	slideHeight,
	slideWidth,
	type TextParagraph,
} from "./presentation";

// Report visuals laid out on slides, placed where the page places them. Takes what each visual
// shows, already read, so it can be tested with no data behind it.

const margin = 36;
const contentTop = 88;
const contentBottom = slideHeight - 24;
const usableHeight = contentBottom - contentTop;
// The width a page is laid out at before being scaled onto a slide.
const layoutWidth = 1180;

const toneColor = (tone: Tone | undefined): string =>
	tone === "good"
		? "#1a7f45"
		: tone === "warn"
			? "#b5740b"
			: tone === "bad"
				? "#c22b2b"
				: "#666d77";

export interface SlidePage {
	title: string;
	subtitle: string | null;
	visuals: PdfVisual[];
	// Words said on the slide, for one designed in the app.
	text?: string | null;
	// A slide that is only its title, shown large.
	titleOnly?: boolean;
	// Designed in the app, so it is one slide whatever it holds.
	designed?: boolean;
	// Its words sit in a column beside what it shows.
	textBeside?: boolean;
}

// A page a little taller than a slide is squeezed onto one. Much taller and it runs on, since
// charts squeezed further stop being readable.
const squeezeLimit = 1.6;

function drawFigures(
	slide: PptxSlide,
	figures: PdfFigure[],
	x: number,
	y: number,
	width: number,
	height: number,
	series: string,
): void {
	const bands: { label: string | null; figures: PdfFigure[] }[] = [];
	for (const figure of figures) {
		const label = figure.band ?? null;
		const last = bands[bands.length - 1];
		if (last && last.label === label) last.figures.push(figure);
		else bands.push({ label, figures: [figure] });
	}
	const bandHeight = height / Math.max(1, bands.length);
	bands.forEach((band, bandIndex) => {
		let top = y + bandIndex * bandHeight;
		let room = bandHeight;
		if (band.label) {
			slide.textBox(x, top, width, 12, [
				[{ text: band.label, size: 9, bold: true, color: "#666d77" }],
			]);
			top += 13;
			room -= 13;
		}
		const tile = width / band.figures.length;
		band.figures.forEach((figure, index) => {
			const left = x + index * tile;
			const size = Math.min(26, Math.max(12, room * 0.34));
			const paragraphs: TextParagraph[] = [
				[{ text: figure.label, size: 10, color: "#666d77" }],
				[
					{
						text: figure.text,
						size,
						bold: true,
						color: figure.color,
					},
				],
			];
			for (const extra of [figure.change, figure.target]) {
				if (extra) {
					paragraphs.push([
						{
							text: extra.text,
							size: 9,
							color: toneColor(extra.tone),
						},
					]);
				}
			}
			const wordsHeight =
				12 +
				size * 1.25 +
				(figure.change ? 12 : 0) +
				(figure.target ? 12 : 0);
			slide.textBox(
				left,
				top,
				tile - 8,
				Math.min(room, wordsHeight + 4),
				paragraphs,
				{
					name: figure.label,
					fill: parseColor(figure.background),
				},
			);
			const values = (figure.trend ?? []).filter(
				(value): value is number => value !== null,
			);
			const trendRoom = room - wordsHeight - 6;
			if (values.length > 1 && trendRoom > 8) {
				drawTrend(
					slide,
					figure.trend ?? [],
					{ min: Math.min(...values), max: Math.max(...values) },
					{
						x: left,
						y: top + wordsHeight + 4,
						width: tile - 12,
						height: Math.min(trendRoom, 34),
					},
					figure.color ?? series,
				);
			}
		});
	});
}

function drawTrend(
	slide: PptxSlide,
	values: (number | null)[],
	range: { min: number; max: number },
	box: { x: number; y: number; width: number; height: number },
	color: string,
): void {
	if (values.length < 2) return;
	const span = range.max - range.min || 1;
	const commands: Parameters<PptxSlide["path"]>[0] = [];
	let drawing = false;
	values.forEach((value, index) => {
		if (value === null) {
			drawing = false;
			return;
		}
		commands.push({
			op: drawing ? "L" : "M",
			x: box.x + (index / (values.length - 1)) * box.width,
			y: box.y + box.height - ((value - range.min) / span) * box.height,
		});
		drawing = true;
	});
	slide.path(commands, {
		stroke: parseColor(color) as Rgba,
		lineWidth: 1,
	});
}

function drawTable(
	slide: PptxSlide,
	body: Extract<PdfBody, { kind: "table" }>,
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	const fontSize = 10;
	const rowHeight = 18;
	const fits = Math.max(0, Math.floor(height / rowHeight) - 1);
	const left = body.rows.length - fits;
	const noteNeeded = left > 0 || body.more;
	const shown = body.rows.slice(0, noteNeeded ? Math.max(0, fits - 1) : fits);

	const needed = body.columns.map((column, index) =>
		column.numeric
			? Math.max(
					textWidth(column.name, fontSize, true),
					...shown.map((row) =>
						textWidth(row[index] ?? "", fontSize),
					),
				) + 12
			: 0,
	);
	const total = needed.reduce((sum, value) => sum + value, 0);
	const wordy = body.columns.filter((column) => !column.numeric).length;
	const room = width * (wordy > 0 ? 0.75 : 1);
	const shrink = total > room ? room / total : 1;
	const wordWidth = wordy > 0 ? (width - total * shrink) / wordy : 0;
	const columns = body.columns.map((column, index) => ({
		...column,
		width: column.numeric ? needed[index] * shrink : wordWidth,
	}));
	slide.table(x, y, width, columns, shown, rowHeight, fontSize);
	if (noteNeeded) {
		slide.textBox(x, y + rowHeight * (shown.length + 1) + 2, width, 14, [
			[
				{
					text: body.more
						? "More rows in the app."
						: `${body.rows.length - shown.length} more rows in the app.`,
					size: 9,
					color: "#666d77",
				},
			],
		]);
	}
}

function drawBody(
	slide: PptxSlide,
	body: PdfBody,
	x: number,
	y: number,
	width: number,
	height: number,
	colors: string[],
): void {
	if (body.kind === "figures") {
		drawFigures(slide, body.figures, x, y, width, height, colors[0]);
	} else if (body.kind === "chart") {
		const captionRoom = body.caption ? 16 : 0;
		const room = height - captionRoom;
		if (body.native) {
			slide.chart(x, y, width, room, body.native, colors);
		} else {
			drawSvg(slide, body.svg, { x, y, width, height: room });
		}
		if (body.caption) {
			slide.textBox(x, y + room + 2, width, 14, [
				[
					{
						text: fitText(body.caption, width * 1.4, 9),
						size: 9,
						color: "#666d77",
					},
				],
			]);
		}
	} else if (body.kind === "table") {
		drawTable(slide, body, x, y, width, height);
	} else if (body.kind === "text") {
		slide.textBox(
			x,
			y,
			width,
			height,
			body.paragraphs.map((text) => [{ text, size: 12 }]),
		);
	} else if (body.kind === "note") {
		slide.textBox(x, y, width, height, [
			[{ text: body.text, size: 11, color: "#666d77" }],
		]);
	} else if (body.kind === "pairs") {
		slide.table(
			x,
			y,
			width,
			[
				{ name: "", numeric: false, width: width * 0.4 },
				{ name: "", numeric: false, width: width * 0.6 },
			],
			body.pairs.map((pair) => [pair.label, pair.text]),
			18,
			10,
		);
		if (body.notice) {
			slide.textBox(x, y + 18 * (body.pairs.length + 1) + 4, width, 14, [
				[{ text: body.notice, size: 9, color: "#b5740b" }],
			]);
		}
	} else if (body.kind === "lines") {
		slide.textBox(
			x,
			y,
			width,
			height,
			body.lines.map((line) => [
				{
					text: line.text,
					size: line.large ? 22 : 11,
					bold: line.large,
					color: line.tone
						? toneColor(line.tone)
						: line.large
							? undefined
							: "#666d77",
				},
			]),
		);
		if (body.bar) {
			const barTop = y + height - 8;
			slide.rect(x, barTop, width, 6, { fill: parseColor("#eef0f3") });
			slide.rect(x, barTop, width * Math.min(1, body.bar.share), 6, {
				fill: parseColor(toneColor(body.bar.tone)),
			});
		}
	} else if (body.kind === "multiples") {
		const count = body.panels.length;
		const columns = Math.max(
			1,
			Math.min(count, Math.ceil(Math.sqrt((count * width) / height))),
		);
		const rows = Math.ceil(count / columns);
		const panelWidth = width / columns;
		const panelHeight = height / rows;
		body.panels.forEach((panel, index) => {
			const left = x + (index % columns) * panelWidth;
			const top = y + Math.floor(index / columns) * panelHeight;
			slide.textBox(left, top, panelWidth - 6, 12, [
				[{ text: panel.label, size: 9, color: "#666d77" }],
			]);
			drawTrend(
				slide,
				panel.values,
				{ min: body.min, max: body.max },
				{
					x: left,
					y: top + 14,
					width: panelWidth - 8,
					height: Math.max(6, panelHeight - 20),
				},
				colors[0],
			);
		});
	}
}

// One or more slides for a page. A visual that would cross the bottom starts another slide.
export function slidesForPage(
	page: SlidePage,
	theme: { accent: string | null; colors: string[] },
): PptxSlide[] {
	const start = () => {
		const count = slides.length;
		const slide = new PptxSlide(
			count === 0 ? page.title : `${page.title} (${count + 1})`,
		);
		slide.titleBox(page.subtitle, theme.accent);
		slides.push(slide);
		return slide;
	};
	const slides: PptxSlide[] = [];
	if (page.titleOnly) {
		const slide = new PptxSlide(page.title);
		slide.titleBox(null, null, true);
		if (page.text) {
			slide.textBox(
				margin * 2,
				290,
				slideWidth - margin * 4,
				120,
				[[{ text: page.text, size: 20, color: "#434952" }]],
				{ align: "ctr" },
			);
		}
		return [slide];
	}

	let slide = start();
	const ordered = [...page.visuals].sort(
		(a, b) => a.box.top - b.box.top || a.box.left - b.box.left,
	);

	// Words take a column or a strip, and what the slide shows has the rest.
	let areaLeft = margin;
	let areaWidth = slideWidth - margin * 2;
	let areaTop = contentTop;
	if (page.text && page.textBeside) {
		slide.textBox(margin, contentTop, areaWidth * 0.28, usableHeight, [
			[{ text: page.text, size: 14, color: "#434952" }],
		]);
		areaLeft = margin + areaWidth * 0.3;
		areaWidth *= 0.7;
	} else if (page.text) {
		slide.textBox(margin, contentTop - 4, areaWidth, 30, [
			[{ text: page.text, size: 13, color: "#434952" }],
		]);
		areaTop += 34;
	}
	const room = contentBottom - areaTop;
	const across = areaWidth / layoutWidth;
	const first = ordered[0]?.box.top ?? 0;
	const fullHeight = Math.max(
		0,
		...ordered.map((visual) => visual.box.top + visual.box.height - first),
	);
	const naturalHeight = fullHeight * across;
	const fits = page.designed || naturalHeight <= room * squeezeLimit;
	const down = fits && naturalHeight > room ? room / fullHeight : across;

	let sliceStart = first;
	for (const visual of ordered) {
		const height = Math.min(visual.box.height * down, room);
		if ((visual.box.top - sliceStart) * down + height > room + 0.5) {
			slide = start();
			sliceStart = visual.box.top;
		}
		const x = areaLeft + visual.box.left * across;
		const y = areaTop + (visual.box.top - sliceStart) * down;
		const width = visual.box.width * across;
		let top = y;
		if (visual.body.kind === "heading") {
			slide.textBox(x, y, width, 22, [
				[{ text: visual.body.text, size: 16, bold: true }],
			]);
			continue;
		}
		if (visual.title) {
			slide.textBox(x, top, width, 16, [
				[{ text: visual.title, size: 12, bold: true }],
			]);
			top += 18;
		}
		drawBody(
			slide,
			visual.body,
			x,
			top,
			width - 6,
			Math.max(10, y + height - top - 4),
			theme.colors,
		);
	}
	return slides;
}
