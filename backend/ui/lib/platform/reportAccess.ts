import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { insertLog } from "../activityLog";
import { settings } from "../settings";
import {
	can,
	canOnReport,
	editingFacts,
	getExplicitContext,
	invalidateAccessCache,
	isEditPolicy,
	type AccessContext,
	type EditPolicy,
	type SubjectType,
} from "./access";
import { catalogueChanged, invalidateReport, reportSubject } from "./curated";
import { leavesNoMaintainer } from "./accessRules";
import { maintainersOf } from "./permissionStore";
import {
	assignRole,
	listAssignments,
	listRoles,
	revokeAssignment,
} from "./roles";

// Who looks after a report, who can edit it, and the tags it carries.
//
// A Maintainer decides this for what they look after without administering the
// platform. They can only hand out what they hold themselves, so nobody raises
// anyone's rights above their own. See lib/platform/accessRules.

export class ReportAccessError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

async function subjectOf(reportId: string) {
	const subject = await reportSubject(reportId);
	if (!subject) throw new ReportAccessError("Not found", 404);
	if (subject.is_personal) {
		throw new ReportAccessError(
			"A personal page belongs to its owner, who shares it directly.",
		);
	}
	return subject;
}

function delegates(
	context: AccessContext,
	reportId: string,
	categoryId: string | null,
	tags: string[] | null | undefined,
): boolean {
	return canOnReport(
		context.capabilities,
		"access.delegate",
		{ reportId, categoryId, tags },
		context.denied,
	);
}

export async function describeReportAccess(
	policy: PolicyClass,
	identity: Identity,
	reportId: string,
) {
	const subject = await reportSubject(reportId);
	if (!subject) throw new ReportAccessError("Not found", 404);
	const [context, facts, assignments, roles, pages] = await Promise.all([
		getExplicitContext(policy, identity.email),
		editingFacts(),
		listAssignments(),
		listRoles(),
		sql<{ page_id: string; title: string }>(
			`SELECT page_id::text AS page_id, title FROM report_pages
			 WHERE report_id = $1 AND is_active = TRUE ORDER BY sort_order`,
			[reportId],
		),
	]);

	const ref = {
		reportId,
		categoryId: subject.category_id,
		tags: subject.tags,
	};
	const on = (capability: Parameters<typeof canOnReport>[1]) =>
		canOnReport(context.capabilities, capability, ref, context.denied);
	const canDelegate = delegates(
		context,
		reportId,
		subject.category_id,
		subject.tags,
	);

	const held = new Set(
		[...context.capabilities.keys()].filter((capability) => on(capability)),
	);
	const reviewing = new Set(
		roles
			.filter((role) => role.capabilities.includes("report.review"))
			.map((role) => role.roleId),
	);
	const now = Date.now();
	const running = assignments.filter(
		(a) => !a.expiresOn || new Date(a.expiresOn).getTime() > now,
	);
	const here = running.filter(
		(a) => a.scopeType === "report" && a.scopeId === reportId,
	);
	const pageTitle = new Map(pages.map((page) => [page.page_id, page.title]));
	const onPages = running.filter(
		(a) => a.scopeType === "page" && pageTitle.has(a.scopeId ?? ""),
	);
	const inCategory = running.filter(
		(a) =>
			a.scopeType === "category" &&
			subject.category_id !== null &&
			a.scopeId === subject.category_id,
	);
	const toHolder = (a: (typeof assignments)[number]) => ({
		assignmentId: a.assignmentId,
		roleId: a.roleId,
		roleName: a.roleName,
		subjectType: a.subjectType,
		subjectId: a.subjectId,
		expiresOn: a.expiresOn,
		isMaintainer: reviewing.has(a.roleId),
	});

	const reportPolicy = isEditPolicy(subject.edit_policy)
		? subject.edit_policy
		: null;
	const categoryPolicy = subject.category_id
		? (facts.categoryPolicy.get(subject.category_id) ?? null)
		: null;
	const platformPolicy: EditPolicy = isEditPolicy(
		settings().defaultEditPolicy,
	)
		? (settings().defaultEditPolicy as EditPolicy)
		: "maintainers";

	const hasMaintainers = maintainersOf(facts, ref).length > 0;
	return {
		isPersonal: subject.is_personal,
		categoryId: subject.category_id,
		tags: subject.tags ?? [],
		reportPolicy,
		categoryPolicy,
		platformPolicy,
		// What actually applies, in words a person can act on.
		effective: !hasMaintainers
			? "Nobody looks after this report yet, so any Editor can change it."
			: (reportPolicy ?? categoryPolicy ?? platformPolicy) === "any"
				? "Any Editor can change this report."
				: "Only Maintainers change this report. Other Editors suggest.",
		holders: here.map(toHolder),
		categoryHolders: inCategory.map(toHolder),
		pages: pages.map((page) => ({
			pageId: page.page_id,
			title: page.title,
		})),
		pageHolders: onPages.map((a) => ({
			...toHolder(a),
			pageTitle: pageTitle.get(a.scopeId ?? "") ?? "",
		})),
		canDelegate,
		canSetCategoryPolicy:
			subject.category_id !== null &&
			can(
				context.capabilities,
				"access.delegate",
				subject.category_id,
				context.denied,
			),
		canTakeBack:
			!subject.is_personal &&
			can(
				context.capabilities,
				"report.makeOfficial",
				subject.category_id,
				context.denied,
			),
		// Only roles this person could hand out, which never includes more than
		// they hold here.
		assignableRoles: canDelegate
			? roles
					.filter(
						(role) =>
							!role.categoryId &&
							role.capabilities.length > 0 &&
							role.capabilities.every((c) => held.has(c)),
					)
					.map((role) => ({
						roleId: role.roleId,
						name: role.name,
						description: role.description,
					}))
			: [],
	};
}

