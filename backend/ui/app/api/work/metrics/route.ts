import { NextRequest, NextResponse } from "next/server";
import { metrics } from "@/lib/work/releases";
import { privateJson } from "../../notifications/guard";
import { failed, workCaller } from "../shared";

// The queue's numbers, for the engineers: throughput, cycle time, time in each
// column, what is open and blocked, and estimates against what work took.
export async function GET(request: NextRequest) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	try {
		const days = Number(request.nextUrl.searchParams.get("days")) || 90;
		return privateJson(
			await metrics(who.actor, Math.min(Math.max(days, 7), 730)),
		);
	} catch (error) {
		return failed(error);
	}
}
