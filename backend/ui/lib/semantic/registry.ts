import { sql } from "../data/lakebase";
import { setTrackedGroups } from "../auth/policy";
import type {
	AccessMode,
	FieldKind,
	FormatHint,
	SemanticField,
	SemanticSource,
} from "./types";

// Loads the semantic layer from Lakebase and holds it in memory. Sources and
// fields change when an admin edits them, not per request, so this is read
// once and refreshed on a timer rather than queried on every query build.

interface SourceRow {
	source_key: string;
	title: string;
	description: string | null;
	catalog_name: string;
	schema_name: string;
	object_name: string;
	kind: string;
	access_mode: string;
	has_row_filter: boolean;
	cache_ttl_seconds: number;
	default_time_field: string | null;
}

interface FieldRow {
	field_id: string;
	source_key: string;
	field_name: string;
	display_name: string | null;
	field_kind: string;
	sql_expr: string | null;
	data_type: string | null;
	description: string | null;
	format_hint: string | null;
	tags: Record<string, string> | null;
	folder: string | null;
	sort_order: number;
	is_default: boolean;
}

let sources = new Map<string, SemanticSource>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const refreshIntervalMs = 60000;

function toField(row: FieldRow): SemanticField {
	return {
		fieldId: row.field_id,
		sourceKey: row.source_key,
		name: row.field_name,
		displayName: row.display_name,
		kind: row.field_kind as FieldKind,
		sqlExpr: row.sql_expr,
		dataType: row.data_type,
		description: row.description,
		formatHint: (row.format_hint as FormatHint | null) ?? null,
		tags: row.tags ?? {},
		folder: row.folder,
		sortOrder: row.sort_order,
		isDefault: row.is_default,
	};
}

// force re-walks the catalogue for row filters instead of reusing the memo.
// A poll leaves it alone, because the walk is slow and filters change rarely.
// An explicit sync passes true: it is what an admin runs after fixing the
// privilege that made the walk fail, and reusing the failed answer would report
// the fix as having changed nothing.
export async function loadRegistry(force = false): Promise<void> {
	// Share one in-flight load between concurrent callers.
	if (loading) return loading;

	loading = (async () => {
		try {
			const [sourceRows, fieldRows] = await Promise.all([
				sql<SourceRow>(
					`SELECT source_key, title, description, catalog_name, schema_name,
					        object_name, kind, access_mode, has_row_filter,
					        cache_ttl_seconds, default_time_field
					 FROM data_sources
					 WHERE is_active = TRUE`,
				),
				sql<FieldRow>(
					`SELECT field_id, source_key, field_name, display_name, field_kind,
					        sql_expr, data_type, description, format_hint, tags,
					        folder, sort_order, is_default
					 FROM source_fields
					 WHERE is_active = TRUE
					 ORDER BY sort_order, field_name`,
				),
			]);

			const byKey = new Map<string, SemanticSource>();
			for (const row of sourceRows) {
				byKey.set(row.source_key, {
					sourceKey: row.source_key,
					title: row.title,
					description: row.description,
					catalog: row.catalog_name,
					schema: row.schema_name,
					object: row.object_name,
					kind: row.kind === "metric_view" ? "metric_view" : "table",
					accessMode: row.access_mode as AccessMode,
					hasRowFilter: row.has_row_filter,
					cacheTtlSeconds: row.cache_ttl_seconds,
					defaultTimeField: row.default_time_field,
					dimensions: [],
					measures: [],
				});
			}

			for (const row of fieldRows) {
				const source = byKey.get(row.source_key);
				if (!source) continue;
				const field = toField(row);
				if (field.kind === "measure") source.measures.push(field);
				else source.dimensions.push(field);
			}

			sources = byKey;
			loadedAt = Date.now();

			// Only groups that actually appear in an access rule are probed
			// when resolving a policy class, so membership stays one small
			// query no matter how many groups exist in the account.
			//
			await refreshTrackedGroups(force);
		} catch (error) {
			// Keep serving the previous registry. An empty one would make
			// every query fail rather than degrade.
			console.error("Semantic registry load failed:", error);
		} finally {
			loading = null;
		}
	})();

	return loading;
}

