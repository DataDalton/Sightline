import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { getSource, listSources } from "../semantic/registry";
import {
	quotedSourceRef,
	sourceRef,
	type SemanticField,
} from "../semantic/types";
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
import { type FieldRole } from "./fieldRefs";
import {
	collectDependents,
	dependentKey,
	findDependents,
	type Dependent,
	type DependentKind,
} from "./dependents";

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

// Where a field is used other than on a visual: saved views, alerts, sheets,
// saved explorations, deliveries, a page's data-through stamp and the dataset's
// own default time field. Grouped by kind, because most of these belong to one
// person and are not the reader's to open.
export interface OtherUsage {
	kind: DependentKind;
	// How many there are, whoever they belong to. A count says nothing about
	// any one of them.
	total: number;
	// The caller's own, by name.
	yours: { name: string; link: string | null }[];
	// Reports the caller can open that these sit on, for the kinds that sit on
	// a report.
	reports: { title: string; slug: string }[];
}

export interface FieldUsageDetail {
	usage: FieldUsage[];
	elsewhere: OtherUsage[];
}

// Everything that names a field, as much of it as the caller may know about.
export async function fieldUsageDetail(
	identity: Identity,
	policy: PolicyClass,
	sourceKey: string,
	fieldName: string,
): Promise<FieldUsageDetail> {
	const readable = await reachableSet(identity);
	if (readable && !readable.has(sourceKey)) {
		return { usage: [], elsewhere: [] };
	}

	const dependents = await findDependents(sourceKey, fieldName);

	// Filtered by what the caller can open. A reader being told their figure
	// also appears on a report they cannot reach is a disclosure about that
	// report, and the point of the list is the ones they can go and look at.
	const context = await getAccessContext(policy, identity);
	const canOpen = (d: Dependent) =>
		d.report !== null &&
		resolveReportAccess(
			context.grants,
			{
				reportId: d.report.reportId,
				categoryId: d.report.categoryId,
				isPersonal: d.report.isPersonal,
				ownerEmail: d.report.ownerEmail,
			},
			context.email,
			"view",
			context.baseline,
		).allowed;

	const usage: FieldUsage[] = dependents
		.filter((d) => d.kind === "visual" && canOpen(d))
		.map((d) => ({
			reportSlug: d.report!.slug,
			reportTitle: d.report!.title,
			reportId: d.report!.reportId,
			categoryId: d.report!.categoryId,
			isPersonal: d.report!.isPersonal,
			ownerEmail: d.report!.ownerEmail,
			pageTitle: d.pageTitle,
			visualId: d.id,
			visualTitle: d.name,
			visualType: d.visualType ?? "",
			usedAs: d.usedAs ?? "filter",
		}));

	const me = identity.email.toLowerCase();
	const byKind = new Map<DependentKind, Dependent[]>();
	for (const d of dependents) {
		if (d.kind === "visual") continue;
		const held = byKind.get(d.kind) ?? [];
		held.push(d);
		byKind.set(d.kind, held);
	}

	const elsewhere: OtherUsage[] = [];
	for (const [kind, items] of byKind) {
		const ids = new Set(items.map((d) => d.id));
		const yours = new Map<string, { name: string; link: string | null }>();
		const reports = new Map<string, { title: string; slug: string }>();
		for (const d of items) {
			if (d.ownerEmail?.toLowerCase() === me) {
				yours.set(d.id, { name: d.name ?? "Untitled", link: d.link });
			}
			if (d.report && canOpen(d)) {
				reports.set(d.report.slug, {
					title: d.report.title,
					slug: d.report.slug,
				});
			}
		}
		elsewhere.push({
			kind,
			total: ids.size,
			yours: [...yours.values()],
			reports: [...reports.values()],
		});
	}

	return { usage, elsewhere };
}

export async function fieldUsage(
	identity: Identity,
	policy: PolicyClass,
	sourceKey: string,
	fieldName: string,
): Promise<FieldUsage[]> {
	return (await fieldUsageDetail(identity, policy, sourceKey, fieldName))
		.usage;
}

// Counts per source set, held briefly. The list page asks for every field at
// once and is reopened often, and the walk reads every stored item on those
// sources.
const countTtlMs = 60 * 1000;
const heldCounts = new Map<
	string,
	{ at: number; counts: Map<string, number> }
>();

// How many items name each field, for every field on the readable sources.
//
// One walk for the whole catalogue rather than one per field, because the page
// that wants this is showing hundreds of rows at once, and a count beside each is
// what makes an unused field visible without opening it. Every kind of item is
// counted, so a field used only by somebody's alert does not read as unused.
export async function usageCounts(
	identity: Identity,
): Promise<Map<string, number>> {
	const readable = await reachableSet(identity);
	if (readable && readable.size === 0) return new Map();
	const keys = [
		...(readable ?? new Set(listSources().map((s) => s.sourceKey))),
	].sort();

	const cacheKey = keys.join("\u0000");
	const held = heldCounts.get(cacheKey);
	if (held && Date.now() - held.at < countTtlMs) return held.counts;

	// Each item counted once per field, however many places in it name it.
	const seen = new Set<string>();
	const counts = new Map<string, number>();
	for (const d of await collectDependents(keys)) {
		const key = dependentKey(d.sourceKey, d.field);
		const item = `${key}\u0000${d.kind}\u0000${d.id}`;
		if (seen.has(item)) continue;
		seen.add(item);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	if (heldCounts.size > 50) heldCounts.clear();
	heldCounts.set(cacheKey, { at: Date.now(), counts });
	return counts;
}

// Source and field together, since a field name is only unique within a source.
export function usageKey(sourceKey: string, fieldName: string): string {
	return dependentKey(sourceKey, fieldName);
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
			`SHOW CREATE TABLE ${quotedSourceRef(source)}`,
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
