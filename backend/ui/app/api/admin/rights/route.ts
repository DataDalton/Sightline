import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { insertLog } from "@/lib/activityLog";
import { sql } from "@/lib/data/lakebase";
import {
	canDo,
	explainRights,
	invalidateAccessCache,
	isCapability,
	type Capability,
	type ScopeType,
	type SubjectType,
} from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	listAttributeRules,
	listAttributes,
	listPermissionGrants,
	removeAttribute,
	removeAttributeRule,
	removePermissionGrant,
	saveAttributeRule,
	savePermissionGrant,
	setAttribute,
} from "@/lib/platform/permissionStore";
import { listAssignments, listRoles } from "@/lib/platform/roles";

// One person's or group's rights, and the things that change them directly: a single
// permission, an exception, a label, or a rule granting a role from a label.

const scopeTypes: ScopeType[] = [
	"global",
	"category",
	"tag",
	"report",
	"page",
	"source",
];
const subjectTypes: SubjectType[] = ["group", "user", "service_principal"];

async function guard(request: NextRequest) {
	await ensureReadyOrDegrade();
	const identity = getIdentity(request);
	if (!identity) {
		return {
			error: NextResponse.json(
				{ error: "Not authenticated" },
				{ status: 401 },
			),
		};
	}
	const policy = await resolvePolicyClass(identity);
	if (!(await canDo(policy, identity, "access.grant"))) {
		return {
			error: NextResponse.json({ error: "Not found" }, { status: 404 }),
		};
	}
	return { identity };
}

