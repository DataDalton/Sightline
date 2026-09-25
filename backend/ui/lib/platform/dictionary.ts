import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { getSource, listSources } from "../semantic/registry";
import { sourceRef, type SemanticField } from "../semantic/types";
import { runCatalogQuery } from "../semantic/ucMetadata";
import {
	measuresReferenced,
	parseMetricViewCalculations,
	type ViewCalculations,
	type ViewJoin,
} from "../semantic/metricViewCalculations";
import { getAccessContext } from "./access";
import { reachableSet } from "./sources";
import { resolveReportAccess } from "./accessRules";
import { roleOf, type FieldRole } from "./fieldRefs";

// What every field means, and what depends on it.
//
// The definitions are already written: a metric view carries a comment on
// every dimension and measure, and the catalogue walk copies them into
// source_fields. Until this existed they were reachable only by opening a
// report built on that source and hovering the right column, so the question
// "what does Net Amount actually count" was answered by asking somebody.
//
// The second half is the one an editor needs before changing anything. A field
// is referenced from a visual's config, which is JSON, so nothing in the schema
// records the dependency and renaming a measure broke pages nobody could
// enumerate first.

export interface DictionaryField {
	sourceKey: string;
	sourceTitle: string;
	name: string;
	displayName: string | null;
	kind: "dimension" | "measure";
	dataType: string | null;
	description: string | null;
	formatHint: string | null;
	tags: Record<string, string>;
	folder: string | null;
}

// Where a field is used. One row per visual, because that is the grain an
// editor acts at: a report appearing once tells them to look, a visual tells
// them where.
export interface FieldUsage {
	reportSlug: string;
	reportTitle: string;
	reportId: string;
	categoryId: string | null;
	isPersonal: boolean;
	ownerEmail: string | null;
	pageTitle: string | null;
	visualId: string;
	visualTitle: string | null;
	visualType: string;
	// Which part of the visual names it. A field used only as a filter is still
	// a dependency, and it is the one most easily missed.
	usedAs: FieldRole;
}

function toField(
	field: SemanticField,
	sourceKey: string,
	sourceTitle: string,
): DictionaryField {
	return {
		sourceKey,
		sourceTitle,
		name: field.name,
		displayName: field.displayName,
		kind: field.kind,
		dataType: field.dataType,
		description: field.description,
		formatHint: field.formatHint,
		tags: field.tags,
		folder: field.folder,
	};
}

// Every field on every source the caller holds SELECT on.
//
// Read from the registry rather than from source_fields directly, so the list
// is the same one the query builder resolves against. A dictionary describing
// fields a query cannot name would be worse than none.
export async function dictionaryFields(
	identity: Identity,
): Promise<DictionaryField[]> {
	// The same three cases every other surface resolves reachability under,
	// through the same helper. Null means no filtering, which is what local
	// development gets: the query runs as the developer's own credentials and
	// those decide at query time.
	const readable = await reachableSet(identity);
	const fields: DictionaryField[] = [];

	for (const source of listSources()) {
		if (readable && !readable.has(source.sourceKey)) continue;
		for (const field of [...source.dimensions, ...source.measures]) {
			fields.push(toField(field, source.sourceKey, source.title));
		}
	}

	return fields;
}

interface UsageRow {
	report_id: string;
	slug: string;
	report_title: string;
	category_id: string | null;
	is_personal: boolean;
	owner_email: string | null;
	page_title: string | null;
	visual_id: string;
	visual_title: string | null;
	visual_type: string;
	config: unknown;
}

// A visual's source is its own, or its page's, or its report's.
//
// The same inheritance the reader applies when it builds a query. Matching on
// report_visuals.source_key alone would report every visual that leaves it null
// as belonging to no source, which is most of them on a single-source report,
// and the field would read as unused.
const effectiveSource = `coalesce(v.source_key, p.source_key, r.source_key)`;

// Named in any of the four places a config can name it. jsonb_exists covers the
// two plain string arrays; filters and sort hold objects, so those are searched
// element by element.
const referencesField = `(
	jsonb_exists(coalesce(v.config->'dimensions', '[]'::jsonb), $2)
	OR jsonb_exists(coalesce(v.config->'measures', '[]'::jsonb), $2)
	OR EXISTS (
		SELECT 1 FROM jsonb_array_elements(
			coalesce(v.config->'filters', '[]'::jsonb)) AS f
		WHERE f->>'field' = $2)
	OR EXISTS (
		SELECT 1 FROM jsonb_array_elements(
			coalesce(v.config->'sort', '[]'::jsonb)) AS s
		WHERE s->>'field' = $2)
)`;

