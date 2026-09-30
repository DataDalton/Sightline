import { NextRequest, NextResponse } from "next/server";
import { listSubscriptions } from "@/lib/alerts/pageStore";
import { privateJson } from "../../notifications/guard";
import { failed, pageAlertCaller } from "../respond";

// Every page alert the caller follows, for the inbox's alerts view.
export async function GET(request: NextRequest) {
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	try {
		return privateJson({
			subscriptions: await listSubscriptions(who.identity),
		});
	} catch (error) {
		return failed(error, "list the page alerts you follow");
	}
}
