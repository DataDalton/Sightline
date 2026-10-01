import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { isUuid } from "@/lib/alerts/store";
import { cleanText, limits } from "@/lib/messages/rules";
import { MessageError, openThread, reply } from "@/lib/messages/store";
import { caller, privateJson, readJson } from "../../notifications/guard";

// One conversation. A conversation the caller is not in reads as not found,
// so an id is no way of learning that one exists.

type Context = { params: Promise<{ id: string }> };

const notFound = () => privateJson({ error: "Conversation not found" }, 404);

export async function GET(request: NextRequest, { params }: Context) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	if (!isUuid(id)) return notFound();
	try {
		const policy = await resolvePolicyClass(identity);
		const opened = await openThread(id, identity.email, policy.grants);
		return opened ? privateJson(opened) : notFound();
	} catch (error) {
		console.error("Conversation could not be opened:", error);
		return privateJson({ error: "Internal error" }, 500);
	}
}

// { body }: a reply.
export async function POST(request: NextRequest, { params }: Context) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	if (!isUuid(id)) return notFound();

	const input = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const body = cleanText(input.body, limits.body);
	if (!body) return privateJson({ error: "Write a reply first." }, 400);

	try {
		const policy = await resolvePolicyClass(identity);
		await reply(id, identity.email, policy.grants, body);
		return privateJson({ sent: true }, 201);
	} catch (error) {
		if (error instanceof MessageError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Reply could not be sent:", error);
		return privateJson({ error: "Internal error" }, 500);
	}
}
