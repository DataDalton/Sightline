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

// Held in the grants by whoever may open other people's personal pages. An administrator
// holds it at admin, and anyone else at view, so looking never becomes changing.
export const personalViewKey = "personal:*";

// The pages a person reaches a report through when nothing wider lets them open it. Null
// means the whole report.
export function pagesLimitedTo(
	grants: Map<string, Permission>,
	report: ReportRef,
	viewerEmail: string,
	baseline: Permission | null,
	pagesByReport: Map<string, Set<string>> | undefined,
	addedForPages: Set<string> | undefined,
): Set<string> | null {
	if (!addedForPages?.has(report.reportId)) return null;
	const without = new Map(grants);
	without.delete(grantKey("report", report.reportId));
	const wider = resolveReportAccess(
		without,
		report,
		viewerEmail,
		"view",
		baseline,
	);
	return wider.allowed ? null : (pagesByReport?.get(report.reportId) ?? null);
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
	// Working on curated reports.
	"report.create",
	"report.edit",
	"report.suggest",
	"report.review",
	"report.editAny",
	"report.delete",
	"report.move",
	"page.create",
	// Turning a personal page into an official report, which is what puts it in
	// front of everybody who can read its data. Held apart from editing because
	// reaching everyone is a decision of its own.
	"report.makeOfficial",
	// Locking a page against deletion or against change. Its own capability
	// rather than part of editing, because the point of a lock is that the
	// people who edit a page cannot lift it.
	"page.protect",
	// Changing or removing a block somebody else built.
	"block.manage",
	// Making the themes Editors apply.
	"theme.manage",
	// Opening other people's personal pages, always logged.
	"personal.viewAny",
	// Creating data rules and answering for what they find.
	"rule.manage",
	// Posting to Updates about what it is held on, and looking after everyone's.
	"update.post",
	"update.moderate",
	// Navigation structure.
	"category.create",
	"category.manage",
	// What every reader can do unless an exception takes it away.
	"export.run",
	"explore.use",
	"assistant.use",
	"personal.create",
	"board.create",
	"sheet.create",
	"alert.create",
	"schedule.create",
	"note.write",
	"note.moderate",
	// Deciding who edits inside a scope, without administering the platform.
	"access.delegate",
	// Administering the platform itself.
	"access.grant",
	"semantic.sync",
	"settings.manage",
	"audit.view",
	"usage.view",
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
//
// A tag reaches every report carrying it, so an area can be granted without a row
// per report.
export type ScopeType =
	| "global"
	| "category"
	| "tag"
	| "report"
	| "page"
	| "source";

// Who can hold anything. A service principal is how an automation signs in.
export type SubjectType = "group" | "user" | "service_principal";

// How a scope is written in a set of scopes. Ids of the other kinds are unique on
// their own, and a tag is a word somebody typed, so only a tag needs marking.
export function tagScope(tag: string): string {
	return `tag:${tag.trim().toLowerCase()}`;
}

// Scope marker for a capability held everywhere. Not a valid category or
// report id, so it cannot collide with a scoped one.
export const globalScope = "*";

// Re-asserted on every start rather than seeded once, so the capability set of
// a built-in role is owned by this file. An administrator who wants a different
// bundle makes a role of their own, which is a thing they can name and explain,
// rather than quietly widening one whose name everyone already trusts.
//
// Each builds on the one before it, except Report Publisher, which is added on top
// of whatever somebody already holds.
export const readerCapabilities: Capability[] = [
	"export.run",
	"explore.use",
	"assistant.use",
	"personal.create",
	"board.create",
	"sheet.create",
	"alert.create",
	"schedule.create",
	"note.write",
];

const contributorCapabilities: Capability[] = [
	...readerCapabilities,
	"report.suggest",
];

const editorCapabilities: Capability[] = [
	...contributorCapabilities,
	"report.create",
	"report.edit",
	"page.create",
];

export const maintainerCapabilities: Capability[] = [
	...editorCapabilities,
	"report.review",
	"report.delete",
	"report.move",
	"note.moderate",
	"access.delegate",
	"rule.manage",
];

export const builtinRoles: RoleDefinition[] = [
	{
		roleId: "admin",
		name: "Administrator",
		description:
			"Manages access, platform settings and the semantic layer, and can do everything else.",
		permission: "admin",
		capabilities: [...capabilities],
	},
	{
		roleId: "maintainer",
		name: "Maintainer",
		description:
			"Looks after reports where it is held. Edits them, approves suggested changes, decides who else can edit, and is who readers ask.",
		permission: "edit",
		capabilities: maintainerCapabilities,
	},
	{
		roleId: "editor",
		name: "Editor",
		description:
			"Builds reports and edits official ones. Where a report is set to Maintainers only, suggests changes instead.",
		permission: "edit",
		capabilities: editorCapabilities,
	},
	{
		roleId: "contributor",
		name: "Contributor",
		description: "Reads, and suggests changes for a Maintainer to approve.",
		permission: "view",
		capabilities: contributorCapabilities,
	},
	{
		roleId: "reader",
		name: "Reader",
		description:
			"Opens what they can read and builds pages of their own. Everyone has this without being assigned it.",
		permission: "view",
		capabilities: readerCapabilities,
	},
	{
		roleId: "publisher",
		name: "Report Publisher",
		description:
			"Makes reports official, so they reach everyone who can read their data. Added on top of any other role.",
		permission: "view",
		capabilities: ["report.makeOfficial"],
	},
];

// The level a role reaches reports at, worked out from what it can do. The people
// choosing a role's abilities should not also have to choose a level that could
// disagree with them.
export function permissionFor(held: Capability[]): Permission {
	if (held.includes("report.editAny") && held.includes("access.grant")) {
		return "admin";
	}
	return held.includes("report.edit") ? "edit" : "view";
}

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
	// Absent where the caller has no need of them, and read as no tags.
	tags?: string[] | null;
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
		const seesAny = grants.get(personalViewKey);
		if (seesAny) {
			return {
				allowed: true,
				permission: seesAny,
				viaAdministration: true,
			};
		}
		if (!direct) return denied;
		return { allowed: atLeast(direct, required), permission: direct };
	}

	const inherited = report.categoryId
		? grants.get(grantKey("category", report.categoryId))
		: undefined;

	const held = strongest([
		direct,
		inherited,
		baseline,
		...(report.tags ?? []).map((tag) =>
			grants.get(grantKey("tag", tagScope(tag))),
		),
	]);
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
//
// An exception wins over anything held, in the scope it names. Everywhere, if it
// names everywhere.
export function can(
	held: CapabilityMap,
	capability: Capability,
	scopeId?: string | null,
	denied?: CapabilityMap,
): boolean {
	const refused = denied?.get(capability);
	if (refused?.has(globalScope)) return false;
	if (scopeId && refused?.has(scopeId)) return false;

	const scopes = held.get(capability);
	if (!scopes || scopes.size === 0) return false;
	if (scopes.has(globalScope)) return true;
	if (!scopeId) return false;
	return scopes.has(scopeId);
}

