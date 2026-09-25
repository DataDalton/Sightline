import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { cleanState } from "@/lib/explore/state";
import { deleteView, updateView } from "@/lib/explore/views";

// One saved exploration, renamed, overwritten or deleted by whoever saved it.
// Somebody else's answers exactly as one that does not exist.

type Context = { params: Promise<{ id: string }> };

const notFound = () =>
	NextResponse.json({ error: "Not found" }, { status: 404 });

export async function PUT(request: NextRequest, { params }: Context) {
	await ensureReadyOrDegrade();
	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}
	const { id } = await params;

	let name: string | undefined;
	let state = undefined;
	try {
		const body = await request.json();
		if (typeof body?.name === "string") name = body.name;
		if (body?.state !== undefined) {
			state = cleanState(body.state) ?? undefined;
			if (!state) {
				return NextResponse.json(
					{ error: "That is not something that can be saved" },
					{ status: 400 },
				);
			}
		}
	} catch {
		return NextResponse.json(
			{ error: "Malformed request" },
			{ status: 400 },
		);
	}

	const view = await updateView(identity.email, id, { name, state });
	return view ? NextResponse.json(view) : notFound();
}

export async function DELETE(request: NextRequest, { params }: Context) {
	await ensureReadyOrDegrade();
	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}
	const { id } = await params;
	return (await deleteView(identity.email, id))
		? NextResponse.json({ deleted: true })
		: notFound();
}
