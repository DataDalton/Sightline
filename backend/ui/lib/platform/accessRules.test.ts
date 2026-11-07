import assert from "node:assert/strict";
import { test } from "node:test";
import {
	can,
	globalScope,
	grantKey,
	resolveAssignments,
	resolveCategoryAccess,
	resolvePageAccess,
	resolveReportAccess,
	strongest,
	type Permission,
	type ReportRef,
	canOnReport,
	editModeFor,
	permissionFor,
	tagScope,
	builtinRoles,
	type CapabilityMap,
	explainRights,
	leavesNoMaintainer,
	pagesLimitedTo,
	personalViewKey,
} from "./accessRules";

// The property these tests exist to protect: a page somebody built for
// themselves is reachable by them and by people they named, and by nobody
// else. Every other way into a report is an implicit grant, and each one of
// them is a way for a personal page to leak.

const grants = (entries: [string, string, Permission][]) =>
	new Map(entries.map(([type, id, p]) => [grantKey(type, id), p]));

const curated = (over: Partial<ReportRef> = {}): ReportRef => ({
	reportId: "r1",
	categoryId: "sales",
	isPersonal: false,
	ownerEmail: "author@example.com",
	...over,
});

const personal = (over: Partial<ReportRef> = {}): ReportRef => ({
	reportId: "p1",
	categoryId: null,
	isPersonal: true,
	ownerEmail: "reader@example.com",
	...over,
});

// --- Curated content behaves exactly as it did ------------------------------

test("a grant on the report opens it", () => {
	const access = resolveReportAccess(
		grants([["report", "r1", "view"]]),
		curated(),
		"someone@example.com",
	);
	assert.equal(access.allowed, true);
	assert.equal(access.permission, "view");
});

test("a report inherits its category grant", () => {
	const access = resolveReportAccess(
		grants([["category", "sales", "edit"]]),
		curated(),
		"someone@example.com",
	);
	assert.equal(access.allowed, true);
	assert.equal(access.permission, "edit");
});

test("a global role stands in when nothing names the report", () => {
	const access = resolveReportAccess(
		new Map(),
		curated(),
		"someone@example.com",
		"edit",
		"edit",
	);
	assert.equal(access.allowed, true);
});

test("the strongest of several grants is the one held", () => {
	const access = resolveReportAccess(
		grants([
			["report", "r1", "view"],
			["category", "sales", "admin"],
		]),
		curated(),
		"someone@example.com",
		"admin",
	);
	assert.equal(access.permission, "admin");
});

test("nothing at all is refused", () => {
	const access = resolveReportAccess(
		new Map(),
		curated(),
		"someone@example.com",
	);
	assert.equal(access.allowed, false);
	assert.equal(access.permission, null);
});

// --- A personal page ignores every implicit grant ---------------------------

test("its owner holds a personal page outright", () => {
	const access = resolveReportAccess(
		new Map(),
		personal(),
		"reader@example.com",
	);
	assert.equal(access.allowed, true);
	assert.equal(access.permission, "admin");
});

test("the owner is matched without regard to case or padding", () => {
	const access = resolveReportAccess(
		new Map(),
		personal({ ownerEmail: "  Reader@Example.com " }),
		"reader@example.com",
	);
	assert.equal(access.allowed, true);
});

test("a global editor role does not reach a personal page", () => {
	// The failure this prevents: every editor seeing every reader's private
	// work the moment personal pages moved into the reports table. An
	// administrator does reach one; an editor is not an administrator, and the
	// two baselines have to stay told apart here.
	const access = resolveReportAccess(
		new Map(),
		personal(),
		"editor@example.com",
		"view",
		"edit",
	);
	assert.equal(access.allowed, false);
	assert.equal(access.permission, null);
});

test("a global administrator reaches a personal page, and it is marked", () => {
	// Administering the platform means being able to answer for what it holds.
	// The flag is what makes it recordable: reaching somebody's page as an
	// administrator is a different act from opening your own.
	const access = resolveReportAccess(
		new Map<string, Permission>([[personalViewKey, "admin"]]),
		personal(),
		"admin@example.com",
		"edit",
		"admin",
	);
	assert.equal(access.allowed, true);
	assert.equal(access.permission, "admin");
	assert.equal(access.viaAdministration, true);
});