// The same question about a report, which can be reached through itself, its
// category or any of its tags. An exception on any of those wins.
export function canOnReport(
	held: CapabilityMap,
	capability: Capability,
	report: {
		reportId: string;
		categoryId: string | null;
		tags?: string[] | null;
	},
	denied?: CapabilityMap,
): boolean {
	const scopes = [
		report.reportId,
		...(report.categoryId ? [report.categoryId] : []),
		...(report.tags ?? []).map(tagScope),
	];
	const refused = denied?.get(capability);
	if (refused?.has(globalScope)) return false;
	if (scopes.some((scope) => refused?.has(scope))) return false;

	const holding = held.get(capability);
	if (!holding || holding.size === 0) return false;
	if (holding.has(globalScope)) return true;
	return scopes.some((scope) => holding.has(scope));
}

// --- Who can edit a report ---------------------------------------------------

// "maintainers" means only its Maintainers edit it directly and other Editors
// suggest. "any" means any Editor can. Set on a report, then its category, then the
// platform, the nearest one winning.
export type EditPolicy = "maintainers" | "any";

export function isEditPolicy(value: unknown): value is EditPolicy {
	return value === "maintainers" || value === "any";
}

// "edit" changes the report. "suggest" makes a draft for a Maintainer to approve.
// Null is neither.
export type EditMode = "edit" | "suggest" | null;

