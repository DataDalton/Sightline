import assert from "node:assert/strict";
import { test } from "node:test";
import {
	describe,
	effective,
	isProtected,
	refuse,
	sourceOf,
	refuseAddPage,
	refuseReportDelete,
	unprotected,
	unprotectedReport,
	type PageProtection,
	type ReportProtection,
} from "./pageProtection";

// A lock that only the editor honours is not a lock, so this is the rule the
// server applies. The failures worth pinning are the ones that let a write
// through: a lock that stops the wrong operation is visible immediately, and a
// lock that stops nothing is not visible until somebody has already used it.

const deleteLocked: PageProtection = {
	protectDelete: true,
	protectEdit: false,
};
const editLocked: PageProtection = { protectDelete: false, protectEdit: true };
const bothLocked: PageProtection = { protectDelete: true, protectEdit: true };

// Every operation applyEdits accepts. Kept here in full so that adding one to
// the editor and forgetting it here shows up as a decision nobody made.
const everyOperation = [
	"addVisual",
	"updateVisual",
	"removeVisual",
	"reorderVisuals",
	"updatePage",
	"addPage",
	"removePage",
	"reorderPages",
	"updateReport",
];

test("an unlocked page refuses nothing", () => {
	for (const operation of everyOperation) {
		assert.equal(
			refuse(operation, unprotected),
			null,
			`${operation} was refused on an unlocked page`,
		);
	}
});

test("a delete lock stops removal and nothing else", () => {
	assert.ok(refuse("removePage", deleteLocked));
	for (const operation of everyOperation) {
		if (operation === "removePage") continue;
		assert.equal(
			refuse(operation, deleteLocked),
			null,
			`${operation} was refused by a delete lock`,
		);
	}
});

test("an edit lock stops everything that changes the page", () => {
	for (const operation of [
		"addVisual",
		"updateVisual",
		"removeVisual",
		"reorderVisuals",
		"updatePage",
	]) {
		assert.ok(
			refuse(operation, editLocked),
			`${operation} got through an edit lock`,
		);
	}
});

// The distinction the two switches exist for: a signed-off page that must
// survive a tidy-up while still being correctable.
test("an edit lock still allows the page to be deleted", () => {
	assert.equal(refuse("removePage", editLocked), null);
});

test("a delete lock still allows the page to be changed", () => {
	assert.equal(refuse("updateVisual", deleteLocked), null);
	assert.equal(refuse("addVisual", deleteLocked), null);
});

test("both locks stop both", () => {
	assert.ok(refuse("removePage", bothLocked));
	assert.ok(refuse("updateVisual", bothLocked));
});

// Report-level operations are not a page's to refuse. Renaming the report or
// reordering its pages is not a change to what is on this one.
test("a lock does not reach past its own page", () => {
	for (const operation of ["updateReport", "reorderPages", "addPage"]) {
		assert.equal(refuse(operation, bothLocked), null, operation);
	}
});

test("a refusal says which operation and why", () => {
	const said = refuse("removePage", deleteLocked);
	assert.equal(said?.operation, "removePage");
	assert.match(said?.reason ?? "", /protected against deletion/);
	assert.match(said?.reason ?? "", /administrator/);
});

test("nothing set is not protected", () => {
	assert.equal(isProtected(unprotected), false);
	assert.equal(isProtected(deleteLocked), true);
	assert.equal(isProtected(editLocked), true);
});

test("what is locked is described one line per lock", () => {
	assert.deepEqual(describe(unprotected), []);
	assert.equal(describe(deleteLocked).length, 1);
	assert.equal(describe(bothLocked).length, 2);
});

// --- a report's locks and a page's own -------------------------------------
//
// The two combine. Locking a whole report must not lift a lock a page already
// carried, and unlocking the report must not lift it either: each was a
// decision somebody made, and neither is the other's to undo.

test("a report lock reaches every page in it", () => {
	assert.deepEqual(effective(deleteLocked, unprotected), deleteLocked);
	assert.deepEqual(effective(editLocked, unprotected), editLocked);
});

