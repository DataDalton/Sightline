import type {
	BoardItem,
	ColorName,
	ItemStyle,
	LineStyle,
	TextSize,
} from "../../lib/boards/definition";

// Board colours as theme colours. A board stores colour names, and each is
// drawn from the theme's own chart and text colours, so the same board reads
// in light and dark.

type Named = Exclude<ColorName, "none" | "default">;

const tokens: Record<Named, string> = {
	grey: "var(--text-muted)",
	blue: "var(--chart-1)",
	teal: "var(--chart-2)",
	orange: "var(--chart-3)",
	purple: "var(--chart-4)",
	pink: "var(--chart-5)",
	green: "var(--chart-7)",
	red: "var(--chart-8)",
	yellow: "var(--brand)",
};

// The colours offered in a picker, in order.
export const swatches: Named[] = [
	"grey",
	"blue",
	"teal",
	"green",
	"yellow",
	"orange",
	"red",
	"pink",
	"purple",
];

// A line, border or arrow.
export function strokeOf(name: ColorName | undefined): string {
	if (name === "none") return "transparent";
	if (!name || name === "default") return "var(--border-strong)";
	return tokens[name];
}

// A shape's inside, light enough that its words stay readable.
export function fillOf(name: ColorName | undefined): string {
	if (name === "none") return "transparent";
	if (!name || name === "default") return "var(--surface-raised)";
	return `color-mix(in srgb, ${tokens[name]} 20%, var(--surface-raised))`;
}

// A swatch in a picker, at full strength so colours can be told apart.
export function swatchOf(name: ColorName): string {
	if (name === "none") return "transparent";
	if (name === "default") return "var(--surface-raised)";
	return tokens[name];
}

export function textOf(name: ColorName | undefined): string {
	if (!name || name === "default" || name === "none")
		return "var(--text-primary)";
	return tokens[name];
}

export const textPixels: Record<TextSize, number> = {
	small: 13,
	medium: 16,
	large: 22,
	title: 32,
};

export function dashOf(style: LineStyle | undefined, width: number): string {
	if (style === "dashed") return `${width * 3} ${width * 2}`;
	if (style === "dotted") return `0 ${width * 2}`;
	return "none";
}

// What each kind of item looks like when nothing has been set on it.
const defaults: Record<Exclude<BoardItem["kind"], "visual">, ItemStyle> = {
	shape: {
		fill: "default",
		stroke: "default",
		strokeWidth: 2,
		strokeStyle: "solid",
		textColor: "default",
		textSize: "medium",
		bold: false,
		italic: false,
		align: "center",
		valign: "middle",
	},
	note: {
		textColor: "default",
		textSize: "medium",
		bold: false,
		italic: false,
		align: "left",
		valign: "top",
	},
	text: {
		textColor: "default",
		textSize: "title",
		bold: true,
		italic: false,
		align: "left",
		valign: "top",
	},
};

export function styleOf(item: BoardItem): Required<ItemStyle> {
	const base = item.kind === "visual" ? defaults.shape : defaults[item.kind];
	return {
		...defaults.shape,
		...base,
		...(item.style ?? {}),
	} as Required<ItemStyle>;
}
