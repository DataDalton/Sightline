import { sql } from "../data/lakebase";
import {
	isCapability,
	isEditPolicy,
	type Capability,
	type EditPolicy,
	type ResolvedAssignment,
	type ScopeType,
	type SubjectType,
} from "./accessRules";
import { cachedDefinition } from "./definitionCache";

// The rights that do not come from an ordinary role assignment: one permission
// given to or taken from one person, labels on people, and the rules that grant a
// role from those labels. Also what is known about who maintains what.
//
// Each list is the same for everybody and held until something changes, so working
// out one person's rights is a lookup rather than a query. Every write here ends
// with invalidateAccessCache in the caller, which drops these on every process.

// Every key a person can be named under, so a grant to any of them reaches them.
function subjectKeys(groups: string[], email: string): string[] {
	const lower = email.toLowerCase();
	return [
		...groups.map((group) => `group|${group.toLowerCase()}`),
		`user|${lower}`,
		`service_principal|${lower}`,
	];
}

// --- One permission, given or taken -------------------------------------------

export interface PermissionGrant {
	grantId: string;
	subjectType: SubjectType;
	subjectId: string;
	capability: Capability;
	effect: "allow" | "deny";
	scopeType: ScopeType;
	scopeId: string | null;
	reason: string | null;
	grantedBy: string | null;
	grantedOn: string;
	expiresOn: string | null;
}

interface GrantRow {
	grant_id: string;
	subject_type: SubjectType;
	subject_id: string;
	capability: string;
	effect: "allow" | "deny";
	scope_type: ScopeType;
	scope_id: string | null;
	reason: string | null;
	granted_by: string | null;
	granted_on: string;
	expires_on: string | null;
}

function toGrant(row: GrantRow): PermissionGrant {
	return {
		grantId: row.grant_id,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		capability: row.capability as Capability,
		effect: row.effect,
		scopeType: row.scope_type,
		scopeId: row.scope_id,
		reason: row.reason,
		grantedBy: row.granted_by,
		grantedOn: row.granted_on,
		expiresOn: row.expires_on,
	};
}

async function grantIndex(): Promise<Map<string, PermissionGrant[]>> {
	return cachedDefinition("access-index:grants", async () => {
		const rows = await sql<GrantRow>(
			`SELECT grant_id::text AS grant_id, subject_type, subject_id, capability,
			        effect, scope_type, scope_id, reason, granted_by, granted_on,
			        expires_on
			 FROM permission_grants
			 WHERE is_active = TRUE`,
		);
		const index = new Map<string, PermissionGrant[]>();
		for (const row of rows) {
			// A capability this build does not know is dropped, so one written by
			// hand cannot quietly become something somebody holds.
			if (!isCapability(row.capability)) continue;
			const key = `${row.subject_type}|${row.subject_id.toLowerCase()}`;
			index.set(key, [...(index.get(key) ?? []), toGrant(row)]);
		}
		return index;
	});
}

// What reaches this person, with anything past its end date left out. Compared
// here because an end date passing changes nothing in the table, so nothing would
// drop the held index.
export async function loadPermissionGrants(
	groups: string[],
	email: string,
): Promise<PermissionGrant[]> {
	const index = await grantIndex();
	const now = Date.now();
	return subjectKeys(groups, email)
		.flatMap((key) => index.get(key) ?? [])
		.filter(
			(grant) =>
				!grant.expiresOn || new Date(grant.expiresOn).getTime() > now,
		);
}

export async function listPermissionGrants(
	subjectId: string,
): Promise<PermissionGrant[]> {
	const rows = await sql<GrantRow>(
		`SELECT grant_id::text AS grant_id, subject_type, subject_id, capability,
		        effect, scope_type, scope_id, reason, granted_by, granted_on,
		        expires_on
		 FROM permission_grants
		 WHERE is_active = TRUE AND lower(subject_id) = lower($1)
		 ORDER BY granted_on DESC`,
		[subjectId],
	);
	return rows.filter((row) => isCapability(row.capability)).map(toGrant);
}

export async function savePermissionGrant(
	input: {
		subjectType: SubjectType;
		subjectId: string;
		capability: Capability;
		effect: "allow" | "deny";
		scopeType: ScopeType;
		scopeId?: string | null;
		reason?: string | null;
		expiresOn?: string | null;
	},
	actor: string,
): Promise<string> {
	const scopeId =
		input.scopeType === "global" ? null : (input.scopeId ?? null);
	if (input.scopeType !== "global" && !scopeId) {
		throw new Error(
			`A ${input.scopeType} permission has to name the ${input.scopeType} it applies to.`,
		);
	}
	const rows = await sql<{ grant_id: string }>(
		`INSERT INTO permission_grants
		   (subject_type, subject_id, capability, effect, scope_type, scope_id,
		    reason, granted_by, expires_on)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING grant_id::text AS grant_id`,
		[
			input.subjectType,
			input.subjectId.trim(),
			input.capability,
			input.effect,
			input.scopeType,
			scopeId,
			input.reason ?? null,
			actor,
			input.expiresOn ?? null,
		],
	);
	return rows[0].grant_id;
}

