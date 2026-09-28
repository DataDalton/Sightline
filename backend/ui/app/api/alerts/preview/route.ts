import { NextRequest, NextResponse } from "next/server";
import { previewAlert } from "@/lib/alerts/runner";
import { AlertDefinitionError } from "@/lib/alerts/rule";
import { caller, privateJson, readJson } from "../../notifications/guard";

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
		console.error("Alert preview failed:", error);
		return privateJson(
			{
				error:
					error instanceof Error
						? error.message
						: "Could not read the value",
			},
			500,
		);
	}
}
