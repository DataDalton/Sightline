// What a locked page refuses.
//
// An administrator can lock a page against deletion, against change, or both.
// The two are separate because they answer different worries: a page that has
// been signed off needs to survive somebody tidying up the report, while still
// being correctable when a figure is wrong; a page quoted in a board pack needs
// the opposite, to stop moving while remaining removable when it is retired.
//
// The rule lives here rather than in the editor because a lock that only the
// editor honours is not a lock. Every write goes through applyEdits, so that is
// where it is enforced, and this is the part of it worth testing on its own.

export interface PageProtection {
	protectDelete: boolean;
	protectEdit: boolean;
}

// What a report refuses, which is its pages' two locks plus one of its own.
//
// Adding a page is not a page's business: the page being created does not exist
// yet, so there is nothing on it to carry a lock. It belongs to the report.
export interface ReportProtection extends PageProtection {
	protectAddPage: boolean;
}

export const unprotectedReport: ReportProtection = {
	protectDelete: false,
	protectEdit: false,
	protectAddPage: false,
};

export const unprotected: PageProtection = {
	protectDelete: false,
	protectEdit: false,
};

// Operations that change what is on a page, as opposed to which pages exist.
//
// Named rather than derived, so an operation added later is unprotected until
// somebody decides it should not be, rather than silently blocked by a rule
// that guessed. The test below fails if the two lists drift.
const changesPage = new Set([
	"addVisual",
	"updateVisual",
	"removeVisual",
	"reorderVisuals",
	"updatePage",
]);

const deletesPage = new Set(["removePage"]);

const addsPage = new Set(["addPage"]);

export interface Refusal {
	operation: string;
	reason: string;
}

// Why an operation cannot be applied to this page, or nothing.
export function refuse(
	operation: string,
	protection: PageProtection,
): Refusal | null {
	if (protection.protectDelete && deletesPage.has(operation)) {
		return {
			operation,
			reason: "This page is protected against deletion. An administrator can lift that.",
		};
	}
	if (protection.protectEdit && changesPage.has(operation)) {
		return {
			operation,
			reason: "This page is protected against changes. An administrator can lift that.",
		};
	}
	return null;
}

// What a page actually refuses, once the report it sits in has had its say.
//
// Combined rather than one overriding the other. A lock is a decision somebody
// made, so locking a whole report must not quietly lift a lock a page already
// carried, and unlocking the report must not lift it either.
export function effective(
	report: PageProtection,
	page: PageProtection,
): PageProtection {
	return {
		protectDelete: report.protectDelete || page.protectDelete,
		protectEdit: report.protectEdit || page.protectEdit,
	};
}

// Where a lock came from, for the places that have to explain why something is
// refused. A page locked by its report cannot be unlocked from the page.
export function sourceOf(
	report: PageProtection,
	page: PageProtection,
): { delete: "report" | "page" | null; edit: "report" | "page" | null } {
	return {
		delete: report.protectDelete
			? "report"
			: page.protectDelete
				? "page"
				: null,
		edit: report.protectEdit ? "report" : page.protectEdit ? "page" : null,
	};
}

// Why a page cannot be added to this report, or nothing.
//
// Checked against the report rather than a page, and separately from refuse()
// for the same reason: the operation names a page that does not exist yet, so
// there is no page whose locks could be consulted.
export function refuseAddPage(
	operation: string,
	protection: ReportProtection,
): Refusal | null {
	if (protection.protectAddPage && addsPage.has(operation)) {
		return {
			operation,
			reason: "This report is protected against new pages. An administrator can lift that.",
		};
	}
	return null;
}

// Whether anything is locked, for the places that only need to know that much:
// a badge on the tab, or whether to offer the controls at all.
export function isProtected(protection: PageProtection): boolean {
	return protection.protectDelete || protection.protectEdit;
}

// The operations each lock stops, for the dialog that explains itself.
export function describe(
	protection: PageProtection | ReportProtection,
): string[] {
	const said: string[] = [];
	if (protection.protectDelete) {
		said.push("This page cannot be deleted.");
	}
	if (protection.protectEdit) {
		said.push("Visuals, layout and page settings on it cannot be changed.");
	}
	if ("protectAddPage" in protection && protection.protectAddPage) {
		said.push("No page can be added to this report.");
	}
	return said;
}
