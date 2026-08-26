import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	getExportJob,
	readExportChunks,
	releaseExport,
} from "@/lib/query/export";

// Collecting a finished export.
//
// Streamed out of Lakebase in the pieces it was written in. Reading it into one
// string to send it would undo the reason it was written in pieces, and a fifty
// thousand row file is the case this exists for.
export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ jobId: string }> },
) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const { jobId } = await params;

	// Ownership is checked here as well as inside the reader, because a 404 for
	// somebody else's job should not depend on the reader happening to be
	// called.
	const job = await getExportJob(identity, jobId);
	if (!job) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	if (job.status !== "complete") {
		return NextResponse.json(
			{ error: `The export is ${job.status}.`, status: job.status },
			{ status: 409 },
		);
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of readExportChunks(identity, jobId)) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			} catch (error) {
				console.error(`Export ${jobId} could not be read:`, error);
				controller.error(error);
				return;
			}

			// Released once the last chunk is out. A file the reader now holds
			// is not one this table needs to keep, and the sweep would only get
			// to it an hour later.
			void releaseExport(identity, jobId).catch(() => {});
		},
	});

	return new NextResponse(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="${job.filename}"`,
			// The id ties the downloaded file to its audit row.
			"X-Export-Id": job.jobId,
			"X-Export-Rows": String(job.rowCount),
			"X-Export-Truncated": String(job.truncated),
			"Cache-Control": "private, no-store",
		},
	});
}
