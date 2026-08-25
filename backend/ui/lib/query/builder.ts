import { valuelessOperators } from "../search/types";
import {
	findField,
	sourceRef,
	type SemanticField,
	type SemanticSource,
} from "../semantic/types";
import { QuerySpecError, type QueryFilter, type QuerySpec } from "./spec";

// Compiles a validated QuerySpec into Databricks SQL.
//
// Most sources are metric views, which carry their own semantic layer: each
// measure already defines its aggregation, read with MEASURE(), and the caller
// never writes SUM or AVG. That is the point of them. Re-deriving aggregation
// here would let the app disagree with every other consumer of the same view,
// which is exactly the drift metric views exist to prevent.
//
// Plain tables have no such layer, so their fields carry an expression the
// registry supplies.
//
// Two rules make this safe, both structural rather than a matter of
// remembering:
//
//   1. Every identifier in the output comes from the semantic registry. A
//      client sends field names; a name the source does not define is rejected
//      here rather than interpolated.
//   2. Every value from the client is bound as a named parameter. No client
//      value is ever concatenated into the SQL string.
//
// Row filtering is not this module's job. The query runs under the caller's
// own token, so Unity Catalog applies row filters and column masks during the
// scan. The platform deliberately does not reimplement them.

export interface CompiledQuery {
	sql: string;
	params: Record<string, unknown>;
	// Output column names in order, so the client reads the result set without
	// guessing.
	columns: string[];
}

// Databricks quotes identifiers with backticks. Metric view field names carry
// spaces, so every reference is quoted and embedded backticks are doubled.
function quoteIdent(name: string): string {
	return `\`${name.replace(/`/g, "``")}\``;
}

// How a field is referenced in a SELECT, WHERE, GROUP BY or HAVING clause.
//
// For a metric view the reference is the field name, with measures wrapped in
// MEASURE(). For a table it is the expression the registry carries.
function fieldRef(source: SemanticSource, field: SemanticField): string {
	if (source.kind === "metric_view") {
		return field.kind === "measure"
			? `MEASURE(${quoteIdent(field.name)})`
			: quoteIdent(field.name);
	}

	if (!field.sqlExpr) {
		throw new QuerySpecError(
			`Field "${field.name}" on table source "${source.sourceKey}" has no expression`,
		);
	}
	return field.sqlExpr;
}

function isNumericType(dataType: string | null): boolean {
	return (
		dataType !== null &&
		/int|double|decimal|float|long|numeric|bigint|smallint/i.test(dataType)
	);
}

function isDateType(dataType: string | null): boolean {
	return dataType !== null && /date|timestamp/i.test(dataType);
}

function buildFilterSql(
	source: SemanticSource,
	field: SemanticField,
	filter: QueryFilter,
	index: number,
	params: Record<string, unknown>,
): string {
	const expr = fieldRef(source, field);
	const marker = `f${index}`;

	if (valuelessOperators.has(filter.op)) {
		return filter.op === "is_empty"
			? `(${expr} IS NULL OR CAST(${expr} AS STRING) = '')`
			: `(${expr} IS NOT NULL AND CAST(${expr} AS STRING) <> '')`;
	}

	// A set of accepted values becomes an IN over individually bound markers.
	if (filter.values && filter.values.length > 0) {
		const numeric = isNumericType(field.dataType);
		const markers = filter.values.map((value, i) => {
			const name = `${marker}_${i}`;
			params[name] = numeric ? Number(value) : value;
			return `:${name}`;
		});
		return filter.op === "neq"
			? `${expr} NOT IN (${markers.join(", ")})`
			: `${expr} IN (${markers.join(", ")})`;
	}

	const value = filter.value ?? "";
	const numeric = isNumericType(field.dataType);
	const date = isDateType(field.dataType);

	switch (filter.op) {
		case "eq":
		case "neq": {
			const operator = filter.op === "eq" ? "=" : "<>";
			if (numeric) {
				params[marker] = Number(value);
				return `${expr} ${operator} :${marker}`;
			}
			if (date) {
				params[marker] = value;
				return `${expr} ${operator} CAST(:${marker} AS TIMESTAMP)`;
			}
			params[marker] = value;
			return `LOWER(COALESCE(CAST(${expr} AS STRING), '')) ${operator} LOWER(:${marker})`;
		}
		case "contains":
			params[marker] = `%${value}%`;
			return `LOWER(COALESCE(CAST(${expr} AS STRING), '')) LIKE LOWER(:${marker})`;
		case "starts_with":
			params[marker] = `${value}%`;
			return `LOWER(COALESCE(CAST(${expr} AS STRING), '')) LIKE LOWER(:${marker})`;
		case "ends_with":
			params[marker] = `%${value}`;
			return `LOWER(COALESCE(CAST(${expr} AS STRING), '')) LIKE LOWER(:${marker})`;
		case "like":
			params[marker] = value;
			return `LOWER(COALESCE(CAST(${expr} AS STRING), '')) LIKE LOWER(:${marker})`;
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			const operator = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.op];
			if (date) {
				params[marker] = value;
				return `${expr} ${operator} CAST(:${marker} AS TIMESTAMP)`;
			}
			params[marker] = numeric ? Number(value) : value;
			return `${expr} ${operator} :${marker}`;
		}
		default:
			throw new QuerySpecError(`Unsupported operator "${filter.op}"`);
	}
}