export async function removePermissionGrant(grantId: string): Promise<boolean> {
	const rows = await sql<{ grant_id: string }>(
		`UPDATE permission_grants SET is_active = FALSE
		 WHERE grant_id = $1 AND is_active = TRUE
		 RETURNING grant_id::text AS grant_id`,
		[grantId],
	);
	return rows.length > 0;
}

// --- Attributes, and the rules that grant from them ---------------------------

export interface SubjectAttribute {
	subjectType: SubjectType;
	subjectId: string;
	attribute: string;
	value: string;
}

export interface AttributeRule {
	ruleId: string;
	attribute: string;
	value: string;
	roleId: string;
	roleName: string;
	scopeType: ScopeType;
	scopeId: string | null;
}

// An attribute is compared without case, so "finance" and "Finance" are one label.
function attributeKey(attribute: string, value: string): string {
	return `${attribute.trim().toLowerCase()}=${value.trim().toLowerCase()}`;
}

interface AttributeState {
	bySubject: Map<string, string[]>;
	byRule: Map<string, ResolvedAssignment[]>;
}

async function attributeState(): Promise<AttributeState> {
	return cachedDefinition("access-index:attributes", async () => {
		const [attributes, rules] = await Promise.all([
			sql<{
				subject_type: string;
				subject_id: string;
				attribute: string;
				value: string;
			}>(
				`SELECT subject_type, subject_id, attribute, value
				 FROM subject_attributes`,
			),
			sql<{
				attribute: string;
				value: string;
				permission: ResolvedAssignment["permission"];
				scope_type: ScopeType;
				scope_id: string | null;
				capabilities: string[] | null;
			}>(
				`SELECT ar.attribute, ar.value, r.permission, ar.scope_type,
				        ar.scope_id,
				        coalesce(
				          array_agg(rc.capability) FILTER (WHERE rc.capability IS NOT NULL),
				          '{}'
				        ) AS capabilities
				 FROM attribute_rules ar
				 JOIN roles r ON r.role_id = ar.role_id AND r.is_active = TRUE
				 LEFT JOIN role_capabilities rc ON rc.role_id = ar.role_id
				 WHERE ar.is_active = TRUE
				 GROUP BY ar.rule_id, ar.attribute, ar.value, r.permission,
				          ar.scope_type, ar.scope_id`,
			),
		]);

		const bySubject = new Map<string, string[]>();
		for (const row of attributes) {
			const key = `${row.subject_type}|${row.subject_id.toLowerCase()}`;
			bySubject.set(key, [
				...(bySubject.get(key) ?? []),
				attributeKey(row.attribute, row.value),
			]);
		}

		const byRule = new Map<string, ResolvedAssignment[]>();
		for (const rule of rules) {
			const key = attributeKey(rule.attribute, rule.value);
			byRule.set(key, [
				...(byRule.get(key) ?? []),
				{
					permission: rule.permission,
					capabilities: (rule.capabilities ?? []).filter(
						isCapability,
					),
					scopeType: rule.scope_type,
					scopeId: rule.scope_id,
				},
			]);
		}
		return { bySubject, byRule };
	});
}

// The roles this person holds because of their labels, or their groups' labels.
export async function loadAttributeAssignments(
	groups: string[],
	email: string,
): Promise<ResolvedAssignment[]> {
	const { bySubject, byRule } = await attributeState();
	if (byRule.size === 0) return [];
	const labels = new Set(
		subjectKeys(groups, email).flatMap((key) => bySubject.get(key) ?? []),
	);
	return [...labels].flatMap((label) => byRule.get(label) ?? []);
}

export async function listAttributes(
	subjectId: string,
): Promise<SubjectAttribute[]> {
	const rows = await sql<{
		subject_type: SubjectType;
		subject_id: string;
		attribute: string;
		value: string;
	}>(
		`SELECT subject_type, subject_id, attribute, value
		 FROM subject_attributes
		 WHERE lower(subject_id) = lower($1)
		 ORDER BY attribute`,
		[subjectId],
	);
	return rows.map((row) => ({
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		attribute: row.attribute,
		value: row.value,
	}));
}

export async function setAttribute(
	input: SubjectAttribute,
	actor: string,
): Promise<void> {
	await sql(
		`INSERT INTO subject_attributes
		   (subject_type, subject_id, attribute, value, set_by)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (subject_type, subject_id, attribute)
		 DO UPDATE SET value = EXCLUDED.value, set_by = EXCLUDED.set_by,
		               set_on = now()`,
		[
			input.subjectType,
			input.subjectId.trim(),
			input.attribute.trim(),
			input.value.trim(),
			actor,
		],
	);
}

export async function removeAttribute(
	subjectType: SubjectType,
	subjectId: string,
	attribute: string,
): Promise<void> {
	await sql(
		`DELETE FROM subject_attributes
		 WHERE subject_type = $1 AND lower(subject_id) = lower($2) AND attribute = $3`,
		[subjectType, subjectId, attribute],
	);
}

