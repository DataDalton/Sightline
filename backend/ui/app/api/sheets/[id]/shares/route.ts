import { NextRequest, NextResponse } from "next/server";
import { notify } from "@/lib/notify/store";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { listShares, shareSheet, unshareSheet } from "@/lib/sheets/store";
import { privateJson, readJson } from "../../../notifications/guard";
import { failure, sheetFor, type IdContext } from "../../respond";

// Who a sheet is shared with. Only its owner changes that.

export async function GET(request: NextRequest, { params }: IdContext) {
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	return privateJson({ shares: await listShares(found.sheet.id) });
}

// { email, permission: "edit" | "view" }
export async function POST(request: NextRequest, { params }: IdContext) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const email = typeof body.email === "string" ? body.email : "";
	const permission = body.permission === "edit" ? "edit" : "view";
	try {
		const added = await shareSheet(
			found.identity,
			found.sheet,
			email,
			permission,
		);
		// Told once, when they are first given it. Each of them sees their
		// own rows when they open it, so naming the sheet tells them nothing
		// their access does not already allow.
		// Addressed the way the share row stores it, trimmed and lower
		// case, so the notice reaches the inbox the share opens.
		if (added) {
			void notify(email.trim().toLowerCase(), {
				kind: "share",
				title: `${found.identity.name} shared the sheet ${found.sheet.title} with you`,
				body:
					permission === "edit"
						? "You can change it as well as read it."
						: "You can read it and download it.",
				link: `/sheets/${found.sheet.id}/`,
				data: { sheetId: found.sheet.id, from: found.identity.email },
			}).catch(() => {});
		}
		return privateJson({ shares: await listShares(found.sheet.id) });
	} catch (error) {
		return failure(error, "share the sheet");
	}
}

// { email }
export async function DELETE(request: NextRequest, { params }: IdContext) {
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		await unshareSheet(
			found.identity,
			found.sheet,
			typeof body.email === "string" ? body.email : "",
		);
		return privateJson({ shares: await listShares(found.sheet.id) });
	} catch (error) {
		return failure(error, "change who has the sheet");
	}
}