export async function fieldUsage(
	identity: Identity,
	policy: PolicyClass,
	sourceKey: string,
	fieldName: string,
): Promise<FieldUsage[]> {
	const readable = await reachableSet(identity);
	if (readable && !readable.has(sourceKey)) return [];

	const rows = await sql<UsageRow>(
		`SELECT r.report_id::text   AS report_id,
		        r.slug              AS slug,
		        r.title             AS report_title,
		        r.category_id       AS category_id,
		        r.is_personal       AS is_personal,
		        r.owner_email       AS owner_email,
		        p.title             AS page_title,
		        v.visual_id::text   AS visual_id,
		        v.title             AS visual_title,
		        v.visual_type       AS visual_type,
		        v.config            AS config
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 JOIN reports r      ON r.report_id = p.report_id
		 WHERE v.is_active
		   AND ${effectiveSource} = $1
		   AND ${referencesField}
		 ORDER BY r.title, p.sort_order, v.sort_order`,
		[sourceKey, fieldName],
	);

	// Filtered by what the caller can open. A reader being told their figure
	// also appears on a report they cannot reach is a disclosure about that
	// report, and the point of the list is the ones they can go and look at.
	const context = await getAccessContext(policy, identity);

	return rows
		.filter(
			(row) =>
				resolveReportAccess(
					context.grants,
					{
						reportId: row.report_id,
						categoryId: row.category_id,
						isPersonal: row.is_personal,
						ownerEmail: row.owner_email,
					},
					context.email,
					"view",
					context.baseline,
				).allowed,
		)
		.map((row) => ({
			reportSlug: row.slug,
			reportTitle: row.report_title,
			reportId: row.report_id,
			categoryId: row.category_id,
			isPersonal: row.is_personal,
			ownerEmail: row.owner_email,
			pageTitle: row.page_title,
			visualId: row.visual_id,
			visualTitle: row.visual_title,
			visualType: row.visual_type,
			usedAs: roleOf(row.config, fieldName) ?? "filter",
		}));
}

// How many visuals name each field, for every field on the readable sources.
//
// One query for the whole catalogue rather than one per field: the page that
// wants this is showing hundreds of rows at once, and a count beside each is
// what makes an unused field visible without opening it.
export async function usageCounts(
	identity: Identity,
): Promise<Map<string, number>> {
	const readable = await reachableSet(identity);
	if (readable && readable.size === 0) return new Map();
	const keys = [
		...(readable ?? new Set(listSources().map((s) => s.sourceKey))),
	];

	const rows = await sql<{ source_key: string; field: string; uses: string }>(
		`SELECT ${effectiveSource} AS source_key,
		        field.name          AS field,
		        count(*)::text      AS uses
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 JOIN reports r      ON r.report_id = p.report_id
		 CROSS JOIN LATERAL (
		     SELECT jsonb_array_elements_text(
		                coalesce(v.config->'dimensions', '[]'::jsonb)) AS name
		     UNION ALL
		     SELECT jsonb_array_elements_text(
		                coalesce(v.config->'measures', '[]'::jsonb))
		     UNION ALL
		     SELECT f->>'field' FROM jsonb_array_elements(
		                coalesce(v.config->'filters', '[]'::jsonb)) AS f
		     UNION ALL
		     SELECT s->>'field' FROM jsonb_array_elements(
		                coalesce(v.config->'sort', '[]'::jsonb)) AS s
		 ) AS field
		 WHERE v.is_active
		   AND field.name IS NOT NULL
		   AND ${effectiveSource} = ANY($1)
		 GROUP BY 1, 2`,
		[keys],
	);

	const counts = new Map<string, number>();
	for (const row of rows) {
		counts.set(usageKey(row.source_key, row.field), Number(row.uses));
	}
	return counts;
}

// Source and field together, since a field name is only unique within a source.
export function usageKey(sourceKey: string, fieldName: string): string {
	return `${sourceKey}\u0000${fieldName}`;
}

// How a field is calculated.
export interface FieldDefinition {
	// The expression as the view or the source declares it. For a plain table
	// column with no expression of its own, the column name.
	expr: string;
	window: string | null;
	// Other measures the expression is built from, so a ratio can be followed
	// back to its numerator and denominator.
	uses: string[];
	// Where the view reads from, which is where the columns in the expression
	// live.
	reads: string | null;
	filter: string | null;
	joins: ViewJoin[];
}

// Parsed definitions, per source. The definition changes only when the view is
// redeployed, and reading it costs a warehouse round trip and up to a hundred
// kilobytes of YAML, so one reader opening several fields reads it once.
//
// Keyed by source alone, which is safe because the entry is served only after
// the caller's own access to that source has been checked below. What the
// definition says is the same for everybody who may read it.
const definitionTtlMs = 10 * 60 * 1000;
const definitions = new Map<string, { parsed: ViewCalculations; at: number }>();

export async function fieldDefinition(
	identity: Identity,
	sourceKey: string,
	fieldName: string,
): Promise<FieldDefinition | null> {
	const readable = await reachableSet(identity);
	if (readable && !readable.has(sourceKey)) return null;

	const source = getSource(sourceKey);
	if (!source) return null;
	const field = [...source.dimensions, ...source.measures].find(
		(f) => f.name === fieldName,
	);
	if (!field) return null;

	// A table source declares its expressions here rather than in the
	// warehouse, and a column with none is simply that column.
	if (source.kind !== "metric_view") {
		return {
			expr: field.sqlExpr ?? field.name,
			window: null,
			uses: [],
			reads: sourceRef(source),
			filter: null,
			joins: [],
		};
	}

	let held = definitions.get(sourceKey);
	if (!held || Date.now() - held.at > definitionTtlMs) {
		// Under the caller's own identity, so reading a definition needs
		// exactly the access reading the data does.
		const rows = await runCatalogQuery(
			identity,
			`SHOW CREATE TABLE ${sourceRef(source)}`,
		);
		const statement = String(Object.values(rows[0] ?? {})[0] ?? "");
		held = {
			parsed: parseMetricViewCalculations(statement),
			at: Date.now(),
		};
		definitions.set(sourceKey, held);
	}

	const calc = held.parsed.fields.get(fieldName);
	if (!calc) return null;
	return {
		expr: calc.expr,
		window: calc.window,
		uses: measuresReferenced(calc.expr),
		reads: held.parsed.source,
		filter: held.parsed.filter,
		joins: held.parsed.joins,
	};
}
