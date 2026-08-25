// Value formatting shared by every visual, so a measure reads the same way in
// a KPI tile, a table cell and a chart axis.
//
// Databricks returns DECIMAL as a string to avoid the precision loss a JS
// number would introduce. That is correct, and it means every numeric path
// here has to accept a string and convert only for display.

export type FormatHint =
	| "currency"
	| "percent"
	| "integer"
	| "decimal"
	| "date"
	| "text";

export function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return Number(value);
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

const currencyFormat = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 0,
});

const currencyPreciseFormat = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

const integerFormat = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 0,
});

const decimalFormat = new Intl.NumberFormat("en-US", {
	minimumFractionDigits: 1,
	maximumFractionDigits: 2,
});

const percentFormat = new Intl.NumberFormat("en-US", {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});

// Compact form for KPI tiles and axis labels, where the exact figure matters
// less than the magnitude. 10486579701.6 reads as $10.5B.
export function formatCompact(value: unknown, hint: FormatHint): string {
	const n = toNumber(value);
	if (n === null) return "-";

	if (hint === "percent") return `${percentFormat.format(n)}%`;

	const abs = Math.abs(n);
	const sign = n < 0 ? "-" : "";
	const prefix = hint === "currency" ? "$" : "";

	if (abs >= 1_000_000_000)
		return `${sign}${prefix}${(abs / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000)
		return `${sign}${prefix}${(abs / 1_000_000).toFixed(1)}M`;
	if (abs >= 10_000) return `${sign}${prefix}${(abs / 1_000).toFixed(0)}K`;

	if (hint === "currency") return currencyFormat.format(n);
	if (hint === "integer") return integerFormat.format(n);
	return decimalFormat.format(n);
}

// Full precision, for table cells and tooltips where the figure is the point.
export function formatValue(value: unknown, hint: FormatHint): string {
	if (value === null || value === undefined || value === "") return "-";

	switch (hint) {
		case "currency": {
			const n = toNumber(value);
			return n === null ? String(value) : currencyPreciseFormat.format(n);
		}
		case "percent": {
			const n = toNumber(value);
			return n === null ? String(value) : `${percentFormat.format(n)}%`;
		}
		case "integer": {
			const n = toNumber(value);
			return n === null ? String(value) : integerFormat.format(n);
		}
		case "decimal": {
			const n = toNumber(value);
			return n === null ? String(value) : decimalFormat.format(n);
		}
		case "date":
			return formatDate(value);
		default:
			return String(value);
	}
}

export function formatDate(value: unknown): string {
	if (value === null || value === undefined || value === "") return "-";
	const text = String(value);
	// Databricks returns DATE as yyyy-MM-dd. Parsing that with the Date
	// constructor treats it as UTC and can shift the day backwards in a
	// negative offset, so the parts are read directly instead.
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
	if (match) {
		const [, year, month, day] = match;
		return `${month}/${day}/${year}`;
	}
	return text;
}

// True when a value should be rendered right-aligned and in tabular figures.
export function isNumericHint(hint: FormatHint): boolean {
	return (
		hint === "currency" ||
		hint === "percent" ||
		hint === "integer" ||
		hint === "decimal"
	);
}

// Signed variant for period-over-period deltas. The sign is always in the
// text, never carried by colour alone.
export function formatDelta(value: unknown, hint: FormatHint): string {
	const n = toNumber(value);
	if (n === null) return "-";
	const sign = n > 0 ? "+" : "";
	return `${sign}${formatCompact(n, hint)}`;
}