export function editModeFor(input: {
	// The level held on the report, from any route.
	permission: Permission | null;
	canSuggest: boolean;
	isMaintainer: boolean;
	canEditAny: boolean;
	// An exception removing editing from this person.
	editDenied: boolean;
	hasMaintainers: boolean;
	policies: (EditPolicy | null | undefined)[];
}): EditMode {
	const canEdit =
		!input.editDenied &&
		input.permission !== null &&
		atLeast(input.permission, "edit");

	if (canEdit || (input.isMaintainer && !input.editDenied)) {
		if (input.canEditAny || input.isMaintainer) return "edit";
		// A report nobody maintains stays open, so nothing waits on nobody.
		if (!input.hasMaintainers) return "edit";
		const policy = input.policies.find((p) => isEditPolicy(p));
		return policy === "any" ? "edit" : "suggest";
	}
	return input.canSuggest ? "suggest" : null;
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
				: assignment.scopeType === "tag" && assignment.scopeId
					? tagScope(assignment.scopeId)
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

// Whether taking this holder away would leave nobody looking after the report. A
// report that loses its own Maintainers falls back to its category's, so removing
// the last one on the report is refused only when the category has none either.
export function leavesNoMaintainer(input: {
	removing: { assignmentId: string; isMaintainer: boolean };
	onReport: { assignmentId: string; isMaintainer: boolean }[];
	onCategory: { assignmentId: string; isMaintainer: boolean }[];
}): boolean {
	if (!input.removing.isMaintainer) return false;
	return ![...input.onReport, ...input.onCategory].some(
		(holder) =>
			holder.isMaintainer &&
			holder.assignmentId !== input.removing.assignmentId,
	);
}

// --- Explaining what somebody holds -------------------------------------------

export interface RightSource {
	kind: "role" | "rule" | "single" | "everyone";
	name: string;
	where: string;
	expiresOn: string | null;
}

export interface RightExplained {
	capability: Capability;
	sources: RightSource[];
	exceptions: {
		where: string;
		expiresOn: string | null;
		reason: string | null;
	}[];
}

// Every permission somebody holds or has had taken away, each with where it comes
// from. Anything past its end date counts as gone.
export function explainRights(input: {
	assignments: {
		roleName: string;
		capabilities: Capability[];
		scopeType: ScopeType;
		scopeId: string | null;
		expiresOn: string | null;
	}[];
	rules: {
		label: string;
		roleName: string;
		capabilities: Capability[];
		scopeType: ScopeType;
		scopeId: string | null;
	}[];
	grants: {
		capability: Capability;
		effect: "allow" | "deny";
		scopeType: ScopeType;
		scopeId: string | null;
		reason: string | null;
		expiresOn: string | null;
	}[];
	// What to call a category or report, since its id means nothing to a reader.
	nameOf?: (scopeId: string) => string | undefined;
	now?: number;
}): RightExplained[] {
	const now = input.now ?? Date.now();
	const whereWords = (scopeType: ScopeType, scopeId: string | null) =>
		scopeType === "global"
			? "Everywhere"
			: `In ${scopeType} ${(scopeId && input.nameOf?.(scopeId)) ?? scopeId}`;
	const live = (expiresOn: string | null) =>
		!expiresOn || new Date(expiresOn).getTime() > now;

	const rights = new Map<Capability, RightExplained>();
	const entry = (capability: Capability) => {
		let right = rights.get(capability);
		if (!right) {
			right = { capability, sources: [], exceptions: [] };
			rights.set(capability, right);
		}
		return right;
	};

	for (const capability of readerCapabilities) {
		entry(capability).sources.push({
			kind: "everyone",
			name: "Everyone",
			where: "Everywhere",
			expiresOn: null,
		});
	}
	for (const assignment of input.assignments) {
		if (!live(assignment.expiresOn)) continue;
		for (const capability of assignment.capabilities) {
			entry(capability).sources.push({
				kind: "role",
				name: assignment.roleName,
				where: whereWords(assignment.scopeType, assignment.scopeId),
				expiresOn: assignment.expiresOn,
			});
		}
	}
	for (const rule of input.rules) {
		for (const capability of rule.capabilities) {
			entry(capability).sources.push({
				kind: "rule",
				name: `${rule.roleName}, because ${rule.label}`,
				where: whereWords(rule.scopeType, rule.scopeId),
				expiresOn: null,
			});
		}
	}
	for (const grant of input.grants) {
		if (!live(grant.expiresOn)) continue;
		const right = entry(grant.capability);
		const where = whereWords(grant.scopeType, grant.scopeId);
		if (grant.effect === "deny") {
			right.exceptions.push({
				where,
				expiresOn: grant.expiresOn,
				reason: grant.reason,
			});
		} else {
			right.sources.push({
				kind: "single",
				name: "Given directly",
				where,
				expiresOn: grant.expiresOn,
			});
		}
	}

	const order = new Map(capabilities.map((c, i) => [c as Capability, i]));
	return [...rights.values()].sort(
		(a, b) =>
			(order.get(a.capability) ?? 0) - (order.get(b.capability) ?? 0),
	);
}
