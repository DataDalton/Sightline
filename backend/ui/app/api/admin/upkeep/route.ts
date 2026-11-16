import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { canDo } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { sql } from "@/lib/data/lakebase";
import { runUpkeep } from "@/lib/upkeep/runner";

// What the assistant has done on its own about changes to sources, newest
// first, and a way to run its pass now rather than on its next tick. For
// whoever may sync sources. See lib/upkeep.

async function allowed(request: NextRequest) {
	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}
	const policy = await resolvePolicyClass(identity);
	if (!(await canDo(policy, identity, "semantic.sync"))) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	return null;
}

async function listActions() {
	return sql<{
		action_key: string;
		kind: string;
		action: unknown;
		update_id: string | null;
		state: string;
		attempts: number;
		reason: string | null;
		result: unknown;
		created_on: string;
		finished_on: string | null;
		next_try_on: string;
	}>(
		`SELECT action_key, kind, action, update_id::text, state, attempts, reason,
		        result, created_on::text, finished_on::text, next_try_on::text
		 FROM upkeep_actions
		 ORDER BY coalesce(finished_on, created_on) DESC
		 LIMIT 200`,
	);
}

export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();
	const refused = await allowed(request);
	if (refused) return refused;
	return NextResponse.json({ actions: await listActions() });
}

// { run: true } runs one pass now and answers with the actions after it.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();
	const refused = await allowed(request);
	if (refused) return refused;
	await runUpkeep();
	return NextResponse.json({ actions: await listActions() });
}