export async function setEditPolicy(
	policy: PolicyClass,
	identity: Identity,
	reportId: string,
	input: { level: "report" | "category"; value: unknown },
): Promise<void> {
	const subject = await subjectOf(reportId);
	const context = await getExplicitContext(policy, identity.email);
	const value = isEditPolicy(input.value) ? input.value : null;

	if (input.level === "category") {
		if (
			!subject.category_id ||
			!can(
				context.capabilities,
				"access.delegate",
				subject.category_id,
				context.denied,
			)
		) {
			throw new ReportAccessError(
				"Only the category's Maintainers can change this.",
				403,
			);
		}
		await sql(
			`UPDATE categories SET edit_policy = $2 WHERE category_id = $1`,
			[subject.category_id, value],
		);
	} else {
		if (!delegates(context, reportId, subject.category_id, subject.tags)) {
			throw new ReportAccessError(
				"Only this report's Maintainers can change this.",
				403,
			);
		}
		await sql(`UPDATE reports SET edit_policy = $2 WHERE report_id = $1`, [
			reportId,
			value,
		]);
	}

	await insertLog({
		recordType: input.level,
		recordId:
			input.level === "report" ? reportId : (subject.category_id ?? ""),
		action: "set_edit_policy",
		changedBy: identity.email,
		newValue: value ?? "inherit",
	});
	invalidateReport(reportId, []);
	invalidateAccessCache();
}

export async function setReportTags(
	policy: PolicyClass,
	identity: Identity,
	reportId: string,
	tags: unknown,
): Promise<void> {
	const subject = await subjectOf(reportId);
	const context = await getExplicitContext(policy, identity.email);
	if (!delegates(context, reportId, subject.category_id, subject.tags)) {
		throw new ReportAccessError(
			"Only this report's Maintainers can change its tags.",
			403,
		);
	}
	const cleaned = Array.isArray(tags)
		? [
				...new Set(
					tags
						.filter((tag): tag is string => typeof tag === "string")
						.map((tag) => tag.trim().toLowerCase().slice(0, 60))
						.filter(Boolean),
				),
			]
		: [];
	await sql(`UPDATE reports SET tags = $2 WHERE report_id = $1`, [
		reportId,
		cleaned,
	]);
	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "set_tags",
		changedBy: identity.email,
		newValue: JSON.stringify(cleaned),
	});
	invalidateReport(reportId, []);
	invalidateAccessCache();
}

