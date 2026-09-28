import { NextRequest, NextResponse } from "next/server";
import { checkAlertNow } from "@/lib/alerts/runner";
import { AlertDefinitionError } from "@/lib/alerts/rule";
import { isUuid } from "@/lib/alerts/store";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { caller, privateJson } from "../../../notifications/guard";

// Checks one alert now, under the caller's own token, and records it like a
// scheduled check.
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	if (!isUuid(id)) return privateJson({ error: "Alert not found" }, 404);

	try {
		const outcome = await checkAlertNow(identity, id);
		if (!outcome) return privateJson({ error: "Alert not found" }, 404);
		return privateJson({
			alert: outcome.record,
			fired: outcome.firings.length,
			error: outcome.error,
		});
	} catch (error) {
		if (error instanceof AlertDefinitionError) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("Alert check failed:", error);
		return privateJson(
			{
				error:
					error instanceof Error
						? error.message
						: "Could not check the alert",
			},
			500,
		);
	}
}
