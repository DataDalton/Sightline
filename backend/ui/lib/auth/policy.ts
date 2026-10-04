import { createHash } from "node:crypto";
import { effectiveAdminGroups, settings } from "../settings";
import { batchedRead } from "../data/batch";
import type { Identity } from "./identity";
import { perProcess } from "../perProcess";

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
// Membership is probed with a single query per sign-in rather than one per
// request, and no SCIM permission is required. A sign-in is told apart by the
// forwarded token. A new sign-in, or the token being replaced while somebody
// stays signed in, is a new token, and the probe runs once for it. A change of
// membership while a token lasts takes effect with the next one. Queries that
// are not answered from the shared cache are unaffected by that wait, since
// Unity Catalog applies the row filter under the token as each one runs.

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
	// The sign-in and the tracked group list the answer was found for. Served
	// only while both are still the caller's.
	session: string;
	setKey: string;
	// Point at which the entry is refreshed on next use.
	expiresAt: number;
	// Point past which the entry is no longer served even in a degraded
	// lookup. Bounds how long a revoked grant keeps working.
	graceUntil: number;
}

const cache = perProcess(
	"auth/policy:cache",
	() => new Map<string, CacheEntry>(),
);
const inflight = perProcess(
	"auth/policy:inflight",
	() => new Map<string, Promise<PolicyClass>>(),
);

const maxCacheEntries = 1_000_000;

// How long one sign-in's answer stands when its token is never replaced, as
// with a token that does not expire. A forwarded token is replaced well
// within this.
const sessionLifetimeMs = 24 * 60 * 60 * 1000;

// Tells one sign-in from another without keeping the token itself. Without a
// token, as in local development and the demo, each person is one sign-in.
function sessionOf(identity: Identity): string {
	return identity.userToken
		? createHash("sha256")
				.update(identity.userToken)
				.digest("hex")
				.slice(0, 32)
		: "local";
}

// How many times one resolution asks again after the tracked group list changes
// under it, before it gives up and reports the class as unresolved.
const maxResolveAttempts = 2;

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

// Whether a probe has ever come back true for a group, per replica.
//
// Group names are matched exactly and case sensitively, and nothing validates
// one at the point somebody types it into a role assignment. A misspelling
// produces a row that looks right, grants nothing, and reports nothing, so this
// is the evidence that distinguishes the two. Absence is not proof of a typo:
// a correctly named group nobody in it has signed in under yet looks the same,
// which is why the administration screen says "not seen" rather than "wrong".
const groupProbes = perProcess(
	"auth/policy:groupProbes",
	() => new Map<string, { probedAt: number; matchedAt: number }>(),
);

export interface GroupProbeRecord {
	name: string;
	probedAt: number;
	matchedAt: number;
}

export function getGroupProbes(): GroupProbeRecord[] {
	return [...groupProbes.entries()].map(([name, seen]) => ({
		name,
		probedAt: seen.probedAt,
		matchedAt: seen.matchedAt,
	}));
}

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
	for (const raw of filterGroups.accountGroups)
		add(raw, "account", "row-filter");
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

