import {
	parseColor,
	type PaintStyle,
	type PathCommand,
	type Rgba,
	type TextStyle,
} from "./document";

// Draws a chart onto a PDF page from the SVG the charting library writes on the server, so
// a PDF shows the chart the page shows rather than a second drawing of it.
//
// Handles what that library writes, which is shapes, text, groups, transforms and flat or
// gradient fills. A gradient prints as its first colour.

type Matrix = [number, number, number, number, number, number];

const identity: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
	return [
		a[0] * b[0] + a[2] * b[1],
		a[1] * b[0] + a[3] * b[1],
		a[0] * b[2] + a[2] * b[3],
		a[1] * b[2] + a[3] * b[3],
		a[0] * b[4] + a[2] * b[5] + a[4],
		a[1] * b[4] + a[3] * b[5] + a[5],
	];
}

function parseTransform(value: string | undefined): Matrix {
	if (!value) return identity;
	let held = identity;
	for (const match of value.matchAll(/(\w+)\(([^)]*)\)/g)) {
		const args = match[2]
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
		if (match[1] === "matrix" && args.length === 6) {
			held = multiply(held, args as Matrix);
		} else if (match[1] === "translate") {
			held = multiply(held, [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]);
		} else if (match[1] === "scale") {
			const x = args[0] ?? 1;
			held = multiply(held, [x, 0, 0, args[1] ?? x, 0, 0]);
		} else if (match[1] === "rotate") {
			const angle = ((args[0] ?? 0) * Math.PI) / 180;
			const cos = Math.cos(angle);
			const sin = Math.sin(angle);
			held = multiply(held, [cos, sin, -sin, cos, 0, 0]);
		}
	}
	return held;
}

// An SVG arc as curves, by the conversion the SVG specification gives.
function arcToCurves(
	fromX: number,
	fromY: number,
	radiusX: number,
	radiusY: number,
	rotation: number,
	large: boolean,
	sweep: boolean,
	toX: number,
	toY: number,
): PathCommand[] {
	if (radiusX === 0 || radiusY === 0) return [{ op: "L", x: toX, y: toY }];
	if (fromX === toX && fromY === toY) return [];
	let rx = Math.abs(radiusX);
	let ry = Math.abs(radiusY);
	const phi = (rotation * Math.PI) / 180;
	const cosPhi = Math.cos(phi);
	const sinPhi = Math.sin(phi);
	const dx = (fromX - toX) / 2;
	const dy = (fromY - toY) / 2;
	const x1 = cosPhi * dx + sinPhi * dy;
	const y1 = -sinPhi * dx + cosPhi * dy;
	const stretch = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
	if (stretch > 1) {
		rx *= Math.sqrt(stretch);
		ry *= Math.sqrt(stretch);
	}
	const top = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
	const bottom = rx * rx * y1 * y1 + ry * ry * x1 * x1;
	const factor =
		(large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, top / bottom));
	const cx1 = (factor * (rx * y1)) / ry;
	const cy1 = (factor * -(ry * x1)) / rx;
	const centerX = cosPhi * cx1 - sinPhi * cy1 + (fromX + toX) / 2;
	const centerY = sinPhi * cx1 + cosPhi * cy1 + (fromY + toY) / 2;
	const angleOf = (ux: number, uy: number) => Math.atan2(uy, ux);
	const start = angleOf((x1 - cx1) / rx, (y1 - cy1) / ry);
	let delta = angleOf((-x1 - cx1) / rx, (-y1 - cy1) / ry) - start;
	if (sweep && delta < 0) delta += 2 * Math.PI;
	if (!sweep && delta > 0) delta -= 2 * Math.PI;

	const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
	const step = delta / segments;
	const handle = (4 / 3) * Math.tan(step / 4);
	const point = (angle: number, offsetX: number, offsetY: number) => {
		const x = rx * (Math.cos(angle) + offsetX);
		const y = ry * (Math.sin(angle) + offsetY);
		return [
			cosPhi * x - sinPhi * y + centerX,
			sinPhi * x + cosPhi * y + centerY,
		];
	};
	const out: PathCommand[] = [];
	for (let index = 0; index < segments; index += 1) {
		const a = start + index * step;
		const b = a + step;
		const [x1c, y1c] = point(
			a,
			-handle * Math.sin(a),
			handle * Math.cos(a),
		);
		const [x2c, y2c] = point(
			b,
			handle * Math.sin(b),
			-handle * Math.cos(b),
		);
		const [x, y] = index === segments - 1 ? [toX, toY] : point(b, 0, 0);
		out.push({ op: "C", x1: x1c, y1: y1c, x2: x2c, y2: y2c, x, y });
	}
	return out;
}

