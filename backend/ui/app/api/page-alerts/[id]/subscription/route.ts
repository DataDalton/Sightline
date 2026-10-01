import { NextRequest, NextResponse } from "next/server";
import { isMuteChoice } from "@/lib/alerts/pageRules";
import { setSubscription } from "@/lib/alerts/pageStore";
import { privateJson } from "../../../notifications/guard";
import { badBody, failed, pageAlertCaller, readBody } from "../../respond";

// The caller following, leaving or muting one page alert. The alert's own
// schedule and rule are not the caller's to change here.

type Context = { params: Promise<{ id: string }> };

// { subscribed?: boolean, mute?: "off" | "day" | "week" | "forever" }
export async function PUT(request: NextRequest, { params }: Context) {
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	const { id } = await params;
	const body = await readBody(request);
	if (!body) return badBody();
	const subscribed =
		typeof body.subscribed === "boolean" ? body.subscribed : undefined;
	const mute = isMuteChoice(body.mute) ? body.mute : undefined;
	if (subscribed === undefined && mute === undefined) {
		return privateJson(
			{ error: "Say whether to follow it or how long to mute it." },
			400,
		);
	}
	try {
		const alert = await setSubscription(who.identity, who.policy, id, {
			subscribed,
			mute,
		});
		return privateJson({ alert });
	} catch (error) {
		return failed(error, "change the subscription");
	}
}
