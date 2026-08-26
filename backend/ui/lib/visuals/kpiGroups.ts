// Splitting a row of scorecards into named bands.
//
// A page that wants "these four are the headline, these four are ratios, these
// four are counts" had to place three separate visuals to say it, one per band.
// That worked, and it lost the labels: a scorecard row renders without a frame,
// so the titles the authors gave those visuals were never shown to anybody. The
// grouping existed in the author's head and in the stored report, and a reader
// saw three unexplained bands of tiles.
//
// So the grouping moves into the visual. Measures stay one ordered list, which
// is what the encoding rules and the query are built from, and this describes
// how to slice it.

export interface KpiGroup {
	label?: string;
	// How many of the remaining measures this band takes.
	count: number;
}

export interface ResolvedKpiGroup {
	label: string | null;
	measures: string[];
}

// Groups in the order they are declared, each taking its count from what is
// left. Anything past the last declared group becomes a final unlabelled band
// rather than disappearing, because a measure an author added and cannot see is
// worse than one in the wrong place.
export function resolveKpiGroups(
	measures: string[],
	groups: KpiGroup[] | undefined,
): ResolvedKpiGroup[] {
	if (!groups || groups.length === 0) {
		return measures.length > 0 ? [{ label: null, measures }] : [];
	}

	const resolved: ResolvedKpiGroup[] = [];
	let at = 0;

	for (const group of groups) {
		if (at >= measures.length) break;
		// A count that is missing, zero or negative would consume nothing and
		// leave the band empty, so it takes one rather than rendering a label
		// with nothing under it.
		const take = Math.max(1, Math.floor(group.count || 1));
		const slice = measures.slice(at, at + take);
		if (slice.length === 0) break;
		resolved.push({
			label: group.label?.trim() ? group.label.trim() : null,
			measures: slice,
		});
		at += slice.length;
	}

	if (at < measures.length) {
		resolved.push({ label: null, measures: measures.slice(at) });
	}

	return resolved;
}
