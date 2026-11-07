import { markerCategory } from "../../lib/updates/model";

// Draws a line at the date an update took effect, on a chart with a time axis. A chart
// whose axis is not dates is handed back as it was.

interface ChartOption {
	xAxis?: { data?: unknown[] } | { data?: unknown[] }[];
	series?: { markLine?: { data?: unknown[] } & Record<string, unknown> }[];
	[key: string]: unknown;
}

export function withUpdateMarkers<T>(
	option: T,
	markers: { at: string; label: string }[],
): T {
	const held = option as ChartOption | null;
	if (!held || markers.length === 0 || !Array.isArray(held.series))
		return option;
	const axis = Array.isArray(held.xAxis) ? held.xAxis[0] : held.xAxis;
	const categories = axis?.data;
	if (!Array.isArray(categories) || held.series.length === 0) return option;

	const names = categories.map((category) =>
		typeof category === "object" && category !== null
			? String((category as { value?: unknown }).value)
			: String(category),
	);
	const lines = markers.flatMap((marker) => {
		const at = markerCategory(names, marker.at);
		return at === null
			? []
			: [
					{
						xAxis: at,
						name: marker.label,
						label: { show: false },
						tooltip: { formatter: marker.label },
					},
				];
	});
	if (lines.length === 0) return option;

	const [first, ...rest] = held.series;
	return {
		...held,
		series: [
			{
				...first,
				markLine: {
					symbol: "none",
					silent: false,
					lineStyle: { type: "dotted", width: 1 },
					...first.markLine,
					data: [...(first.markLine?.data ?? []), ...lines],
				},
			},
			...rest,
		],
	} as T;
}

// Marks points that stand out, with the reason as its tooltip. Only where the chart has a
// category axis to find them on, and on whichever side of the chart that axis is.
export function withOddMarks<T>(
	option: T,
	odd: { label: string; value: number; reason: string }[],
	color: string,
): T {
	const held = option as ChartOption & {
		yAxis?: { data?: unknown[] } | { data?: unknown[] }[];
	};
	if (!held || odd.length === 0 || !Array.isArray(held.series)) return option;
	if (held.series.length === 0) return option;
	const axisOf = (axis: unknown) =>
		(Array.isArray(axis) ? axis[0] : axis) as
			| { data?: unknown[] }
			| undefined;
	const across = axisOf(held.xAxis)?.data;
	const down = axisOf(held.yAxis)?.data;
	const sideways = !Array.isArray(across) && Array.isArray(down);
	const names = (sideways ? down : across) as unknown[] | undefined;
	if (!Array.isArray(names)) return option;
	const shown = new Set(
		names.map((name) =>
			typeof name === "object" && name !== null
				? String((name as { value?: unknown }).value)
				: String(name),
		),
	);
	const data = odd
		.filter((item) => shown.has(item.label))
		.map((item) => ({
			coord: sideways
				? [item.value, item.label]
				: [item.label, item.value],
			name: item.reason,
			tooltip: { formatter: `${item.label}: ${item.reason}` },
		}));
	if (data.length === 0) return option;
	const [first, ...rest] = held.series;
	return {
		...held,
		series: [
			{
				...first,
				markPoint: {
					symbol: "circle",
					symbolSize: 12,
					z: 20,
					label: { show: false },
					itemStyle: {
						color,
						borderColor: "#ffffff",
						borderWidth: 1,
					},
					data,
				},
			},
			...rest,
		],
	} as T;
}