// Matched as text, so a wildcard typed into the box stays literal.
function literalLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function GET(request: NextRequest) {
	const checked = await guard(request);
	if (checked.error) return checked.error;

	const subject = (request.nextUrl.searchParams.get("subject") ?? "").trim();
	const [roles, rules] = await Promise.all([
		listRoles(),
		listAttributeRules(),
	]);

	const shared = {
		roles: roles.map((role) => ({
			roleId: role.roleId,
			name: role.name,
		})),
		rules,
	};
	if (!subject) {
		const response = NextResponse.json(shared);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	}

	const lowered = subject.toLowerCase();
	const [assignments, grants, attributes, history] = await Promise.all([
		listAssignments(),
		listPermissionGrants(subject),
		listAttributes(subject),
		sql<{
			action: string;
			changed_by: string;
			changed_on: string;
			new_value: string | null;
		}>(
			`SELECT action, changed_by, changed_on::text AS changed_on, new_value
			 FROM activity_log
			 WHERE record_type IN ('role_assignment', 'permission_grant', 'subject_attribute')
			   AND (lower(record_id) = $1 OR lower(new_value) LIKE '%' || $2 || '%')
			 ORDER BY changed_on DESC
			 LIMIT 50`,
			[lowered, literalLike(lowered)],
		),
	]);

	const own = assignments.filter(
		(a) => a.subjectId.toLowerCase() === lowered,
	);
	const labels = new Set(
		attributes.map(
			(a) => `${a.attribute.toLowerCase()}=${a.value.toLowerCase()}`,
		),
	);
	const matchedRules = rules.filter((rule) =>
		labels.has(
			`${rule.attribute.toLowerCase()}=${rule.value.toLowerCase()}`,
		),
	);

	const [reportNames, categoryNames, pageNames] = await Promise.all([
		sql<{ id: string; name: string }>(
			`SELECT report_id::text AS id, title AS name FROM reports WHERE is_active = TRUE`,
		),
		sql<{ id: string; name: string }>(
			`SELECT category_id AS id, name FROM categories WHERE is_active = TRUE`,
		),
		sql<{ id: string; name: string }>(
			`SELECT p.page_id::text AS id, r.title || ', ' || p.title AS name
			 FROM report_pages p
			 JOIN reports r ON r.report_id = p.report_id AND r.is_active = TRUE
			 WHERE p.is_active = TRUE`,
		),
	]);
	const scopeNames = new Map(
		[...reportNames, ...categoryNames, ...pageNames].map((row) => [
			row.id,
			row.name,
		]),
	);

	const capabilitiesOf = new Map(
		roles.map((role) => [role.roleId, role.capabilities]),
	);
	const response = NextResponse.json({
		...shared,
		subject,
		assignments: own,
		grants,
		attributes,
		matchedRules,
		rights: explainRights({
			assignments: own.map((a) => ({
				roleName: a.roleName,
				capabilities: capabilitiesOf.get(a.roleId) ?? [],
				scopeType: a.scopeType,
				scopeId: a.scopeId,
				expiresOn: a.expiresOn,
			})),
			rules: matchedRules.map((rule) => ({
				label: `${rule.attribute} = ${rule.value}`,
				roleName: rule.roleName,
				capabilities: capabilitiesOf.get(rule.roleId) ?? [],
				scopeType: rule.scopeType,
				scopeId: rule.scopeId,
			})),
			grants,
			nameOf: (scopeId) => scopeNames.get(scopeId),
		}),
		history: history.map((row) => ({
			action: row.action,
			changedBy: row.changed_by,
			changedOn: row.changed_on,
			detail: row.new_value,
		})),
	});
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export async function POST(request: NextRequest) {
	const checked = await guard(request);
	if (checked.error) return checked.error;
	const identity = checked.identity;

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
	}

	const action = String(body.action ?? "");
	const subjectType = body.subjectType as SubjectType;
	const subjectId = String(body.subjectId ?? "").trim();
	const scopeType = (body.scopeType ?? "global") as ScopeType;
	const scopeId = body.scopeId ? String(body.scopeId).trim() : null;
	const needsSubject = () => {
		if (!subjectTypes.includes(subjectType) || !subjectId) {
			throw new Error("A person or group is required.");
		}
	};
	const needsScope = () => {
		if (!scopeTypes.includes(scopeType)) {
			throw new Error("That is not somewhere a right can apply.");
		}
	};

	try {
		if (action === "grant") {
			needsSubject();
			needsScope();
			const capability = String(body.capability ?? "");
			if (!isCapability(capability)) {
				throw new Error("That permission does not exist.");
			}
			const effect = body.effect === "deny" ? "deny" : "allow";
			const grantId = await savePermissionGrant(
				{
					subjectType,
					subjectId,
					capability: capability as Capability,
					effect,
					scopeType,
					scopeId,
					reason: body.reason
						? String(body.reason).slice(0, 500)
						: null,
					expiresOn: body.expiresOn ? String(body.expiresOn) : null,
				},
				identity.email,
			);
			await insertLog({
				recordType: "permission_grant",
				recordId: grantId,
				action:
					effect === "deny" ? "add_exception" : "grant_permission",
				changedBy: identity.email,
				newValue: JSON.stringify({
					subjectId,
					capability,
					scopeType,
					scopeId,
					expiresOn: body.expiresOn ?? null,
				}),
			});
		} else if (action === "ungrant") {
			const grantId = String(body.grantId ?? "");
			if (!(await removePermissionGrant(grantId))) {
				return NextResponse.json(
					{ error: "Not found" },
					{ status: 404 },
				);
			}
			await insertLog({
				recordType: "permission_grant",
				recordId: grantId,
				action: "remove_permission",
				changedBy: identity.email,
				newValue: JSON.stringify({ subjectId }),
			});
		} else if (action === "setAttribute") {
			needsSubject();
			const attribute = String(body.attribute ?? "").trim();
			const value = String(body.value ?? "").trim();
			if (!attribute || !value) {
				throw new Error("A label needs a name and a value.");
			}
			await setAttribute(
				{ subjectType, subjectId, attribute, value },
				identity.email,
			);
			await insertLog({
				recordType: "subject_attribute",
				recordId: subjectId.toLowerCase(),
				action: "set_attribute",
				changedBy: identity.email,
				newValue: JSON.stringify({ attribute, value }),
			});
		} else if (action === "removeAttribute") {
			needsSubject();
			const attribute = String(body.attribute ?? "");
			await removeAttribute(subjectType, subjectId, attribute);
			await insertLog({
				recordType: "subject_attribute",
				recordId: subjectId.toLowerCase(),
				action: "remove_attribute",
				changedBy: identity.email,
				newValue: JSON.stringify({ attribute }),
			});
		} else if (action === "saveRule") {
			needsScope();
			const attribute = String(body.attribute ?? "").trim();
			const value = String(body.value ?? "").trim();
			const roleId = String(body.roleId ?? "").trim();
			if (!attribute || !value || !roleId) {
				throw new Error("A rule needs a label, a value and a role.");
			}
			const ruleId = await saveAttributeRule(
				{ attribute, value, roleId, scopeType, scopeId },
				identity.email,
			);
			await insertLog({
				recordType: "attribute_rule",
				recordId: ruleId,
				action: "save_attribute_rule",
				changedBy: identity.email,
				newValue: JSON.stringify({
					attribute,
					value,
					roleId,
					scopeType,
					scopeId,
				}),
			});
		} else if (action === "removeRule") {
			const ruleId = String(body.ruleId ?? "");
			await removeAttributeRule(ruleId);
			await insertLog({
				recordType: "attribute_rule",
				recordId: ruleId,
				action: "remove_attribute_rule",
				changedBy: identity.email,
			});
		} else {
			return NextResponse.json(
				{ error: "Unknown action." },
				{ status: 400 },
			);
		}

		invalidateAccessCache();
		return NextResponse.json({ ok: true });
	} catch (error) {
		console.error("Changing a person's rights failed:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Could not make that change.",
			},
			{ status: 400 },
		);
	}
}
