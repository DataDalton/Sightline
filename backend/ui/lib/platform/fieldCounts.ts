// How many items name each field, split by the source the field is on. Pure,
// so the counting can be tested without the platform store.
//
// Every item a walk finds belongs to one of the sources walked, so counts made
// one source at a time add up to the counts of a walk over all of them. That is
// what lets each source's counts be held once and shared by every reader who
// may read it.

export interface FieldMention {
	sourceKey: string;
	field: string;
	kind: string;
	id: string;
}

// Counts per source, for exactly the sources named. A source nothing names
// still gets an empty entry, so it is known to have been counted.
export function countsBySource(
	mentions: FieldMention[],
	sourceKeys: string[],
	keyOf: (sourceKey: string, field: string) => string,
): Map<string, Map<string, number>> {
	const bySource = new Map<string, Map<string, number>>(
		sourceKeys.map((key) => [key, new Map<string, number>()]),
	);
	// Each item counted once per field, however many places in it name it.
	const seen = new Set<string>();
	for (const m of mentions) {
		const counts = bySource.get(m.sourceKey);
		if (!counts) continue;
		const key = keyOf(m.sourceKey, m.field);
		const item = `${key}\u0000${m.kind}\u0000${m.id}`;
		if (seen.has(item)) continue;
		seen.add(item);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return bySource;
}

// The counts of several sources as one map. Keys carry their source, so no
// two sources share a key and nothing is added twice.
export function mergeCounts(parts: Map<string, number>[]): Map<string, number> {
	const merged = new Map<string, number>();
	for (const part of parts) {
		for (const [key, count] of part) {
			merged.set(key, (merged.get(key) ?? 0) + count);
		}
	}
	return merged;
}
