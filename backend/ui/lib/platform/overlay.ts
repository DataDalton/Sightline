// Reconciles what an editor publishes with what a reader personalised.
//
// A saved view records differences against the report, never a snapshot of it.
// That distinction is the whole design:
//
//   Snapshot ("show exactly these six columns")
//     An editor adds a measure and nobody with a saved view ever sees it.
//     Their view pins the old list, so the edit reaches only people who never
//     personalised anything. This is how reporting tools end up with users
//     insisting a number is missing when it is right there for everyone else.
//
//   Delta ("hide Freight, add Discount Pct")
//     An editor adds a measure and it appears for everyone, including people
//     with saved views, because the view never claimed to be exhaustive. A
//     reader only loses a column by explicitly hiding it.
//
// The cost of the delta model is that a view can reference a field an editor
// later deleted. That is resolved by dropping unknown fields at render time
// and reporting them, rather than failing.

export interface ViewOverlay {
	// Fields from the report definition the reader chose to hide.
	hiddenDimensions?: string[];
	hiddenMeasures?: string[];
	// Fields the reader added that the report does not include.
	addedDimensions?: string[];
	addedMeasures?: string[];
	// Explicit ordering. Fields absent from this list keep report order and
	// follow the ones named here.
	dimensionOrder?: string[];
	measureOrder?: string[];
	// The reader's own filters and sort, which never affect anyone else.
	filters?: unknown[];
	sort?: { field: string; direction: "asc" | "desc" }[];
	options?: Record<string, unknown>;
}

export interface ResolvedFields {
	dimensions: string[];
	measures: string[];
	// Fields the overlay referenced that no longer exist on the source, so the
	// UI can tell the reader their view has drifted rather than silently
	// changing what they see.
	missing: string[];
}

function applyOrder(fields: string[], order: string[] | undefined): string[] {
	if (!order || order.length === 0) return fields;
	const known = new Set(fields);
	const ordered = order.filter((f) => known.has(f));
	const remainder = fields.filter((f) => !ordered.includes(f));
	return [...ordered, ...remainder];
}

// Combines the report's own field list with a reader's overlay.
//
// `available` is the current semantic layer for the source. Anything the
// overlay names that is not in it has been removed by an editor since the view
// was saved, so it is dropped and reported.
export function resolveFields(
	reportDimensions: string[],
	reportMeasures: string[],
	overlay: ViewOverlay | null,
	available: { dimensions: Set<string>; measures: Set<string> },
): ResolvedFields {
	if (!overlay) {
		return {
			dimensions: reportDimensions.filter((f) => available.dimensions.has(f)),
			measures: reportMeasures.filter((f) => available.measures.has(f)),
			missing: [
				...reportDimensions.filter((f) => !available.dimensions.has(f)),
				...reportMeasures.filter((f) => !available.measures.has(f)),
			],
		};
	}

	const missing: string[] = [];
	const hiddenDimensions = new Set(overlay.hiddenDimensions ?? []);
	const hiddenMeasures = new Set(overlay.hiddenMeasures ?? []);

	// Start from what the report publishes, minus what the reader hid. A field
	// the editor added since the view was saved is included here without the
	// reader doing anything, which is the point.
	const dimensions = reportDimensions.filter(
		(f) => !hiddenDimensions.has(f) && available.dimensions.has(f),
	);
	const measures = reportMeasures.filter(
		(f) => !hiddenMeasures.has(f) && available.measures.has(f),
	);

	for (const field of overlay.addedDimensions ?? []) {
		if (!available.dimensions.has(field)) {
			missing.push(field);
			continue;
		}
		if (!dimensions.includes(field)) dimensions.push(field);
	}

	for (const field of overlay.addedMeasures ?? []) {
		if (!available.measures.has(field)) {
			missing.push(field);
			continue;
		}
		if (!measures.includes(field)) measures.push(field);
	}

	// A hidden field that no longer exists is not drift worth reporting: the
	// reader wanted it gone and it is gone.
	for (const field of reportDimensions) {
		if (!available.dimensions.has(field) && !hiddenDimensions.has(field)) {
			missing.push(field);
		}
	}
	for (const field of reportMeasures) {
		if (!available.measures.has(field) && !hiddenMeasures.has(field)) {
			missing.push(field);
		}
	}

	return {
		dimensions: applyOrder(dimensions, overlay.dimensionOrder),
		measures: applyOrder(measures, overlay.measureOrder),
		missing: Array.from(new Set(missing)),
	};
}

// Turns a reader's concrete selection back into a delta against the report.
//
// The UI works in absolute terms because that is how a person thinks about a
// column picker. Storage has to be relative, so the conversion happens here at
// the boundary rather than being spread through the client.
export function toOverlay(
	reportDimensions: string[],
	reportMeasures: string[],
	chosenDimensions: string[],
	chosenMeasures: string[],
	extra?: Pick<ViewOverlay, "filters" | "sort" | "options">,
): ViewOverlay {
	const chosenDimensionSet = new Set(chosenDimensions);
	const chosenMeasureSet = new Set(chosenMeasures);

	return {
		hiddenDimensions: reportDimensions.filter(
			(f) => !chosenDimensionSet.has(f),
		),
		hiddenMeasures: reportMeasures.filter((f) => !chosenMeasureSet.has(f)),
		addedDimensions: chosenDimensions.filter(
			(f) => !reportDimensions.includes(f),
		),
		addedMeasures: chosenMeasures.filter((f) => !reportMeasures.includes(f)),
		// Order is recorded so a reader who rearranged columns keeps that
		// arrangement, with newly published fields appended rather than lost.
		dimensionOrder: chosenDimensions,
		measureOrder: chosenMeasures,
		filters: extra?.filters ?? [],
		sort: extra?.sort ?? [],
		options: extra?.options ?? {},
	};
}
