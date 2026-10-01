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
	// The expression a metric view holds for the field, read from its
	// definition at sync. Never compiled into a query. It says what kind of
	// figure a measure is, such as a sum or a rate.
	expression?: string | null;
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
	// Data that streams in rather than landing on a schedule. Answers are
	// reused for the live interval only and open pages refresh on it.
	isLive: boolean;
	// Dimension used as the default time axis for trend visuals.
	defaultTimeField: string | null;
	dimensions: SemanticField[];
	measures: SemanticField[];
	// Fields the source used to publish and no longer does, by name. Kept
	// apart from the pickers so nobody builds on one, and so a query naming
	// one can say what happened rather than fail in the warehouse.
	missingFields?: ReadonlyMap<string, MissingField>;
}

export interface MissingField {
	name: string;
	kind: FieldKind;
	missingSince: string | null;
	// The name an administrator confirmed it was renamed to.
	renamedTo: string | null;
	// A likely new name the sync offered, not yet confirmed.
	renameCandidate: string | null;
}

// Fully qualified object name, unquoted. For display and for comparing with
// names the catalogue reports, never for composing SQL. See quotedSourceRef.
export function sourceRef(source: SemanticSource): string {
	return `${source.catalog}.${source.schema}.${source.object}`;
}

// What registration accepts as a catalogue, schema or object name. Letters,
// digits, underscores and hyphens, so no name can carry a quote, a dot or
// whitespace into the SQL it is written into.
const namePattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,254}$/;

export function isValidObjectName(name: unknown): name is string {
	return typeof name === "string" && namePattern.test(name);
}

// A plain identifier the warehouse reads without quoting.
const bareName = /^[A-Za-z_][A-Za-z0-9_]*$/;

// One part of an object name, ready to write into SQL. A plain identifier is
// written as it is. Anything else is backticked with backticks inside doubled,
// which is how Databricks escapes them, so a crafted name closes nothing.
export function quoteName(part: string): string {
	return bareName.test(part) ? part : "`" + part.replace(/`/g, "``") + "`";
}

// The expression a table field is registered with. A column name can hold a
// backtick, so embedded ones are doubled and the name cannot close the quote
// and write the rest of the statement.
export function defaultTableExpr(name: string, kind: string): string {
	const column = `\`${name.replace(/`/g, "``")}\``;
	return kind === "measure" ? `SUM(${column})` : column;
}

// A catalogue, schema and object as one reference for SQL, each part quoted.
export function quotedRef(
	catalog: string,
	schema: string,
	object: string,
): string {
	return `${quoteName(catalog)}.${quoteName(schema)}.${quoteName(object)}`;
}

// Fully qualified object reference for the warehouse, each part quoted.
export function quotedSourceRef(source: SemanticSource): string {
	return quotedRef(source.catalog, source.schema, source.object);
}

// The record of a field the source no longer publishes, or null.
export function findMissingField(
	source: SemanticSource,
	name: string,
): MissingField | null {
	return source.missingFields?.get(name) ?? null;
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
