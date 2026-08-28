// Figures worked out from the answer rather than asked of the warehouse.
//
// Every name in a spec resolves to a field the semantic registry defines, which
// is what makes the query layer safe: a client sends names, and a name the
// source does not define is refused rather than interpolated. The cost is that
// a figure nobody modelled upstream cannot be asked for at all. Share of total,
// running total, rank and the ratio between two measures are all arithmetic over
// numbers the warehouse has already returned, and every one of them needed a
// data engineer to add a measure before anybody could see it.
//
// So they are computed here, over rows that have already come back. Three things
// follow from that, and all three are the reason it is done this way:
//
//   No SQL is built, so none of this widens what a client can make the warehouse
//   run. The worst a malformed transform can do is name a column that is not
//   there, and that is refused when the spec is parsed.
//
//   They are pure functions of the result set, so they are testable on their own
//   rather than only against a warehouse.
//
//   They run before the answer is cached and the transforms are part of the
//   cache key, so a hit serves the derived columns too and costs nothing.
//
// What they cannot do is change which rows come back. A running total over the
// first five hundred rows of a larger result is a running total over those five
// hundred, and the visuals that use these ask for the whole set they draw.

export type QueryTransform =
	// Each row's share of the column's total, as a percentage.
	| { kind: "percentOfTotal"; measure: string; as: string }
	// The column accumulated down the rows, in the order they arrive.
	| { kind: "runningTotal"; measure: string; as: string }
	// Position in the column, 1 for the largest unless asked otherwise.
	| { kind: "rank"; measure: string; as: string; direction?: "asc" | "desc" }
	// One measure divided by another.
	| {
			kind: "ratio";
			measure: string;
			denominator: string;
			as: string;
			// Multiplies the result, so a ratio can be expressed as a
			// percentage without a second transform.
			scale?: number;
	  }
	// Every row against the first, with the first at 100.
	| { kind: "indexTo"; measure: string; as: string };

export const transformKinds = new Set([
	"percentOfTotal",
	"runningTotal",
	"rank",
	"ratio",
	"indexTo",
]);

// What each kind is called where an author picks one.
export const transformLabels: Record<QueryTransform["kind"], string> = {
	percentOfTotal: "Share of total",
	runningTotal: "Running total",
	rank: "Rank",
	ratio: "Divided by",
	indexTo: "Indexed to the first row",
};

function numberOf(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : null;
}

export interface TransformResult {
	rows: Record<string, unknown>[];
	columns: string[];
}

// Applies each transform in turn, so a later one can read a column an earlier
// one produced. That ordering is the author's, and it is what lets a ratio be
// taken of a running total.
export function applyTransforms(
	rows: Record<string, unknown>[],
	columns: string[],
	transforms: QueryTransform[] | undefined,
): TransformResult {
	if (!transforms || transforms.length === 0) return { rows, columns };

	// Copied once rather than per transform, so a chain of four does not build
	// four intermediate result sets.
	const out = rows.map((row) => ({ ...row }));
	const outColumns = [...columns];

	for (const transform of transforms) {
		const values = out.map((row) => numberOf(row[transform.measure]));

		switch (transform.kind) {
			case "percentOfTotal": {
				const total = values.reduce<number>(
					(sum, n) => sum + (n ?? 0),
					0,
				);
				for (const [index, row] of out.entries()) {
					const value = values[index];
					// A total of zero has no shares in it, and a missing
					// figure has no share either. Both are left empty rather
					// than reported as zero percent, which is a statement.
					row[transform.as] =
						total === 0 || value === null
							? null
							: (value / total) * 100;
				}
				break;
			}

			case "runningTotal": {
				let carried = 0;
				for (const [index, row] of out.entries()) {
					const value = values[index];
					// A gap does not reset the total and does not add to it.
					// The accumulation carries through, which is what a
					// running total means.
					if (value !== null) carried += value;
					row[transform.as] = carried;
				}
				break;
			}

			case "rank": {
				const ascending = transform.direction === "asc";
				// Ranked over the values that exist. A row with nothing in the
				// column is not last, it is unranked, and giving it a position
				// would put it in an order it is not in.
				const ordered = values
					.map((value, index) => ({ value, index }))
					.filter(
						(entry): entry is { value: number; index: number } =>
							entry.value !== null,
					)
					.sort((a, b) =>
						ascending ? a.value - b.value : b.value - a.value,
					);

				const positions = new Map<number, number>();
				let position = 0;
				let previous: number | null = null;
				for (const [seen, entry] of ordered.entries()) {
					// Ties share a position, and the next distinct value skips
					// the ones they used up. Two firsts are followed by a
					// third, which is what a ranking means everywhere else.
					if (previous === null || entry.value !== previous) {
						position = seen + 1;
						previous = entry.value;
					}
					positions.set(entry.index, position);
				}

				for (const [index, row] of out.entries()) {
					row[transform.as] = positions.get(index) ?? null;
				}
				break;
			}

			case "ratio": {
				const scale = transform.scale ?? 1;
				for (const [index, row] of out.entries()) {
					const value = values[index];
					const by = numberOf(row[transform.denominator]);
					// Dividing by nothing, or by zero, has no answer. Empty
					// rather than infinity, which formats as a number and
					// reads as one.
					row[transform.as] =
						value === null || by === null || by === 0
							? null
							: (value / by) * scale;
				}
				break;
			}

			case "indexTo": {
				// The first row that has a figure, not the first row: a series
				// beginning with a gap would otherwise index everything
				// against nothing.
				const base = values.find(
					(value): value is number => value !== null && value !== 0,
				);
				for (const [index, row] of out.entries()) {
					const value = values[index];
					row[transform.as] =
						base === undefined || value === null
							? null
							: (value / base) * 100;
				}
				break;
			}
		}

		// Named columns are appended in the order they were declared, and a
		// name reused simply overwrites, which is what re-running a transform
		// against the same name should do.
		if (!outColumns.includes(transform.as)) outColumns.push(transform.as);
	}

	return { rows: out, columns: outColumns };
}
