import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { catalogAccessEnabled, readableSources } from "../auth/sourceAccess";
import { effectiveAdminGroups, settings } from "../settings";
import { isDatabricksApp } from "../runtime";
import { loadAssignments } from "./roles";
import { announce, onChange } from "./changes";
import {
	cachedDefinition,
	dropDefinitionsLocally,
	dropMatchingLocally,
	invalidateDefinitions,
} from "./definitionCache";
import { curatedReports } from "./curated";
import {
	can,
	capabilities as allCapabilities,
	globalScope,
	grantKey,
	resolveAssignments,
	strongest,
	type Capability,
	type CapabilityMap,
	type Permission,
} from "./accessRules";
import { perProcess } from "../perProcess";

// Resolves what a caller may open and what they may do, from the tables that
// say so. The decisions themselves live in lib/platform/accessRules, which has
// no database behind it and is tested directly.
//
// Three things feed an answer:
//
//   Role assignments. A named bundle bound to a group or an individual, within
//   a scope. Global assignments become the baseline; scoped ones become grants
//   on the category or report they name.
//
//   Access policies. Per-resource grants, including the ones a person makes
//   when they share a page of their own with somebody by name.
//
//   Unity Catalog. A reader holding SELECT on a source is taken to be entitled
//   to the curated reports built on it. This is the grant somebody already
//   made, read back rather than transcribed into a second list.
//
// The last of those never reaches a personal page, and neither does the first.

export type {
	Capability,
	CapabilityMap,
	Permission,
	AccessCheck,
	ReportRef,
	RoleDefinition,
	ScopeType,
} from "./accessRules";

export {
	atLeast,
	builtinRoles,
	can,
	capabilities,
	isCapability,
	resolveCategoryAccess,
	resolvePageAccess,
	resolveReportAccess,
} from "./accessRules";

function inAnyGroup(policy: PolicyClass, groups: string[]): boolean {
	if (policy.degraded) return false;
	const held = new Set(policy.grants.map((g) => g.toLowerCase()));
	return groups.some((g) => held.has(g.trim().toLowerCase()));
}

// The configured groups, still honoured directly.
//
// These are the floor, not the model. Roles are the model, and an assignment
// can say things these cannot: one person rather than a group, or edit within
// a single subject area. But a role table is reachable only when the platform
// store is, and an administrator locked out of the tool that manages roles by
// a problem with the roles has no way back in. So the configured groups keep
// working whatever the tables say.
export function isEditor(policy: PolicyClass): boolean {
	return inAnyGroup(policy, settings().editorGroups);
}

export function isAdmin(policy: PolicyClass): boolean {
	// Outside a deployment, whoever is running it administers it.
	//
	// Group membership is resolved by asking the warehouse about the forwarded
	// token, and there is no forwarded token on a developer machine, so no
	// configured group can ever match and nobody could reach the administration
	// pages at all. The person running the process already holds the database
	// and warehouse credentials those pages act through, so withholding them
	// protects nothing.
	//
	// Keyed on DATABRICKS_APP_PORT, which only the Apps runtime sets. See the
	// note on isDatabricksApp: client id looks like the obvious signal and is
	// wrong, because local development against a service principal sets it too.
	if (!isDatabricksApp) return true;
	return inAnyGroup(policy, effectiveAdminGroups());
}

// The permission the configured groups confer everywhere, before any role or
// grant. Null when they confer none.
export function configuredBaseline(policy: PolicyClass): Permission | null {
	if (isAdmin(policy)) return "admin";
	if (isEditor(policy)) return "edit";
	return null;
}

export interface AccessGrant {
	resourceType: "category" | "report" | "page";
	resourceId: string;
	permission: Permission;
}

// Everything one caller can reach and everything they may do, resolved once.
//
// Bundled rather than fetched piecemeal because the baseline now comes from the
// role tables. It used to be a synchronous read of a settings key, which meant
// every call site could ask for it inline; asking three separate questions of
// the database on every request instead would be three round trips to answer
// one question.
export interface AccessContext {
	grants: Map<string, Permission>;
	baseline: Permission | null;
	capabilities: CapabilityMap;
	// Whose context this is, needed by the ownership rule.
	email: string;
}

interface CacheEntry {
	context: AccessContext;
	expiresAt: number;
}

const cache = perProcess(
	"platform/access:cache",
	() => new Map<string, CacheEntry>(),
);

// A lookup in progress, and whether an invalidation reached its key while it
// ran. One that started before a grant changed may have read the old grants,
// so it answers its own callers but is not kept.
interface PendingContext {
	promise: Promise<AccessContext>;
	stale: boolean;
}

