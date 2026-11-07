import {
	parseColor,
	textWidth,
	type PathCommand,
	type PaintStyle,
	type Rgba,
	type TextStyle,
} from "../pdf/document";
import type { DrawingSurface } from "../pdf/svgToPdf";
import {
	chartWorkbook,
	chartXml,
	escapeXml,
	type NativeChart,
} from "./nativeChart";
import { zip } from "./zip";

// A PowerPoint file written by hand. Text is text, tables are tables and common charts are
// PowerPoint's own, so whoever receives it can edit everything. Anything PowerPoint has no chart
// for is drawn as shapes, which can still be moved and recoloured.

// A wide slide, in points. A point is 12700 of PowerPoint's own units.
export const slideWidth = 960;
export const slideHeight = 540;

const emu = (points: number) => Math.round(points * 12700);

function hex(color: Rgba): string {
	const part = (value: number) =>
		Math.round(Math.max(0, Math.min(1, value)) * 255)
			.toString(16)
			.padStart(2, "0");
	return `${part(color.r)}${part(color.g)}${part(color.b)}`.toUpperCase();
}

function fillXml(color: Rgba | null | undefined): string {
	if (!color) return "<a:noFill/>";
	const alpha =
		color.a < 1 ? `<a:alpha val="${Math.round(color.a * 100000)}"/>` : "";
	return `<a:solidFill><a:srgbClr val="${hex(color)}">${alpha}</a:srgbClr></a:solidFill>`;
}

export interface TextRun {
	text: string;
	size: number;
	bold?: boolean;
	color?: string | null;
}

export type TextParagraph = TextRun[];

function paragraphsXml(
	paragraphs: TextParagraph[],
	align: "l" | "ctr" | "r" = "l",
): string {
	return paragraphs
		.map(
			(runs) =>
				`<a:p><a:pPr algn="${align}"/>${runs
					.map((run) => {
						const color =
							parseColor(run.color ?? "#16181d") ??
							(parseColor("#16181d") as Rgba);
						return `<a:r><a:rPr lang="en-US" sz="${Math.round(run.size * 100)}" b="${run.bold ? 1 : 0}" dirty="0">${fillXml(color)}</a:rPr><a:t>${escapeXml(run.text)}</a:t></a:r>`;
					})
					.join("")}</a:p>`,
		)
		.join("");
}

export class PptxSlide implements DrawingSurface {
	private readonly shapes: string[] = [];
	private nextId = 2;
	readonly charts: { chart: NativeChart; colors: string[] }[] = [];

	constructor(readonly title: string) {}

	private id(): number {
		const held = this.nextId;
		this.nextId += 1;
		return held;
	}

	// The slide's title, in the place PowerPoint keeps it, so its outline view and slide sorter
	// know what each slide is called. A title slide moves it to the middle and makes it large.
	titleBox(
		subtitle: string | null,
		accent: string | null,
		large = false,
	): void {
		const id = this.id();
		const place = large
			? `<a:xfrm><a:off x="${emu(72)}" y="${emu(170)}"/><a:ext cx="${emu(slideWidth - 144)}" cy="${emu(110)}"/></a:xfrm>`
			: "";
		this.shapes.push(
			`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${place}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphsXml([[{ text: this.title, size: large ? 40 : 24, bold: true }]], large ? "ctr" : "l")}</p:txBody></p:sp>`,
		);
		if (subtitle) {
			this.textBox(36, 58, slideWidth - 72, 18, [
				[{ text: subtitle, size: 11, color: "#666d77" }],
			]);
		}
		if (accent) {
			this.rect(36, 78, slideWidth - 72, 1.5, {
				fill: parseColor(accent),
			});
		}
	}

