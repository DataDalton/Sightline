import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { catalogAccessEnabled, readableSources } from "../auth/sourceAccess";
import { effectiveAdminGroups, settings } from "../settings";
import { isDatabricksApp } from "../runtime";
import { loadAssignments } from "./roles";
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

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<AccessContext>>();
// How long a resolved access context is reused.
//
// The same setting the membership probe uses, rather than a second number
// meaning nearly the same thing. Both answer "how long is a membership-derived
// decision trusted", and having one at sixty seconds and the other at five
// minutes meant the shorter one silently decided, so the setting an admin can
// see did not describe the behaviour.
//
// This bounds how long a withdrawn grant keeps working inside the app. Access
// to the app itself is gated upstream by the identity provider, which revokes
// on its own schedule regardless of this.
function contextTtlMs(): number {
	return Math.max(settings().groupCacheTtlSeconds, 30) * 1000;
}

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

// Per-resource grants, including personal shares.
async function loadPolicies(
	policy: PolicyClass,
	email: string,
): Promise<Map<string, Permission>> {
	const rows = await sql<{
		resource_type: string;
		resource_id: string;
		permission: Permission;
	}>(
		`SELECT resource_type, resource_id, permission
		 FROM access_policies
		 WHERE is_active = TRUE
		   AND (
		     (subject_type = 'group' AND subject_id = ANY($1))
		     OR (subject_type = 'user' AND lower(subject_id) = $2)
		   )`,
		[policy.grants, email.toLowerCase()],
	);

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
// Personal pages are excluded at the query. Somebody who can read a table is
// entitled to the curated reporting built on it; they are not entitled to a
// page a colleague built for themselves on the same table. Excluded here rather
// than filtered afterwards, so nothing derived ever lands in the map for a
// personal page and the resolver's guarantee has nothing to unpick.
async function catalogGrants(
	identity: Identity,
): Promise<Map<string, Permission>> {
	const derived = new Map<string, Permission>();
	const readable = await readableSources(identity);
	if (readable.size === 0) return derived;

	const rows = await sql<{ report_id: string; category_id: string | null }>(
		`SELECT report_id::text AS report_id, category_id
		 FROM reports
		 WHERE is_active = TRUE
		   AND is_personal = FALSE
		   AND source_key = ANY($1)`,
		[Array.from(readable)],
	);

	for (const row of rows) {
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
	if (existing) return existing;

	const pending = (async () => {
		try {
			const context = await load();
			cache.set(key, { context, expiresAt: now + contextTtlMs() });
			return context;
		} catch (error) {
			console.error(
				"Access lookup failed, serving the configured groups only:",
				error,
			);
			return floorContext(policy, email);
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, pending);
	return pending;
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
	const [policies, assignments] = await Promise.all([
		loadPolicies(policy, email).catch((error) => {
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

	return {
		grants,
		baseline: strongest([roles.baseline, configured]),
		capabilities,
		email,
	};
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

export function invalidateAccessCache(): void {
	cache.clear();
}