export async function listAttributeRules(): Promise<AttributeRule[]> {
	const rows = await sql<{
		rule_id: string;
		attribute: string;
		value: string;
		role_id: string;
		role_name: string;
		scope_type: ScopeType;
		scope_id: string | null;
	}>(
		`SELECT ar.rule_id::text AS rule_id, ar.attribute, ar.value, ar.role_id,
		        r.name AS role_name, ar.scope_type, ar.scope_id
		 FROM attribute_rules ar
		 JOIN roles r ON r.role_id = ar.role_id
		 WHERE ar.is_active = TRUE
		 ORDER BY ar.attribute, ar.value`,
	);
	return rows.map((row) => ({
		ruleId: row.rule_id,
		attribute: row.attribute,
		value: row.value,
		roleId: row.role_id,
		roleName: row.role_name,
		scopeType: row.scope_type,
		scopeId: row.scope_id,
	}));
}

export async function saveAttributeRule(
	input: {
		attribute: string;
		value: string;
		roleId: string;
		scopeType: ScopeType;
		scopeId?: string | null;
	},
	actor: string,
): Promise<string> {
	const scopeId =
		input.scopeType === "global" ? null : (input.scopeId ?? null);
	if (input.scopeType !== "global" && !scopeId) {
		throw new Error(`A rule on a ${input.scopeType} has to name it.`);
	}
	const rows = await sql<{ rule_id: string }>(
		`INSERT INTO attribute_rules
		   (attribute, value, role_id, scope_type, scope_id, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING rule_id::text AS rule_id`,
		[
			input.attribute.trim(),
			input.value.trim(),
			input.roleId,
			input.scopeType,
			scopeId,
			actor,
		],
	);
	return rows[0].rule_id;
}

export async function removeAttributeRule(ruleId: string): Promise<void> {
	await sql(
		`UPDATE attribute_rules SET is_active = FALSE WHERE rule_id = $1`,
		[ruleId],
	);
}

// --- Who maintains what -------------------------------------------------------

interface MaintainerRow {
	scope_type: string;
	scope_id: string;
	subject_type: SubjectType;
	subject_id: string;
	expires_on: string | null;
}

export interface EditingFacts {
	maintainers: Map<string, { subjectType: SubjectType; subjectId: string }[]>;
	categoryPolicy: Map<string, EditPolicy>;
}

// Whoever holds report.review on a report, its category or a tag. Read from the
// ability rather than the role's name, so a custom role that reviews counts too.
export async function editingFacts(): Promise<EditingFacts> {
	return cachedDefinition("access-index:editing", async () => {
		const [rows, categories] = await Promise.all([
			sql<MaintainerRow>(
				`SELECT DISTINCT ra.scope_type, ra.scope_id, ra.subject_type,
				        ra.subject_id, ra.expires_on
				 FROM role_assignments ra
				 JOIN roles r ON r.role_id = ra.role_id AND r.is_active = TRUE
				 JOIN role_capabilities rc ON rc.role_id = ra.role_id
				 WHERE ra.is_active = TRUE
				   AND rc.capability = 'report.review'
				   AND ra.scope_type IN ('report', 'category', 'tag')`,
			),
			sql<{ category_id: string; edit_policy: string | null }>(
				`SELECT category_id, edit_policy FROM categories
				 WHERE edit_policy IS NOT NULL`,
			),
		]);

		const maintainers: EditingFacts["maintainers"] = new Map();
		const now = Date.now();
		for (const row of rows) {
			if (row.expires_on && new Date(row.expires_on).getTime() <= now) {
				continue;
			}
			const key = `${row.scope_type}:${
				row.scope_type === "tag"
					? row.scope_id.toLowerCase()
					: row.scope_id
			}`;
			maintainers.set(key, [
				...(maintainers.get(key) ?? []),
				{ subjectType: row.subject_type, subjectId: row.subject_id },
			]);
		}

		const categoryPolicy: EditingFacts["categoryPolicy"] = new Map();
		for (const row of categories) {
			if (isEditPolicy(row.edit_policy)) {
				categoryPolicy.set(row.category_id, row.edit_policy);
			}
		}
		return { maintainers, categoryPolicy };
	});
}

// Who looks after a report, nearest first: its own, its tags', its category's.
export function maintainersOf(
	facts: EditingFacts,
	report: {
		reportId: string;
		categoryId: string | null;
		tags?: string[] | null;
	},
): { subjectType: SubjectType; subjectId: string }[] {
	const own = facts.maintainers.get(`report:${report.reportId}`) ?? [];
	if (own.length > 0) return own;
	const tagged = (report.tags ?? []).flatMap(
		(tag) => facts.maintainers.get(`tag:${tag.toLowerCase()}`) ?? [],
	);
	if (tagged.length > 0) return tagged;
	return report.categoryId
		? (facts.maintainers.get(`category:${report.categoryId}`) ?? [])
		: [];
}
