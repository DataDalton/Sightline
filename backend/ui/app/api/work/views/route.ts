import { NextRequest, NextResponse } from "next/server";
import { listViews, removeView, saveView } from "@/lib/work/releases";
import { privateJson, readJson } from "../../notifications/guard";
import { failed, workCaller } from "../shared";

// Saved views of the queue: a person's own, and the ones shared with everybody.
// POST { id?, name, shared, state } saves one, { remove: id } removes one.
export async function GET(request: NextRequest) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	return privateJson({ views: await listViews(who.actor) });
}

export async function POST(request: NextRequest) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		if (typeof body.remove === "string") {
			await removeView(who.actor, body.remove);
			return privateJson({ ok: true });
		}
		const id = await saveView(who.actor, {
			id: typeof body.id === "string" ? body.id : null,
			name: String(body.name ?? ""),
			shared: body.shared === true,
			state: body.state,
		});
		return privateJson({ id });
	} catch (error) {
		return failed(error);
	}
}
