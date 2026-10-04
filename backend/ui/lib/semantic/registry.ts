import { sql } from "../data/lakebase";
import { setTrackedGroups } from "../auth/policy";
import { dropDefinitionsLocally } from "../platform/definitionCache";
import {
	marksReadAt,
	onMarksRead,
	protectedSources,
	refreshMarks,
} from "../freshness/marks";
import { settings } from "../settings";
import type {
	AccessMode,
	FieldKind,
	FormatHint,
	MissingField,
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
	is_live: boolean;
	default_time_field: string | null;
}

interface FieldRow {
	field_id: string;
	source_key: string;
	field_name: string;
	display_name: string | null;
	field_kind: string;
	sql_expr: string | null;
	expression: string | null;
	data_type: string | null;
	description: string | null;
	format_hint: string | null;
	tags: Record<string, string> | null;
	folder: string | null;
	sort_order: number;
	is_default: boolean;
	status: string;
	missing_since: string | null;
	renamed_to: string | null;
	rename_candidate: string | null;
}

let sources = new Map<string, SemanticSource>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
// A reload asked for while one was running, and whether any caller forced it.
let queuedLoad: Promise<void> | null = null;
let queuedForce = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let protectionTimer: ReturnType<typeof setInterval> | null = null;

// How often the stored protection flags are reread, apart from the full
// reload. Another replica can record a source as protected at any moment,
// and until this one knows, it keys that source's answers as shared by
// everyone. The flags come with the freshness marks, which are read on the
// same period. See lib/freshness/marks.
const protectionCheckMs = 5_000;

// When each source was marked protected on this replica. A reload that read
// the tables before that moment carries the older flag, and is not allowed to
// put it back.
const markedAt = new Map<string, number>();

// What is stored about each source, reread. Registering or editing one reloads
// this immediately, so the poll is only for changes another replica made, which
// is not something worth asking about every minute.
//
// Read per tick rather than once at startup, so changing the setting takes
// effect on the next tick instead of on the next deploy. Floored, because a
// setting of zero or a stray small number would turn this into a busy loop
// against the platform store.
function refreshIntervalMs(): number {
	return Math.max(settings().refreshIntervalSeconds, 30) * 1000;
}