	textBox(
		x: number,
		y: number,
		width: number,
		height: number,
		paragraphs: TextParagraph[],
		options: {
			name?: string;
			align?: "l" | "ctr" | "r";
			wrap?: boolean;
			angle?: number;
			fill?: Rgba | null;
		} = {},
	): void {
		const rotation = options.angle
			? ` rot="${Math.round((((options.angle * 180) / Math.PI + 360) % 360) * 60000)}"`
			: "";
		const id = this.id();
		this.shapes.push(
			`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(options.name ?? `Text ${id}`)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${rotation}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml(options.fill)}</p:spPr><p:txBody><a:bodyPr wrap="${options.wrap === false ? "none" : "square"}" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphsXml(paragraphs, options.align)}</p:txBody></p:sp>`,
		);
	}

	table(
		x: number,
		y: number,
		width: number,
		columns: { name: string; numeric: boolean; width: number }[],
		rows: string[][],
		rowHeight: number,
		fontSize: number,
	): void {
		const id = this.id();
		const cell = (text: string, numeric: boolean, header: boolean) => {
			const color = header ? "#16181d" : "#16181d";
			return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraphsXml(
				[[{ text, size: fontSize, bold: header, color }]],
				numeric ? "r" : "l",
			)}</a:txBody><a:tcPr marL="45720" marR="45720" marT="18288" marB="18288" anchor="ctr"><a:lnL w="0"><a:noFill/></a:lnL><a:lnR w="0"><a:noFill/></a:lnR><a:lnT w="0"><a:noFill/></a:lnT><a:lnB w="6350"><a:solidFill><a:srgbClr val="DFE3E8"/></a:solidFill></a:lnB>${header ? `<a:solidFill><a:srgbClr val="F4F6F8"/></a:solidFill>` : "<a:noFill/>"}</a:tcPr></a:tc>`;
		};
		const row = (cells: string) =>
			`<a:tr h="${emu(rowHeight)}">${cells}</a:tr>`;
		const header = row(
			columns
				.map((column) => cell(column.name, column.numeric, true))
				.join(""),
		);
		const body = rows
			.map((values) =>
				row(
					columns
						.map((column, index) =>
							cell(values[index] ?? "", column.numeric, false),
						)
						.join(""),
				),
			)
			.join("");
		this.shapes.push(
			`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(rowHeight * (rows.length + 1))}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${columns
				.map((column) => `<a:gridCol w="${emu(column.width)}"/>`)
				.join(
					"",
				)}</a:tblGrid>${header}${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
		);
	}

	chart(
		x: number,
		y: number,
		width: number,
		height: number,
		chart: NativeChart,
		colors: string[],
	): void {
		const id = this.id();
		this.charts.push({ chart, colors });
		this.shapes.push(
			`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart${this.charts.length}"/></a:graphicData></a:graphic></p:graphicFrame>`,
		);
	}

	rect(
		x: number,
		y: number,
		width: number,
		height: number,
		style: PaintStyle,
	): void {
		const id = this.id();
		this.shapes.push(
			`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml(style.fill)}${this.lineXml(style)}</p:spPr></p:sp>`,
		);
	}

	private lineXml(style: PaintStyle): string {
		if (!style.stroke) return "<a:ln><a:noFill/></a:ln>";
		const dash = style.dash?.length ? `<a:prstDash val="dash"/>` : "";
		return `<a:ln w="${emu(style.lineWidth ?? 1)}">${fillXml(style.stroke)}${dash}</a:ln>`;
	}

	// One free shape. Its own box comes from its points, which PowerPoint measures from.
	path(commands: PathCommand[], style: PaintStyle): void {
		if (commands.length === 0 || (!style.fill && !style.stroke)) return;
		const xs: number[] = [];
		const ys: number[] = [];
		for (const command of commands) {
			if (command.op === "Z") continue;
			xs.push(command.x);
			ys.push(command.y);
			if (command.op === "C") {
				xs.push(command.x1, command.x2);
				ys.push(command.y1, command.y2);
			}
		}
		if (xs.length === 0) return;
		const left = Math.min(...xs);
		const top = Math.min(...ys);
		const width = Math.max(Math.max(...xs) - left, 0.01);
		const height = Math.max(Math.max(...ys) - top, 0.01);
		const point = (x: number, y: number) =>
			`<a:pt x="${emu(x - left)}" y="${emu(y - top)}"/>`;
		const steps = commands
			.map((command) => {
				if (command.op === "M") {
					return `<a:moveTo>${point(command.x, command.y)}</a:moveTo>`;
				}
				if (command.op === "L") {
					return `<a:lnTo>${point(command.x, command.y)}</a:lnTo>`;
				}
				if (command.op === "C") {
					return `<a:cubicBezTo>${point(command.x1, command.y1)}${point(command.x2, command.y2)}${point(command.x, command.y)}</a:cubicBezTo>`;
				}
				return "<a:close/>";
			})
			.join("");
		const id = this.id();
		this.shapes.push(
			`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(left)}" y="${emu(top)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${emu(width)}" h="${emu(height)}"${style.fill ? "" : ` fill="none"`}>${steps}</a:path></a:pathLst></a:custGeom>${fillXml(style.fill)}${this.lineXml(style)}</p:spPr></p:sp>`,
		);
	}

	// Words placed by their baseline, as a chart places them. A box is built around them.
	text(x: number, y: number, content: string, style: TextStyle): void {
		if (!content) return;
		const width = textWidth(content, style.size, style.bold) + 4;
		const height = style.size * 1.3;
		const lead =
			style.align === "right"
				? width
				: style.align === "center"
					? width / 2
					: 0;
		this.textBox(
			x - lead,
			y - style.size,
			width,
			height,
			[
				[
					{
						text: content,
						size: style.size,
						bold: style.bold,
						color: style.color ? `#${hex(style.color)}` : undefined,
					},
				],
			],
			{
				wrap: false,
				angle: style.angle,
				align:
					style.align === "right"
						? "r"
						: style.align === "center"
							? "ctr"
							: "l",
			},
		);
	}

	xml(): string {
		return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${this.shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
	}
}