export async function addReportHolder(
	policy: PolicyClass,
	identity: Identity,
	reportId: string,
	input: {
		level: "report" | "category" | "page";
		pageId?: string | null;
		roleId: string;
		subjectType: SubjectType;
		subjectId: string;
		expiresOn: string | null;
	},
): Promise<void> {
	const described = await describeReportAccess(policy, identity, reportId);
	if (described.isPersonal) {
		throw new ReportAccessError(
			"A personal page belongs to its owner, who shares it directly.",
		);
	}
	const allowed =
		input.level === "category"
			? described.canSetCategoryPolicy
			: described.canDelegate;
	if (!allowed) {
		throw new ReportAccessError("You cannot change who holds this.", 403);
	}
	if (!described.assignableRoles.some((r) => r.roleId === input.roleId)) {
		throw new ReportAccessError(
			"You can only give out what you hold yourself.",
			403,
		);
	}
	if (!input.subjectId.trim()) {
		throw new ReportAccessError("A person or group is needed.");
	}

	if (
		input.level === "page" &&
		!described.pages.some((page) => page.pageId === input.pageId)
	) {
		throw new ReportAccessError("That page is not on this report.");
	}
	const scopeId =
		input.level === "category"
			? (described.categoryId as string)
			: input.level === "page"
				? (input.pageId as string)
				: reportId;
	const assignmentId = await assignRole(
		{
			roleId: input.roleId,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			scopeType: input.level,
			scopeId,
			expiresOn: input.expiresOn,
		},
		identity.email,
	);
	await insertLog({
		recordType: "role_assignment",
		recordId: assignmentId,
		action: "assign_role",
		changedBy: identity.email,
		newValue: JSON.stringify({ ...input, scopeId }),
	});
	invalidateAccessCache();
}

export async function removeReportHolder(
	policy: PolicyClass,
	identity: Identity,
	reportId: string,
	assignmentId: string,
): Promise<void> {
	const described = await describeReportAccess(policy, identity, reportId);
	const here = described.holders.find((h) => h.assignmentId === assignmentId);
	const inCategory = described.categoryHolders.find(
		(h) => h.assignmentId === assignmentId,
	);
	const onPage = described.pageHolders.find(
		(h) => h.assignmentId === assignmentId,
	);
	const holder = here ?? onPage ?? inCategory;
	if (!holder) throw new ReportAccessError("Not found", 404);
	if (
		here || onPage
			? !described.canDelegate
			: !described.canSetCategoryPolicy
	) {
		throw new ReportAccessError("You cannot change who holds this.", 403);
	}

	if (
		!onPage &&
		leavesNoMaintainer({
			removing: holder,
			onReport: described.holders,
			onCategory: described.categoryHolders,
		})
	) {
		throw new ReportAccessError(
			"Nobody would be left looking after this report. Add another Maintainer first.",
		);
	}

	await revokeAssignment(assignmentId);
	await insertLog({
		recordType: "role_assignment",
		recordId: assignmentId,
		action: "revoke_role",
		changedBy: identity.email,
	});
	invalidateAccessCache();
}

// Takes an official report back to being its owner's page. Publishing it again
// returns it, so nothing is lost and it can be reversed.
export async function takeBackToDraft(
	policy: PolicyClass,
	identity: Identity,
	reportId: string,
): Promise<void> {
	const subject = await subjectOf(reportId);
	const context = await getExplicitContext(policy, identity.email);
	if (
		!can(
			context.capabilities,
			"report.makeOfficial",
			subject.category_id,
			context.denied,
		)
	) {
		throw new ReportAccessError(
			"Only a Report Publisher can take a report back.",
			403,
		);
	}
	await sql(
		`UPDATE reports
		 SET is_personal = TRUE, category_id = NULL, visibility = 'private',
		     owner_email = COALESCE(owner_email, created_by, $2),
		     modified_by = $2, modified_on = now()
		 WHERE report_id = $1`,
		[reportId, identity.email],
	);
	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "unpublish_report",
		changedBy: identity.email,
		oldValue: subject.category_id,
	});
	invalidateReport(reportId, []);
	catalogueChanged();
	invalidateAccessCache();
}