function toField(row: FieldRow): SemanticField {
	return {
		fieldId: row.field_id,
		sourceKey: row.source_key,
		name: row.field_name,
		displayName: row.display_name,
		kind: row.field_kind as FieldKind,
		sqlExpr: row.sql_expr,
		expression: row.expression,
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
// The sources and titles the last load found. See loadRegistry.
let listedSources = "";

export async function loadRegistry(force = false): Promise<void> {
	// A caller arriving during a load gets a fresh load after it, not the one
	// already running. That load may have read the tables before the caller's
	// own write committed, so joining it would leave a just registered or
	// edited source invisible until the next poll. Callers arriving during the
	// same load share one queued reload.
	if (loading) {
		queuedForce = queuedForce || force;
		if (!queuedLoad) {
			queuedLoad = loading.then(() => {
				const again = queuedForce;
				queuedLoad = null;
				queuedForce = false;
				return loadRegistry(again);
			});
		}
		return queuedLoad;
	}

	loading = (async () => {
		const startedAt = Date.now();
		try {
			const [sourceRows, fieldRows] = await Promise.all([
				sql<SourceRow>(
					`SELECT source_key, title, description, catalog_name, schema_name,
					        object_name, kind, access_mode, has_row_filter,
					        cache_ttl_seconds, is_live, default_time_field
					 FROM data_sources
					 WHERE is_active = TRUE`,
				),
				sql<FieldRow>(
					`SELECT field_id, source_key, field_name, display_name, field_kind,
					        sql_expr, fingerprint->>'expression' AS expression,
					        data_type, description, format_hint, tags,
					        folder, sort_order, is_default, status,
					        missing_since::text AS missing_since, renamed_to,
					        rename_candidate
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
					hasRowFilter:
						row.has_row_filter ||
						(markedAt.get(row.source_key) ?? 0) >= startedAt,
					cacheTtlSeconds: row.cache_ttl_seconds,
					isLive: row.is_live,
					defaultTimeField: row.default_time_field,
					dimensions: [],
					measures: [],
				});
			}

			const missingBySource = new Map<
				string,
				Map<string, MissingField>
			>();
			for (const row of fieldRows) {
				const source = byKey.get(row.source_key);
				if (!source) continue;
				// A field the source stopped publishing is kept out of the
				// pickers and the query builder, and remembered so a query
				// naming it can say what happened.
				if (row.status === "missing") {
					let missing = missingBySource.get(row.source_key);
					if (!missing) {
						missing = new Map();
						missingBySource.set(row.source_key, missing);
						source.missingFields = missing;
					}
					missing.set(row.field_name, {
						name: row.field_name,
						kind: row.field_kind as FieldKind,
						missingSince: row.missing_since,
						renamedTo: row.renamed_to,
						renameCandidate: row.rename_candidate,
					});
					continue;
				}
				const field = toField(row);
				if (field.kind === "measure") source.measures.push(field);
				else source.dimensions.push(field);
			}

			sources = byKey;
			loadedAt = Date.now();

			// What is held about each source's standing names its title and
			// leaves out sources that stopped, so a source added, removed or
			// renamed drops it here. Every instance reloads its own registry,
			// so this is not announced.
			const listed = sourceRows
				.map((r) => `${r.source_key}\u0000${r.title}`)
				.sort()
				.join("\u0001");
			if (listed !== listedSources) {
				listedSources = listed;
				dropDefinitionsLocally("freshness:");
			}

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
	// Both tables that can name a group, because membership of a group nothing
	// probes is never resolved, and an assignment against an unprobed group
	// matches nobody. The failure is silent: the role exists, the assignment
	// exists, and the person it names holds nothing.
	const rows = await sql<{ subject_id: string }>(
		`SELECT DISTINCT subject_id
		 FROM access_policies
		 WHERE subject_type = 'group' AND is_active = TRUE
		 UNION
		 SELECT DISTINCT subject_id
		 FROM role_assignments
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
		// Nothing newer than what is already tracked, because another
		// replica is walking. The list set before this ran stays in place.
		if (!discovered) return;

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

// Treats a source as protected from now on, on this replica, without waiting
// for the next reload. Set on the object every request is already holding, so
// a query mid way through keys its answer by policy class too. Answers held
// in memory for it are dropped.
export async function markProtected(sourceKey: string): Promise<void> {
	markedAt.set(sourceKey, Date.now());
	const source = sources.get(sourceKey);
	if (!source || source.hasRowFilter) return;
	source.hasRowFilter = true;
	const { forgetSourceInMemory } = await import("../query/cache");
	forgetSourceInMemory(sourceKey);
}

// Takes on any source recorded as protected that this replica still treats as
// unprotected. What is recorded comes from the freshness marks, which read
// every source's protection flag with the rest of its standing, so the flag
// costs no query of its own. The full reload follows so the walk reads the
// new filters.
async function checkProtection(): Promise<void> {
	try {
		let changed = false;
		for (const key of protectedSources()) {
			const source = sources.get(key);
			if (source && !source.hasRowFilter) {
				await markProtected(key);
				changed = true;
			}
		}
		if (changed) void loadRegistry(true);
	} catch (error) {
		// The shared cache is guarded in its own statements, so a missed check
		// delays this replica's switch rather than leaking a shared answer.
		console.warn("Protection check failed:", error);
	}
}

// One function for the life of the module, so starting the polling again does
// not add a second listener.
const checkOnMarksRead = () => void checkProtection();

// Reads the marks again when nothing else has for a while, such as when their
// own polling is not running in this module instance. Each read runs the check
// above when it lands.
function rereadProtection(): void {
	if (Date.now() - marksReadAt() < protectionCheckMs + 1_000) return;
	void refreshMarks().catch((error) => {
		console.warn("Protection check failed:", error);
	});
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
	// A timeout that reschedules itself rather than a fixed interval, so a
	// change to the setting is picked up without a restart.
	const tick = () => {
		void loadRegistry();
		refreshTimer = setTimeout(tick, refreshIntervalMs());
		refreshTimer.unref?.();
	};
	refreshTimer = setTimeout(tick, refreshIntervalMs());
	refreshTimer.unref?.();
	onMarksRead(checkOnMarksRead);
	protectionTimer = setInterval(rereadProtection, protectionCheckMs);
	protectionTimer.unref?.();
}

export function stopRegistryPolling(): void {
	if (refreshTimer) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
	if (protectionTimer) {
		clearInterval(protectionTimer);
		protectionTimer = null;
	}
}
