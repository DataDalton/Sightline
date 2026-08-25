import { sql } from "../data/lakebase";
import type { PolicyClass } from "../auth/policy";
import { effectiveAdminGroups, settings } from "../settings";

// Decides what a caller may open: which categories appear in navigation, which
// reports they can view, and which they can edit.
//
// This layer governs reachability, never row visibility. Which rows a user
// sees is Unity Catalog's job, applied during the scan under their own token.
// Keeping the two separate matters: if this layer had a bug it would show a
// user a report they should not see, but the report would still contain only
// rows they are entitled to.

export type Permission = "view" | "edit" | "admin";

// Ordered weakest to strongest, so a caller holding several grants keeps the
// strongest one.
const permissionRank: Record<Permission, number> = {
	view: 1,
	edit: 2,
	admin: 3,
};

export function atLeast(held: Permission, required: Permission): boolean {
	return permissionRank[held] >= permissionRank[required];
}

function inAnyGroup(policy: PolicyClass, groups: string[]): boolean {
	if (policy.degraded) return false;
	const held = new Set(policy.grants.map((g) => g.toLowerCase()));
	return groups.some((g) => held.has(g.trim().toLowerCase()));
}

// Central editors maintain one shared definition of every report. Their edits
// publish to everyone rather than creating a personal copy, which is what
// makes the report a single source rather than a per-user fork.
export function isEditor(policy: PolicyClass): boolean {
	return inAnyGroup(policy, settings().editorGroups);
}

// Administrators manage access policy, platform settings and the semantic
// layer. Being an admin implies editing.
export function isAdmin(policy: PolicyClass): boolean {
	// The bootstrap groups stand in while the table names none, so a fresh
	// install has somebody who can configure it.
	return inAnyGroup(policy, effectiveAdminGroups());
}

// The permission a caller holds everywhere, before any per-resource grant.
// Returns null when they hold none, in which case the grant table decides.
export function baselinePermission(policy: PolicyClass): Permission | null {
	if (isAdmin(policy)) return "admin";
	if (isEditor(policy)) return "edit";
	return null;
}

export interface AccessGrant {
	resourceType: "category" | "report" | "page";
	resourceId: string;
	permission: Permission;
}

// Everything a policy class can reach, resolved in one query. Cached per class
// rather than per user, because two users with identical grants resolve to the
// identical answer, which is the same property that makes the query cache
// shareable.
interface CacheEntry {
	grants: Map<string, Permission>;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Map<string, Permission>>>();
const ttlMs = 60000;

function grantKey(type: string, id: string): string {
	return `${type}:${id}`;
}

async function loadGrants(
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
		const existing = grants.get(key);
		if (!existing || permissionRank[row.permission] > permissionRank[existing]) {
			grants.set(key, row.permission);
		}
	}
	return grants;
}

export async function getGrants(
	policy: PolicyClass,
	email: string,
): Promise<Map<string, Permission>> {
	// A degraded class has unknown membership, so it gets no grants at all.
	// Navigation renders empty rather than guessing.
	if (policy.degraded) return new Map();

	// Personal grants make the cache key per user; group grants alone make it
	// per class. Including the email keeps both correct.
	const key = `${policy.id}|${email.toLowerCase()}`;
	const now = Date.now();

	const cached = cache.get(key);
	if (cached && cached.expiresAt > now) return cached.grants;

	const existing = inflight.get(key);
	if (existing) return existing;

	const pending = (async () => {
		try {
			const grants = await loadGrants(policy, email);
			cache.set(key, { grants, expiresAt: now + ttlMs });
			return grants;
		} catch (error) {
			console.error("Access grant lookup failed:", error);
			// No grants rather than all grants. An access lookup failure must
			// not open reports the caller has never been given.
			return new Map<string, Permission>();
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, pending);
	return pending;
}

export interface AccessCheck {
	allowed: boolean;
	permission: Permission | null;
}

// Resolves the effective permission on a report. A grant on the report itself
// wins; otherwise the report inherits from its category, which is how a team
// is given a whole subject area in one row.
export function resolveReportAccess(
	grants: Map<string, Permission>,
	reportId: string,
	categoryId: string | null,
	required: Permission = "view",
	baseline: Permission | null = null,
): AccessCheck {
	const direct = grants.get(grantKey("report", reportId));
	const inherited = categoryId
		? grants.get(grantKey("category", categoryId))
		: undefined;

	const candidates = [direct, inherited, baseline].filter(
		(p): p is Permission => Boolean(p),
	);
	if (candidates.length === 0) return { allowed: false, permission: null };

	const held = candidates.reduce((best, p) =>
		permissionRank[p] > permissionRank[best] ? p : best,
	);
	return { allowed: atLeast(held, required), permission: held };
}

export function resolveCategoryAccess(
	grants: Map<string, Permission>,
	categoryId: string,
	required: Permission = "view",
	baseline: Permission | null = null,
): AccessCheck {
	const direct = grants.get(grantKey("category", categoryId));
	const candidates = [direct, baseline].filter((p): p is Permission =>
		Boolean(p),
	);
	if (candidates.length === 0) return { allowed: false, permission: null };

	const held = candidates.reduce((best, p) =>
		permissionRank[p] > permissionRank[best] ? p : best,
	);
	return { allowed: atLeast(held, required), permission: held };
}

// Page-level override, used when one page of a report is more sensitive than
// the rest. Absence means the page inherits the report.
export function resolvePageAccess(
	grants: Map<string, Permission>,
	pageId: string,
	reportAccess: AccessCheck,
	required: Permission = "view",
): AccessCheck {
	const direct = grants.get(grantKey("page", pageId));
	if (direct) return { allowed: atLeast(direct, required), permission: direct };
	return reportAccess;
}

export function invalidateAccessCache(): void {
	cache.clear();
}
