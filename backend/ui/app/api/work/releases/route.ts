import { NextRequest, NextResponse } from "next/server";
import { postUpdate, UpdateError } from "@/lib/updates/store";
import { listItems } from "@/lib/work/store";
import { listReleases, markShipped, saveRelease } from "@/lib/work/releases";
import { WorkError } from "@/lib/work/access";
import { privateJson, readJson } from "../../notifications/guard";
import { failed, workCaller } from "../shared";

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// Named releases that group requests under one target date.
// POST { id?, name, target, notes } saves one.
// POST { ship: id, postNotes } ships it. With postNotes, its notes are posted to
// Updates as release notes, which resolves every request in it.
export async function GET(request: NextRequest) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	return privateJson({ releases: await listReleases() });
}

export async function POST(request: NextRequest) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		if (typeof body.ship === "string") {
			if (!who.actor.engineer) {
				throw new WorkError("Only the engineers ship releases.", 403);
			}
			const release = (await listReleases()).find(
				(r) => r.id === body.ship,
			);
			if (!release) throw new WorkError("Not found", 404);
			let updateId: string | null = null;
			if (body.postNotes === true) {
				const items = await listItems(who.actor, {
					release: release.id,
				});
				const lines = items
					.map(
						(item) =>
							`<li>${item.key}: ${escapeHtml(item.title)}</li>`,
					)
					.join("");
				// Posting to Updates is its own permission, held by the Updates
				// Publisher role on top of an engineer's own. Without it nothing
				// is shipped, so the release is not marked out with no notes.
				const posted = await postUpdate(who.policy, who.identity, {
					type: "releaseNotes",
					title: release.name,
					body: `${release.notes ? `<p>${escapeHtml(release.notes)}</p>` : ""}<ul>${lines}</ul>`,
					impact: "info",
					reference: `work-release-${release.id}`,
				}).catch((error: unknown) => {
					if (error instanceof UpdateError && error.status === 403) {
						throw new WorkError(
							"Posting release notes to Updates needs the Updates Publisher role. Ship it without notes, or ask an administrator for that role.",
							403,
						);
					}
					throw error;
				});
				updateId = posted.update.updateId;
			}
			await markShipped(who.actor, release.id, updateId);
			return privateJson({ ok: true, updateId });
		}
		const id = await saveRelease(who.actor, {
			id: typeof body.id === "string" ? body.id : null,
			name: String(body.name ?? ""),
			target: typeof body.target === "string" ? body.target : null,
			notes: typeof body.notes === "string" ? body.notes : "",
		});
		return privateJson({ id });
	} catch (error) {
		return failed(error);
	}
}
