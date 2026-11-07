import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { insertLog } from "@/lib/activityLog";
import { sql } from "@/lib/data/lakebase";
import { converse } from "@/lib/assistant/endpoint";
import { parseRebuild, rebuildPrompt } from "@/lib/assistant/rebuild";
import { refusedUnless } from "@/lib/platform/capabilityGuard";
import { applyEdits, EditRejectedError } from "@/lib/platform/editing";
import { createPersonalPage } from "@/lib/platform/personal";
import {
	missingHere,
	PackageError,
	readPackage,
	remapIds,
} from "@/lib/platform/reportPackage";
import { reachableSet } from "@/lib/platform/sources";
import { getSource, listSources } from "@/lib/semantic/registry";
import { caller, privateJson, readJson } from "../notifications/guard";

// Two ways a report arrives from elsewhere: a file exported from another environment, and a
// picture of an old dashboard rebuilt from real fields. Either way it lands as the person's
// own page, and they ask to publish it like anything else they build.

const biggestPictureBytes = 8 * 1024 * 1024;

export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const refused = await refusedUnless(identity, "personal.create");
	if (refused) return refused;

	try {
		const policy = await resolvePolicyClass(identity);

		if (body.action === "picture") {
			const stopped = await refusedUnless(identity, "assistant.use");
			if (stopped) return stopped;
			const sourceKey = String(body.sourceKey ?? "");
			const image = String(body.image ?? "");
			const source = getSource(sourceKey);
			const reachable = await reachableSet(identity);
			if (!source || (reachable && !reachable.has(sourceKey))) {
				return privateJson(
					{ error: "That dataset is not one you can read." },
					403,
				);
			}
			if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(image)) {
				return privateJson({ error: "Choose a picture file." }, 400);
			}
			if (image.length > biggestPictureBytes * 1.4) {
				return privateJson(
					{ error: "That picture is too large." },
					400,
				);
			}
			const fields = {
				dimensions: source.dimensions.map((f) => f.name),
				measures: source.measures.map((f) => f.name),
			};
			const turn = await converse(
				identity.userToken,
				[
					{
						role: "user",
						content: [
							{ type: "text", text: rebuildPrompt(fields) },
							{ type: "image_url", image_url: { url: image } },
						],
					},
				],
				[],
				{},
				3000,
			);
			const { visuals, dropped } = parseRebuild(
				turn.content ?? "",
				fields,
			);
			if (visuals.length === 0) {
				return privateJson(
					{
						error: "Nothing in that picture matched fields on this source.",
					},
					422,
				);
			}
			const made = await createPersonalPage(identity, {
				title:
					String(body.title ?? "").trim() || "Rebuilt from a picture",
				sourceKey,
			});
			const current = await sql<{ version: string }>(
				`SELECT version FROM reports WHERE report_id = $1`,
				[made.reportId],
			);
			await applyEdits(policy, identity.email, {
				reportId: made.reportId,
				baseVersion: Number(current[0]?.version ?? 0),
				operations: visuals.map((visual) => ({
					type: "addVisual" as const,
					visualId: randomUUID(),
					pageId: made.pageId,
					visualType: visual.visualType,
					title: visual.title,
					sourceKey,
					config: {
						dimensions: visual.dimensions,
						measures: visual.measures,
						filters: [],
						sort: [],
						layout: visual.layout,
					},
				})) as never,
			});
			await insertLog({
				recordType: "report",
				recordId: made.reportId,
				action: "rebuild_from_picture",
				changedBy: identity.email,
				newValue: JSON.stringify({ visuals: visuals.length, dropped }),
			});
			return privateJson({
				slug: made.slug,
				built: visuals.length,
				dropped,
			});
		}

		// A report file.
		const pack = readPackage(body.package);
		const known = new Map(
			listSources().map((source) => [
				source.sourceKey,
				{
					dimensions: source.dimensions.map((f) => f.name),
					measures: source.measures.map((f) => f.name),
				},
			]),
		);
		const missing = missingHere(pack, known);
		if (missing.length > 0 && body.anyway !== true) {
			return privateJson({ missing }, 409);
		}

		const made = await createPersonalPage(identity, {
			title: pack.title,
			sourceKey: pack.sourceKey,
		});
		const ids = new Map<string, string>();
		for (const page of pack.pages) {
			for (const visual of page.visuals) {
				ids.set(visual.localId, randomUUID());
			}
		}
		const operations: unknown[] = [];
		pack.pages.forEach((page, index) => {
			const pageId = index === 0 ? made.pageId : randomUUID();
			if (index > 0) {
				operations.push({
					type: "addPage",
					pageId,
					title: page.title,
					slug: `page-${pageId.slice(0, 8)}`,
					sourceKey: page.sourceKey,
				});
			}
			operations.push({
				type: "updatePage",
				pageId,
				title: page.title,
				config: remapIds(page.config, ids),
			});
			for (const visual of page.visuals) {
				operations.push({
					type: "addVisual",
					visualId: ids.get(visual.localId),
					pageId,
					visualType: visual.visualType,
					title: visual.title,
					sourceKey: visual.sourceKey,
					config: {
						...remapIds(visual.config, ids),
						...(visual.layout ? { layout: visual.layout } : {}),
					},
				});
			}
		});
		operations.push({
			type: "updateReport",
			description: pack.description ?? "",
			theme: pack.theme ?? "",
		});
		const current = await sql<{ version: string }>(
			`SELECT version FROM reports WHERE report_id = $1`,
			[made.reportId],
		);
		await applyEdits(policy, identity.email, {
			reportId: made.reportId,
			baseVersion: Number(current[0]?.version ?? 0),
			operations: operations as never,
		});
		await insertLog({
			recordType: "report",
			recordId: made.reportId,
			action: "import_report",
			changedBy: identity.email,
			newValue: pack.title,
		});
		return privateJson({ slug: made.slug, missing });
	} catch (error) {
		if (
			error instanceof PackageError ||
			error instanceof EditRejectedError
		) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("Bringing a report in failed:", error);
		return privateJson({ error: "Could not bring that report in" }, 500);
	}
}
