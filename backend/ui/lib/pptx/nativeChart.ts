import { zip } from "./zip";

// A chart PowerPoint treats as its own, so someone can restyle it and edit its numbers there.
// Holds the figures twice, as PowerPoint expects: in the chart for drawing, and in a small
// workbook beside it for Edit Data.

export type NativeKind =
	| "column"
	| "bar"
	| "stackedColumn"
	| "percentColumn"
	| "line"
	| "area"
	| "pie"
	| "donut";

export interface NativeChart {
	kind: NativeKind;
	categories: string[];
	series: {
		name: string;
		values: (number | null)[];
		// A forecast and its likely range, drawn apart from what has happened.
		style?: "forecast" | "range";
		// Which series' colour it shares, where it continues another.
		colorOf?: number;
	}[];
	// Excel's way of writing the figures, such as $#,##0.
	numberFormat: string;
}

const kindOfVisual: Record<string, NativeKind> = {
	barChart: "column",
	horizontalBarChart: "bar",
	stackedBarChart: "percentColumn",
	lineChart: "line",
	areaChart: "area",
	pieChart: "pie",
	donutChart: "donut",
};

export function excelFormat(hint: string | undefined): string {
	if (hint === "currency") return '"$"#,##0';
	if (hint === "percent") return '0.0"%"';
	if (hint === "integer") return "#,##0";
	return "#,##0.##";
}

// The chart for a visual, or null where PowerPoint has nothing that draws it the same way, which
// is then drawn as shapes instead. Two dimensions become one series per value of the second.
export function nativeChartFor(input: {
	visualType: string;
	rows: Record<string, unknown>[];
	dimensions: string[];
	measures: string[];
	hint?: string;
	forecast?: {
		periods: string[];
		series: {
			measure: string;
			values: number[];
			lower: number[];
			upper: number[];
		}[];
	} | null;
}): NativeChart | null {
	const { rows, dimensions, measures, forecast } = input;
	// A forecast's range only reads as lines, so it stays with charts drawn as lines.
	if (forecast && input.visualType !== "lineChart") return null;
	const kind = kindOfVisual[input.visualType];
	if (!kind || rows.length === 0 || measures.length === 0) return null;
	const [category, split] = dimensions;
	if (!category || dimensions.length > 2) return null;
	const round = kind === "pie" || kind === "donut";
	if (round && (split || measures.length > 1)) return null;

	const number = (value: unknown): number | null => {
		const held = Number(value);
		return value === null || value === undefined || !Number.isFinite(held)
			? null
			: held;
	};
	const categories = [
		...new Set(rows.map((row) => String(row[category] ?? ""))),
	];
	if (forecast) {
		for (const period of forecast.periods) {
			if (!categories.includes(period)) categories.push(period);
		}
	}

	if (split) {
		if (measures.length > 1) return null;
		const measure = measures[0];
		const names = [...new Set(rows.map((row) => String(row[split] ?? "")))];
		const cell = new Map(
			rows.map((row) => [
				`${row[category]}\u0000${row[split]}`,
				number(row[measure]),
			]),
		);
		return {
			kind: kind === "column" ? "stackedColumn" : kind,
			categories,
			series: names.map((name) => ({
				name,
				values: categories.map(
					(value) => cell.get(`${value}\u0000${name}`) ?? null,
				),
			})),
			numberFormat: excelFormat(input.hint),
		};
	}

	const byCategory = new Map(
		rows.map((row) => [String(row[category] ?? ""), row]),
	);
	const forecastLines = (forecast?.series ?? []).flatMap((held) => {
		const at = measures.indexOf(held.measure);
		if (at < 0) return [];
		const line = (values: number[]) =>
			categories.map((value) => {
				const index = forecast?.periods.indexOf(value) ?? -1;
				return index >= 0 ? (values[index] ?? null) : null;
			});
		const label = measures.length > 1 ? `${held.measure} ` : "";
		return [
			{
				name: `${label}Forecast`,
				values: line(held.values),
				style: "forecast" as const,
				colorOf: at,
			},
			{
				name: `${label}Likely low`,
				values: line(held.lower),
				style: "range" as const,
				colorOf: at,
			},
			{
				name: `${label}Likely high`,
				values: line(held.upper),
				style: "range" as const,
				colorOf: at,
			},
		];
	});
	return {
		kind,
		categories,
		series: [
			...measures.map((name) => ({
				name,
				values: categories.map((value) =>
					number(byCategory.get(value)?.[name]),
				),
			})),
			...forecastLines,
		],
		numberFormat: excelFormat(input.hint),
	};
}

export function escapeXml(text: string): string {
	return (
		text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			// Characters XML cannot hold, which would make the whole file unopenable.
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
	);
}

function columnName(index: number): string {
	let name = "";
	for (let at = index; at >= 0; at = Math.floor(at / 26) - 1) {
		name = String.fromCharCode(65 + (at % 26)) + name;
	}
	return name;
}

// The small workbook behind a chart.
export function chartWorkbook(chart: NativeChart): Buffer {
	const text = (reference: string, value: string) =>
		`<c r="${reference}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
	const header = [
		text("A1", ""),
		...chart.series.map((series, index) =>
			text(`${columnName(index + 1)}1`, series.name),
		),
	].join("");
	const rows = chart.categories
		.map((category, rowIndex) => {
			const row = rowIndex + 2;
			const cells = chart.series
				.map((series, index) => {
					const value = series.values[rowIndex];
					return value === null
						? ""
						: `<c r="${columnName(index + 1)}${row}"><v>${value}</v></c>`;
				})
				.join("");
			return `<row r="${row}">${text(`A${row}`, category)}${cells}</row>`;
		})
		.join("");
	return zip([
		{
			name: "[Content_Types].xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
		},
		{
			name: "_rels/.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		},
		{
			name: "xl/workbook.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		},
		{
			name: "xl/_rels/workbook.xml.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
		},
		{
			name: "xl/worksheets/sheet1.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${header}</row>${rows}</sheetData></worksheet>`,
		},
	]);
}