function union(a: string[], b: string[]): string[] {
	return Array.from(new Set([...a, ...b]));
}

// Groups the current tracked list credits to a row filter. Only that origin,
// because editor, admin and configured groups reach setTrackedGroups by their
// own routes and folding them in here would relabel where they came from.
async function previousFilterGroups(): Promise<{
	accountGroups: string[];
	workspaceGroups: string[];
}> {
	const { getTrackedGroupDetail } = await import("../auth/policy");
	const existing = getTrackedGroupDetail().filter(
		(g) => g.origin === "row-filter",
	);
	return {
		accountGroups: existing
			.filter((g) => g.scope === "account")
			.map((g) => g.name),
		workspaceGroups: existing
			.filter((g) => g.scope === "workspace")
			.map((g) => g.name),
	};
}

async function accessRuleGroups(): Promise<string[]> {
	const rows = await sql<{ subject_id: string }>(
		`SELECT DISTINCT subject_id
		 FROM access_policies
		 WHERE subject_type = 'group' AND is_active = TRUE`,
	);
	return rows.map((r) => r.subject_id);
}

// The groups a policy class is built from, in two stages.
//
// Stage one is one small query and is awaited: the editor and admin groups are
// what decide whether the caller can reach the administration pages at all, and
// deferring them means an administrator is not one for the first few seconds
// after a start.
//
// Stage two walks the catalogue for the groups the row filters branch on. That
// opens every source in turn and takes tens of seconds, so it runs behind the
// request rather than in front of it. Until it lands, nothing filtered is
// served from a shared cache, which is what makes deferring it safe. See
// isShareable in lib/query/cache.
export async function refreshTrackedGroups(force = false): Promise<void> {
	const rules = await accessRuleGroups();

	// Whatever the last walk found stands until this one finishes, so the list
	// is never briefly narrower than it was a moment ago.
	setTrackedGroups(rules, await previousFilterGroups());

	void discoverAndApply(rules, force);
}

async function discoverAndApply(
	rules: string[],
	force: boolean,
): Promise<void> {
	// Groups named by the row filters on every source, read from the catalogue.
	// Without them two readers restricted to different rows resolve to the same
	// policy class. See lib/semantic/filterDiscovery.
	try {
		const { discoverFilterGroups } = await import("./filterDiscovery");
		const discovered = await discoverFilterGroups(null, force);

		let filterGroups: {
			accountGroups: string[];
			workspaceGroups: string[];
		} = discovered;

		// A source the walk could not open contributes no group names, which
		// reads identically to a source that has no filter. Taking the second
		// reading is what widens who shares a cache entry, and the walk reports
		// a source it could not open rather than raising, so a partial failure
		// arrives here as a successful call with a short list.
		if (discovered.unreadableSources.length > 0) {
			const previous = await previousFilterGroups();
			filterGroups = {
				accountGroups: union(
					discovered.accountGroups,
					previous.accountGroups,
				),
				workspaceGroups: union(
					discovered.workspaceGroups,
					previous.workspaceGroups,
				),
			};
			console.warn(
				"Row filter discovery could not read " +
					`${discovered.unreadableSources.length} source(s); ` +
					"keeping the groups already tracked.",
			);
		}

		setTrackedGroups(rules, filterGroups);
	} catch (error) {
		// The list set before this ran stays in place. A catalogue outage must
		// not quietly widen who shares a cache entry.
		console.warn(
			"Row filter discovery failed; keeping the previous group list:",
			error,
		);
	}
}

export function getSource(sourceKey: string): SemanticSource | null {
	return sources.get(sourceKey) ?? null;
}

export function listSources(): SemanticSource[] {
	return Array.from(sources.values()).sort((a, b) =>
		a.title.localeCompare(b.title),
	);
}

export function registryLoadedAt(): number {
	return loadedAt;
}

export function startRegistryPolling(): void {
	if (refreshTimer) return;
	refreshTimer = setInterval(() => {
		void loadRegistry();
	}, refreshIntervalMs);
	refreshTimer.unref?.();
}

export function stopRegistryPolling(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
}
