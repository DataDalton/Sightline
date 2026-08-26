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
		new Map(),
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