const relationships = (items: { id: string; type: string; target: string }[]) =>
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
		.map(
			(item) =>
				`<Relationship Id="${item.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${item.type}" Target="${item.target}"/>`,
		)
		.join("")}</Relationships>`;

function themeXml(accents: string[]): string {
	const accent = (index: number) =>
		accents[index % accents.length].replace("#", "").toUpperCase();
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Report"><a:themeElements><a:clrScheme name="Report"><a:dk1><a:srgbClr val="16181D"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="434952"/></a:dk2><a:lt2><a:srgbClr val="F4F6F8"/></a:lt2>${[
		0, 1, 2, 3, 4, 5,
	]
		.map(
			(index) =>
				`<a:accent${index + 1}><a:srgbClr val="${accent(index)}"/></a:accent${index + 1}>`,
		)
		.join(
			"",
		)}<a:hlink><a:srgbClr val="0B5CD5"/></a:hlink><a:folHlink><a:srgbClr val="666D77"/></a:folHlink></a:clrScheme><a:fontScheme name="Report"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Report"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

const emptyTree = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`;
const namespaces = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const titlePlace = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(36)}" y="${emu(20)}"/><a:ext cx="${emu(slideWidth - 72)}" cy="${emu(38)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>`;

// The whole file, from its slides.
export function buildPresentation(input: {
	title: string;
	author: string;
	slides: PptxSlide[];
	accents: string[];
}): Buffer {
	const files: { name: string; data: Buffer | string }[] = [];
	const overrides: string[] = [];
	const override = (part: string, type: string) =>
		overrides.push(
			`<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`,
		);

	const sizes = `<p:sldSz cx="${emu(slideWidth)}" cy="${emu(slideHeight)}"/><p:notesSz cx="6858000" cy="9144000"/>`;
	files.push({
		name: "ppt/presentation.xml",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${namespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${input.slides
			.map(
				(_, index) =>
					`<p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`,
			)
			.join("")}</p:sldIdLst>${sizes}</p:presentation>`,
	});
	override("/ppt/presentation.xml", "presentationml.presentation.main");
	files.push({
		name: "ppt/_rels/presentation.xml.rels",
		data: relationships([
			{
				id: "rIdMaster",
				type: "slideMaster",
				target: "slideMasters/slideMaster1.xml",
			},
			{ id: "rIdTheme", type: "theme", target: "theme/theme1.xml" },
			...input.slides.map((_, index) => ({
				id: `rIdSlide${index + 1}`,
				type: "slide",
				target: `slides/slide${index + 1}.xml`,
			})),
		]),
	});

	files.push({
		name: "ppt/theme/theme1.xml",
		data: themeXml(input.accents),
	});
	override("/ppt/theme/theme1.xml", "theme");

	files.push({
		name: "ppt/slideMasters/slideMaster1.xml",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${namespaces}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${emptyTree}${titlePlace}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="2400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
	});
	override(
		"/ppt/slideMasters/slideMaster1.xml",
		"presentationml.slideMaster",
	);
	files.push({
		name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
		data: relationships([
			{
				id: "rIdLayout",
				type: "slideLayout",
				target: "../slideLayouts/slideLayout1.xml",
			},
			{ id: "rIdTheme", type: "theme", target: "../theme/theme1.xml" },
		]),
	});

	files.push({
		name: "ppt/slideLayouts/slideLayout1.xml",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${namespaces} type="titleOnly" preserve="1"><p:cSld name="Title only"><p:spTree>${emptyTree}${titlePlace}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
	});
	override(
		"/ppt/slideLayouts/slideLayout1.xml",
		"presentationml.slideLayout",
	);
	files.push({
		name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
		data: relationships([
			{
				id: "rIdMaster",
				type: "slideMaster",
				target: "../slideMasters/slideMaster1.xml",
			},
		]),
	});

	let chartNumber = 0;
	input.slides.forEach((slide, index) => {
		const number = index + 1;
		files.push({
			name: `ppt/slides/slide${number}.xml`,
			data: slide.xml(),
		});
		override(`/ppt/slides/slide${number}.xml`, "presentationml.slide");
		const links = [
			{
				id: "rIdLayout",
				type: "slideLayout",
				target: "../slideLayouts/slideLayout1.xml",
			},
		];
		slide.charts.forEach(({ chart, colors }, chartIndex) => {
			chartNumber += 1;
			links.push({
				id: `rIdChart${chartIndex + 1}`,
				type: "chart",
				target: `../charts/chart${chartNumber}.xml`,
			});
			files.push({
				name: `ppt/charts/chart${chartNumber}.xml`,
				data: chartXml(
					chart,
					colors.map((color) => color.replace("#", "").toUpperCase()),
				),
			});
			override(`/ppt/charts/chart${chartNumber}.xml`, "drawingml.chart");
			files.push({
				name: `ppt/charts/_rels/chart${chartNumber}.xml.rels`,
				data: relationships([
					{
						id: "rId1",
						type: "package",
						target: `../embeddings/Microsoft_Excel_Sheet${chartNumber}.xlsx`,
					},
				]),
			});
			files.push({
				name: `ppt/embeddings/Microsoft_Excel_Sheet${chartNumber}.xlsx`,
				data: chartWorkbook(chart),
			});
		});
		files.push({
			name: `ppt/slides/_rels/slide${number}.xml.rels`,
			data: relationships(links),
		});
	});

	files.push({
		name: "docProps/core.xml",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(input.title)}</dc:title><dc:creator>${escapeXml(input.author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`,
	});
	files.push({
		name: "_rels/.rels",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
	});
	files.unshift({
		name: "[Content_Types].xml",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${overrides.join("")}</Types>`,
	});
	return zip(files);
}