test("a page keeps its own lock when the report has none", () => {
	assert.deepEqual(effective(unprotected, editLocked), editLocked);
});

test("locking the report does not lift a lock the page already had", () => {
	// The report is locked against deletion only; the page against changes.
	// The page has to end up refusing both.
	assert.deepEqual(effective(deleteLocked, editLocked), bothLocked);
});

test("unlocking the report leaves the page's own lock standing", () => {
	assert.deepEqual(effective(unprotected, bothLocked), bothLocked);
});

test("neither locked is unlocked", () => {
	assert.equal(isProtected(effective(unprotected, unprotected)), false);
});

test("a report lock is reported as coming from the report", () => {
	const from = sourceOf(deleteLocked, unprotected);
	assert.equal(from.delete, "report");
	assert.equal(from.edit, null);
});

test("the report wins the attribution when both are locked", () => {
	// Which matters for the message: a page locked by its report cannot be
	// unlocked from the page, so saying "page" would send somebody to a
	// control that will not help them.
	const from = sourceOf(bothLocked, bothLocked);
	assert.equal(from.delete, "report");
	assert.equal(from.edit, "report");
});

test("a page's own lock is attributed to the page", () => {
	const from = sourceOf(unprotected, editLocked);
	assert.equal(from.edit, "page");
	assert.equal(from.delete, null);
});

// --- adding a page ---------------------------------------------------------
//
// Its own lock, and its own check, because the operation names a page that does
// not exist yet: there is nothing there whose locks could be consulted.

const addLocked: ReportProtection = {
	protectDelete: false,
	protectEdit: false,
	protectAddPage: true,
};

test("an unlocked report takes new pages", () => {
	assert.equal(refuseAddPage("addPage", unprotectedReport), null);
});

test("a report locked against new pages refuses one", () => {
	const said = refuseAddPage("addPage", addLocked);
	assert.equal(said?.operation, "addPage");
	assert.match(said?.reason ?? "", /against new pages/);
});

test("the add lock stops nothing else", () => {
	for (const operation of everyOperation) {
		if (operation === "addPage") continue;
		assert.equal(
			refuseAddPage(operation, addLocked),
			null,
			`${operation} was refused by the add lock`,
		);
	}
});

// The three are independent: locking a report against new pages must not stop
// the pages it already has from being corrected or retired.
test("the add lock does not lock the pages already there", () => {
	assert.equal(refuse("updateVisual", addLocked), null);
	assert.equal(refuse("removePage", addLocked), null);
});

test("the other two locks do not stop a page being added", () => {
	assert.equal(
		refuseAddPage("addPage", {
			...bothLocked,
			protectAddPage: false,
		}),
		null,
	);
});

test("what a report refuses includes the add lock", () => {
	assert.equal(describe(addLocked).length, 1);
	assert.equal(describe({ ...bothLocked, protectAddPage: true }).length, 3);
});

// Deleting the report itself.
//
// The page lock and the report lock are enforced on different writes, so until
// removeReport consulted this a report locked against deletion was deleted by
// anybody holding the capability, while every locked page inside it survived.

test("a report locked against deletion refuses to be deleted", () => {
	const said = refuseReportDelete("removeReport", deleteLocked);
	assert.notEqual(said, null);
	assert.match(said!.reason, /protected against deletion/);
});

test("an unlocked report is deleted", () => {
	assert.equal(refuseReportDelete("removeReport", unprotected), null);
});

test("the edit lock alone does not stop a report being deleted", () => {
	assert.equal(refuseReportDelete("removeReport", editLocked), null);
});

test("the delete lock stops deletion and nothing else", () => {
	for (const operation of everyOperation) {
		if (operation === "removeReport") continue;
		assert.equal(
			refuseReportDelete(operation, bothLocked),
			null,
			`${operation} is not a report deletion and must not be refused as one`,
		);
	}
});
