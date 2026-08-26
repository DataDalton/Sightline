import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { canDo } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	countActiveSources,
	syncAllSources,
	syncSourceMetadata,
} from "@/lib/semantic/ucMetadata";
import {
	syncAllSourceFields,
	syncSourceFields,
} from "@/lib/semantic/fieldSync";
import { loadRegistry } from "@/lib/semantic/registry";
import {
	finishSyncRun,
	latestSyncRun,
	noteSyncProgress,
	startSyncRun,
} from "@/lib/semantic/syncRun";
import { insertLog } from "@/lib/activityLog";
import { checkWriteRateLimit } from "@/lib/rateLimit";

// Refreshes the semantic layer from Unity Catalog.
//
// Two passes, in order. The first registers fields the source publishes that
// the app has never seen, because a measure added to a metric view is
// invisible to every report until it exists here. The second refreshes
// descriptions, data types and tags on the fields that result.
//
// The comments are maintained next to the data, so this keeps the app's
// tooltips in step with the definitions every other consumer of those views
// sees, rather than relying on a copy made at seed time.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const policy = await resolvePolicyClass(identity);
	if (!(await canDo(policy, identity, "semantic.sync"))) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	const body = await request.json().catch(() => ({}));
	const sourceKey = body?.sourceKey ? String(body.sourceKey) : null;

	// Recorded before the work starts, so a page opened a second later can see
	// that a sync is under way rather than an idle button.
	const total = sourceKey ? 1 : await countActiveSources();
	const runId = await startSyncRun(identity.email, total);

	try {
		const fieldResults = sourceKey
			? [await syncSourceFields(identity, sourceKey)]
			: await syncAllSourceFields(identity);

		const results = sourceKey
			? [await syncSourceMetadata(identity, sourceKey)]
			: await syncAllSources(identity, (completed, current) => {
					void noteSyncProgress(runId, completed, current || null);
				});

		// The in-memory registry is rebuilt so the change is visible without
		// waiting out the poll interval, and the row filter walk is redone
		// rather than reused: a sync is what an admin runs after granting the
		// catalogue access that walk needs.
		await loadRegistry(true);

		const totals = results.reduce(
			(acc, r) => ({
				columnsSeen: acc.columnsSeen + r.columnsSeen,
				descriptionsUpdated:
					acc.descriptionsUpdated + r.descriptionsUpdated,
				typesUpdated: acc.typesUpdated + r.typesUpdated,
				tagsUpdated: acc.tagsUpdated + r.tagsUpdated,
			}),
			{
				columnsSeen: 0,
				descriptionsUpdated: 0,
				typesUpdated: 0,
				tagsUpdated: 0,
			},
		);

		const fieldTotals = fieldResults.reduce(
			(acc, r) => ({
				fieldsAdded: acc.fieldsAdded + r.added.length,
				fieldsReclassified:
					acc.fieldsReclassified + r.reclassified.length,
				fieldsMissing: acc.fieldsMissing + r.missing.length,
			}),
			{ fieldsAdded: 0, fieldsReclassified: 0, fieldsMissing: 0 },
		);

		void insertLog({
			recordType: "semantic_layer",
			recordId: sourceKey ?? "all",
			action: "sync_catalog_metadata",
			changedBy: identity.email,
			newValue: JSON.stringify({ ...totals, ...fieldTotals }),
		});

		await finishSyncRun(runId);

		return NextResponse.json({
			results,
			totals: { ...totals, ...fieldTotals },
			fieldResults: fieldResults.filter(
				(r) =>
					r.added.length > 0 ||
					r.reclassified.length > 0 ||
					r.missing.length > 0 ||
					r.error,
			),
		});
	} catch (error) {
		console.error("Catalog metadata sync failed:", error);
		await finishSyncRun(
			runId,
			error instanceof Error
				? error.message.slice(0, 400)
				: "Sync failed",
		);
		return NextResponse.json({ error: "Sync failed" }, { status: 500 });
	}
}

// What the last sync did, so a page that did not start one can still show it.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const policy = await resolvePolicyClass(identity);
	if (!(await canDo(policy, identity, "semantic.sync"))) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	const response = NextResponse.json({ run: await latestSyncRun() });
	response.headers.set("Cache-Control", "no-store");
	return response;
}
