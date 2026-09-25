import { NextRequest, NextResponse } from "next/server";
import {
	getProfile,
	maxInstructions,
	saveProfile,
	type Memory,
} from "@/lib/assistant/store";
import { assistantCaller } from "../guard";

// How the caller wants the assistant to work with them: their own standing
// instructions, and the things they asked it to remember.

export async function GET(request: NextRequest) {
	const caller = await assistantCaller(request);
	if (caller instanceof NextResponse) return caller;
	const response = NextResponse.json(await getProfile(caller.email));
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export async function PUT(request: NextRequest) {
	const caller = await assistantCaller(request);
	if (caller instanceof NextResponse) return caller;

	let instructions = "";
	let memories: Memory[] = [];
	try {
		const body = await request.json();
		instructions = String(body?.instructions ?? "");
		memories = (Array.isArray(body?.memories) ? body.memories : [])
			.filter(
				(m: unknown): m is Memory =>
					Boolean(m) &&
					typeof m === "object" &&
					typeof (m as Memory).id === "string" &&
					typeof (m as Memory).text === "string" &&
					(m as Memory).text.trim().length > 0,
			)
			.map((m: Memory) => ({
				id: m.id,
				text: m.text,
				createdOn: typeof m.createdOn === "string" ? m.createdOn : "",
			}));
	} catch {
		return NextResponse.json(
			{ error: "Malformed request" },
			{ status: 400 },
		);
	}

	if (instructions.length > maxInstructions) {
		return NextResponse.json(
			{ error: `Keep instructions under ${maxInstructions} characters` },
			{ status: 400 },
		);
	}

	return NextResponse.json(
		await saveProfile(caller.email, { instructions, memories }),
	);
}
