import { sql } from "../data/lakebase";
import { settings, effectiveAdminGroups } from "../settings";
import type { Permission } from "./accessRules";

// Answering an access review.
//
// "Who holds what" lists assignments one row each, which is the input to the
// question rather than the answer. Turning those rows into "who can open this"
// meant reading four lists and running the resolver in your head, and the
// drill-down that looked like it answered it reported who had viewed a report,
// which is a different question with a similar shape.
//
// Two directions, because a review asks in both: given a report, who reaches
// it; given a person, what do they reach.
//
// What cannot be answered here is said rather than guessed. Group membership is
// resolved by probing Unity Catalog under the caller's own token, so the app
// cannot enumerate anybody else's groups. A route that depends on membership is
// reported as conditional on it, which is the honest shape of the answer.

export type RouteKind =
	| "owner"
	| "role"
	| "grant"
	| "settingsGroup"
	| "catalogue";

export interface AccessRoute {
	kind: RouteKind;
	// Who this route lets in.
	subjectType: "user" | "group" | "anyone";
	subjectId: string;
	permission: Permission;
	// What the route is called, for a row that reads on its own.
	via: string;
	// Where the route applies, when it is not the resource itself.
	scope: string | null;
	// True when the route only applies if the subject is in a group the app
	// cannot confirm from here.
	conditional: boolean;
	grantedBy: string | null;
	grantedOn: string | null;
}

export interface ReportAccessReport {
	reportId: string;
	title: string;
	categoryId: string | null;
	isPersonal: boolean;
	ownerEmail: string | null;
	routes: AccessRoute[];
	// Set when the report is personal, where implicit grants do not apply and
	// the list above is therefore complete except for administrators.
	note: string | null;
}

interface ReportRow {
	report_id: string;
	title: string;
	category_id: string | null;
	is_personal: boolean;
	owner_email: string | null;
	source_key: string | null;
}

interface AssignmentRow {
	subject_type: "user" | "group";
	subject_id: string;
	scope_type: "global" | "category" | "report";
	scope_id: string | null;
	role_name: string;
	permission: Permission;
	granted_by: string | null;
	granted_on: string;
}

interface PolicyRow {
	subject_type: "user" | "group";
	subject_id: string;
	resource_type: string;
	resource_id: string;
	permission: Permission;
	granted_by: string | null;
	granted_on: string;
}

// Every way into one report.
export async function explainReportAccess(
	reportId: string,
): Promise<ReportAccessReport | null> {
	const reports = await sql<ReportRow>(
		`SELECT report_id::text AS report_id, title, category_id, is_personal,
		        owner_email, source_key
		 FROM reports
		 WHERE report_id = $1 AND is_active = TRUE`,
		[reportId],
	);
	const report = reports[0];
	if (!report) return null;

	// A scope that reaches this report: named on it, named on its category, or
	// global. Anything else is about a different resource.
	const assignments = await sql<AssignmentRow>(
		`SELECT a.subject_type, a.subject_id, a.scope_type, a.scope_id,
		        r.name AS role_name, r.permission, a.granted_by,
		        a.granted_on::text AS granted_on
		 FROM role_assignments a
		 JOIN roles r ON r.role_id = a.role_id
		 WHERE a.is_active = TRUE AND r.is_active = TRUE
		   AND (a.scope_type = 'global'
		        OR (a.scope_type = 'report' AND a.scope_id = $1)
		        OR (a.scope_type = 'category' AND a.scope_id = $2))`,
		[reportId, report.category_id],
	);

	const policies = await sql<PolicyRow>(
		`SELECT subject_type, subject_id, resource_type, resource_id,
		        permission, granted_by, granted_on::text AS granted_on
		 FROM access_policies
		 WHERE is_active = TRUE
		   AND ((resource_type = 'report' AND resource_id = $1)
		        OR (resource_type = 'category' AND resource_id = $2))`,
		[reportId, report.category_id ?? ""],
	);

	const routes: AccessRoute[] = [];

	if (report.is_personal && report.owner_email) {
		routes.push({
			kind: "owner",
			subjectType: "user",
			subjectId: report.owner_email,
			permission: "admin",
			via: "Owns this page",
			scope: null,
			conditional: false,
			grantedBy: null,
			grantedOn: null,
		});
	}

	for (const row of assignments) {
		// A personal page is exempt from every implicit grant. Only a global
		// administrator reaches one, and a role scoped to its category does
		// not, so listing scoped roles here would overstate who can open it.
		if (report.is_personal) {
			const global = row.scope_type === "global";
			if (!global || row.permission !== "admin") continue;
		}
		routes.push({
			kind: "role",
			subjectType: row.subject_type,
			subjectId: row.subject_id,
			permission: row.permission,
			via: `Role: ${row.role_name}`,
			scope:
				row.scope_type === "global"
					? "Everywhere"
					: row.scope_type === "category"
						? `Category ${row.scope_id}`
						: "This report",
			conditional: row.subject_type === "group",
			grantedBy: row.granted_by,
			grantedOn: row.granted_on,
		});
	}

	for (const row of policies) {
		routes.push({
			kind: "grant",
			subjectType: row.subject_type,
			subjectId: row.subject_id,
			permission: row.permission,
			via: "Direct grant",
			scope:
				row.resource_type === "category"
					? `Category ${row.resource_id}`
					: "This report",
			conditional: row.subject_type === "group",
			grantedBy: row.granted_by,
			grantedOn: row.granted_on,
		});
	}

	// The configured groups are a floor that no table can withdraw, so they
	// belong in the answer even though nothing granted them here.
	if (!report.is_personal) {
		for (const group of settings().editorGroups) {
			routes.push({
				kind: "settingsGroup",
				subjectType: "group",
				subjectId: group,
				permission: "edit",
				via: "Editor group in settings",
				scope: "Everywhere",
				conditional: true,
				grantedBy: null,
				grantedOn: null,
			});
		}
	}

	for (const group of effectiveAdminGroups()) {
		routes.push({
			kind: "settingsGroup",
			subjectType: "group",
			subjectId: group,
			permission: "admin",
			via: "Admin group in settings",
			scope: "Everywhere",
			conditional: true,
			grantedBy: null,
			grantedOn: null,
		});
	}

	// The widest route of all, and the one people forget: with catalogue
	// reachability on, anybody holding SELECT on the source can open anything
	// built on it, whether or not a single grant names them.
	if (
		!report.is_personal &&
		settings().accessModel === "catalog" &&
		report.source_key
	) {
		routes.push({
			kind: "catalogue",
			subjectType: "anyone",
			subjectId: `Anyone with SELECT on ${report.source_key}`,
			permission: "view",
			via: "Unity Catalog reachability",
			scope: "This report's source",
			conditional: true,
			grantedBy: null,
			grantedOn: null,
		});
	}

	return {
		reportId: report.report_id,
		title: report.title,
		categoryId: report.category_id,
		isPersonal: report.is_personal,
		ownerEmail: report.owner_email,
		routes,
		note: report.is_personal
			? "A personal page is exempt from implicit grants. Only the owner, people named on it, and a global administrator can open it."
			: null,
	};
}

