// Reading the field list out of a metric view definition.
//
// Kept free of database and network imports so it can be tested on its own:
// the kind split decides whether a field lands in a GROUP BY or inside
// MEASURE(), which changes what a query means rather than only how it looks.

// Extracts the dimension and measure names from a metric view definition.
//
// The definition is YAML embedded in the CREATE statement between dollar
// quotes. Only the names and which list they sit in are read: expressions stay
// in the view, which is the point of a metric view, and types come from
// information_schema where they are already resolved.
export function parseMetricViewFields(createStatement: string): {
	dimensions: string[];
	measures: string[];
} {
	const start = createStatement.indexOf("$$");
	const end = createStatement.lastIndexOf("$$");
	const body =
		start >= 0 && end > start
			? createStatement.slice(start + 2, end)
			: createStatement;

	const dimensions: string[] = [];
	const measures: string[] = [];
	let section: "dimensions" | "measures" | null = null;

	for (const line of body.split(/\r?\n/)) {
		// A key at the left margin opens or closes a section. "joins" also
		// holds "- name:" entries, so a list item only counts once the
		// enclosing section is known.
		const topLevel = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
		if (topLevel) {
			const key = topLevel[1];
			section =
				key === "dimensions" ? "dimensions" : key === "measures" ? "measures" : null;
			continue;
		}
		if (!section) continue;

		// Exactly one list indent. A continuation line inside a folded comment
		// is indented further, so it cannot be mistaken for a new field.
		const item = /^ {2}- name:\s*(.+?)\s*$/.exec(line);
		if (!item) continue;

		const name = item[1].replace(/^["']|["']$/g, "");
		if (!name) continue;
		(section === "dimensions" ? dimensions : measures).push(name);
	}

	return { dimensions, measures };
}
