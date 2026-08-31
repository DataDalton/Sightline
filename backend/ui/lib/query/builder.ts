import { valuelessOperators } from "../search/types";
import {
	findField,
	sourceRef,
	type SemanticField,
	type SemanticSource,
} from "../semantic/types";
import {
	QuerySpecError,
	defaultBins,
	type QueryFilter,
	type QuerySpec,
} from "./spec";
import { distributionColumns } from "./visualSpec";

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

	// A set of accepted values becomes an IN over individually bound markers,
	// compared the same way a single value is.
	//
	// Every value arrives from a client as a string, so a set was matched
	// against the column as it stands: on a boolean that is a type mismatch the
	// warehouse refuses outright, on a timestamp it is a comparison that never
	// matches, and on text it was the one case-sensitive comparison in a module
	// whose whole rule is that a reader never has to guess at casing.
	if (filter.values && filter.values.length > 0) {
		const numeric = isNumericType(field.dataType);
		const date = isDateType(field.dataType);

		const markers = filter.values.map((value, i) => {
			const name = `${marker}_${i}`;
			params[name] = numeric ? Number(value) : value;
			if (numeric) return `:${name}`;
			return date ? `CAST(:${name} AS TIMESTAMP)` : `LOWER(:${name})`;
		});

		// Coalesced, so a row with no value is excluded by an IN and kept by a
		// NOT IN rather than both dropping it: NOT IN against NULL is NULL,
		// which is not a match.
		const target =
			numeric || date
				? expr
				: `LOWER(COALESCE(CAST(${expr} AS STRING), ''))`;

		return filter.op === "neq"
			? `${target} NOT IN (${markers.join(", ")})`
			: `${target} IN (${markers.join(", ")})`;
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
			const operator = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[
				filter.op
			];
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

// Where a histogram cuts its range. Bins spread over the full extent of money
// data put every value in one bar and leave the other twenty nine empty, so
// the range runs from the first percentile to the ninety ninth and the two
// tails fold into the end bins rather than being dropped.
const binLowQuantile = 0.01;
const binHighQuantile = 0.99;

// Quantiles are read to about one part in ten thousand rather than exactly.
//
// An exact percentile has to sort the whole set, and a box plot of order value
// by division is taken over thirty six million orders: fourteen seconds against
// five for the same picture. On the same data the approximate median came back
// at 1,247.48 where the exact one is 1,247.91, which is three hundredths of a
// percent and a fraction of a pixel.
//
// The whiskers and the outlier count are not approximated. Those are real
// values compared against the fence, so the ends of the box are always figures
// that exist in the data.
const quantileAccuracy = 10000;

function quantile(expr: string, fraction: number): string {
	return `approx_percentile(${expr}, ${fraction}, ${quantileAccuracy})`;
}

interface ResolvedFilters {
	params: Record<string, unknown>;
	whereParts: string[];
	havingParts: string[];
}

// Dimension filters restrict rows before aggregation and push down into the
// underlying table; measure filters restrict groups after it. Resolved once so
// the flat and distribution branches cannot disagree about either.
function resolveFilters(
	source: SemanticSource,
	spec: QuerySpec,
): ResolvedFilters {
	const params: Record<string, unknown> = {};
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

	return { params, whereParts, havingParts };
}

function requireField(
	source: SemanticSource,
	name: string,
	kind: "dimension" | "measure",
): SemanticField {
	const field = findField(source, name, kind);
	if (!field) {
		throw new QuerySpecError(
			`Unknown ${kind} "${name}" on source "${source.sourceKey}"`,
		);
	}
	return field;
}

// The spread of one measure across a grain, summarised by the warehouse.
//
// Both shapes start from the same inner query: the measure evaluated once per
// distinct combination of the detail fields, which is the set of values whose
// shape is being described. None of that set comes back to the client, only
// the summary of it.
function compileDistribution(
	source: SemanticSource,
	spec: QuerySpec,
): CompiledQuery {
	const distribution = spec.distribution;
	if (!distribution) throw new QuerySpecError("No distribution to compile");

	if (spec.measures.length !== 1) {
		throw new QuerySpecError(
			"A distribution describes exactly one measure",
		);
	}
	if (distribution.kind === "bins" && spec.dimensions.length > 0) {
		throw new QuerySpecError(
			"A binned distribution has no grouping. One histogram draws one set of values",
		);
	}
	if (distribution.kind === "summary" && spec.dimensions.length > 1) {
		throw new QuerySpecError(
			"A summarised distribution groups by at most one field, one box each",
		);
	}

	const measure = requireField(source, spec.measures[0], "measure");
	const groups = spec.dimensions.map((name) =>
		requireField(source, name, "dimension"),
	);
	const details = distribution.detail.map((name) =>
		requireField(source, name, "dimension"),
	);

	const { params, whereParts, havingParts } = resolveFilters(source, spec);

	// Prefixed so it cannot collide with a field name, which on these sources
	// is any phrase the author of the view wrote.
	const value = quoteIdent("__value");
	const groupAliases = groups.map((g) => quoteIdent(g.name));

	const detailSelect = [
		...groups.map((g) => {
			const ref = fieldRef(source, g);
			return ref === quoteIdent(g.name)
				? ref
				: `${ref} AS ${quoteIdent(g.name)}`;
		}),
		`${fieldRef(source, measure)} AS ${value}`,
	];
	const detailGroupBy = [...groups, ...details].map((f) =>
		fieldRef(source, f),
	);

	const inner = [
		`SELECT ${detailSelect.join(", ")}`,
		`FROM ${sourceRef(source)}`,
	];
	if (whereParts.length > 0) inner.push(`WHERE ${whereParts.join(" AND ")}`);
	inner.push(`GROUP BY ${detailGroupBy.join(", ")}`);
	if (havingParts.length > 0) {
		inner.push(`HAVING ${havingParts.join(" AND ")}`);
	}

	const c = distributionColumns;

	if (distribution.kind === "bins") {
		const bins = distribution.bins ?? defaultBins;
		const lo = quoteIdent("__lo");
		const hi = quoteIdent("__hi");
		const bucket = quoteIdent("__bucket");
		const width = `((e.${hi} - e.${lo}) / ${bins})`;

		const sql = [
			"WITH detail AS (",
			inner.join("\n"),
			"),",
			"edges AS (",
			`SELECT ${quantile(value, binLowQuantile)} AS ${lo},`,
			`       ${quantile(value, binHighQuantile)} AS ${hi}`,
			`FROM detail WHERE ${value} IS NOT NULL`,
			"),",
			"placed AS (",
			// Values outside the trimmed range land in the end bins rather
			// than being dropped, so the bars still account for every value.
			`SELECT LEAST(${bins}, GREATEST(1, CASE WHEN e.${hi} <= e.${lo} THEN 1`,
			`       ELSE CAST(FLOOR((d.${value} - e.${lo}) / ${width}) AS INT) + 1 END)) AS ${bucket}`,
			`FROM detail d CROSS JOIN edges e`,
			`WHERE d.${value} IS NOT NULL`,
			"),",
			// Every bin is listed even when nothing fell in it. A bin missing
			// from the answer draws as a missing bar, which reads as a gap in
			// the data rather than as a count of zero.
			`bins AS (SELECT explode(sequence(1, ${bins})) AS ${bucket})`,
			`SELECT e.${lo} + (e.${hi} - e.${lo}) * (b.${bucket} - 1) / ${bins} AS ${quoteIdent(c.binStart)},`,
			`       e.${lo} + (e.${hi} - e.${lo}) * b.${bucket} / ${bins} AS ${quoteIdent(c.binEnd)},`,
			`       COUNT(p.${bucket}) AS ${quoteIdent(c.count)}`,
			"FROM bins b CROSS JOIN edges e",
			`LEFT JOIN placed p ON p.${bucket} = b.${bucket}`,
			`GROUP BY b.${bucket}, e.${lo}, e.${hi}`,
			`ORDER BY b.${bucket}`,
			`LIMIT ${bins}`,
		].join("\n");

		return { sql, params, columns: [c.binStart, c.binEnd, c.count] };
	}

	const q1 = quoteIdent("__q1");
	const med = quoteIdent("__med");
	const q3 = quoteIdent("__q3");
	const n = quoteIdent("__n");
	const fence = `1.5 * (q.${q3} - q.${q1})`;
	const below = `d.${value} < q.${q1} - ${fence}`;
	const above = `d.${value} > q.${q3} + ${fence}`;

	const quartileGroupBy =
		groupAliases.length > 0 ? `GROUP BY ${groupAliases.join(", ")}` : "";
	// Null safe, because a grouping field with no value is a group like any
	// other and an equality join would drop it.
	const joinOn =
		groupAliases.length > 0
			? ` ON ${groupAliases.map((a) => `d.${a} <=> q.${a}`).join(" AND ")}`
			: "";

	const outerGroupBy = [
		...groupAliases.map((a) => `q.${a}`),
		`q.${n}`,
		`q.${q1}`,
		`q.${med}`,
		`q.${q3}`,
	].join(", ");

	// Ranking, so a source with sixty eight areas can draw the twelve worth
	// looking at rather than the twelve whose names sort first. Sorting on the
	// measure means sorting on its median, which is the one number that stands
	// for a box.
	const orderParts: string[] = [];
	for (const entry of spec.sort) {
		const direction = entry.direction === "desc" ? "DESC" : "ASC";
		if (entry.field === measure.name) {
			orderParts.push(`${quoteIdent(c.median)} ${direction}`);
			continue;
		}
		const alias = groups.find((g) => g.name === entry.field);
		if (!alias) {
			throw new QuerySpecError(
				`A distribution sorts by its measure or by what it groups by, not by "${entry.field}"`,
			);
		}
		orderParts.push(`${quoteIdent(alias.name)} ${direction}`);
	}
	if (orderParts.length === 0 && groupAliases.length > 0) {
		orderParts.push(`${groupAliases[0]} ASC`);
	}

	const sql = [
		"WITH detail AS (",
		inner.join("\n"),
		"),",
		"quartiles AS (",
		`SELECT ${[...groupAliases, `COUNT(${value}) AS ${n}`].join(", ")},`,
		`       ${quantile(value, 0.25)} AS ${q1},`,
		`       ${quantile(value, 0.5)} AS ${med},`,
		`       ${quantile(value, 0.75)} AS ${q3}`,
		"FROM detail",
		quartileGroupBy,
		")",
		`SELECT ${[
			...groupAliases.map((a) => `q.${a}`),
			`q.${n} AS ${quoteIdent(c.count)}`,
			// The whisker reaches the furthest value still inside the fence,
			// not the fence itself. A whisker drawn at the fence claims a
			// value that is not in the data.
			`MIN(CASE WHEN NOT (${below}) THEN d.${value} END) AS ${quoteIdent(c.lowerWhisker)}`,
			`q.${q1} AS ${quoteIdent(c.lowerQuartile)}`,
			`q.${med} AS ${quoteIdent(c.median)}`,
			`q.${q3} AS ${quoteIdent(c.upperQuartile)}`,
			`MAX(CASE WHEN NOT (${above}) THEN d.${value} END) AS ${quoteIdent(c.upperWhisker)}`,
			// A count rather than the values. Nine hundred thousand outlying
			// orders cannot be drawn, and how many there are is the part that
			// gets read anyway.
			`COUNT(CASE WHEN ${below} OR ${above} THEN 1 END) AS ${quoteIdent(c.outliers)}`,
		].join(", ")}`,
		`FROM quartiles q ${groupAliases.length > 0 ? "JOIN" : "CROSS JOIN"} detail d${joinOn}`,
		`GROUP BY ${outerGroupBy}`,
		orderParts.length > 0 ? `ORDER BY ${orderParts.join(", ")}` : "",
		`LIMIT ${spec.limit}`,
	]
		.filter((line) => line !== "")
		.join("\n");

	return {
		sql,
		params,
		columns: [
			...groups.map((g) => g.name),
			c.count,
			c.lowerWhisker,
			c.lowerQuartile,
			c.median,
			c.upperQuartile,
			c.upperWhisker,
			c.outliers,
		],
	};
}

export function compileQuery(
	source: SemanticSource,
	spec: QuerySpec,
): CompiledQuery {
	if (spec.distribution) return compileDistribution(source, spec);

	if (spec.dimensions.length === 0 && spec.measures.length === 0) {
		throw new QuerySpecError(
			"A query needs at least one dimension or measure",
		);
	}

	const { params, whereParts, havingParts } = resolveFilters(source, spec);
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
		selectParts.push(
			`${fieldRef(source, field)} AS ${quoteIdent(field.name)}`,
		);
		columns.push(field.name);
	}

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
