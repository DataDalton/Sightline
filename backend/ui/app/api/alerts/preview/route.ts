import { NextRequest, NextResponse } from "next/server";
import { previewAlert } from "@/lib/alerts/runner";
import { AlertDefinitionError } from "@/lib/alerts/rule";
import { caller, privateJson, readJson } from "../../notifications/guard";

// The one refusal from the runner worded for the reader.
const tokenRequired = "A user token is required to preview an alert.";

// What an alert would read right now, before it is saved, so the owner can
// pick a threshold against the real figure rather than a guess.
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	try {
		return privateJson(
			await previewAlert(identity, await readJson(request)),
		);
	} catch (error) {
		if (error instanceof AlertDefinitionError) {
			return privateJson({ error: error.message }, 400);
		}
		if (error instanceof Error && error.message === tokenRequired) {
			return privateJson({ error: error.message }, 403);
		}
		// Anything else can be a warehouse error carrying the compiled SQL or
		// schema details, so it is logged rather than returned.
		console.error("Alert preview failed:", error);
		return privateJson({ error: "Could not read the value" }, 500);
	}
}