export function parsePath(d: string): PathCommand[] {
	const out: PathCommand[] = [];
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	let lastHandleX = 0;
	let lastHandleY = 0;
	let previous = "";
	for (const match of d.matchAll(/([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/gi)) {
		const letter = match[1];
		const relative = letter === letter.toLowerCase();
		const op = letter.toUpperCase();
		const args = (match[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(
			Number,
		);
		const size: Record<string, number> = {
			M: 2,
			L: 2,
			T: 2,
			H: 1,
			V: 1,
			C: 6,
			S: 4,
			Q: 4,
			A: 7,
			Z: 0,
		};
		const take = size[op];
		if (take === undefined) continue;
		if (op === "Z") {
			out.push({ op: "Z" });
			x = startX;
			y = startY;
			previous = op;
			continue;
		}
		for (let at = 0; at + take <= args.length; at += take) {
			const a = args.slice(at, at + take);
			const baseX = relative ? x : 0;
			const baseY = relative ? y : 0;
			if (op === "M" && at === 0) {
				x = baseX + a[0];
				y = baseY + a[1];
				startX = x;
				startY = y;
				out.push({ op: "M", x, y });
			} else if (op === "M" || op === "L" || op === "T") {
				x = baseX + a[0];
				y = baseY + a[1];
				out.push({ op: "L", x, y });
			} else if (op === "H") {
				x = baseX + a[0];
				out.push({ op: "L", x, y });
			} else if (op === "V") {
				y = baseY + a[0];
				out.push({ op: "L", x, y });
			} else if (op === "C" || op === "S") {
				const curved = previous === "C" || previous === "S";
				const [x1, y1] =
					op === "C"
						? [baseX + a[0], baseY + a[1]]
						: curved
							? [2 * x - lastHandleX, 2 * y - lastHandleY]
							: [x, y];
				const rest = op === "C" ? a.slice(2) : a;
				const x2 = baseX + rest[0];
				const y2 = baseY + rest[1];
				x = baseX + rest[2];
				y = baseY + rest[3];
				out.push({ op: "C", x1, y1, x2, y2, x, y });
				lastHandleX = x2;
				lastHandleY = y2;
			} else if (op === "Q") {
				const qx = baseX + a[0];
				const qy = baseY + a[1];
				const endX = baseX + a[2];
				const endY = baseY + a[3];
				out.push({
					op: "C",
					x1: x + (2 / 3) * (qx - x),
					y1: y + (2 / 3) * (qy - y),
					x2: endX + (2 / 3) * (qx - endX),
					y2: endY + (2 / 3) * (qy - endY),
					x: endX,
					y: endY,
				});
				x = endX;
				y = endY;
			} else if (op === "A") {
				const endX = baseX + a[5];
				const endY = baseY + a[6];
				out.push(
					...arcToCurves(
						x,
						y,
						a[0],
						a[1],
						a[2],
						a[3] === 1,
						a[4] === 1,
						endX,
						endY,
					),
				);
				x = endX;
				y = endY;
			}
			previous = op;
		}
	}
	return out;
}

function applyMatrix(commands: PathCommand[], m: Matrix): PathCommand[] {
	const map = (x: number, y: number) => ({
		x: m[0] * x + m[2] * y + m[4],
		y: m[1] * x + m[3] * y + m[5],
	});
	return commands.map((command) => {
		if (command.op === "Z") return command;
		if (command.op === "C") {
			const one = map(command.x1, command.y1);
			const two = map(command.x2, command.y2);
			const end = map(command.x, command.y);
			return {
				op: "C" as const,
				x1: one.x,
				y1: one.y,
				x2: two.x,
				y2: two.y,
				x: end.x,
				y: end.y,
			};
		}
		return { op: command.op, ...map(command.x, command.y) };
	});
}

function parseAttributes(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
		out[match[1]] = match[2];
	}
	for (const part of (out.style ?? "").split(";")) {
		const split = part.indexOf(":");
		if (split > 0) {
			const key = part.slice(0, split).trim();
			if (!(key in out)) out[key] = part.slice(split + 1).trim();
		}
	}
	return out;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&amp;/g, "&");
}

// What is inherited down through groups.
interface Scope {
	matrix: Matrix;
	fill: string | undefined;
	stroke: string | undefined;
	strokeWidth: number | undefined;
	opacity: number;
}

// Whatever a chart can be drawn onto, a PDF page or a slide.
export interface DrawingSurface {
	path: (commands: PathCommand[], style: PaintStyle) => void;
	text: (x: number, y: number, content: string, style: TextStyle) => void;
}

export function drawSvg(
	document: DrawingSurface,
	svg: string,
	box: { x: number; y: number; width: number; height: number },
): void {
	const opening = svg.match(/<svg\b([^>]*)>/);
	if (!opening) return;
	const root = parseAttributes(opening[1]);
	const viewBox = (root.viewBox ?? "")
		.split(/[\s,]+/)
		.filter(Boolean)
		.map(Number);
	const sourceWidth = viewBox[2] ?? Number(root.width) ?? box.width;
	const sourceHeight = viewBox[3] ?? Number(root.height) ?? box.height;
	const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);

	const gradients = new Map<string, string>();
	for (const match of svg.matchAll(
		/<(?:linear|radial)Gradient\b[^>]*\bid="([^"]+)"[^>]*>\s*<stop\b([^>]*)>/g,
	)) {
		const stop = parseAttributes(match[2]);
		gradients.set(match[1], stop["stop-color"] ?? "");
	}
	const colorOf = (spec: string | undefined, alpha: number): Rgba | null => {
		if (!spec) return null;
		const reference = spec.match(/^url\(#([^)]+)\)/);
		const parsed = parseColor(
			reference ? gradients.get(reference[1]) : spec,
		);
		return parsed ? { ...parsed, a: parsed.a * alpha } : null;
	};

	const stack: Scope[] = [
		{
			matrix: [scale, 0, 0, scale, box.x, box.y],
			fill: undefined,
			stroke: undefined,
			strokeWidth: undefined,
			opacity: 1,
		},
	];
	let skipping = 0;
	let openText: { attributes: Record<string, string>; scope: Scope } | null =
		null;

	const inner = svg.slice((opening.index ?? 0) + opening[0].length);
	for (const token of inner.matchAll(
		/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g,
	)) {
		const [, closing, tag, rawAttributes, selfClosing, words] = token;

		if (words !== undefined) {
			if (openText && !skipping && words.trim()) {
				drawText(document, decodeEntities(words), openText, colorOf);
			}
			continue;
		}

		if (["defs", "clipPath", "mask", "style", "title"].includes(tag)) {
			if (closing) skipping -= 1;
			else if (!selfClosing) skipping += 1;
			continue;
		}
		if (skipping) continue;

		if (closing) {
			if (tag === "g") stack.pop();
			if (tag === "text") openText = null;
			continue;
		}

		const attributes = parseAttributes(rawAttributes ?? "");
		const parent = stack[stack.length - 1];
		const elementOpacity = Number(attributes.opacity ?? 1);
		const scope: Scope = {
			matrix: multiply(
				parent.matrix,
				parseTransform(attributes.transform),
			),
			fill: attributes.fill ?? parent.fill,
			stroke: attributes.stroke ?? parent.stroke,
			strokeWidth:
				attributes["stroke-width"] !== undefined
					? Number(attributes["stroke-width"])
					: parent.strokeWidth,
			opacity:
				parent.opacity *
				(Number.isFinite(elementOpacity) ? elementOpacity : 1),
		};

		if (tag === "g") {
			if (!selfClosing) stack.push(scope);
			continue;
		}
		if (tag === "text") {
			if (!selfClosing) openText = { attributes, scope };
			continue;
		}

		const shape = shapeOf(tag, attributes);
		if (!shape) continue;

		const fillAlpha =
			scope.opacity * Number(attributes["fill-opacity"] ?? 1);
		const strokeAlpha =
			scope.opacity * Number(attributes["stroke-opacity"] ?? 1);
		// Shapes fill black when nothing is said, which is what the format means by it.
		const fill = colorOf(scope.fill ?? "#000000", fillAlpha);
		const stroke = colorOf(scope.stroke, strokeAlpha);
		const size = Math.sqrt(
			Math.abs(
				scope.matrix[0] * scope.matrix[3] -
					scope.matrix[1] * scope.matrix[2],
			),
		);
		const dash = (attributes["stroke-dasharray"] ?? "")
			.split(/[\s,]+/)
			.filter(Boolean)
			.map((part) => Number(part) * size)
			.filter((part) => part > 0);
		document.path(applyMatrix(shape, scope.matrix), {
			fill: tag === "line" || tag === "polyline" ? null : fill,
			stroke,
			lineWidth: (scope.strokeWidth ?? 1) * size,
			...(dash.length ? { dash } : {}),
		});
	}
}

function shapeOf(
	tag: string,
	attributes: Record<string, string>,
): PathCommand[] | null {
	const value = (name: string) => Number(attributes[name] ?? 0);
	if (tag === "path") return parsePath(attributes.d ?? "");
	if (tag === "rect") {
		const x = value("x");
		const y = value("y");
		const width = value("width");
		const height = value("height");
		return [
			{ op: "M", x, y },
			{ op: "L", x: x + width, y },
			{ op: "L", x: x + width, y: y + height },
			{ op: "L", x, y: y + height },
			{ op: "Z" },
		];
	}
	if (tag === "circle" || tag === "ellipse") {
		const rx = tag === "circle" ? value("r") : value("rx");
		const ry = tag === "circle" ? value("r") : value("ry");
		const cx = value("cx");
		const cy = value("cy");
		return parsePath(
			`M${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}Z`,
		);
	}
	if (tag === "line") {
		return [
			{ op: "M", x: value("x1"), y: value("y1") },
			{ op: "L", x: value("x2"), y: value("y2") },
		];
	}
	if (tag === "polyline" || tag === "polygon") {
		const numbers = (attributes.points ?? "")
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
		const out: PathCommand[] = [];
		for (let at = 0; at + 1 < numbers.length; at += 2) {
			out.push({
				op: at === 0 ? "M" : "L",
				x: numbers[at],
				y: numbers[at + 1],
			});
		}
		if (tag === "polygon") out.push({ op: "Z" });
		return out;
	}
	return null;
}

function drawText(
	document: DrawingSurface,
	content: string,
	open: { attributes: Record<string, string>; scope: Scope },
	colorOf: (spec: string | undefined, alpha: number) => Rgba | null,
): void {
	const { attributes, scope } = open;
	const fontSize = parseFloat(
		attributes["font-size"] ??
			attributes.font?.match(/([\d.]+)px/)?.[1] ??
			"12",
	);
	const m = scope.matrix;
	const size = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
	// A baseline given as the middle of the letters, moved to where the letters sit.
	const baseline = attributes["dominant-baseline"];
	const lift =
		baseline === "central" || baseline === "middle"
			? fontSize * 0.35
			: baseline === "hanging"
				? fontSize * 0.75
				: 0;
	const x = Number(attributes.x ?? 0);
	const y = Number(attributes.y ?? 0) + lift;
	const anchor = attributes["text-anchor"];
	const color = colorOf(scope.fill ?? "#000000", scope.opacity);
	if (!color) return;
	document.text(
		m[0] * x + m[2] * y + m[4],
		m[1] * x + m[3] * y + m[5],
		content,
		{
			size: fontSize * size,
			color,
			angle: Math.atan2(m[1], m[0]),
			bold: /bold|[6-9]00/.test(
				`${attributes["font-weight"] ?? ""} ${attributes.font ?? ""}`,
			),
			align:
				anchor === "middle"
					? "center"
					: anchor === "end"
						? "right"
						: "left",
		},
	);
}
