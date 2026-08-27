import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { getTrackedGroups, policyCacheStats } from "@/lib/auth/policy";
import { userSessionStats } from "@/lib/data/userSession";
import { cacheStats } from "@/lib/query/cache";
import { telemetryStats } from "@/lib/telemetry/usage";
import { listSources, registryLoadedAt } from "@/lib/semantic/registry";
import { settingsLoadedAt } from "@/lib/settings";
import {
	bootstrapLastError,
	bootstrapReadyAt,
	ensureReadyOrDegrade,
} from "@/lib/platform/bootstrap";
import { schemaStatus } from "@/lib/platform/schema";
import { rollupState } from "@/lib/telemetry/rollup";

// Operational health of one replica. Each replica reports its own counters,
// since caches and pools are per-process.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const response = NextResponse.json({
		policyCache: policyCacheStats(),
		// The exact group names probed, so a mismatch is visible rather than
		// silently resolving everyone to an empty class.
		trackedGroups: getTrackedGroups(),
		warehouseSessions: userSessionStats(),
		resultCache: cacheStats(),
		telemetry: telemetryStats(),
		registry: {
			loadedAt: registryLoadedAt() || null,
			sourceCount: listSources().length,
		},
		settingsLoadedAt: settingsLoadedAt() || null,
		// Whether this replica finished starting, and what stopped it if not.
		// A replica that is serving an empty navigation because its schema is
		// half applied reads identically to one with nothing to show, and this
		// is the difference.
		bootstrap: {
			readyAt: bootstrapReadyAt() || null,
			lastError: bootstrapLastError(),
		},
		schema: schemaStatus(),
		// How current the aggregates the administration screens read are.
		usageRollup: await rollupState(),
	});
	response.headers.set("Cache-Control", "no-store");
	return response;
}
