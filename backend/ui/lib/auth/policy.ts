import { effectiveAdminGroups, settings } from "../settings";
import type { Identity } from "./identity";

// Resolves a caller into a policy class: the set of group grants that decides
// which rows Unity Catalog will return for them.
//
// The platform never re-implements a Unity Catalog row filter. UC applies the
// filter when the aggregate is computed, under the user token. The policy
// class exists only so results can be cached and shared safely: two users in
// the same class provably see the same rows, so they can share a cache entry,
// and two users in different classes can never read each other entries
// because the class id is part of the cache key.
//
// Membership is probed with a single query per user per TTL rather than one
// per request, and no SCIM permission is required.

export interface PolicyClass {
	// Stable id for the resolved grant set. Part of every data cache key.
	id: string;
	// Group names the user belongs to, of those the platform cares about.
	grants: string[];
	// True when membership could not be resolved. Callers must refuse to serve
	// data for a degraded class rather than treating it as unrestricted.
	degraded: boolean;
	// True when the value came from the grace window during a lookup outage.
	// Access already granted keeps working; nothing new is granted.
	stale: boolean;
	resolvedAt: number;
}

interface CacheEntry {
	value: PolicyClass;
	// Point at which the entry is refreshed on next use.
	expiresAt: number;
	// Point past which the entry is no longer served even in a degraded
	// lookup. Bounds how long a revoked grant keeps working.
	graceUntil: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<PolicyClass>>();

const maxCacheEntries = 50000;

// Groups the platform evaluates, and which directory each is asked about.
//
// Two sources feed this. The platform's own access rules say who may open a
// report. Row filters discovered in the catalogue say who sees which rows, and
// those matter just as much: a cached answer may only be shared between two
// people when every group that changes row visibility agrees for both. A group
// missing from here is not a smaller cache, it is one reader receiving another
// reader's rows.
//
// The two membership functions are held apart because they read different
// directories and can disagree for the same person. A filter written with
// is_member() has to be probed with is_member(), or the partition is built on
// an answer to a different question.
interface TrackedGroup {
	name: string;
	scope: "account" | "workspace";
	// Why this group is probed. Reported to administrators, because "found in
	// a row filter" and "because you named it an editor group" are different
	// facts and only one of them follows a filter someone else edits.
	origin: "row-filter" | "access-rule" | "editor" | "admin" | "configured";
}

let trackedGroups: TrackedGroup[] = [];

export function setTrackedGroups(
	groups: string[],
	filterGroups: { accountGroups: string[]; workspaceGroups: string[] } = {
		accountGroups: [],
		workspaceGroups: [],
	},
): void {
	// Editor and admin groups are always probed, whether or not an access rule
	// names them. Without this a central editor whose only grant is implicit
	// would resolve to a class with no membership and lose their own edit
	// rights.
	const { editorGroups } = settings();
	const adminGroups = effectiveAdminGroups();

	// Group names keep their original case. is_account_group_member is
	// case-sensitive: 'Data-Engineering' matches and 'data-engineering' does
	// not. Normalising the name before the probe silently reports every member
	// as a non-member, which denies a whole team with nothing in the logs to
	// explain it.
	//
	// Duplicates are still removed case-insensitively, keeping the first
	// spelling seen, so one group configured two ways is probed once.
	const seen = new Set<string>();
	const unique: TrackedGroup[] = [];

	const add = (
		raw: string,
		scope: TrackedGroup["scope"],
		origin: TrackedGroup["origin"],
	) => {
		const name = raw.trim();
		if (!name) return;
		// Scoped, so the same name asked of two directories is two questions
		// rather than one deduplicated into the wrong answer.
		const fingerprint = `${scope}:${name.toLowerCase()}`;
		if (seen.has(fingerprint)) return;
		seen.add(fingerprint);
		unique.push({ name, scope, origin });
	};

	// An explicit list from the settings table is added, never substituted.
	//
	// It exists for a group discovery cannot see, such as a filter on a table
	// this identity may not read. Letting it replace the discovered list would
	// make it a way to silently switch the safety off, and the failure would
	// look like nothing at all.
	const { trackedGroups: configured } = settings();

	// Order matters: the first mention of a name decides what it is recorded
	// as, and a filter is the reason worth surfacing when a group is both.
	for (const raw of filterGroups.accountGroups) add(raw, "account", "row-filter");
	for (const raw of filterGroups.workspaceGroups) {
		add(raw, "workspace", "row-filter");
	}
	for (const raw of groups) add(raw, "account", "access-rule");
	for (const raw of editorGroups) add(raw, "account", "editor");
	for (const raw of adminGroups) add(raw, "account", "admin");
	for (const raw of configured) add(raw, "account", "configured");

	const next = unique.sort((a, b) =>
		a.scope === b.scope
			? a.name.localeCompare(b.name)
			: a.scope.localeCompare(b.scope),
	);

	// A cached class was resolved against the previous list, so it cannot
	// answer for the new one. Without clearing, an admin adding an editor
	// group waited out the membership cache before it took effect, which reads
	// as the setting not working rather than as a delay.
	//
	// Only on an actual change: this runs on every settings poll, and clearing
	// each time would mean a membership probe per user per minute.
	const fingerprintOf = (list: TrackedGroup[]) =>
		list.map((g) => `${g.scope}:${g.name}`).join("\u0000");

	if (fingerprintOf(next) !== fingerprintOf(trackedGroups)) {
		cache.clear();
		inflight.clear();
	}

	trackedGroups = next;
}

export function getTrackedGroups(): string[] {
	return trackedGroups.map((g) => g.name);
}

export function getTrackedGroupDetail(): TrackedGroup[] {
	return trackedGroups;
}

// Builds the policy class id from the sorted grant list. This is deliberately
// not a hash: the id becomes part of every data cache key, so a collision
// between two different grant sets would let one policy class read rows
// cached for another. Encoding the grants directly makes that impossible.
//
// Group names are not secret, and keys stay short because only groups that
// appear in a dataset access rule are ever tracked.
function policyIdFor(grants: string[]): string {
	if (grants.length === 0) return "none";
	// Lowercased for the id only, so two spellings of the same grant set
	// resolve to one cache entry. The probe itself uses the original case.
	return grants
		.map((g) => g.toLowerCase())
		.sort()
		.map((g) => encodeURIComponent(g))
		.join("+");
}

function evictIfNeeded(): void {
	if (cache.size <= maxCacheEntries) return;
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (entry.graceUntil <= now) cache.delete(key);
	}
	if (cache.size > maxCacheEntries) {
		let excess = cache.size - maxCacheEntries;
		for (const key of cache.keys()) {
			cache.delete(key);
			if (--excess <= 0) break;
		}
	}
}

