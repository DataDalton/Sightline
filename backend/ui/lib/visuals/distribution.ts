// Working out the shape of a set of numbers.
//
// The plan for this was a bin expression in the GROUP BY, and that was the
// wrong shape for this platform. Every source here is a metric view: it carries
// its own semantic layer, measures are read with MEASURE(), and what comes back
// is aggregates rather than rows. There are no underlying records to put into
// buckets, so a SQL bin would have been binning something that is not there.
//
// What a distribution means against a metric view is the spread of a measure
// across whatever it is grouped by: how order value is distributed across
// customers, how margin is distributed across products. That is a question the
// query layer already answers, so the binning happens here, over an answer that
// has already come back and is already cached.
//
// It also means no SQL is built, nothing widens what a client can make the
// warehouse run, and both of these are testable without a warehouse at all.

export interface Bin {
	// The half-open interval this bin covers: from is included, to is not.
	from: number;
	to: number;
	count: number;
}

// Bins chosen by Sturges' rule, which is what most tools use and is right for
// the few hundred rows a chart asks for. Deliberately not Freedman-Diaconis:
// it is better on heavily skewed data and it produces a bin count that changes
// as the filter changes, so the same chart redraws with a different number of
// bars and reads as different data.
export function suggestBinCount(count: number): number {
	if (count <= 1) return 1;
	return Math.min(50, Math.max(5, Math.ceil(Math.log2(count) + 1)));
}

export function binValues(values: number[], bins?: number): Bin[] {
	const usable = values.filter((v) => Number.isFinite(v));
	if (usable.length === 0) return [];

	const min = Math.min(...usable);
	const max = Math.max(...usable);

	// Every value identical, so there is one bin and it holds all of them.
	// Splitting a zero range would divide by zero and produce bins of nothing.
	if (min === max) {
		return [{ from: min, to: min, count: usable.length }];
	}

	const count = Math.max(
		1,
		Math.floor(bins ?? suggestBinCount(usable.length)),
	);
	const width = (max - min) / count;

	const out: Bin[] = Array.from({ length: count }, (_, i) => ({
		from: min + width * i,
		to: min + width * (i + 1),
		count: 0,
	}));

	for (const value of usable) {
		// The last bin is closed at the top, so the maximum lands in it rather
		// than in a bin past the end of the array.
		const index = Math.min(count - 1, Math.floor((value - min) / width));
		out[index].count++;
	}

	return out;
}

export interface FiveNumber {
	min: number;
	q1: number;
	median: number;
	q3: number;
	max: number;
	// Values more than one and a half interquartile ranges outside the box,
	// which is the convention a box plot is read by.
	outliers: number[];
}

// The quantile at a fraction, interpolating between the two values it falls
// between. The same method percentile_cont uses, so a box drawn here and one
// computed in SQL agree.
function quantile(sorted: number[], fraction: number): number {
	if (sorted.length === 1) return sorted[0];
	const at = (sorted.length - 1) * fraction;
	const low = Math.floor(at);
	const high = Math.ceil(at);
	if (low === high) return sorted[low];
	return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

export function fiveNumber(values: number[]): FiveNumber | null {
	const usable = values.filter((v) => Number.isFinite(v));
	if (usable.length === 0) return null;

	const sorted = [...usable].sort((a, b) => a - b);
	const q1 = quantile(sorted, 0.25);
	const median = quantile(sorted, 0.5);
	const q3 = quantile(sorted, 0.75);
	const spread = q3 - q1;

	// The whiskers reach to the furthest value still inside the fence, not to
	// the fence itself. A whisker drawn at the fence would claim a value that
	// is not in the data.
	const lowFence = q1 - spread * 1.5;
	const highFence = q3 + spread * 1.5;

	const inside = sorted.filter((v) => v >= lowFence && v <= highFence);
	const outliers = sorted.filter((v) => v < lowFence || v > highFence);

	return {
		min: inside.length > 0 ? inside[0] : sorted[0],
		q1,
		median,
		q3,
		max:
			inside.length > 0
				? inside[inside.length - 1]
				: sorted[sorted.length - 1],
		outliers,
	};
}
