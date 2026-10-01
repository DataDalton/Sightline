import { NextRequest, NextResponse } from "next/server";
import { listShares, shareBoard, unshareBoard } from "@/lib/boards/store";
import { notify } from "@/lib/notify/store";
import { privateJson, readJson } from "../../../notifications/guard";
import { boardFor, failure, type IdContext } from "../../respond";

// Who a board is shared with. Only its owner changes that.

export async function GET(request: NextRequest, { params }: IdContext) {
	const found = await boardFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	return privateJson({ shares: await listShares(found.board.id) });
}

// { email, permission: "edit" | "view" }
export async function POST(request: NextRequest, { params }: IdContext) {
	const found = await boardFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const email = typeof body.email === "string" ? body.email : "";
	const permission = body.permission === "edit" ? "edit" : "view";
	try {
		const added = await shareBoard(
			found.identity,
			found.board,
			email,
			permission,
		);
		// Told once, when first given it. Each visual is read under their own
		// access when they open it, so naming the board tells them nothing
		// their access does not already allow.
		if (added) {
			void notify(email.trim().toLowerCase(), {
				kind: "share",
				title: `${found.identity.name} shared the board ${found.board.title} with you`,
				body:
					permission === "edit"
						? "You can arrange it as well as look at it."
						: "You can look at it.",
				link: `/boards/${found.board.id}/`,
				data: { boardId: found.board.id, from: found.identity.email },
			}).catch(() => {});
		}
		return privateJson({ shares: await listShares(found.board.id) });
	} catch (error) {
		return failure(error, "share the board");
	}
}

// { email }
export async function DELETE(request: NextRequest, { params }: IdContext) {
	const found = await boardFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		await unshareBoard(
			found.identity,
			found.board,
			typeof body.email === "string" ? body.email : "",
		);
		return privateJson({ shares: await listShares(found.board.id) });
	} catch (error) {
		return failure(error, "change who has the board");
	}
}
