import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	BlockError,
	createBlock,
	listBlocks,
	removeBlock,
	updateBlock,
} from "@/lib/platform/blocks";
import { EditRejectedError } from "@/lib/platform/editing";
import { caller, privateJson, readJson } from "../notifications/guard";

// Reusable sets of visuals. See lib/platform/blocks.

function failure(error: unknown) {
	if (error instanceof BlockError) {
		return privateJson({ error: error.message }, error.status);
	}
	if (error instanceof EditRejectedError) {
		return privateJson({ error: error.message }, 400);
	}
	console.error("A block request failed:", error);
	return privateJson({ error: "Could not do that to the block" }, 500);
}

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	try {
		const policy = await resolvePolicyClass(identity);
		return privateJson({ blocks: await listBlocks(policy, identity) });
	} catch (error) {
		return failure(error);
	}
}

// { action: "create", name, description?, visuals }
// { action: "update", blockId, name?, visuals }
// { action: "remove", blockId }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		const policy = await resolvePolicyClass(identity);
		const blockId = String(body.blockId ?? "");
		if (body.action === "create") {
			return privateJson({
				block: await createBlock(policy, identity, {
					name: body.name,
					description: body.description,
					visuals: body.visuals,
				}),
			});
		}
		if (body.action === "update") {
			return privateJson(
				await updateBlock(policy, identity, blockId, {
					name: body.name,
					visuals: body.visuals,
				}),
			);
		}
		if (body.action === "remove") {
			await removeBlock(policy, identity, blockId);
			return privateJson({ ok: true });
		}
		return privateJson({ error: "Unknown action." }, 400);
	} catch (error) {
		return failure(error);
	}
}
