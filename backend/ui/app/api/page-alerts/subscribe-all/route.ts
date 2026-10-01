import { NextRequest, NextResponse } from "next/server";
import { subscribeAll } from "@/lib/alerts/pageStore";
import { privateJson } from "../../notifications/guard";
import { badBody, failed, pageAlertCaller, readBody } from "../respond";

// Follows every alert on a page the caller can see.

// { pageId }
export async function POST(request: NextRequest) {
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	const body = await readBody(request);
	if (!body || typeof body.pageId !== "string") return badBody();
	try {
		return privateJson(
			await subscribeAll(who.identity, who.policy, body.pageId),
		);
	} catch (error) {
		return failed(error, "follow the page's alerts");
	}
}