const inflight = perProcess(
	"platform/access:inflight",
	() => new Map<string, PendingContext>(),
);

// Contexts built while part of what feeds them could not be read. Served to
// the request that built them and never cached, so the next request tries
// again rather than working from a partial answer for a whole lifetime.
const partial = new WeakSet<AccessContext>();

// Two entries accumulate per person, and each holds their whole reachable
// catalogue: catalogGrants puts a grant in the map for every report built on a
// source they can read. Expiry decides whether an entry may be served and on
// its own removes nothing, so without a ceiling the map grows with everybody
// who has ever used the replica rather than with whoever is using it now.
//
// The ceiling is sized for people rather than reports, so it is only reached
// by more people than any one replica serves at once.
const maxCacheEntries = 1_000_000;

// Swept on write rather than on a timer, so a replica that stops being asked
// stops doing work. The interval is what keeps a walk of the map off every
// insert.
const sweepIntervalMs = 60 * 1000;
let sweptAt = 0;

function evictIfNeeded(now: number): void {
	if (now - sweptAt >= sweepIntervalMs) {
		sweptAt = now;
		for (const [key, held] of cache) {
			if (held.expiresAt <= now) cache.delete(key);
		}
	}

	// Past the ceiling the entry resolved longest ago goes, whether or not it
	// is still live. Entries are held in the order they were resolved, so it
	// is the first. A dropped entry costs its owner one resolution.
	while (cache.size > maxCacheEntries) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) return;
		cache.delete(oldest);
	}
}

// How long a resolved access context is reused.
//
// A context is keyed by the caller's policy class, so a change of membership
// gives it a new key, and a change to a role or a grant made here is announced
// and drops it. What it folds in without either is what the catalogue lets
// the caller read, from lib/auth/sourceAccess, so this is how soon a change
// there reaches a context already held. Access to the app itself is gated
// upstream by the identity provider, which revokes on its own schedule
// regardless of this.
const contextLifetimeMs = 5 * 60 * 1000;

// What a caller holds when nothing can be read from the platform store.
//
// Not empty. The configured admin and editor groups are the floor, and the
// whole reason they still exist is that an administrator must not be locked out
// by a problem with the tables that decide who is an administrator. Before the
// role tables, the baseline was a synchronous read of a settings key, so it
// survived any database failure by construction. Moving it into a query put it
// behind the same failure that takes the grants out, and returning nothing here
// meant one unreadable table revoked everybody.
function floorContext(policy: PolicyClass, email: string): AccessContext {
	const configured = configuredBaseline(policy);
	const capabilities: CapabilityMap = new Map();

	if (configured === "admin") {
		for (const capability of allCapabilities) {
			capabilities.set(capability, new Set([globalScope]));
		}
	}

	return { grants: new Map(), baseline: configured, capabilities, email };
}

interface PolicyRow {
	resource_type: string;
	resource_id: string;
	permission: Permission;
}

// Every active per-resource grant, personal shares included, grouped by the
// group or person it names. Held once for everybody rather than asked per
// person, so a morning of first visits works out each person's grants from
// memory. A grant made, changed or withdrawn drops it on every instance,
// through the access change announced with it.
async function policyIndex(): Promise<Map<string, PolicyRow[]>> {
	return cachedDefinition("access-index:policies", async () => {
		const rows = await sql<
			PolicyRow & { subject_type: string; subject: string }
		>(
			`SELECT subject_type, lower(subject_id) AS subject,
			        resource_type, resource_id, permission
			 FROM access_policies
			 WHERE is_active = TRUE`,
		);
		const index = new Map<string, PolicyRow[]>();
		for (const row of rows) {
			const key = `${row.subject_type}|${row.subject}`;
			const list = index.get(key) ?? [];
			list.push(row);
			index.set(key, list);
		}
		return index;
	});
}

// Per-resource grants, including personal shares. Group names compared
// without case, the same as role assignments.
async function loadPolicies(
	policy: PolicyClass,
	email: string,
): Promise<Map<string, Permission>> {
	const index = await policyIndex();
	const rows = [
		...policy.grants.flatMap(
			(group) => index.get(`group|${group.toLowerCase()}`) ?? [],
		),
		...(index.get(`user|${email.toLowerCase()}`) ?? []),
	];

	const grants = new Map<string, Permission>();
	for (const row of rows) {
		const key = grantKey(row.resource_type, row.resource_id);
		grants.set(
			key,
			strongest([grants.get(key), row.permission]) ?? row.permission,
		);
	}
	return grants;
}