test("an owner opening their own page is not administering it", () => {
	const access = resolveReportAccess(
		new Map(),
		personal(),
		"reader@example.com",
		"view",
		"admin",
	);
	assert.equal(access.allowed, true);
	assert.equal(access.viaAdministration, undefined);
});

test("somebody the page was shared with is not administering it either", () => {
	const access = resolveReportAccess(
		grants([["report", "p1", "view"]]),
		personal(),
		"colleague@example.com",
	);
	assert.equal(access.allowed, true);
	assert.equal(access.viaAdministration, undefined);
});

test("an administrator scoped to a category does not reach a personal page", () => {
	// A scoped assignment becomes a grant on the category it names, never a
	// baseline. A personal page is in no category, so there is nothing for that
	// grant to reach through.
	const scoped = resolveAssignments([
		{
			permission: "admin",
			capabilities: [],
			scopeType: "category",
			scopeId: "sales",
		},
	]);
	const access = resolveReportAccess(
		scoped.grants,
		personal(),
		"admin@example.com",
		"view",
		scoped.baseline,
	);
	assert.equal(access.allowed, false);
});

test("a category grant does not reach a personal page", () => {
	// A personal page carries no category, but a stale or hand-written row
	// could still put one there. Inheritance is refused on the flag, not on the
	// absence of the category.
	const access = resolveReportAccess(
		grants([["category", "sales", "admin"]]),
		personal({ categoryId: "sales" }),
		"someone@example.com",
	);
	assert.equal(access.allowed, false);
});

test("a grant naming the page is the one way in", () => {
	const access = resolveReportAccess(
		grants([["report", "p1", "view"]]),
		personal(),
		"colleague@example.com",
	);
	assert.equal(access.allowed, true);
	assert.equal(access.permission, "view");
});

test("being shared a page does not confer editing it", () => {
	const access = resolveReportAccess(
		grants([["report", "p1", "view"]]),
		personal(),
		"colleague@example.com",
		"edit",
	);
	assert.equal(access.allowed, false);
	assert.equal(access.permission, "view");
});

// --- Categories and pages ---------------------------------------------------

test("a category needs a grant or a global role", () => {
	assert.equal(resolveCategoryAccess(new Map(), "sales").allowed, false);
	assert.equal(
		resolveCategoryAccess(new Map(), "sales", "view", "edit").allowed,
		true,
	);
	assert.equal(
		resolveCategoryAccess(grants([["category", "sales", "view"]]), "sales")
			.allowed,
		true,
	);
});

test("a page grant overrides the report it sits on", () => {
	const report = { allowed: true, permission: "edit" as Permission };
	const access = resolvePageAccess(
		grants([["page", "pg1", "view"]]),
		"pg1",
		report,
		"edit",
	);
	assert.equal(access.allowed, false);
	assert.equal(access.permission, "view");
});

test("a page with no grant of its own inherits the report", () => {
	const report = { allowed: true, permission: "edit" as Permission };
	assert.deepEqual(
		resolvePageAccess(new Map(), "pg1", report, "edit"),
		report,
	);
});

// --- Assignments fold into grants, a baseline and capabilities --------------

test("a global assignment becomes the baseline, not a grant", () => {
	const resolved = resolveAssignments([
		{
			permission: "edit",
			capabilities: ["report.create"],
			scopeType: "global",
			scopeId: null,
		},
	]);
	assert.equal(resolved.baseline, "edit");
	assert.equal(resolved.grants.size, 0);
	assert.equal(can(resolved.capabilities, "report.create"), true);
	assert.equal(can(resolved.capabilities, "settings.manage"), false);
});

