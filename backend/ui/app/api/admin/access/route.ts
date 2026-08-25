import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	invalidateAccessCache,
	isAdmin,
	type Permission,
} from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { insertLog } from "@/lib/activityLog";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { sql } from "@/lib/data/lakebase";
import { refreshTrackedGroups } from "@/lib/semantic/registry";

// Who can open what.
//
// Unity Catalog decides which rows a query returns. This decides which reports
// exist as far as a reader is concerned, which is a separate question: somebody
// with full access to the underlying data still sees an empty home page until a
// grant here names them or a group they belong to.
//
// A grant naming a group is also what puts that group on the probe list, so
// granting is the only step.

const subjectTypes = ["group", "user"] as const;
const resourceTypes = ["category", "report", "page"] as const;
const permissions = ["view", "edit", "admin"] as const;

type SubjectType = (typeof subjectTypes)[number];
type ResourceType = (typeof resourceTypes)[number];

interface GrantInput {
	subjectType: SubjectType;
	subjectId: string;
	resourceType: ResourceType;
	resourceId: string;
	permission: Permission;
}

function readGrant(body: unknown): GrantInput | string {
	if (typeof body !== "object" || body === null) return "Expected an object.";
	const fields = body as Record<string, unknown>;

	const subjectType = fields.subjectType;
	if (!subjectTypes.includes(subjectType as SubjectType)) {
		return `subjectType must be one of ${subjectTypes.join(", ")}.`;
	}

	// Trimmed but never lowercased. is_account_group_member is case sensitive,
	// so a normalised name reports every member as a non-member, which denies
	// the whole group with nothing in the logs to explain it.
	const subjectId =
		typeof fields.subjectId === "string" ? fields.subjectId.trim() : "";
	if (!subjectId) return "A group name or user email is required.";
	if (subjectId.length > 255) return "That name is too long.";

	const resourceType = fields.resourceType;
	if (!resourceTypes.includes(resourceType as ResourceType)) {
		return `resourceType must be one of ${resourceTypes.join(", ")}.`;
	}

	const resourceId =
		typeof fields.resourceId === "string" ? fields.resourceId.trim() : "";
	if (!resourceId) return "A resource is required.";

	const permission = fields.permission;
	if (!permissions.includes(permission as Permission)) {
		return `permission must be one of ${permissions.join(", ")}.`;
	}

	return {
		subjectType: subjectType as SubjectType,
		subjectId,
		resourceType: resourceType as ResourceType,
		resourceId,
		permission: permission as Permission,
	};
}

// The resource has to exist. A grant on a mistyped id grants nothing and reads
// in the list as though it were working, which is worse than a rejection.
async function resourceExists(
	type: ResourceType,
	id: string,
): Promise<boolean> {
	const target =
		type === "category"
			? { table: "categories", column: "category_id" }
			: type === "report"
				? { table: "reports", column: "report_id" }
				: { table: "report_pages", column: "page_id" };

	// Compared as text, because a UUID column rejects a non-UUID argument with
	// an error rather than an empty result.
	const rows = await sql<{ found: boolean }>(
		`SELECT TRUE AS found FROM ${target.table}
		 WHERE ${target.column}::text = $1 LIMIT 1`,
		[id],
	);
	return rows.length > 0;
}

async function requireAdmin(request: NextRequest) {
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
	if (!isAdmin(policy)) {
		// Not found rather than forbidden, so an admin surface does not confirm
		// its own existence to someone who cannot use it.
		return {
			error: NextResponse.json({ error: "Not found" }, { status: 404 }),
		};
	}
	return { identity };
}