// Entries are kept in the order they were resolved, so the first is the one
// resolved longest ago and is dropped when the ceiling is reached. A dropped
// class costs that person one stored policy read on their next request.
function evictIfNeeded(): void {
	while (cache.size > maxCacheEntries) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) return;
		cache.delete(oldest);
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
//
// Takes the group list as an argument rather than reading the module value, so
// the column m<i> in the answer is read back against the same group it was
// asked about even when the tracked list is replaced while the query runs.
async function probeGrants(
	identity: Identity,
	groups: TrackedGroup[],
): Promise<string[]> {
	if (groups.length === 0) return [];

	const { isDatabricksApp } = await import("../runtime");
	if (!identity.userToken && isDatabricksApp) {
		throw new Error(
			"On-behalf-of token required to resolve policy class. " +
				"Enable user authorization with the sql scope on the app.",
		);
	}

	// Imported lazily so the auth layer does not pull the Databricks driver
	// into contexts that never query, such as the proxy bundle.
	const { queryAsUser } = await import("../data/userSession");

	// Each group is asked about with the function the thing that named it uses,
	// so the answer means what the filter meant.
	const selects = groups
		.map((group, i) =>
			group.scope === "workspace"
				? `is_member(:g${i}) AS m${i}`
				: `is_account_group_member(:g${i}) AS m${i}`,
		)
		.join(", ");
	const params: Record<string, unknown> = {};
	groups.forEach((group, i) => {
		params[`g${i}`] = group.name;
	});

	// Development falls back to local credentials, which resolve membership for
	// whoever those credentials belong to rather than for the caller.
	const rows = identity.userToken
		? await queryAsUser(
				identity.userToken,
				`SELECT ${selects}`,
				params,
				identity.email.toLowerCase(),
			)
		: await (
				await import("../data/localSession")
			).queryLocally(
				`SELECT ${selects}`,
				params,
				identity.email.toLowerCase(),
			);
	const row = rows[0] ?? {};

	// The two query paths disagree on type. The SQL driver returns a real
	// boolean; the statement execution API returns the string "true". A strict
	// comparison against true therefore reports every member as a non-member
	// on one path and not the other, so both spellings are accepted.
	const isTrue = (value: unknown): boolean =>
		value === true || String(value).toLowerCase() === "true";

	const matched = groups.filter((_, i) => isTrue(row[`m${i}`]));

	// Records that a probe has resolved for these groups, which is what lets
	// administration tell a group name somebody typed correctly from one they
	// typed wrong. A group assigned a role but never matched by anyone who has
	// signed in is the shape of a typo.
	const now = Date.now();
	for (const group of groups) {
		const seen = groupProbes.get(group.name) ?? {
			probedAt: 0,
			matchedAt: 0,
		};
		seen.probedAt = now;
		groupProbes.set(group.name, seen);
	}
	for (const group of matched) {
		const seen = groupProbes.get(group.name);
		if (seen) seen.matchedAt = now;
	}

	return matched.map((group) => group.name);
}

// The set of groups an answer was computed against. A stored answer is only
// usable while this matches, because a group added to the tracked list is a
// question that was never asked.
function groupSetKey(groups: TrackedGroup[]): string {
	return groups
		.map((g) => `${g.scope}:${g.name}`)
		.sort()
		.join("|");
}

// Read for everyone arriving at about the same time in one statement. See
// lib/data/batch.
// A stored answer is used only for the sign-in it was found for.
const storedPolicies = batchedRead<
	{ email: string; setKey: string; session: string },
	string[] | null
>(
	async (keys) => {
		const { sql } = await import("../data/lakebase");
		const rows = await sql<{
			user_email: string;
			group_set: string;
			session_key: string;
			grants: string[];
		}>(
			`SELECT p.user_email, p.group_set, p.session_key, p.grants
			 FROM reader_policy p
			 JOIN unnest($1::text[], $2::text[], $3::text[]) AS k(e, s, t)
			   ON p.user_email = k.e AND p.group_set = k.s
			  AND p.session_key = k.t
			 WHERE p.expires_on > now()`,
			[
				keys.map((k) => k.email),
				keys.map((k) => k.setKey),
				keys.map((k) => k.session),
			],
		);
		return new Map(
			rows.map((r) => [
				JSON.stringify([r.user_email, r.group_set, r.session_key]),
				r.grants,
			]),
		);
	},
	(k) => JSON.stringify([k.email, k.setKey, k.session]),
	null,
);

async function readStoredPolicy(
	email: string,
	setKey: string,
	session: string,
): Promise<string[] | null> {
	try {
		return await storedPolicies({ email, setKey, session });
	} catch (error) {
		// A miss, never an error the caller sees: the probe still runs.
		console.warn("Stored policy read failed:", error);
		return null;
	}
}

// Answers to store, written together. A burst of people signing in at once,
// a morning's first visits, would otherwise write two rows each, every one
// taking a connection the requests are waiting on. Gathered and written as one
// statement per table about once a second. The answer is already in use from
// memory, so the write only lets another replica skip the probe, and one that
// fails costs that replica a probe, never correctness.
const storeEveryMs = 1000;
const policiesToStore = perProcess(
	"auth/policy:policiesToStore",
	() =>
		new Map<
			string,
			{ email: string; setKey: string; session: string; grants: string[] }
		>(),
);
const groupsToStore = perProcess(
	"auth/policy:groupsToStore",
	() => new Map<string, string[]>(),
);
let storeTimer: ReturnType<typeof setTimeout> | null = null;

function queueStored(
	email: string,
	grants: string[],
	setKey: string,
	session: string,
): void {
	policiesToStore.set(`${email}|${setKey}`, {
		email,
		setKey,
		session,
		grants,
	});
	// Keeps the groups a person was just found in after the stored policy
	// has expired. Only messages read it, to know who is in a group without
	// asking the workspace directory. It grants nothing, since every read of
	// a conversation checks membership again.
	groupsToStore.set(email, grants);
	storeTimer ??= setTimeout(() => {
		storeTimer = null;
		void storeQueued();
	}, storeEveryMs);
	storeTimer.unref?.();
}