test("a scoped assignment becomes a grant on what it names", () => {
	const resolved = resolveAssignments([
		{
			permission: "edit",
			capabilities: ["report.create"],
			scopeType: "category",
			scopeId: "sales",
		},
	]);
	assert.equal(resolved.baseline, null);
	assert.equal(resolved.grants.get(grantKey("category", "sales")), "edit");

	// The point of a scope: it reaches inside and nowhere else.
	assert.equal(can(resolved.capabilities, "report.create", "sales"), true);
	assert.equal(can(resolved.capabilities, "report.create", "ops"), false);
	assert.equal(can(resolved.capabilities, "report.create"), false);
});

test("a capability held globally satisfies any scope", () => {
	const resolved = resolveAssignments([
		{
			permission: "admin",
			capabilities: ["category.create"],
			scopeType: "global",
			scopeId: null,
		},
	]);
	assert.equal(
		can(resolved.capabilities, "category.create", "anything"),
		true,
	);
	assert.equal(
		resolved.capabilities.get("category.create")?.has(globalScope),
		true,
	);
});

test("two assignments on one scope keep the stronger permission", () => {
	const resolved = resolveAssignments([
		{
			permission: "view",
			capabilities: [],
			scopeType: "category",
			scopeId: "sales",
		},
		{
			permission: "admin",
			capabilities: [],
			scopeType: "category",
			scopeId: "sales",
		},
	]);
	assert.equal(resolved.grants.get(grantKey("category", "sales")), "admin");
});

test("a scoped assignment naming no scope is dropped, not treated as global", () => {
	// Widening a grant on malformed input is the one direction this must never
	// fail in.
	const resolved = resolveAssignments([
		{
			permission: "admin",
			capabilities: ["settings.manage"],
			scopeType: "category",
			scopeId: null,
		},
	]);
	assert.equal(resolved.baseline, null);
	assert.equal(resolved.grants.size, 0);
	assert.equal(can(resolved.capabilities, "settings.manage"), false);
});

test("no assignments confer nothing", () => {
	const resolved = resolveAssignments([]);
	assert.equal(resolved.baseline, null);
	assert.equal(resolved.grants.size, 0);
	assert.equal(resolved.capabilities.size, 0);
});

test("strongest ignores what is absent", () => {
	assert.equal(
		strongest([null, "view", undefined, "admin", "edit"]),
		"admin",
	);
	assert.equal(strongest([null, undefined]), null);
	assert.equal(strongest([]), null);
});

// --- Publishing flips which rules apply -------------------------------------

test("publishing a page makes it reachable the way any report is", () => {
	// The same report, before and after. Publishing sets is_personal false and
	// gives it a category; nothing else about it changes. What changes is that
	// every implicit grant starts applying to it, which is the whole point.
	const before = personal({ reportId: "p1" });
	const after: ReportRef = {
		reportId: "p1",
		categoryId: "sales",
		isPersonal: false,
		ownerEmail: "reader@example.com",
	};

	const editor = "editor@example.com";
	assert.equal(
		resolveReportAccess(new Map(), before, editor, "view", "edit").allowed,
		false,
	);
	assert.equal(
		resolveReportAccess(new Map(), after, editor, "view", "edit").allowed,
		true,
	);
});

test("the people a page was shared with keep it after publication", () => {
	// The share is a grant naming the report, and a named grant is honoured on
	// a curated report too. Somebody who could see it before publication does
	// not lose it at the moment it becomes more widely readable.
	const shared = grants([["report", "p1", "view"]]);
	const after: ReportRef = {
		reportId: "p1",
		categoryId: "sales",
		isPersonal: false,
		ownerEmail: "reader@example.com",
	};
	assert.equal(
		resolveReportAccess(shared, after, "colleague@example.com").allowed,
		true,
	);
});

test("its author keeps no special hold on it once it is published", () => {
	// The ownership rule is what gave them one, and it no longer applies. They
	// keep whatever their role gives them, like anybody else.
	const after: ReportRef = {
		reportId: "p1",
		categoryId: "sales",
		isPersonal: false,
		ownerEmail: "reader@example.com",
	};
	assert.equal(
		resolveReportAccess(new Map(), after, "reader@example.com").allowed,
		false,
	);
});