// The axis says $4M where the figures say $4,012,345, since long labels run into each other.
export function axisFormat(chart: NativeChart): string {
	const largest = Math.max(
		0,
		...chart.series.flatMap((held) =>
			held.values.map((value) => Math.abs(value ?? 0)),
		),
	);
	const money = chart.numberFormat.startsWith('"$"') ? '"$"' : "";
	if (largest >= 10_000_000) return `${money}0,,"M"`;
	if (largest >= 1_000_000) return `${money}0.0,,"M"`;
	if (largest >= 10_000) return `${money}0,"K"`;
	return chart.numberFormat;
}

function solid(color: string): string {
	return `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
}

const axisText = (size = 900) =>
	`<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}">${solid("595F69")}</a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;

// The chart part itself, reading from Sheet1 of its workbook.
export function chartXml(chart: NativeChart, colors: string[]): string {
	const count = chart.categories.length;
	const categoryRange = `Sheet1!$A$2:$A$${count + 1}`;
	const categories = `<c:cat><c:strRef><c:f>${categoryRange}</c:f><c:strCache><c:ptCount val="${count}"/>${chart.categories
		.map(
			(value, index) =>
				`<c:pt idx="${index}"><c:v>${escapeXml(value)}</c:v></c:pt>`,
		)
		.join("")}</c:strCache></c:strRef></c:cat>`;
	const round = chart.kind === "pie" || chart.kind === "donut";
	const line = chart.kind === "line";

	const series = chart.series
		.map((held, index) => {
			const column = columnName(index + 1);
			const color = colors[(held.colorOf ?? index) % colors.length];
			const stroke =
				held.style === "forecast"
					? `w="22225" cap="rnd">${solid(color)}<a:prstDash val="dash"/><a:round/>`
					: held.style === "range"
						? `w="9525" cap="rnd">${solid(color)}<a:prstDash val="sysDot"/><a:round/>`
						: `w="19050" cap="rnd">${solid(color)}<a:round/>`;
			const shape = line
				? `<c:spPr><a:ln ${stroke}</a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`
				: `<c:spPr>${solid(color)}</c:spPr>`;
			const points = round
				? chart.categories
						.map(
							(_, point) =>
								`<c:dPt><c:idx val="${point}"/><c:bubble3D val="0"/><c:spPr>${solid(colors[point % colors.length])}</c:spPr></c:dPt>`,
						)
						.join("")
				: "";
			const barInvert =
				chart.kind.includes("olumn") || chart.kind === "bar"
					? `<c:invertIfNegative val="0"/>`
					: "";
			return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>Sheet1!$${column}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${escapeXml(held.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>${shape}${barInvert}${points}${categories}<c:val><c:numRef><c:f>Sheet1!$${column}$2:$${column}$${count + 1}</c:f><c:numCache><c:formatCode>${escapeXml(chart.numberFormat)}</c:formatCode><c:ptCount val="${count}"/>${held.values
				.map((value, point) =>
					value === null
						? ""
						: `<c:pt idx="${point}"><c:v>${value}</c:v></c:pt>`,
				)
				.join(
					"",
				)}</c:numCache></c:numRef></c:val>${line ? `<c:smooth val="0"/>` : ""}</c:ser>`;
		})
		.join("");

	const axes = `<c:axId val="111111111"/><c:axId val="222222222"/>`;
	const horizontal = chart.kind === "bar";
	const grouping =
		chart.kind === "stackedColumn"
			? "stacked"
			: chart.kind === "percentColumn"
				? "percentStacked"
				: "clustered";
	const overlap = grouping === "clustered" ? "" : `<c:overlap val="100"/>`;
	const plot =
		chart.kind === "pie"
			? `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`
			: chart.kind === "donut"
				? `<c:doughnutChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/><c:holeSize val="58"/></c:doughnutChart>`
				: line
					? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axes}</c:lineChart>`
					: chart.kind === "area"
						? `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}${axes}</c:areaChart>`
						: `<c:barChart><c:barDir val="${horizontal ? "bar" : "col"}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}<c:gapWidth val="60"/>${overlap}${axes}</c:barChart>`;
	// A long run of dates labels every so often rather than turning each one on its side.
	const every = Math.ceil(count / 8);
	const labelSkip =
		count > 12
			? `<c:tickLblSkip val="${every}"/><c:tickMarkSkip val="${every}"/>`
			: "";
	const axisLines = round
		? ""
		: `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="${horizontal ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:spPr><a:ln w="9525">${solid("D0D4DA")}</a:ln></c:spPr>${axisText()}<c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>${labelSkip}<c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "b" : "l"}"/><c:majorGridlines><c:spPr><a:ln w="6350">${solid("E5E8EC")}</a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${escapeXml(grouping === "percentStacked" ? "0%" : axisFormat(chart))}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${axisText()}<c:crossAx val="111111111"/><c:crosses val="${horizontal ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>`;
	const legend =
		chart.series.length > 1 || round
			? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${axisText()}</c:legend>`
			: "";
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>${plot}${axisLines}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
}
