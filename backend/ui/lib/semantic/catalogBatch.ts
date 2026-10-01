// Asking one catalogue's information_schema about many tables or routines in
// one statement, rather than one statement each.
//
// A name pair is matched as schema and name together, written out as one
// equality per pair and joined with OR, with every value bound as a named
// parameter. Pure, so the statements can be tested without a warehouse.

export interface NameRef {
	catalog: string;
	schema: string;
	name: string;
}

// A three part table name split into its parts, or null when it is not fully
// qualified. Anything after the third part is ignored, as the walk always has.
export function splitTable(table: string): NameRef | null {
	const [catalog, schema, name] = table.split(".");
	if (!catalog || !schema || !name) return null;
	return { catalog, schema, name };
}

// Where a filter or mask routine lives. The routine can sit in another
// catalogue than the table it is attached to, so the catalogue comes from its
// own qualified name when that has one. Null when the name has no schema.
export function routineRef(
	tableCatalog: string,
	qualified: string,
): NameRef | null {
	const segments = qualified.split(".");
	const name = segments[segments.length - 1];
	const schema = segments[segments.length - 2];
	const catalog = segments[segments.length - 3] || tableCatalog;
	if (!schema || !name) return null;
	return { catalog, schema, name };
}

// Identifies a schema and name pair within one catalogue. Unity Catalog names
// are not case sensitive, so the pair is compared without regard to case.
export function pairKey(schema: string, name: string): string {
	return `${schema.toLowerCase()}\u0000${name.toLowerCase()}`;
}

// The pairs to ask each catalogue about, without repeats.
export function groupByCatalog(
	refs: NameRef[],
): Map<string, { schema: string; name: string }[]> {
	const out = new Map<
		string,
		Map<string, { schema: string; name: string }>
	>();
	for (const ref of refs) {
		const pairs = out.get(ref.catalog) ?? new Map();
		pairs.set(pairKey(ref.schema, ref.name), {
			schema: ref.schema,
			name: ref.name,
		});
		out.set(ref.catalog, pairs);
	}
	return new Map(
		[...out].map(([catalog, pairs]) => [catalog, [...pairs.values()]]),
	);
}

export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

// A WHERE clause matching any of the pairs, with its parameters.
export function pairPredicate(
	pairs: { schema: string; name: string }[],
	schemaColumn: string,
	nameColumn: string,
): { clause: string; params: Record<string, string> } {
	const params: Record<string, string> = {};
	const terms = pairs.map((pair, i) => {
		params[`s${i}`] = pair.schema;
		params[`n${i}`] = pair.name;
		return `(${schemaColumn} = :s${i} AND ${nameColumn} = :n${i})`;
	});
	return {
		clause: terms.length > 0 ? terms.join(" OR ") : "FALSE",
		params,
	};
}