// Reachability implied by Unity Catalog.
//
// View only. Editing and administering are decisions about this platform rather
// than about the data, so they never follow from a catalogue privilege.
//
// Personal pages are excluded by the query behind the curated list. Somebody
// who can read a table is entitled to the curated reporting built on it, but
// not to a page a colleague built for themselves on the same table. Excluded at the source rather than filtered afterwards, so nothing
// derived ever lands in the map for a personal page and the resolver's
// guarantee has nothing to unpick.
async function catalogGrants(
	identity: Identity,
): Promise<Map<string, Permission>> {
	const derived = new Map<string, Permission>();
	const readable = await readableSources(identity);
	if (readable.size === 0) return derived;

	// The shared list of active curated reports, filtered here by source. The
	// same rows a query for reports on the readable sources would return,
	// without asking the database once per reader.
	for (const row of await curatedReports()) {
		if (!row.source_key || !readable.has(row.source_key)) continue;
		derived.set(grantKey("report", row.report_id), "view");
		if (row.category_id) {
			derived.set(grantKey("category", row.category_id), "view");
		}
	}
	return derived;
}

// One memo for every lookup.
//
// A failure yields the configured floor rather than everything or nothing.
// Granting everything would open reports nobody was given; granting nothing
// locks out the administrator who would fix it. The floor is what a settings
// file says, which is readable when the database is not.
//
// The failed answer is not cached, so the next request tries again rather than
// serving a degraded one for a minute after the problem clears.
async function cached(
	key: string,
	policy: PolicyClass,
	email: string,
	load: () => Promise<AccessContext>,
): Promise<AccessContext> {
	const now = Date.now();

	const hit = cache.get(key);
	if (hit && hit.expiresAt > now) return hit.context;

	const existing = inflight.get(key);
	if (existing) return existing.promise;

	const pending = { stale: false } as PendingContext;
	pending.promise = (async () => {
		try {
			const context = await load();
			if (!pending.stale && !partial.has(context)) {
				cache.delete(key);
				cache.set(key, {
					context,
					expiresAt: Date.now() + contextLifetimeMs,
				});
				evictIfNeeded(Date.now());
			}
			return context;
		} catch (error) {
			console.error(
				"Access lookup failed, serving the configured groups only:",
				error,
			);
			return floorContext(policy, email);
		}
	})().finally(() => {
		if (inflight.get(key) === pending) inflight.delete(key);
	});

	inflight.set(key, pending);
	return pending.promise;
}

// Roles and per-resource grants, with nothing derived from the catalogue.
//
// The edit and administer paths ask for this rather than the effective set,
// which keeps somebody who can read a table from being able to rewrite the
// report built on it.
async function loadExplicit(
	policy: PolicyClass,
	email: string,
): Promise<AccessContext> {
	// Neither lookup can take the other down, and neither can take down what
	// the catalogue contributes. Each one failing costs what it adds and
	// nothing else: a reader with no explicit grant at all still reaches the
	// reports built on data they hold SELECT on, which for most people is every
	// report they have ever opened.
	let incomplete = false;
	const [policies, assignments] = await Promise.all([
		loadPolicies(policy, email).catch((error) => {
			incomplete = true;
			console.error("Access policies could not be read:", error);
			return new Map<string, Permission>();
		}),
		loadAssignments(policy, email).catch((error) => {
			// The role tables arrived after the grant table, so a process
			// running against a schema that has not caught up finds one and not
			// the other. Losing the roles costs what they add; losing the
			// grants as well would cost what somebody was given years ago.
			console.error(
				"Role assignments could not be read. If this persists, the " +
					"roles, role_capabilities and role_assignments tables may " +
					"not exist yet: restart so the schema is applied.",
				error,
			);
			incomplete = true;
			return [];
		}),
	]);

	const roles = resolveAssignments(assignments);

	// Merged into one map, strongest wins. A scoped role and a per-resource
	// grant naming the same thing are two ways of saying it, not two answers.
	const grants = roles.grants;
	for (const [key, permission] of policies) {
		grants.set(key, strongest([grants.get(key), permission]) ?? permission);
	}

	const configured = configuredBaseline(policy);
	const capabilities: CapabilityMap = roles.capabilities;

	// The configured admin groups carry every capability, globally. Same floor
	// as isAdmin, expressed the way the rest of the system asks the question.
	// Read off the capability list itself, so the floor cannot fall behind a
	// capability added later.
	if (configured === "admin") {
		for (const capability of allCapabilities) {
			const scopes = capabilities.get(capability) ?? new Set<string>();
			scopes.add(globalScope);
			capabilities.set(capability, scopes);
		}
	}

	const context: AccessContext = {
		grants,
		baseline: strongest([roles.baseline, configured]),
		capabilities,
		email,
	};
	if (incomplete) partial.add(context);
	return context;
}

