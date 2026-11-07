import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { EditForbiddenError } from "@/lib/platform/editing";
import {
	DeckError,
	listDecks,
	noteProgress,
	offerAgain,
	removeDeck,
	saveDeck,
} from "@/lib/platform/decks";
import { refusedUnless } from "@/lib/platform/capabilityGuard";
import { draftWalkthrough } from "@/lib/platform/deckDraft";
import { getReport } from "@/lib/platform/reports";
import { caller, privateJson, readJson } from "../../../notifications/guard";

// A report's walkthroughs and slides. Anyone who can open the report can go through
// them. Changing one takes the right to edit it. See lib/platform/decks.

type Params = { params: Promise<{ slug: string }> };

export async function GET(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);
		return privateJson(
			await listDecks(
				report.reportId,
				identity.email,
				report.editMode === "edit" || report.canReview,
			),
		);
	} catch (error) {
		console.error("Could not list decks:", error);
		return privateJson({ error: "Could not load these" }, 500);
	}
}

// { action: "save", deckId?, deck }
// { action: "remove", deckId }
// { action: "offerAgain", deckId }
// { action: "progress", deckId, stage }
export async function POST(request: NextRequest, { params }: Params) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const deckId = body.deckId ? String(body.deckId) : null;

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);

		if (body.action === "save") {
			return privateJson({
				deck: await saveDeck(
					policy,
					identity.email,
					report.reportId,
					deckId,
					body.deck,
				),
			});
		}
		if (body.action === "draft") {
			if (report.editMode !== "edit") {
				return privateJson({ error: "Not found" }, 404);
			}
			const refused = await refusedUnless(identity, "assistant.use");
			if (refused) return refused;
			return privateJson({
				steps: await draftWalkthrough(identity.userToken, report),
			});
		}
		if (!deckId) return privateJson({ error: "Which one?" }, 400);

		if (body.action === "remove") {
			await removeDeck(policy, identity.email, report.reportId, deckId);
			return privateJson({ ok: true });
		}
		if (body.action === "offerAgain") {
			return privateJson({
				told: await offerAgain(policy, identity.email, report, deckId),
			});
		}
		if (body.action === "progress") {
			const stage = String(body.stage);
			if (
				stage !== "started" &&
				stage !== "finished" &&
				stage !== "dismissed"
			) {
				return privateJson({ error: "Unknown stage." }, 400);
			}
			await noteProgress(identity.email, report.reportId, deckId, stage);
			return privateJson({ ok: true });
		}
		return privateJson({ error: "Unknown action." }, 400);
	} catch (error) {
		if (error instanceof DeckError) {
			return privateJson({ error: error.message }, error.status);
		}
		if (error instanceof EditForbiddenError) {
			return privateJson({ error: error.message }, 403);
		}
		console.error("A deck request failed:", error);
		return privateJson({ error: "Could not do that" }, 500);
	}
}
