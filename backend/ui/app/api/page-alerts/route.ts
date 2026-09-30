import { NextRequest, NextResponse } from "next/server";
import { createPageAlert, listPageAlerts } from "@/lib/alerts/pageStore";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { privateJson } from "../notifications/guard";
import { badBody, failed, pageAlertCaller, readBody } from "./respond";

// The alerts on one report page. Listing needs the page to open for the
// caller, and adding one needs the report to be editable by them. See
// lib/alerts/pageStore.

// ?pageId=
export async function GET(request: NextRequest) {
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	const pageId = request.nextUrl.searchParams.get("pageId") ?? "";
	try {
		return privateJson(
			await listPageAlerts(who.identity, who.policy, pageId),
		);
	} catch (error) {
		return failed(error, "list the page's alerts");
	}
}

// { pageId, definition }
export async function POST(request: NextRequest) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	const body = await readBody(request);
	if (!body || typeof body.pageId !== "string") return badBody();
	try {
		const alert = await createPageAlert(
			who.identity,
			who.policy,
			body.pageId,
			body.definition,
		);
		return privateJson({ alert });
	} catch (error) {
		return failed(error, "save the alert");
	}
}
