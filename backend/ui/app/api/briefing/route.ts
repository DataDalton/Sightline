import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { briefingPlan } from "@/lib/briefing/plan";
import { caller, privateJson } from "../notifications/guard";

// What the home page briefing holds for the caller before any figure is read.
// See lib/briefing/plan.
export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	try {
		const policy = await resolvePolicyClass(identity);
		return privateJson(await briefingPlan(identity, policy));
	} catch (error) {
		console.error("The briefing could not be planned:", error);
		return privateJson(
			{ error: "The briefing could not be put together." },
			500,
		);
	}
}
