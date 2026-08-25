import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { executeQuery, QueryAccessError } from "@/lib/query/execute";
import { parseQuerySpec, QuerySpecError } from "@/lib/query/spec";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { record } from "@/lib/telemetry/usage";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

// The single endpoint every visual, table and export queries through.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	let spec;
	try {
		spec = parseQuerySpec(await request.json());
	} catch (error) {
		const message =
			error instanceof QuerySpecError ? error.message : "Malformed request";
		return NextResponse.json({ error: message }, { status: 400 });
	}

	try {
		const result = await executeQuery(identity, spec);
		const policy = await resolvePolicyClass(identity);

		record({
			occurredOn: new Date().toISOString(),
			userEmail: identity.email,
			policyClass: policy.id,
			eventType: "query",
			sourceKey: spec.sourceKey,
			durationMs: result.durationMs,
			queryMs: result.queryMs,
			rowCount: result.rowCount,
			cacheHit: result.source !== "warehouse",
			sessionId: request.headers.get("x-session-id"),
		});

		const response = NextResponse.json({
			rows: result.rows,
			columns: result.columns,
			rowCount: result.rowCount,
			meta: {
				source: result.source,
				stale: result.stale,
				computedAt: result.computedAt,
				durationMs: result.durationMs,
			},
		});
		// Results are identity-scoped, so no shared cache may hold them.
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		const isAccess = error instanceof QueryAccessError;
		const isSpec = error instanceof QuerySpecError;

		record({
			occurredOn: new Date().toISOString(),
			userEmail: identity.email,
			policyClass: "unknown",
			eventType: "error",
			sourceKey: spec.sourceKey,
			errorMessage: error instanceof Error ? error.message : "unknown",
		});

		if (isAccess) {
			return NextResponse.json({ error: (error as Error).message }, { status: 403 });
		}
		if (isSpec) {
			return NextResponse.json({ error: (error as Error).message }, { status: 400 });
		}

		// Warehouse errors can carry schema details, so they are logged rather
		// than returned.
		console.error("Query failed:", error);
		return NextResponse.json({ error: "Query failed" }, { status: 500 });
	}
}
