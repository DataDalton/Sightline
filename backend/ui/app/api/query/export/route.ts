import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { parseQuerySpec, QuerySpecError } from "@/lib/query/spec";
import { QueryAccessError } from "@/lib/query/execute";
import { getExportJob, listExportJobs, startExport } from "@/lib/query/export";
import { checkWriteRateLimit } from "@/lib/rateLimit";

// Starting an export, and asking how one is going.
//
// The POST returns as soon as the job is on record rather than when the file
// is ready. A large export takes long enough that holding the request open
// meant a reader who navigated away lost the work, and a proxy timeout could
// discard a finished file nobody ever saw.

// Export is rate limited like a write, not a read. It is the most expensive
// thing a user can ask for and the only one that takes data off the platform.
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

	try {
		const body = await request.json();
		const spec = parseQuerySpec(body?.spec ?? body);

		const job = await startExport(identity, {
			spec,
			format: "csv",
			reportId: body?.reportId ? String(body.reportId) : null,
			pageId: body?.pageId ? String(body.pageId) : null,
			visualId: body?.visualId ? String(body.visualId) : null,
		});

		// Accepted, not done. The body carries where to ask next.
		return NextResponse.json(job, {
			status: 202,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		if (error instanceof QueryAccessError) {
			return NextResponse.json({ error: error.message }, { status: 403 });
		}
		if (error instanceof QuerySpecError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Export could not be started:", error);
		return NextResponse.json(
			{ error: "Export could not be started" },
			{ status: 500 },
		);
	}
}

// With a jobId, how that one is going. Without, what this person has running,
// so a page they have just opened can offer them a file they asked for
// somewhere else.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const jobId = request.nextUrl.searchParams.get("jobId");

	try {
		if (jobId) {
			const job = await getExportJob(identity, jobId);
			if (!job) {
				return NextResponse.json(
					{ error: "Not found" },
					{ status: 404 },
				);
			}
			const response = NextResponse.json(job);
			response.headers.set("Cache-Control", "no-store");
			return response;
		}

		const response = NextResponse.json({
			jobs: await listExportJobs(identity),
		});
		response.headers.set("Cache-Control", "no-store");
		return response;
	} catch (error) {
		console.error("Export status read failed:", error);
		return NextResponse.json(
			{ error: "Could not read the export status" },
			{ status: 500 },
		);
	}
}
