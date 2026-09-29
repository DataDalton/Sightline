// Small statistics shared by the checks that judge a figure against its own
// history, such as unusual alerts and late data.

// The value a fraction of the way through a sorted list, interpolating
// between neighbours. Zero for an empty list.
export function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const at = (sorted.length - 1) * q;
	const low = Math.floor(at);
	const high = Math.ceil(at);
	return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

// The middle value, sorting a copy first.
export function median(values: number[]): number {
	return quantile(
		[...values].sort((a, b) => a - b),
		0.5,
	);
}
