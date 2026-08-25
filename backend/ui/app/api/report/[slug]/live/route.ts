import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { opsSince } from "@/lib/platform/editing";
import { heartbeat, leave, listPresent } from "@/lib/platform/presence";
import { getReport } from "@/lib/platform/reports";

// The live channel: presence in, changes out.
//
// This is a poll rather than a socket, deliberately. The app runs on several
// replicas behind a proxy with no shared pub/sub, so a socket would only ever
// see the changes that happened to land on its own replica. The op sequence in
// Lakebase is shared by all of them, so polling it is both simpler and
// strictly more correct. A heartbeat rides along on the same request, which
// means presence costs no extra round trip.
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	const { slug } = await params;

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity.email, slug);
		if (!report) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const body = await request.json().catch(() => ({}));
		const sessionId = String(body?.sessionId ?? "");
		if (!sessionId) {
			return NextResponse.json(
				{ error: "sessionId is required" },
				{ status: 400 },
			);
		}

		if (body?.leaving) {
			await leave(report.reportId, sessionId);
			return NextResponse.json({ left: true });
		}

		const afterSeq = Number(body?.afterSeq ?? 0);

		// The heartbeat lands before the roster is read, so a caller always
		// sees itself. Running them together raced and returned a list that
		// omitted the very session that just checked in.
		await heartbeat(
			report.reportId,
			identity.email,
			sessionId,
			body?.state ?? {},
		);

		const [present, ops] = await Promise.all([
			listPresent(report.reportId, sessionId),
			opsSince(report.reportId, afterSeq),
		]);

		const response = NextResponse.json({
			version: report.version,
			present,
			ops,
			// The sequence the caller is now caught up to.
			seq: ops.length > 0 ? ops[ops.length - 1].seq : afterSeq,
		});
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Live channel failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
