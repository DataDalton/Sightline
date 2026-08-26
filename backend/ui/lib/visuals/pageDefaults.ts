import { optionValue } from "./catalog";

// The filters a page carries before anybody touches it.
//
// A filter widget can declare what it is set to on arrival, which is worth
// having twice over: a page that opens on a sensible slice is closer to what
// the reader came for, and it asks the warehouse for far less than a page that
// opens on everything.
//
// Applying that in an effect after mount would defeat both. The visuals render
// first, issue their unfiltered query, and only then does the widget narrow
// them, so the page runs the widest query it has every time and then throws the
// answer away. It has to be in the opening state, which is why this is computed
// from the stored page rather than announced by the widget.
//
// Shared with the warmer for the same reason the query shape is: a default the
// server does not know about is a warm cache entry keyed on a filter the page
// never asks for.

export interface FilterClause {
	field: string;
	op: string;
	value?: string;
	values?: string[];
}

const dayMs = 24 * 60 * 60 * 1000;

const startOfDay = (d: Date) =>
	new Date(d.getFullYear(), d.getMonth(), d.getDate());
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Resolved against a date the caller supplies rather than against now(), so the
// server and the browser computing the same preset an hour apart still agree on
// the day, and so this stays testable.
export function resolvePreset(
	label: string,
	today: Date,
): [string, string] | null {
	const n = startOfDay(today);
	const back = (days: number): [string, string] => [
		iso(new Date(n.getTime() - days * dayMs)),
		iso(n),
	];

	switch (label) {
		case "7d":
			return back(7);
		case "30d":
			return back(30);
		case "90d":
			return back(90);
		case "12m":
			return [
				iso(new Date(n.getFullYear() - 1, n.getMonth(), n.getDate())),
				iso(n),
			];
		case "MTD":
			return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), iso(n)];
		case "QTD":
			return [
				iso(
					new Date(
						n.getFullYear(),
						Math.floor(n.getMonth() / 3) * 3,
						1,
					),
				),
				iso(n),
			];
		case "YTD":
			return [iso(new Date(n.getFullYear(), 0, 1)), iso(n)];
		default:
			return null;
	}
}

interface WidgetVisual {
	visualId: string;
	visualType: string;
	config: {
		dimensions?: string[];
		measures?: string[];
		options?: Record<string, unknown>;
	};
}

// Keyed by the widget that contributes them, matching how page filter state is
// held, so a reader clearing one widget clears exactly what it added.
export function openingFilters(
	visuals: WidgetVisual[],
	today: Date,
): Record<string, FilterClause[]> {
	const opening: Record<string, FilterClause[]> = {};

	for (const visual of visuals) {
		const field = visual.config.dimensions?.[0];

		if (visual.visualType === "dateRangeFilter") {
			const preset = optionValue<string>(
				visual.visualType,
				visual.config,
				"defaultPreset",
			);
			if (!field || !preset) continue;
			const range = resolvePreset(preset, today);
			if (!range) continue;
			opening[visual.visualId] = [
				{ field, op: "gte", value: range[0] },
				{ field, op: "lte", value: range[1] },
			];
			continue;
		}

		if (visual.visualType === "dropdownFilter") {
			const raw = optionValue<string>(
				visual.visualType,
				visual.config,
				"defaultValues",
			);
			if (!field || !raw) continue;
			const multiple =
				optionValue<boolean>(
					visual.visualType,
					visual.config,
					"multiple",
				) !== false;
			const values = raw
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean);
			if (values.length === 0) continue;
			opening[visual.visualId] = [
				{
					field,
					op: "eq",
					values: multiple ? values : values.slice(0, 1),
				},
			];
			continue;
		}

		if (visual.visualType === "toggleFilter") {
			const on = optionValue<boolean>(
				visual.visualType,
				visual.config,
				"defaultOn",
			);
			if (!field || on !== true) continue;
			const onValue =
				optionValue<string>(
					visual.visualType,
					visual.config,
					"onValue",
				) ?? "true";
			opening[visual.visualId] = [{ field, op: "eq", values: [onValue] }];
			continue;
		}

		if (visual.visualType === "thresholdControl") {
			const cutoff = optionValue<number>(
				visual.visualType,
				visual.config,
				"defaultValue",
			);
			const measure = visual.config.measures?.[0] ?? field;
			if (!measure || typeof cutoff !== "number") continue;
			const above =
				optionValue<string>(
					visual.visualType,
					visual.config,
					"direction",
				) !== "below";
			opening[visual.visualId] = [
				{
					field: measure,
					op: above ? "gte" : "lte",
					value: String(cutoff),
				},
			];
		}
	}

	return opening;
}
