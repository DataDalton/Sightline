// Turning a brushed region into the rows it covers.
//
// The chart library reports a selection two ways: a list of selected data
// indices per series, and the coordinate range of the region that was drawn.
// The index list is the convenient one and the unreliable one: it is reported
// per series, it arrives on its own schedule, and it is empty whenever the
// chart is redrawn, which happens the moment the selection is acted on.
//
// The coordinate range is geometry. On a category axis it is a pair of
// positions along that axis, so the rows it covers are a slice, and a slice is
// something that can be reasoned about and tested rather than trusted.

export function rangeToIndices(
	coordRange: unknown,
	rowCount: number,
): number[] {
	if (!Array.isArray(coordRange) || coordRange.length < 2) return [];

	const a = Number(coordRange[0]);
	const b = Number(coordRange[1]);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return [];

	// Drawn right to left is the same selection drawn left to right.
	const low = Math.min(a, b);
	const high = Math.max(a, b);

	// Positions along a category axis are row indices. On an axis of values
	// they are the values themselves, and a date axis reports milliseconds,
	// which clamped to the row count would quietly select every row. A range
	// that cannot be index space selects nothing rather than everything.
	if (low > rowCount || high < -1) return [];

	// The edges land between categories. Rounding inwards would drop a column
	// the reader visibly covered, so a category is included when the region
	// reaches it at all.
	const first = Math.max(0, Math.round(low));
	const last = Math.min(rowCount - 1, Math.round(high));
	if (last < first) return [];

	const indices: number[] = [];
	for (let i = first; i <= last; i++) indices.push(i);
	return indices;
}

// The values those rows carry for the field the chart is broken down by.
//
// Expressed in the data rather than in pixel bounds, so the filter the page
// applies means the same thing to every other visual on it.
export function indicesToValues(
	indices: number[],
	rows: Record<string, unknown>[],
	field: string,
): string[] {
	const values: string[] = [];
	const seen = new Set<string>();
	for (const i of indices) {
		const raw = rows[i]?.[field];
		if (raw === null || raw === undefined) continue;
		const value = String(raw);
		if (value === "" || seen.has(value)) continue;
		seen.add(value);
		values.push(value);
	}
	return values;
}
