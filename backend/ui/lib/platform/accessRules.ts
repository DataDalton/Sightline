// The access decisions themselves, with no database behind them.
//
// Split from lib/platform/access.ts so the rules can be tested directly. That
// module owns the queries and the cache; this one owns what the answers mean.
// Both halves matter, but only this half can be got wrong silently, because a
// query that fails is loud and a resolver that returns "allowed" is not.
//
// This layer governs reachability, never row visibility. Which rows a user sees
// is Unity Catalog's job, applied during the scan under their own token. If
// this layer had a bug it would show somebody a report they should not reach,
// but the report would still hold only rows they are entitled to.

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

// The strongest of several, ignoring the ones that are not there.
export function strongest(
	candidates: (Permission | null | undefined)[],
): Permission | null {
	const held = candidates.filter((p): p is Permission => Boolean(p));
	if (held.length === 0) return null;
	return held.reduce((best, p) =>
		permissionRank[p] > permissionRank[best] ? p : best,
	);
}

export function grantKey(type: string, id: string): string {
	return `${type}:${id}`;
}

// --- Capabilities ----------------------------------------------------------

// Things somebody may do to the platform, as distinct from resources they may
// open. The permission ladder answers "may I open this report"; a capability
// answers "may I create a report at all".
//
// Kept as a closed list rather than free text, so a role cannot be granted a
// capability nothing checks and a check cannot name a capability no role can
// hold. Both failures are silent, and in opposite directions.
export const capabilities = [
	// Authoring curated content.
	"report.create",
	"page.create",
	// Moving somebody's personal page into a curated category.
	"report.publish",
	// Navigation structure.
	"category.create",
	"category.manage",
	// Administering the platform itself.
	"access.grant",
	"semantic.sync",
	"settings.manage",
] as const;

export type Capability = (typeof capabilities)[number];

const capabilitySet = new Set<string>(capabilities);

export function isCapability(value: string): value is Capability {
	return capabilitySet.has(value);
}

// --- Roles -----------------------------------------------------------------

// A named bundle: one permission on the resources in scope, plus the platform
// actions the holder may take.
export interface RoleDefinition {
	roleId: string;
	name: string;
	description: string;
	permission: Permission;
	capabilities: Capability[];
}

// Where an assignment applies. A role held globally applies everywhere; one
// held on a category applies to that category and the reports inside it.
//
// This is what lets "edit, but only in this subject area" be said without
// inventing a permission level for it.
export type ScopeType = "global" | "category" | "report";

// Scope marker for a capability held everywhere. Not a valid category or
// report id, so it cannot collide with a scoped one.
export const globalScope = "*";

// Re-asserted on every start rather than seeded once, so the capability set of
// a built-in role is owned by this file. An administrator who wants a different
// bundle makes a role of their own, which is a thing they can name and explain,
// rather than quietly widening one whose name everyone already trusts.
export const builtinRoles: RoleDefinition[] = [
	{
		roleId: "admin",
		name: "Administrator",
		description:
			"Manages access, platform settings and the semantic layer. Implies editing.",
		permission: "admin",
		capabilities: [...capabilities],
	},
	{
		roleId: "editor",
		name: "Editor",
		description:
			"Builds and maintains curated reports. Edits publish to everyone rather than making a personal copy.",
		permission: "edit",
		capabilities: ["report.create", "page.create", "report.publish"],
	},
	{
		roleId: "reader",
		name: "Reader",
		description:
			"Opens what they have been given, and builds pages of their own.",
		permission: "view",
		capabilities: [],
	},
];

// --- Ownership -------------------------------------------------------------

// A report somebody built for themselves.
//
// Keyed on its own column rather than on visibility. Every report already in
// the table carries visibility 'private' by default and a non-null owner, so
// reading those two as "personal" would hide the entire curated catalogue the
// moment this shipped. is_personal is set only by the path that makes a
// personal page, which means the rule below is inert for everything that
// existed before it.
export interface ReportRef {
	reportId: string;
	categoryId: string | null;
	isPersonal: boolean;
	ownerEmail: string | null;
}

export interface AccessCheck {
	allowed: boolean;
	permission: Permission | null;
	// True when the only thing that opened a personal page was an
	// administrator role. Reported rather than worked out again by the caller,
	// which is how two answers to one question come apart.
	viaAdministration?: boolean;
}

const denied: AccessCheck = { allowed: false, permission: null };