// The empty class. Used when a caller has no grants at all: it is a real,
// cacheable class (they see whatever UC returns for someone with no groups),
// not an error state.
function emptyClass(now: number): PolicyClass {
	return {
		id: policyIdFor([]),
		grants: [],
		degraded: false,
		stale: false,
		resolvedAt: now,
	};
}

// Probes group membership in one round trip. is_account_group_member is
// evaluated by the warehouse for the identity running the query, so this must
// run under the user token, never the service principal.
async function probeGrants(identity: Identity): Promise<string[]> {
	if (trackedGroups.length === 0) return [];

	const { isDatabricksApp } = await import("../runtime");
	if (!identity.userToken && isDatabricksApp) {
		throw new Error(
			"On-behalf-of token required to resolve policy class. " +
				"Enable user authorization with the sql scope on the app.",
		);
	}

	// Imported lazily so the auth layer does not pull the Databricks driver
	// into contexts that never query, such as the middleware bundle.
	const { queryAsUser } = await import("../data/userSession");

	// Each group is asked about with the function the thing that named it uses,
	// so the answer means what the filter meant.
	const selects = trackedGroups
		.map((group, i) =>
			group.scope === "workspace"
				? `is_member(:g${i}) AS m${i}`
				: `is_account_group_member(:g${i}) AS m${i}`,
		)
		.join(", ");
	const params: Record<string, unknown> = {};
	trackedGroups.forEach((group, i) => {
		params[`g${i}`] = group.name;
	});

	// Development falls back to local credentials, which resolve membership for
	// whoever those credentials belong to rather than for the caller.
	const rows = identity.userToken
		? await queryAsUser(identity.userToken, `SELECT ${selects}`, params)
		: await (await import("../data/localSession")).queryLocally(
				`SELECT ${selects}`,
				params,
			);
	const row = rows[0] ?? {};

	// The two query paths disagree on type. The SQL driver returns a real
	// boolean; the statement execution API returns the string "true". A strict
	// comparison against true therefore reports every member as a non-member
	// on one path and not the other, so both spellings are accepted.
	const isTrue = (value: unknown): boolean =>
		value === true || String(value).toLowerCase() === "true";

	return trackedGroups
		.filter((_, i) => isTrue(row[`m${i}`]))
		.map((group) => group.name);
}

export async function resolvePolicyClass(
	identity: Identity,
): Promise<PolicyClass> {
	const key = identity.email.toLowerCase();
	const now = Date.now();

	if (trackedGroups.length === 0) return emptyClass(now);

	const cached = cache.get(key);
	if (cached && cached.expiresAt > now) return cached.value;

	const existing = inflight.get(key);
	if (existing) return existing;

	const pending = (async (): Promise<PolicyClass> => {
		try {
			const grants = await probeGrants(identity);
			const value: PolicyClass = {
				id: policyIdFor(grants),
				grants,
				degraded: false,
				stale: false,
				resolvedAt: now,
			};
			cache.set(key, {
				value,
				expiresAt: now + settings().groupCacheTtlSeconds * 1000,
				graceUntil: now + settings().policyGraceSeconds * 1000,
			});
			evictIfNeeded();
			return value;
		} catch (error) {
			console.error(`Policy class lookup failed for ${key}:`, error);

			// Grace window: keep serving the last known grants so a lookup
			// outage does not lock out users who already had access. The
			// grants themselves are unchanged, so nothing new is granted and
			// a revocation lags by at most the grace window.
			if (cached && cached.graceUntil > now) {
				const stale: PolicyClass = { ...cached.value, stale: true };
				cache.set(key, {
					value: stale,
					expiresAt: now + 30000,
					graceUntil: cached.graceUntil,
				});
				return stale;
			}

			// No prior result to fall back on. Degraded classes are refused
			// by the data layer, so this denies rows while leaving the app
			// shell usable.
			return {
				id: "degraded",
				grants: [],
				degraded: true,
				stale: false,
				resolvedAt: now,
			};
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, pending);
	return pending;
}

// Drops a cached class so a grant change takes effect without waiting out the
// TTL. Only affects the calling replica.
export function invalidatePolicyClass(email?: string): void {
	if (email) {
		cache.delete(email.toLowerCase());
		return;
	}
	cache.clear();
}

export interface PolicyCacheStats {
	entries: number;
	degraded: number;
	stale: number;
}

export function policyCacheStats(): PolicyCacheStats {
	let degraded = 0;
	let stale = 0;
	for (const entry of cache.values()) {
		if (entry.value.degraded) degraded++;
		if (entry.value.stale) stale++;
	}
	return { entries: cache.size, degraded, stale };
}