export async function getExplicitContext(
	policy: PolicyClass,
	email: string,
): Promise<AccessContext> {
	if (policy.degraded) return floorContext(policy, email);
	return cached(
		`explicit|${policy.id}|${email.toLowerCase()}`,
		policy,
		email,
		() => loadExplicit(policy, email),
	);
}

// Everything the caller can reach: what a role or grant names, plus what Unity
// Catalog already lets them read.
export async function getAccessContext(
	policy: PolicyClass,
	identity: Identity,
): Promise<AccessContext> {
	// A degraded class has unknown membership, so no grant that names a group
	// can be resolved. Navigation renders from the configured floor rather than
	// guessing at group membership it could not confirm.
	if (policy.degraded) return floorContext(policy, identity.email);

	const email = identity.email;

	return cached(
		`effective|${policy.id}|${email.toLowerCase()}`,
		policy,
		email,
		async () => {
			const context = await loadExplicit(policy, email);

			if (catalogAccessEnabled()) {
				// A catalogue that cannot be reached costs the reader what it would
				// have added, not what they were already given. Letting this throw
				// would empty the whole context, so a warehouse hiccup would blank
				// the home page of somebody holding an explicit grant that has
				// nothing to do with the catalogue.
				try {
					for (const [resource, permission] of await catalogGrants(
						identity,
					)) {
						const held = context.grants.get(resource);
						context.grants.set(
							resource,
							strongest([held, permission]) ?? permission,
						);
					}
				} catch (error) {
					partial.add(context);
					console.error(
						"Catalogue reachability unavailable, serving explicit grants only:",
						error,
					);
				}
			}

			return context;
		},
	);
}

// Whether the caller may take a platform action, optionally within a scope.
export async function canDo(
	policy: PolicyClass,
	identity: Identity,
	capability: Capability,
	scopeId?: string | null,
): Promise<boolean> {
	const context = await getExplicitContext(policy, identity.email);
	return can(context.capabilities, capability, scopeId);
}

// Administering covers the platform itself rather than any one resource, so it
// asks for the capabilities that only an administrator holds.
export async function canAdminister(
	policy: PolicyClass,
	identity: Identity,
): Promise<boolean> {
	if (isAdmin(policy)) return true;
	const context = await getExplicitContext(policy, identity.email);
	return (
		can(context.capabilities, "access.grant") ||
		can(context.capabilities, "settings.manage")
	);
}

// Also drops what was derived from a context, the per reader navigation counts
// and search targets, which would otherwise go on offering what was withdrawn,
// and every held home page plan, which is chosen from what a reader can open.
// Applied here and announced to every other instance. See lib/platform/changes.
export function invalidateAccessCache(): void {
	dropAllAccessLocally();
	announce("access", "*");
}

function dropAllAccessLocally(): void {
	cache.clear();
	for (const pending of inflight.values()) pending.stale = true;
	inflight.clear();
	dropDefinitionsLocally("navigation:visible:");
	dropDefinitionsLocally("search:targets:");
	// A category's contacts are the holders of its editor role, so a role
	// change can change who is listed.
	dropDefinitionsLocally("navigation:category-summary:");
	dropDefinitionsLocally("briefing-plan:");
	dropDefinitionsLocally("access-index:");
}

// The same, for one person. Used when a grant names that person alone, so
// everybody else keeps what they were holding. Context keys end in the
// lowercased email, and so do the derived navigation and search keys.
export function invalidateAccessFor(email: string): void {
	dropAccessForLocally(email);
	announce("access", email.trim().toLowerCase());
}

onChange(
	"access",
	(key) => (key === "*" ? dropAllAccessLocally() : dropAccessForLocally(key)),
	dropAllAccessLocally,
);

function dropAccessForLocally(email: string): void {
	const suffix = `|${email.trim().toLowerCase()}`;
	for (const key of cache.keys()) {
		if (key.endsWith(suffix)) cache.delete(key);
	}
	for (const [key, pending] of inflight) {
		if (!key.endsWith(suffix)) continue;
		pending.stale = true;
		inflight.delete(key);
	}
	dropMatchingLocally(
		(key) =>
			(key.startsWith("navigation:visible:") ||
				key.startsWith("search:targets:")) &&
			key.endsWith(suffix),
	);
	dropDefinitionsLocally(`briefing-plan:${email.trim().toLowerCase()}|`);
	// The grant that named this person is a row in the shared index.
	dropDefinitionsLocally("access-index:");
}
