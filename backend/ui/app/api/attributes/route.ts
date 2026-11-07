import { NextRequest, NextResponse } from "next/server";
import { insertLog } from "@/lib/activityLog";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	canDo,
	invalidateAccessCache,
	type SubjectType,
} from "@/lib/platform/access";
import {
	listAttributes,
	removeAttribute,
	setAttribute,
} from "@/lib/platform/permissionStore";
import { caller, privateJson, readJson } from "../notifications/guard";

// Labels on people and groups, such as Department = Finance, for an automation to keep in
// step with wherever those facts live. Rules then grant rights from them. Takes the same
// right as setting one by hand, and every change is logged.

const subjectTypes: SubjectType[] = ["user", "group", "service_principal"];

async function allowed(identity: Parameters<typeof canDo>[1]) {
	const policy = await resolvePolicyClass(identity);
	return canDo(policy, identity, "access.grant");
}

function subjectOf(raw: Record<string, unknown>) {
	const subjectType = String(raw.subjectType ?? "user") as SubjectType;
	const subjectId = String(raw.subjectId ?? "").trim();
	if (!subjectTypes.includes(subjectType) || !subjectId) return null;
	return { subjectType, subjectId };
}

// ?subjectType=user&subjectId=person@example.com
export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	if (!(await allowed(identity))) {
		return privateJson({ error: "Not found" }, 404);
	}
	const params = request.nextUrl.searchParams;
	const subject = subjectOf({
		subjectType: params.get("subjectType") ?? "user",
		subjectId: params.get("subjectId"),
	});
	if (!subject) {
		return privateJson({ error: "Say whose labels." }, 400);
	}
	return privateJson({ attributes: await listAttributes(subject.subjectId) });
}

// { subjectType, subjectId, attribute, value }, or { items: [the same, one for each] }.
// Each is checked first, so a bad one in a batch changes nothing.
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	if (!(await allowed(identity))) {
		return privateJson({ error: "Not found" }, 404);
	}
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const raw = Array.isArray(body.items) ? body.items : [body];
	const items = raw.map((item) => {
		const held = (item ?? {}) as Record<string, unknown>;
		const subject = subjectOf(held);
		const attribute = String(held.attribute ?? "").trim();
		const value = String(held.value ?? "").trim();
		return subject && attribute && value
			? { ...subject, attribute, value }
			: null;
	});
	if (items.length === 0 || items.some((item) => !item)) {
		return privateJson(
			{
				error: "Each one needs subjectId, attribute and value, and subjectType if it is not a person.",
			},
			400,
		);
	}
	try {
		for (const item of items) {
			if (!item) continue;
			await setAttribute(item, identity.email);
			await insertLog({
				recordType: "subject_attribute",
				recordId: `${item.subjectType}:${item.subjectId}`,
				action: "set_attribute",
				changedBy: identity.email,
				newValue: JSON.stringify(item),
			});
		}
		invalidateAccessCache();
		return privateJson({ saved: items.length });
	} catch (error) {
		console.error("Could not save labels:", error);
		return privateJson({ error: "Could not save those" }, 500);
	}
}

// { subjectType, subjectId, attribute }
export async function DELETE(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	if (!(await allowed(identity))) {
		return privateJson({ error: "Not found" }, 404);
	}
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const subject = subjectOf(body);
	const attribute = String(body.attribute ?? "").trim();
	if (!subject || !attribute) {
		return privateJson({ error: "Whose label, and which one?" }, 400);
	}
	await removeAttribute(subject.subjectType, subject.subjectId, attribute);
	await insertLog({
		recordType: "subject_attribute",
		recordId: `${subject.subjectType}:${subject.subjectId}`,
		action: "remove_attribute",
		changedBy: identity.email,
		newValue: attribute,
	});
	invalidateAccessCache();
	return privateJson({ ok: true });
}
