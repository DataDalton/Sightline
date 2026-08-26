import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	canDo,
	capabilities as allCapabilities,
	invalidateAccessCache,
	isCapability,
	type Capability,
	type Permission,
	type ScopeType,
} from "@/lib/platform/access";
import {
	assignRole,
	deleteRole,
	listAssignments,
	listRoles,
	revokeAssignment,
	saveRole,
} from "@/lib/platform/roles";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { insertLog } from "@/lib/activityLog";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { refreshTrackedGroups } from "@/lib/semantic/registry";

// Roles, and who holds them.
//
// A role names a bundle: one permission on the resources in its scope, plus the
// platform actions its holder may take. An assignment binds that bundle to a
// group or to a named individual.
//
// What this replaces could only say "everyone in this group edits everything",
// because it was two settings keys holding group names. There was no way to name
// one person, and no way to say "edits this subject area".

const permissions = ["view", "edit", "admin"] as const;
const scopeTypes = ["global", "category", "report"] as const;
const subjectTypes = ["group", "user"] as const;

// A role id is read in logs and used as a key, so it is kept to something that
// survives both without escaping.
const roleIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

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
		// Not found rather than forbidden, so an admin surface does not confirm
		// its own existence to somebody who cannot use it.
		return {
			error: NextResponse.json({ error: "Not found" }, { status: 404 }),
		};
	}

	return { identity };
}

export async function GET(request: NextRequest) {
	const checked = await guard(request);
	if (checked.error) return checked.error;

	const [roles, assignments] = await Promise.all([
		listRoles(),
		listAssignments(),
	]);

	// The capability list travels with the answer, so the page renders its
	// checkboxes from what the server actually recognises rather than from a
	// copy that can fall behind it.
	const response = NextResponse.json({
		roles,
		assignments,
		capabilities: allCapabilities,
	});
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export async function POST(request: NextRequest) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

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

	try {
		if (action === "saveRole") {
			const roleId = String(body.roleId ?? "").trim();
			if (!roleIdPattern.test(roleId)) {
				return NextResponse.json(
					{
						error: "An id is lower case letters, numbers and hyphens, up to 40 characters.",
					},
					{ status: 400 },
				);
			}

			const name = String(body.name ?? "").trim();
			if (!name) {
				return NextResponse.json(
					{ error: "A name is required." },
					{ status: 400 },
				);
			}

			const permission = body.permission as Permission;
			if (!permissions.includes(permission)) {
				return NextResponse.json(
					{
						error: `permission must be one of ${permissions.join(", ")}.`,
					},
					{ status: 400 },
				);
			}

			// Filtered rather than refused, so a client naming a capability
			// this build does not have gets a role without it instead of an
			// error it cannot act on.
			const wanted = Array.isArray(body.capabilities)
				? (body.capabilities as unknown[])
						.filter((c): c is string => typeof c === "string")
						.filter(isCapability)
				: [];

			await saveRole(
				{
					roleId,
					name: name.slice(0, 120),
					description: body.description
						? String(body.description).slice(0, 500)
						: null,
					permission,
					capabilities: wanted as Capability[],
				},
				identity.email,
			);

			await insertLog({
				recordType: "role",
				recordId: roleId,
				action: "save_role",
				changedBy: identity.email,
				newValue: JSON.stringify({
					permission,
					capabilities: wanted,
				}),
			});
			invalidateAccessCache();
			return NextResponse.json({ ok: true });
		}

		if (action === "deleteRole") {
			const roleId = String(body.roleId ?? "").trim();
			await deleteRole(roleId);
			await insertLog({
				recordType: "role",
				recordId: roleId,
				action: "delete_role",
				changedBy: identity.email,
			});
			invalidateAccessCache();
			return NextResponse.json({ ok: true });
		}

		if (action === "assign") {
			const roleId = String(body.roleId ?? "").trim();
			const subjectType = body.subjectType as "group" | "user";
			if (!subjectTypes.includes(subjectType)) {
				return NextResponse.json(
					{
						error: `subjectType must be one of ${subjectTypes.join(", ")}.`,
					},
					{ status: 400 },
				);
			}

			// Trimmed but never lowercased. is_account_group_member is case
			// sensitive, so a normalised name reports every member as a
			// non-member and denies the whole group with nothing in the logs to
			// explain it.
			const subjectId = String(body.subjectId ?? "").trim();
			if (!subjectId || subjectId.length > 255) {
				return NextResponse.json(
					{ error: "A group name or user email is required." },
					{ status: 400 },
				);
			}

			const scopeType = (body.scopeType ?? "global") as ScopeType;
			if (!scopeTypes.includes(scopeType)) {
				return NextResponse.json(
					{
						error: `scopeType must be one of ${scopeTypes.join(", ")}.`,
					},
					{ status: 400 },
				);
			}

			const assignmentId = await assignRole(
				{
					roleId,
					subjectType,
					subjectId,
					scopeType,
					scopeId: body.scopeId ? String(body.scopeId).trim() : null,
				},
				identity.email,
			);

			await insertLog({
				recordType: "role_assignment",
				recordId: assignmentId,
				action: "assign_role",
				changedBy: identity.email,
				newValue: JSON.stringify({
					roleId,
					subjectType,
					subjectId,
					scopeType,
					scopeId: body.scopeId ?? null,
				}),
			});

			// A group named here has to go on the probe list, or membership of
			// it is never resolved and the assignment matches nobody.
			if (subjectType === "group") {
				void refreshTrackedGroups().catch(() => {});
			}
			invalidateAccessCache();
			return NextResponse.json({ ok: true, assignmentId });
		}

		if (action === "revoke") {
			const assignmentId = String(body.assignmentId ?? "").trim();
			const removed = await revokeAssignment(assignmentId);
			if (!removed) {
				return NextResponse.json(
					{ error: "Not found" },
					{ status: 404 },
				);
			}
			await insertLog({
				recordType: "role_assignment",
				recordId: assignmentId,
				action: "revoke_role",
				changedBy: identity.email,
			});
			invalidateAccessCache();
			return NextResponse.json({ ok: true });
		}

		return NextResponse.json(
			{ error: "action must be saveRole, deleteRole, assign or revoke." },
			{ status: 400 },
		);
	} catch (error) {
		// A built-in role somebody tried to change, or a scoped assignment with
		// nothing to scope to. Both name what is wrong.
		const message =
			error instanceof Error
				? error.message
				: "Could not apply that change.";
		console.error("Role administration failed:", error);
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
