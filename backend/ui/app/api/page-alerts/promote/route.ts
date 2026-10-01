import { NextRequest, NextResponse } from "next/server";
import { promote, promoteTargets } from "@/lib/alerts/pageStore";
import { privateJson } from "../../notifications/guard";
import { badBody, failed, pageAlertCaller, readBody } from "../respond";

// Turning a personal alert into an alert on a page the caller may edit.

// The most datasets one request asks about.
const maxSources = 50;

// ?sources=a,b  The pages the caller could put an alert on, per dataset.
export async function GET(request: NextRequest) {
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	const sources = (request.nextUrl.searchParams.get("sources") ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, maxSources);
	try {
		return privateJson({
			targets: await promoteTargets(who.identity, who.policy, sources),
		});
	} catch (error) {
		return failed(error, "list the pages you can add alerts to");
	}
}

// { alertId, pageId }
export async function POST(request: NextRequest) {
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	const body = await readBody(request);
	if (
		!body ||
		typeof body.alertId !== "string" ||
		typeof body.pageId !== "string"
	) {
		return badBody();
	}
	try {
		const alert = await promote(
			who.identity,
			who.policy,
			body.alertId,
			body.pageId,
		);
		return privateJson({ alert });
	} catch (error) {
		return failed(error, "make it a page alert");
	}
}