export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const auth = await requireAdmin(request);
	if (auth.error) return auth.error;

	const grants = await sql<{
		policy_id: string;
		subject_type: string;
		subject_id: string;
		resource_type: string;
		resource_id: string;
		permission: Permission;
		granted_by: string | null;
		granted_on: string;
		resource_name: string | null;
	}>(
		`SELECT p.policy_id, p.subject_type, p.subject_id, p.resource_type,
		        p.resource_id, p.permission, p.granted_by, p.granted_on,
		        COALESCE(c.name, r.title, pg.title) AS resource_name
		 FROM access_policies p
		 LEFT JOIN categories c
		   ON p.resource_type = 'category' AND c.category_id = p.resource_id
		 LEFT JOIN reports r
		   ON p.resource_type = 'report' AND r.report_id::text = p.resource_id
		 LEFT JOIN report_pages pg
		   ON p.resource_type = 'page' AND pg.page_id::text = p.resource_id
		 WHERE p.is_active = TRUE
		 ORDER BY p.subject_type, p.subject_id, p.resource_type, resource_name`,
	);

	// Everything grantable, so the form offers choices rather than asking for
	// an id to be typed correctly.
	const categories = await sql<{ id: string; name: string }>(
		`SELECT category_id AS id, name FROM categories
		 WHERE is_active = TRUE ORDER BY sort_order, name`,
	);
	const reports = await sql<{ id: string; name: string }>(
		`SELECT report_id::text AS id, title AS name
		 FROM reports WHERE is_active = TRUE ORDER BY title`,
	);

	const response = NextResponse.json({ grants, categories, reports });
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const auth = await requireAdmin(request);
	if (auth.error) return auth.error;
	const identity = auth.identity;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
	}

	const grant = readGrant(body);
	if (typeof grant === "string") {
		return NextResponse.json({ error: grant }, { status: 400 });
	}

	if (!(await resourceExists(grant.resourceType, grant.resourceId))) {
		return NextResponse.json(
			{ error: `No ${grant.resourceType} with that id.` },
			{ status: 400 },
		);
	}

	const params = [
		grant.subjectType,
		grant.subjectId,
		grant.resourceType,
		grant.resourceId,
		grant.permission,
		identity.email,
	];

	// One row per subject and resource. Granting the same pair twice changes
	// the permission rather than leaving two rows whose combined meaning has to
	// be worked out at read time, and re-granting something revoked makes it
	// active again.
	const inserted = await sql<{ policy_id: string }>(
		`INSERT INTO access_policies
		   (subject_type, subject_id, resource_type, resource_id, permission,
		    granted_by)
		 SELECT $1, $2, $3, $4, $5, $6
		 WHERE NOT EXISTS (
		   SELECT 1 FROM access_policies
		   WHERE subject_type = $1 AND subject_id = $2
		     AND resource_type = $3 AND resource_id = $4
		 )
		 RETURNING policy_id`,
		params,
	);

	if (inserted.length === 0) {
		await sql(
			`UPDATE access_policies
			 SET permission = $5, is_active = TRUE, granted_by = $6,
			     granted_on = now()
			 WHERE subject_type = $1 AND subject_id = $2
			   AND resource_type = $3 AND resource_id = $4`,
			params,
		);
	}

	await applyGrantChange(identity.email, grant, "grant_access");

	return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const auth = await requireAdmin(request);
	if (auth.error) return auth.error;
	const identity = auth.identity;

	const policyId = request.nextUrl.searchParams.get("policyId")?.trim() ?? "";
	if (!policyId) {
		return NextResponse.json(
			{ error: "policyId is required." },
			{ status: 400 },
		);
	}

	// Deactivated rather than deleted, so an access review can still answer who
	// held what and when it was taken away.
	const revoked = await sql<{
		subject_type: string;
		subject_id: string;
		resource_type: string;
		resource_id: string;
		permission: Permission;
	}>(
		`UPDATE access_policies SET is_active = FALSE
		 WHERE policy_id::text = $1 AND is_active = TRUE
		 RETURNING subject_type, subject_id, resource_type, resource_id,
		           permission`,
		[policyId],
	);

	if (revoked.length === 0) {
		return NextResponse.json({ error: "No such grant." }, { status: 404 });
	}

	const row = revoked[0];
	await applyGrantChange(
		identity.email,
		{
			subjectType: row.subject_type as SubjectType,
			subjectId: row.subject_id,
			resourceType: row.resource_type as ResourceType,
			resourceId: row.resource_id,
			permission: row.permission,
		},
		"revoke_access",
	);

	return NextResponse.json({ ok: true });
}

// Makes a change take effect now, and leaves a record of it.
async function applyGrantChange(
	changedBy: string,
	grant: GrantInput,
	action: "grant_access" | "revoke_access",
): Promise<void> {
	// Grants are cached per policy class, so a stale entry holds a reader out
	// of something they were just given for as long as the TTL.
	invalidateAccessCache();

	// A grant naming a group is what puts that group on the probe list. Without
	// this the group is not probed until the next registry poll, so the reader
	// resolves to a class that does not include it and still sees nothing,
	// which reads as the grant not working.
	if (grant.subjectType === "group") {
		try {
			await refreshTrackedGroups();
		} catch (error) {
			console.error(
				"Tracked group refresh after a grant change failed:",
				error,
			);
		}
	}

	void insertLog({
		recordType: "access_policies",
		recordId: `${grant.resourceType}:${grant.resourceId}`,
		action,
		changedBy,
		fieldName: `${grant.subjectType}:${grant.subjectId}`,
		newValue: action === "grant_access" ? grant.permission : null,
	});
}