export function compileQuery(
	source: SemanticSource,
	spec: QuerySpec,
): CompiledQuery {
	if (spec.dimensions.length === 0 && spec.measures.length === 0) {
		throw new QuerySpecError(
			"A query needs at least one dimension or measure",
		);
	}

	const params: Record<string, unknown> = {};
	const selectParts: string[] = [];
	const groupByParts: string[] = [];
	const columns: string[] = [];

	for (const name of spec.dimensions) {
		const field = findField(source, name, "dimension");
		if (!field) {
			throw new QuerySpecError(
				`Unknown dimension "${name}" on source "${source.sourceKey}"`,
			);
		}
		const ref = fieldRef(source, field);
		// A metric view dimension is already its own name, so aliasing it to
		// itself just adds noise.
		selectParts.push(
			ref === quoteIdent(field.name)
				? ref
				: `${ref} AS ${quoteIdent(field.name)}`,
		);
		groupByParts.push(ref);
		columns.push(field.name);
	}

	for (const name of spec.measures) {
		const field = findField(source, name, "measure");
		if (!field) {
			throw new QuerySpecError(
				`Unknown measure "${name}" on source "${source.sourceKey}"`,
			);
		}
		selectParts.push(`${fieldRef(source, field)} AS ${quoteIdent(field.name)}`);
		columns.push(field.name);
	}

	// Dimension filters restrict rows before aggregation and push down into the
	// underlying table; measure filters restrict groups after it.
	const whereParts: string[] = [];
	const havingParts: string[] = [];
	spec.filters.forEach((filter, i) => {
		const field = findField(source, filter.field);
		if (!field) {
			throw new QuerySpecError(
				`Unknown field "${filter.field}" on source "${source.sourceKey}"`,
			);
		}
		const sqlText = buildFilterSql(source, field, filter, i, params);
		if (field.kind === "measure") havingParts.push(sqlText);
		else whereParts.push(sqlText);
	});

	const orderParts: string[] = [];
	for (const entry of spec.sort) {
		const field = findField(source, entry.field);
		if (!field) {
			throw new QuerySpecError(
				`Unknown sort field "${entry.field}" on source "${source.sourceKey}"`,
			);
		}
		// Ordering by the output alias avoids evaluating a measure twice and is
		// valid whether or not the query aggregates.
		orderParts.push(
			`${quoteIdent(field.name)} ${entry.direction === "desc" ? "DESC" : "ASC"}`,
		);
	}

	// A metric view always aggregates: selecting dimensions alone still reads
	// through the view's grain, and GROUP BY is what makes that explicit. A
	// table only aggregates when a measure is present, so a dimensions-only
	// query against one reads raw rows, which is what detail tables want.
	const aggregates =
		source.kind === "metric_view" || spec.measures.length > 0;

	const lines = [
		`SELECT ${selectParts.join(", ")}`,
		`FROM ${sourceRef(source)}`,
	];
	if (whereParts.length > 0) lines.push(`WHERE ${whereParts.join(" AND ")}`);
	if (aggregates && groupByParts.length > 0) {
		lines.push(`GROUP BY ${groupByParts.join(", ")}`);
	}
	if (havingParts.length > 0) {
		if (!aggregates) {
			throw new QuerySpecError(
				"A measure filter requires at least one measure in the query",
			);
		}
		lines.push(`HAVING ${havingParts.join(" AND ")}`);
	}
	if (orderParts.length > 0) lines.push(`ORDER BY ${orderParts.join(", ")}`);

	// Limit and offset are bounded integers from parseQuerySpec, so they are
	// safe to inline. Databricks does not accept bound parameters in LIMIT.
	lines.push(`LIMIT ${spec.limit}`);
	if (spec.offset > 0) lines.push(`OFFSET ${spec.offset}`);

	return { sql: lines.join("\n"), params, columns };
}