// --- Who can edit, and exceptions --------------------------------------------

const editor = {
	permission: "edit" as const,
	canSuggest: true,
	isMaintainer: false,
	canEditAny: false,
	editDenied: false,
	hasMaintainers: true,
	policies: [],
};

test("an Editor suggests on a report that has Maintainers", () => {
	assert.equal(editModeFor(editor), "suggest");
});

test("an Editor edits a report nobody maintains, so nothing is stuck", () => {
	assert.equal(editModeFor({ ...editor, hasMaintainers: false }), "edit");
});

test("the nearest setting decides, and Any Editor opens it up", () => {
	assert.equal(editModeFor({ ...editor, policies: ["any"] }), "edit");
	assert.equal(
		editModeFor({ ...editor, policies: ["maintainers", "any"] }),
		"suggest",
	);
	assert.equal(
		editModeFor({ ...editor, policies: [null, "any", "maintainers"] }),
		"edit",
	);
});

test("a Maintainer always edits", () => {
	assert.equal(editModeFor({ ...editor, isMaintainer: true }), "edit");
});

test("edit any report goes past Maintainers only", () => {
	assert.equal(editModeFor({ ...editor, canEditAny: true }), "edit");
});

test("a Contributor suggests, and a Reader cannot do either", () => {
	const contributor = { ...editor, permission: "view" as const };
	assert.equal(editModeFor(contributor), "suggest");
	assert.equal(editModeFor({ ...contributor, canSuggest: false }), null);
});

test("an exception on editing stops even a Maintainer", () => {
	assert.equal(
		editModeFor({
			...editor,
			isMaintainer: true,
			editDenied: true,
			canSuggest: false,
		}),
		null,
	);
});

test("an exception wins over a right held everywhere", () => {
	const held: CapabilityMap = new Map([["export.run", new Set(["*"])]]);
	assert.equal(can(held, "export.run"), true);
	const everywhere: CapabilityMap = new Map([["export.run", new Set(["*"])]]);
	assert.equal(can(held, "export.run", null, everywhere), false);
	const one: CapabilityMap = new Map([["export.run", new Set(["sales"])]]);
	assert.equal(can(held, "export.run", "sales", one), false);
	assert.equal(can(held, "export.run", "finance", one), true);
});

test("a report is reached through itself, its category or a tag", () => {
	const report = { reportId: "r", categoryId: "c", tags: ["Finance"] };
	const through = (scope: string): CapabilityMap =>
		new Map([["report.review", new Set([scope])]]);
	assert.equal(canOnReport(through("r"), "report.review", report), true);
	assert.equal(canOnReport(through("c"), "report.review", report), true);
	assert.equal(
		canOnReport(through(tagScope("finance")), "report.review", report),
		true,
	);
	assert.equal(canOnReport(through("x"), "report.review", report), false);
	assert.equal(
		canOnReport(through("c"), "report.review", report, through("r")),
		false,
	);
});

test("a tag grant reaches a report carrying it", () => {
	const { grants } = resolveAssignments([
		{
			permission: "edit",
			capabilities: [],
			scopeType: "tag",
			scopeId: "Finance",
		},
	]);
	const check = resolveReportAccess(
		grants,
		{
			reportId: "r",
			categoryId: null,
			isPersonal: false,
			ownerEmail: null,
			tags: ["finance"],
		},
		"a@example.com",
		"edit",
	);
	assert.equal(check.allowed, true);
});

test("a role's level follows what it can do", () => {
	assert.equal(permissionFor(["report.suggest"]), "view");
	assert.equal(permissionFor(["report.edit"]), "edit");
	assert.equal(permissionFor(["report.editAny", "access.grant"]), "admin");
});

test("only Administrator and Report Publisher can make a report official", () => {
	const holders = builtinRoles
		.filter((role) => role.capabilities.includes("report.makeOfficial"))
		.map((role) => role.roleId)
		.sort();
	assert.deepEqual(holders, ["admin", "publisher"]);
});

