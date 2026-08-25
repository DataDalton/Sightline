// The semantic layer: the set of named dimensions and measures a user can
// build a visual from, and the SQL each one compiles to.
//
// Field expressions are admin-authored and stored in Lakebase. A client only
// ever sends field names, which are resolved here. There is no code path that
// accepts SQL from a browser, so a crafted request can select fields it is not
// entitled to only if the access layer lets it, never by injecting an
// expression.

export type FieldKind = "dimension" | "measure";

export type FormatHint =
	| "currency"
	| "percent"
	| "integer"
	| "decimal"
	| "date"
	| "text";

export interface SemanticField {
	fieldId: string;
	sourceKey: string;
	// The key a client refers to the field by. For a metric view this is the
	// curated name; for a plain table it is the raw column name.
	name: string;
	// Human-readable label where the key is not already one. Presentation
	// only: nothing resolves a field by this.
	displayName: string | null;
	kind: FieldKind;
	// SQL expression evaluated against the source. Used only for table
	// sources: a metric view resolves its own fields by name, so re-declaring
	// the expression here would let the app drift from the view definition.
	sqlExpr: string | null;
	dataType: string | null;
	description: string | null;
	formatHint: FormatHint | null;
	// Unity Catalog column tags, so a tooltip can show how the source itself
	// classifies the field.
	tags: Record<string, string>;
	// Grouping label for the field picker.
	folder: string | null;
	sortOrder: number;
	isDefault: boolean;
}

// How a source is reached, and whether its results may be shared.
export type AccessMode = "direct" | "cached";

// What kind of object the source is, which decides how the query builder
// references its fields.
//
// A metric view owns its own aggregation: measures are read with MEASURE() and
// the caller never writes SUM or AVG. A plain table has no semantic layer, so
// each field carries the SQL expression to evaluate.
export type SourceKind = "metric_view" | "table";

export interface SemanticSource {
	sourceKey: string;
	title: string;
	description: string | null;
	catalog: string;
	schema: string;
	object: string;
	kind: SourceKind;
	accessMode: AccessMode;
	// True when Unity Catalog applies a row filter or column mask. Decides
	// whether a cache entry may be shared beyond a single policy class.
	hasRowFilter: boolean;
	cacheTtlSeconds: number;
	// Dimension used as the default time axis for trend visuals.
	defaultTimeField: string | null;
	dimensions: SemanticField[];
	measures: SemanticField[];
}

// Fully qualified object reference for the warehouse.
export function sourceRef(source: SemanticSource): string {
	return `${source.catalog}.${source.schema}.${source.object}`;
}

export function findField(
	source: SemanticSource,
	name: string,
	kind?: FieldKind,
): SemanticField | null {
	const pool =
		kind === "dimension"
			? source.dimensions
			: kind === "measure"
				? source.measures
				: [...source.dimensions, ...source.measures];
	return pool.find((f) => f.name === name) ?? null;
}
