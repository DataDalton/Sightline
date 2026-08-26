import { sql, transaction } from "../data/lakebase";
import type { PolicyClass } from "../auth/policy";
import { effectiveAdminGroups, settings } from "../settings";
import {
	builtinRoles,
	isCapability,
	type Capability,
	type Permission,
	type ResolvedAssignment,
	type ScopeType,
} from "./accessRules";

// Reading and maintaining the role tables.
//
// A role names a bundle: one permission on the resources in scope, plus the
// platform actions its holder may take. An assignment binds that bundle to a
// group or to a named individual, within a scope.
//
// What this replaces is two hardcoded settings keys, editorGroups and
// adminGroups, which could only say "everyone in this group edits everything".
// There was no way to name one person, and no way to say "edits this subject
// area". Both are ordinary asks, and both used to end in a support request.

export interface RoleRecord {
	roleId: string;
	name: string;
	description: string | null;
	permission: Permission;
	capabilities: Capability[];
	isBuiltin: boolean;
}

export interface AssignmentRecord {
	assignmentId: string;
	roleId: string;
	roleName: string;
	subjectType: "group" | "user";
	subjectId: string;
	scopeType: ScopeType;
	scopeId: string | null;
	grantedBy: string | null;
	grantedOn: string;
}

// Re-asserts the built-in roles from lib/platform/accessRules.
//
// Upserted on every start rather than inserted once, so the capability set of a
// role everyone recognises by name is owned by the code and cannot drift by
// hand. Custom roles are untouched, and so are the assignments pointing at
// built-in ones.
export async function syncBuiltinRoles(): Promise<void> {
	await transaction(async (client) => {
		for (const role of builtinRoles) {
			await client.query(
				`INSERT INTO roles (role_id, name, description, permission, is_builtin)
				 VALUES ($1, $2, $3, $4, TRUE)
				 ON CONFLICT (role_id) DO UPDATE SET
				   name = EXCLUDED.name,
				   description = EXCLUDED.description,
				   permission = EXCLUDED.permission,
				   is_builtin = TRUE`,
				[role.roleId, role.name, role.description, role.permission],
			);

			// Replaced wholesale rather than merged, so a capability removed
			// from the definition is removed from the role. Merging would mean
			// a capability could only ever be added, and narrowing a built-in
			// role would silently do nothing.
			await client.query(
				`DELETE FROM role_capabilities
				 WHERE role_id = $1 AND capability <> ALL($2)`,
				[role.roleId, role.capabilities],
			);
			for (const capability of role.capabilities) {
				await client.query(
					`INSERT INTO role_capabilities (role_id, capability)
					 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
					[role.roleId, capability],
				);
			}
		}
	});
}

// Converts the editorGroups and adminGroups settings into global assignments,
// once.
//
// Only when no assignment exists at all. An administrator who later removes an
// assignment must not have it reinstated by the next restart, and the settings
// keys stay readable so a fresh install still has somebody who can configure
// it before any assignment has been made.
export async function bootstrapRoleAssignments(): Promise<boolean> {
	const existing = await sql<{ count: string }>(
		`SELECT count(*)::text AS count FROM role_assignments`,
	);
	if (Number(existing[0]?.count ?? 0) > 0) return false;

	const pairs: { roleId: string; group: string }[] = [
		...effectiveAdminGroups().map((group) => ({ roleId: "admin", group })),
		...settings().editorGroups.map((group) => ({
			roleId: "editor",
			group,
		})),
	].filter((p) => p.group.trim().length > 0);

	if (pairs.length === 0) return false;

	for (const pair of pairs) {
		await sql(
			`INSERT INTO role_assignments
			   (role_id, subject_type, subject_id, scope_type, scope_id, granted_by)
			 VALUES ($1, 'group', $2, 'global', NULL, 'bootstrap')`,
			[pair.roleId, pair.group.trim()],
		);
	}

	console.log(
		`Seeded ${pairs.length} role assignments from the configured admin and editor groups.`,
	);
	return true;
}

interface AssignmentRow {
	permission: Permission;
	scope_type: ScopeType;
	scope_id: string | null;
	capabilities: string[] | null;
}

// Every assignment reaching this caller, as a group member or by name.
//
// Grouped by assignment rather than by role, so two assignments of the same
// role in different scopes stay distinct. Collapsing them would lose the scope,
// which is the whole point of having one.
export async function loadAssignments(
	policy: PolicyClass,
	email: string,
): Promise<ResolvedAssignment[]> {
	const rows = await sql<AssignmentRow>(
		`SELECT r.permission,
		        ra.scope_type,
		        ra.scope_id,
		        coalesce(
		          array_agg(rc.capability) FILTER (WHERE rc.capability IS NOT NULL),
		          '{}'
		        ) AS capabilities
		 FROM role_assignments ra
		 JOIN roles r ON r.role_id = ra.role_id AND r.is_active = TRUE
		 LEFT JOIN role_capabilities rc ON rc.role_id = ra.role_id
		 WHERE ra.is_active = TRUE
		   AND (
		     (ra.subject_type = 'group' AND ra.subject_id = ANY($1))
		     OR (ra.subject_type = 'user' AND lower(ra.subject_id) = $2)
		   )
		 GROUP BY ra.assignment_id, r.permission, ra.scope_type, ra.scope_id`,
		[policy.grants, email.toLowerCase()],
	);

	return rows.map((row) => ({
		permission: row.permission,
		// Filtered against the closed list, so a capability written into the
		// table by hand and checked nowhere cannot quietly become one somebody
		// holds.
		capabilities: (row.capabilities ?? []).filter(isCapability),
		scopeType: row.scope_type,
		scopeId: row.scope_id,
	}));
}

// --- Administration --------------------------------------------------------

export async function listRoles(): Promise<RoleRecord[]> {
	const rows = await sql<{
		role_id: string;
		name: string;
		description: string | null;
		permission: Permission;
		is_builtin: boolean;
		capabilities: string[] | null;
	}>(
		`SELECT r.role_id, r.name, r.description, r.permission, r.is_builtin,
		        coalesce(
		          array_agg(rc.capability) FILTER (WHERE rc.capability IS NOT NULL),
		          '{}'
		        ) AS capabilities
		 FROM roles r
		 LEFT JOIN role_capabilities rc ON rc.role_id = r.role_id
		 WHERE r.is_active = TRUE
		 GROUP BY r.role_id
		 ORDER BY r.is_builtin DESC, r.name`,
	);

	return rows.map((row) => ({
		roleId: row.role_id,
		name: row.name,
		description: row.description,
		permission: row.permission,
		capabilities: (row.capabilities ?? []).filter(isCapability),
		isBuiltin: row.is_builtin,
	}));
}

export async function listAssignments(): Promise<AssignmentRecord[]> {
	const rows = await sql<{
		assignment_id: string;
		role_id: string;
		role_name: string;
		subject_type: "group" | "user";
		subject_id: string;
		scope_type: ScopeType;
		scope_id: string | null;
		granted_by: string | null;
		granted_on: string;
	}>(
		`SELECT ra.assignment_id, ra.role_id, r.name AS role_name,
		        ra.subject_type, ra.subject_id, ra.scope_type, ra.scope_id,
		        ra.granted_by, ra.granted_on
		 FROM role_assignments ra
		 JOIN roles r ON r.role_id = ra.role_id
		 WHERE ra.is_active = TRUE
		 ORDER BY ra.granted_on DESC
		 LIMIT 500`,
	);

	return rows.map((row) => ({
		assignmentId: row.assignment_id,
		roleId: row.role_id,
		roleName: row.role_name,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		scopeType: row.scope_type,
		scopeId: row.scope_id,
		grantedBy: row.granted_by,
		grantedOn: row.granted_on,
	}));
}

export async function saveRole(
	input: {
		roleId: string;
		name: string;
		description?: string | null;
		permission: Permission;
		capabilities: Capability[];
	},
	actor: string,
): Promise<void> {
	const builtin = builtinRoles.some((r) => r.roleId === input.roleId);
	if (builtin) {
		throw new Error(
			"Built-in roles are defined by the platform and cannot be changed. Make a role of your own instead.",
		);
	}

	await transaction(async (client) => {
		await client.query(
			`INSERT INTO roles (role_id, name, description, permission, is_builtin, created_by)
			 VALUES ($1, $2, $3, $4, FALSE, $5)
			 ON CONFLICT (role_id) DO UPDATE SET
			   name = EXCLUDED.name,
			   description = EXCLUDED.description,
			   permission = EXCLUDED.permission`,
			[
				input.roleId,
				input.name,
				input.description ?? null,
				input.permission,
				actor,
			],
		);

		const wanted = input.capabilities.filter(isCapability);
		await client.query(
			`DELETE FROM role_capabilities
			 WHERE role_id = $1 AND capability <> ALL($2)`,
			[input.roleId, wanted],
		);
		for (const capability of wanted) {
			await client.query(
				`INSERT INTO role_capabilities (role_id, capability)
				 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
				[input.roleId, capability],
			);
		}
	});
}

export async function deleteRole(roleId: string): Promise<void> {
	if (builtinRoles.some((r) => r.roleId === roleId)) {
		throw new Error("Built-in roles cannot be deleted.");
	}
	// Deactivated rather than dropped, so the assignments pointing at it stay
	// readable in an audit rather than vanishing with it.
	await sql(`UPDATE roles SET is_active = FALSE WHERE role_id = $1`, [
		roleId,
	]);
}

export async function assignRole(
	input: {
		roleId: string;
		subjectType: "group" | "user";
		subjectId: string;
		scopeType: ScopeType;
		scopeId?: string | null;
	},
	actor: string,
): Promise<string> {
	const scopeId =
		input.scopeType === "global" ? null : (input.scopeId ?? null);
	if (input.scopeType !== "global" && !scopeId) {
		throw new Error(
			`A ${input.scopeType} assignment has to name the ${input.scopeType} it applies to.`,
		);
	}

	const rows = await sql<{ assignment_id: string }>(
		`INSERT INTO role_assignments
		   (role_id, subject_type, subject_id, scope_type, scope_id, granted_by)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING assignment_id`,
		[
			input.roleId,
			input.subjectType,
			input.subjectId.trim(),
			input.scopeType,
			scopeId,
			actor,
		],
	);
	return rows[0].assignment_id;
}

export async function revokeAssignment(assignmentId: string): Promise<boolean> {
	const rows = await sql<{ assignment_id: string }>(
		`UPDATE role_assignments SET is_active = FALSE
		 WHERE assignment_id = $1 AND is_active = TRUE
		 RETURNING assignment_id`,
		[assignmentId],
	);
	return rows.length > 0;
}
