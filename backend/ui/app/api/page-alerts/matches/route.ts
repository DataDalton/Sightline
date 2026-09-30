import { NextRequest, NextResponse } from "next/server";
import { findMatches } from "@/lib/alerts/pageStore";
import { privateJson } from "../../notifications/guard";
import { badBody, failed, pageAlertCaller, readBody } from "../respond";

// Page alerts the caller can open that already watch what a new personal
// alert would, so the alert dialog can offer to follow one instead.

// { definition, pageId? }
export async function POST(request: NextRequest) {
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	const body = await readBody(request);
	if (!body) return badBody();
	try {
		return privateJson({
			matches: await findMatches(
				who.identity,
				who.policy,
				body.definition,
				typeof body.pageId === "string" ? body.pageId : null,
			),
		});
	} catch (error) {
		return failed(error, "look for matching page alerts");
	}
}