test("each built-in role holds everything the one before it does", () => {
	const of = (id: string) =>
		builtinRoles.find((role) => role.roleId === id)?.capabilities ?? [];
	const chain = ["reader", "contributor", "editor", "maintainer", "admin"];
	for (let i = 1; i < chain.length; i++) {
		for (const capability of of(chain[i - 1])) {
			assert.ok(
				of(chain[i]).includes(capability),
				`${chain[i]} lacks ${capability}`,
			);
		}
	}
});

test("explains where a right comes from, and leaves out what has ended", () => {
	const rights = explainRights({
		assignments: [
			{
				roleName: "Maintainer",
				capabilities: ["report.review"],
				scopeType: "category",
				scopeId: "sales",
				expiresOn: "2026-01-01",
			},
			{
				roleName: "Report Publisher",
				capabilities: ["report.makeOfficial"],
				scopeType: "global",
				scopeId: null,
				expiresOn: null,
			},
		],
		rules: [],
		grants: [
			{
				capability: "export.run",
				effect: "deny",
				scopeType: "global",
				scopeId: null,
				reason: "Contractor",
				expiresOn: null,
			},
		],
		now: new Date("2026-06-01").getTime(),
	});
	const find = (capability: string) =>
		rights.find((right) => right.capability === capability);
	assert.equal(find("report.review"), undefined);
	assert.equal(
		find("report.makeOfficial")?.sources[0].name,
		"Report Publisher",
	);
	assert.equal(find("export.run")?.sources[0].kind, "everyone");
	assert.equal(find("export.run")?.exceptions[0].reason, "Contractor");
});

test("the last Maintainer stays unless the category can take over", () => {
	const one = { assignmentId: "a", isMaintainer: true };
	const other = { assignmentId: "b", isMaintainer: true };
	const editorOnly = { assignmentId: "c", isMaintainer: false };
	assert.equal(
		leavesNoMaintainer({
			removing: one,
			onReport: [one, editorOnly],
			onCategory: [],
		}),
		true,
	);
	assert.equal(
		leavesNoMaintainer({
			removing: one,
			onReport: [one, other],
			onCategory: [],
		}),
		false,
	);
	assert.equal(
		leavesNoMaintainer({
			removing: one,
			onReport: [one],
			onCategory: [other],
		}),
		false,
	);
	assert.equal(
		leavesNoMaintainer({
			removing: editorOnly,
			onReport: [one, editorOnly],
			onCategory: [],
		}),
		false,
	);
});

test("a page right opens only that page, unless something wider opens the report", () => {
	const report = {
		reportId: "r1",
		categoryId: "sales",
		isPersonal: false,
		ownerEmail: null,
	};
	const pages = new Map([["r1", new Set(["p1"])]]);
	const added = new Set(["r1"]);
	const reached = new Map<string, Permission>([
		[grantKey("report", "r1"), "view"],
	]);
	assert.deepEqual(
		[...(pagesLimitedTo(reached, report, "a@x", null, pages, added) ?? [])],
		["p1"],
	);
	assert.equal(
		pagesLimitedTo(reached, report, "a@x", "view", pages, added),
		null,
	);
	reached.set(grantKey("category", "sales"), "view");
	assert.equal(
		pagesLimitedTo(reached, report, "a@x", null, pages, added),
		null,
	);
	assert.equal(
		pagesLimitedTo(reached, report, "a@x", null, undefined, undefined),
		null,
	);
});

test("looking at a personal page through the right to see them changes nothing", () => {
	const page = {
		reportId: "r9",
		categoryId: null,
		isPersonal: true,
		ownerEmail: "owner@x",
	};
	const held = resolveReportAccess(
		new Map<string, Permission>([[personalViewKey, "view"]]),
		page,
		"support@x",
	);
	assert.equal(held.allowed, true);
	assert.equal(held.permission, "view");
	assert.equal(held.viaAdministration, true);
	assert.equal(
		resolveReportAccess(new Map(), page, "support@x").allowed,
		false,
	);
});
