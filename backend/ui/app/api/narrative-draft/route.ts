import { NextRequest, NextResponse } from "next/server";
import { assistantCaller } from "../assist/guard";
import { AssistantFailed, converse } from "@/lib/assistant/endpoint";
import {
	cleanNarrativeDraft,
	narrativeDraftPrompt,
} from "@/lib/insight/insight";
import { refusedUnless } from "@/lib/platform/capabilityGuard";
import { reachableSet } from "@/lib/platform/sources";
import { getSource } from "@/lib/semantic/registry";
import { privateJson, readJson } from "../notifications/guard";

// A first draft of live text, written by the assistant as the person asking. It is told
// field names and never any data, so what comes back holds placeholders the page fills in.

// { sourceKey, about }
export async function POST(request: NextRequest) {
	const identity = await assistantCaller(request);
	if (identity instanceof NextResponse) return identity;
	const refused = await refusedUnless(identity, "assistant.use");
	if (refused) return refused;

	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const sourceKey = String(body.sourceKey ?? "");
	const source = getSource(sourceKey);
	const reachable = await reachableSet(identity);
	if (!source || (reachable && !reachable.has(sourceKey))) {
		return privateJson({ error: "Not found" }, 404);
	}

	const fields = {
		dimensions: source.dimensions.map((field) => field.name),
		measures: source.measures.map((field) => field.name),
	};
	const prompt = narrativeDraftPrompt({
		sourceTitle: source.title,
		about: String(body.about ?? "").slice(0, 500),
		...fields,
	});
	try {
		const turn = await converse(
			identity.userToken,
			[
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			[],
			{},
			800,
		);
		const html = cleanNarrativeDraft(turn.content ?? "", fields);
		if (!html) {
			return privateJson(
				{ error: "The assistant gave nothing usable. Try again." },
				502,
			);
		}
		return privateJson({ html });
	} catch (error) {
		if (error instanceof AssistantFailed) {
			return privateJson({ error: error.message }, 502);
		}
		console.error("Could not draft live text:", error);
		return privateJson({ error: "Could not draft this" }, 500);
	}
}