async function storeQueued(): Promise<void> {
	const policies = [...policiesToStore.values()];
	const groups = [...groupsToStore.entries()];
	policiesToStore.clear();
	groupsToStore.clear();
	const { sql } = await import("../data/lakebase");
	if (policies.length > 0) {
		await sql(
			`INSERT INTO reader_policy
			   (user_email, group_set, session_key, grants, computed_on,
			    expires_on)
			 SELECT e, k, t, g::jsonb, now(),
			        now() + make_interval(secs => $5)
			 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
			   AS u(e, k, t, g)
			 ON CONFLICT (user_email, group_set) DO UPDATE SET
			   session_key = EXCLUDED.session_key,
			   grants = EXCLUDED.grants,
			   computed_on = EXCLUDED.computed_on,
			   expires_on = EXCLUDED.expires_on`,
			[
				policies.map((p) => p.email),
				policies.map((p) => p.setKey),
				policies.map((p) => p.session),
				policies.map((p) => JSON.stringify(p.grants)),
				sessionLifetimeMs / 1000,
			],
		).catch((error) => {
			console.warn("Stored policy write failed:", error);
		});
	}
	if (groups.length > 0) {
		await sql(
			`INSERT INTO member_groups (user_email, grants, checked_on)
			 SELECT e, g::jsonb, now()
			 FROM unnest($1::text[], $2::text[]) AS u(e, g)
			 ON CONFLICT (user_email) DO UPDATE SET
			   grants = EXCLUDED.grants,
			   checked_on = EXCLUDED.checked_on`,
			[groups.map(([e]) => e), groups.map(([, g]) => JSON.stringify(g))],
		).catch((error) => {
			console.warn("Member groups write failed:", error);
		});
	}
}

export async function resolvePolicyClass(
	identity: Identity,
): Promise<PolicyClass> {
	const key = identity.email.toLowerCase();
	const session = sessionOf(identity);
	const now = Date.now();

	if (trackedGroups.length === 0) return emptyClass(now);

	const cached = cache.get(key);
	if (
		cached &&
		cached.expiresAt > now &&
		cached.session === session &&
		cached.setKey === groupSetKey(trackedGroups)
	) {
		return cached.value;
	}

	const resolving = `${key}|${session}`;
	const existing = inflight.get(resolving);
	if (existing) return existing;

	// Declared ahead of the body so its own cleanup can tell its entry apart.
	let pending: Promise<PolicyClass> | undefined = undefined;
	pending = (async (): Promise<PolicyClass> => {
		try {
			// Read back before it is asked for again. A replica that already
			// probed for this sign-in stored what it found, so one sign-in is
			// probed once however many replicas it reaches.
			//
			// The answer is only kept when the tracked list is still the one it
			// was asked against. A list replaced while the probe ran would
			// otherwise leave a class built without a newly tracked row filter
			// group, and that class would share cached rows with people outside
			// the group. The probe is asked again against the new list instead.
			let groups = trackedGroups;
			let setKey = groupSetKey(groups);
			let stored: string[] | null = null;
			let grants: string[] = [];
			for (let attempt = 0; ; attempt++) {
				stored = await readStoredPolicy(key, setKey, session);
				grants = stored ?? (await probeGrants(identity, groups));
				const currentKey = groupSetKey(trackedGroups);
				if (currentKey === setKey) break;
				if (attempt >= maxResolveAttempts) {
					throw new Error(
						"The tracked group list kept changing while membership was resolved.",
					);
				}
				groups = trackedGroups;
				setKey = currentKey;
			}
			if (!stored) queueStored(key, grants, setKey, session);
			const value: PolicyClass = {
				id: policyIdFor(grants),
				grants,
				degraded: false,
				stale: false,
				resolvedAt: now,
			};
			cache.delete(key);
			cache.set(key, {
				value,
				session,
				setKey,
				expiresAt: now + sessionLifetimeMs,
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
					session: cached.session,
					setKey: cached.setKey,
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
			// Only this resolution's own entry. A tracked list change clears the
			// map, and a resolution started after that belongs to someone else.
			if (inflight.get(resolving) === pending) {
				inflight.delete(resolving);
			}
		}
	})();

	inflight.set(resolving, pending);
	return pending;
}

// Drops a cached class so a grant change takes effect without waiting for the
// next sign-in. Only affects the calling replica.
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