export interface SubjectAccess {
	subject: string;
	// Rows naming this exact subject. For a person this is complete; anything
	// they hold through a group is listed under groups below.
	direct: {
		via: string;
		permission: Permission;
		scope: string;
		resource: string;
		grantedBy: string | null;
		grantedOn: string | null;
	}[];
	// Groups that carry a permission. Whether this person is in one cannot be
	// answered from here, so they are listed for somebody who can check.
	throughGroups: {
		group: string;
		via: string;
		permission: Permission;
		scope: string;
	}[];
	// True when reachability follows Unity Catalog, in which case this person
	// also reaches every report built on data they hold SELECT on.
	catalogueApplies: boolean;
}

// Everything naming one person, and every group route that might also apply.
export async function explainSubjectAccess(
	email: string,
): Promise<SubjectAccess> {
	const subject = email.trim();
	const lowered = subject.toLowerCase();

	const [assignments, policies] = await Promise.all([
		sql<AssignmentRow & { resource: string | null }>(
			`SELECT a.subject_type, a.subject_id, a.scope_type, a.scope_id,
			        r.name AS role_name, r.permission, a.granted_by,
			        a.granted_on::text AS granted_on, NULL::text AS resource
			 FROM role_assignments a
			 JOIN roles r ON r.role_id = a.role_id
			 WHERE a.is_active = TRUE AND r.is_active = TRUE
			   AND a.subject_type = 'user' AND lower(a.subject_id) = $1`,
			[lowered],
		),
		sql<PolicyRow>(
			`SELECT subject_type, subject_id, resource_type, resource_id,
			        permission, granted_by, granted_on::text AS granted_on
			 FROM access_policies
			 WHERE is_active = TRUE
			   AND subject_type = 'user' AND lower(subject_id) = $1`,
			[lowered],
		),
	]);

	const direct: SubjectAccess["direct"] = [];

	for (const row of assignments) {
		direct.push({
			via: `Role: ${row.role_name}`,
			permission: row.permission,
			scope: row.scope_type === "global" ? "Everywhere" : row.scope_type,
			resource: row.scope_id ?? "All",
			grantedBy: row.granted_by,
			grantedOn: row.granted_on,
		});
	}

	for (const row of policies) {
		direct.push({
			via: "Direct grant",
			permission: row.permission,
			scope: row.resource_type,
			resource: row.resource_id,
			grantedBy: row.granted_by,
			grantedOn: row.granted_on,
		});
	}

	const groupAssignments = await sql<AssignmentRow>(
		`SELECT a.subject_type, a.subject_id, a.scope_type, a.scope_id,
		        r.name AS role_name, r.permission, a.granted_by,
		        a.granted_on::text AS granted_on
		 FROM role_assignments a
		 JOIN roles r ON r.role_id = a.role_id
		 WHERE a.is_active = TRUE AND r.is_active = TRUE
		   AND a.subject_type = 'group'`,
	);

	const throughGroups: SubjectAccess["throughGroups"] = groupAssignments.map(
		(row) => ({
			group: row.subject_id,
			via: `Role: ${row.role_name}`,
			permission: row.permission,
			scope:
				row.scope_type === "global"
					? "Everywhere"
					: `${row.scope_type} ${row.scope_id}`,
		}),
	);

	for (const group of settings().editorGroups) {
		throughGroups.push({
			group,
			via: "Editor group in settings",
			permission: "edit",
			scope: "Everywhere",
		});
	}
	for (const group of effectiveAdminGroups()) {
		throughGroups.push({
			group,
			via: "Admin group in settings",
			permission: "admin",
			scope: "Everywhere",
		});
	}

	return {
		subject,
		direct,
		throughGroups,
		catalogueApplies: settings().accessModel === "catalog",
	};
}