function samePerson(a: string | null, b: string | null): boolean {
	if (!a || !b) return false;
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Resolves the effective permission on a report.
//
// For curated content: a grant on the report itself wins, otherwise it inherits
// from its category, which is how a team is given a whole subject area in one
// row. A global role stands in when neither names them.
//
// For a personal page, almost none of that applies. Its owner holds it
// outright, everybody else needs a grant naming that page specifically, and
// catalogue reachability never reaches one. That last part is the difference
// between "shared with three people" and "shared with everyone who can read the
// table underneath", and it is why somebody holding SELECT on a source does not
// thereby see a colleague's working page built on it.
//
// The editor role does not reach one either, and that is the case worth being
// careful about: an editor holds edit on every curated report, so letting the
// same baseline through here would have handed every editor every reader's
// private work the moment personal pages moved into this table.
//
// An administrator does reach one. Administering the platform means being able
// to answer for what it holds: a page nobody can open is a page nobody can
// audit, hand back to somebody who lost access to it, or answer a question
// about. Only a global administrator, because a category-scoped one is scoped
// to a category and a personal page is in none. Privileged access rather than
// ordinary access, so lib/platform/reports records it when it is used.
export function resolveReportAccess(
	grants: Map<string, Permission>,
	report: ReportRef,
	viewerEmail: string,
	required: Permission = "view",
	baseline: Permission | null = null,
): AccessCheck {
	const direct = grants.get(grantKey("report", report.reportId));

	if (report.isPersonal) {
		if (samePerson(report.ownerEmail, viewerEmail)) {
			return { allowed: true, permission: "admin" };
		}
		if (baseline === "admin") {
			return {
				allowed: true,
				permission: "admin",
				viaAdministration: true,
			};
		}
		if (!direct) return denied;
		return { allowed: atLeast(direct, required), permission: direct };
	}

	const inherited = report.categoryId
		? grants.get(grantKey("category", report.categoryId))
		: undefined;

	const held = strongest([direct, inherited, baseline]);
	if (!held) return denied;
	return { allowed: atLeast(held, required), permission: held };
}

export function resolveCategoryAccess(
	grants: Map<string, Permission>,
	categoryId: string,
	required: Permission = "view",
	baseline: Permission | null = null,
): AccessCheck {
	const held = strongest([
		grants.get(grantKey("category", categoryId)),
		baseline,
	]);
	if (!held) return denied;
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
	if (direct)
		return { allowed: atLeast(direct, required), permission: direct };
	return reportAccess;
}

// --- Capability checks -----------------------------------------------------

// Which scopes a caller holds each capability in. The empty set and an absent
// key mean the same thing, so a caller holding nothing is an empty map rather
// than a map of empty sets.
export type CapabilityMap = Map<Capability, Set<string>>;

// Whether the caller may take an action, optionally within a scope.
//
// A capability held globally satisfies any scope. One held on a category
// satisfies that category and nothing else, so an editor scoped to one subject
// area cannot create a report in another.
export function can(
	held: CapabilityMap,
	capability: Capability,
	scopeId?: string | null,
): boolean {
	const scopes = held.get(capability);
	if (!scopes || scopes.size === 0) return false;
	if (scopes.has(globalScope)) return true;
	if (!scopeId) return false;
	return scopes.has(scopeId);
}

// Folds one assignment into the running answer.
export interface ResolvedAssignment {
	permission: Permission;
	capabilities: Capability[];
	scopeType: ScopeType;
	scopeId: string | null;
}

export interface ResolvedRoles {
	// Grants keyed the same way an explicit access policy is, so both merge
	// into one map and the resolvers above cannot tell them apart.
	grants: Map<string, Permission>;
	// The strongest global-scope permission, which is what stands in when
	// nothing names a resource.
	baseline: Permission | null;
	capabilities: CapabilityMap;
}

export function resolveAssignments(
	assignments: ResolvedAssignment[],
): ResolvedRoles {
	const grants = new Map<string, Permission>();
	const held: CapabilityMap = new Map();
	let baseline: Permission | null = null;

	for (const assignment of assignments) {
		const scope =
			assignment.scopeType === "global"
				? globalScope
				: (assignment.scopeId ?? null);

		// A scoped assignment with no scope names nothing. Dropped rather than
		// treated as global, because widening a grant on malformed input is the
		// one direction this must never fail in.
		if (!scope) continue;

		if (assignment.scopeType === "global") {
			baseline = strongest([baseline, assignment.permission]);
		} else {
			const key = grantKey(assignment.scopeType, scope);
			grants.set(
				key,
				strongest([grants.get(key), assignment.permission]) ??
					assignment.permission,
			);
		}

		for (const capability of assignment.capabilities) {
			const scopes = held.get(capability) ?? new Set<string>();
			scopes.add(scope);
			held.set(capability, scopes);
		}
	}

	return { grants, baseline, capabilities: held };
}
