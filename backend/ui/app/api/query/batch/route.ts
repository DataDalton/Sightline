import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { executeQueries } from "@/lib/query/execute";
import { parseQuerySpec, QuerySpecError } from "@/lib/query/spec";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { record } from "@/lib/telemetry/usage";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

// A page's queries, asked together.
//
// Every visual used to post its own request. That is one HTTP round trip, one
// identity resolution, one policy lookup and one shared cache read each, and a
// page carries as many of them as it has visuals. The work was mostly the same
// work repeated: the policy class is a property of the caller rather than of
// the visual, and the cache reads are a set of keys that could have been one
// question.
//
// Asking together changes what a page costs from linear in visuals to constant.
// It does not change what any single query means: the same spec produces the
// same cache key and the same entry whichever endpoint it arrives through, so
// the two can be mixed freely and an old client keeps working.

// The most a single batch may carry.
//
// A page has as many visuals as an author put on it, and this is well above any
// real one. It exists so a malformed or hostile body cannot ask the server to
// hold an unbounded array of results in memory at once.
const maxBatchSize = 50;

export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
	}

	const raw = (body as { queries?: unknown })?.queries;
	if (!Array.isArray(raw)) {
		return NextResponse.json(
			{ error: "Expected a queries array." },
			{ status: 400 },
		);
	}
	if (raw.length === 0) {
		return NextResponse.json({ results: [] });
	}
	if (raw.length > maxBatchSize) {
		return NextResponse.json(
			{ error: `A batch carries at most ${maxBatchSize} queries.` },
			{ status: 400 },
		);
	}

	// Parsed up front, so a malformed spec is reported against its own slot
	// rather than failing the page around it.
	const parsed = raw.map((entry) => {
		try {
			return { spec: parseQuerySpec(entry) };
		} catch (error) {
			return {
				error:
					error instanceof QuerySpecError
						? error.message
						: "Malformed request",
			};
		}
	});

	const runnable = parsed
		.map((entry, index) => ({ entry, index }))
		.filter((held) => held.entry.spec !== undefined);

	try {
		const answers = await executeQueries(
			identity,
			runnable.map((held) => held.entry.spec!),
		);

		type Slot =
			| { error: string }
			| {
					rows: Record<string, unknown>[];
					columns: string[];
					rowCount: number;
					meta: {
						source: string;
						stale: boolean;
						computedAt: number;
						durationMs: number;
					};
			  }
			| null;

		const results: Slot[] = parsed.map((entry) =>
			entry.error ? { error: entry.error } : null,
		);
		runnable.forEach((held, position) => {
			const outcome = answers[position];
			results[held.index] = outcome.error
				? { error: outcome.error }
				: {
						rows: outcome.result!.rows,
						columns: outcome.result!.columns,
						rowCount: outcome.result!.rowCount,
						meta: {
							source: outcome.result!.source,
							stale: outcome.result!.stale,
							computedAt: outcome.result!.computedAt,
							durationMs: outcome.result!.durationMs,
						},
					};
		});

		// Recorded per query rather than per batch, so the usage figures mean
		// the same thing however a page chose to ask.
		const policy = await resolvePolicyClass(identity);
		const sessionId = request.headers.get("x-session-id");
		const occurredOn = new Date().toISOString();
		runnable.forEach((held, position) => {
			const outcome = answers[position];
			if (!outcome.result) return;
			record({
				occurredOn,
				userEmail: identity.email,
				policyClass: policy.id,
				eventType: "query",
				sourceKey: held.entry.spec!.sourceKey,
				durationMs: outcome.result.durationMs,
				queryMs: outcome.result.queryMs,
				rowCount: outcome.result.rowCount,
				cacheHit: outcome.result.source !== "warehouse",
				sessionId,
			});
		});

		const response = NextResponse.json({ results });
		// Identity scoped, so no shared cache may hold them.
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Batch query failed:", error);
		return NextResponse.json({ error: "Query failed" }, { status: 500 });
	}
}
