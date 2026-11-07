import { NextResponse } from "next/server";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { canDo, canDoOnReport, type Capability } from "./access";
import { reportSubject } from "./curated";

// The check in front of the things every reader can do, which an administrator can
// take away from a person or a group. Null means carry on.
//
// With a report named, an exception on that report, its category or a tag counts
// too, so exporting can be switched off for one area alone.
export async function refusedUnless(
	identity: Identity,
	capability: Capability,
	reportId?: string | null,
): Promise<NextResponse | null> {
	const policy = await resolvePolicyClass(identity);
	const subject = reportId ? await reportSubject(reportId) : null;
	const allowed =
		reportId && subject
			? await canDoOnReport(policy, identity, capability, {
					reportId,
					categoryId: subject.category_id,
					tags: subject.tags,
				})
			: await canDo(policy, identity, capability);
	if (allowed) return null;
	return NextResponse.json(
		{ error: "An administrator has turned this off for you." },
		{ status: 403 },
	);
}
