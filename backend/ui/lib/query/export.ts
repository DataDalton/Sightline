import { createHash } from "node:crypto";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { insertLog } from "../activityLog";
import { record } from "../telemetry/usage";
import { queryAsUserBatches } from "../data/userSession";
import { sql } from "../data/lakebase";
import { isDatabricksApp } from "../runtime";
import { getSource } from "../semantic/registry";
import { compileQuery } from "./builder";
import { QueryAccessError } from "./execute";
import { QuerySpecError, type QuerySpec } from "./spec";
import { maxExportRows } from "./exportLimits";
import { csvHeader, csvRows } from "./csv";

// Export produces a file of real business data leaving the platform, so it is
// treated as a privileged action rather than a convenience:
//
//   - It bypasses the result cache. A cached page was shaped for display and
//     may be stale; an export must reflect the data at the moment it is taken.
//   - It runs under the caller's own token, so Unity Catalog filters the file
//     exactly as it filters the screen.
//   - Every export writes two records before the bytes are returned: an audit
//     row naming who took what, and a usage event carrying the cost. The audit
//     row is written first, so a crash mid-run still leaves evidence the
//     export was attempted.
//   - Row count is capped. An unbounded export is how a reporting tool becomes
//     an exfiltration tool.
//
// It also runs behind the request rather than inside it. The request records
// what was asked for and returns an id; the work streams rows out of the
// warehouse in batches and writes them to Lakebase as it goes. Nothing ever
// holds the whole file, the reader can leave the page, and the result can be
// collected from a replica that had nothing to do with producing it.

export { maxExportRows } from "./exportLimits";

// Rows per round trip out of the warehouse, and per row written to Lakebase.
// Small enough that a batch is a few hundred kilobytes, large enough that the
// per-statement overhead disappears against the work.
const batchRows = 2000;

// How long a finished file stays collectable. Long enough to survive a reader
// who starts an export and goes to lunch, short enough that the table is not
// an archive of everything ever exported.
const retentionMs = 60 * 60 * 1000;

export type ExportStatus =
	| "queued"
	| "running"
	| "complete"
	| "failed"
	| "expired";

export interface ExportRequest {
	spec: QuerySpec;
	format: "csv";
	// Where the export was triggered from, recorded in the audit trail.
	reportId?: string | null;
	pageId?: string | null;
	visualId?: string | null;
}

export interface ExportJob {
	jobId: string;
	status: ExportStatus;
	filename: string;
	rowCount: number;
	byteCount: number;
	truncated: boolean;
	error: string | null;
	requestedOn: string;
	finishedOn: string | null;
}

function safeFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "export";
}

interface JobRow {
	job_id: string;
	status: string;
	filename: string;
	row_count: number;
	byte_count: string;
	truncated: boolean;
	error: string | null;
	requested_on: string;
	finished_on: string | null;
}

function toJob(row: JobRow): ExportJob {
	return {
		jobId: row.job_id,
		status: row.status as ExportStatus,
		filename: row.filename,
		rowCount: row.row_count,
		byteCount: Number(row.byte_count),
		truncated: row.truncated,
		error: row.error,
		requestedOn: row.requested_on,
		finishedOn: row.finished_on,
	};
}

// Accepts an export and starts it. Returns as soon as the job is on record,
// which is what lets the caller navigate away.
export async function startExport(
	identity: Identity,
	request: ExportRequest,
): Promise<ExportJob> {
	const source = getSource(request.spec.sourceKey);
	if (!source) {
		throw new QuerySpecError(`Unknown source "${request.spec.sourceKey}"`);
	}

	const policy = await resolvePolicyClass(identity);
	if (policy.degraded) {
		throw new QueryAccessError(
			"Access could not be verified, so export is refused.",
		);
	}

	if (!identity.userToken && isDatabricksApp) {
		throw new QueryAccessError("A user token is required to export data.");
	}

	const spec: QuerySpec = {
		...request.spec,
		// One row past the ceiling, so a result that reached it can be reported
		// as cut short rather than silently ending on a round number.
		limit: Math.min(request.spec.limit || maxExportRows, maxExportRows) + 1,
		offset: 0,
	};

	const compiled = compileQuery(source, spec);
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	const filename = `${safeFilename(spec.sourceKey)}-${stamp}.csv`;

	const rows = await sql<{ job_id: string }>(
		`INSERT INTO export_jobs
		   (requested_by, policy_class, source_key, report_id, page_id,
		    visual_id, spec, filename, status, expires_on)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'queued',
		         now() + make_interval(secs => $9))
		 RETURNING job_id`,
		[
			identity.email,
			policy.id,
			spec.sourceKey,
			request.reportId ?? null,
			request.pageId ?? null,
			request.visualId ?? null,
			JSON.stringify(spec),
			filename,
			retentionMs / 1000,
		],
	);

	const jobId = rows[0]?.job_id;
	if (!jobId) throw new Error("Could not record the export.");

	// Before the query runs. If the work then fails or the container recycles,
	// the attempt is still on record, which is the point of an audit trail.
	await insertLog({
		recordType: "export",
		recordId: jobId,
		action: "requested",
		changedBy: identity.email,
		newValue: JSON.stringify({
			sourceKey: spec.sourceKey,
			dimensions: spec.dimensions,
			measures: spec.measures,
			filters: spec.filters,
			sort: spec.sort,
			limit: spec.limit - 1,
			reportId: request.reportId ?? null,
			pageId: request.pageId ?? null,
			policyClass: policy.id,
			// Fingerprint of the exact SQL, so an auditor can prove which query
			// produced a given file without storing the statement itself.
			queryHash: createHash("sha256")
				.update(compiled.sql)
				.digest("hex")
				.slice(0, 16),
		}),
		notes: `${request.format} export from ${spec.sourceKey}`,
	});

	// Deliberately not awaited. The token is captured here because the request
	// that carried it is about to end.
	void runJob(jobId, identity, policy.id, compiled, request).catch(
		(error) => {
			console.error(`Export ${jobId} failed:`, error);
		},
	);

	return {
		jobId,
		status: "queued",
		filename,
		rowCount: 0,
		byteCount: 0,
		truncated: false,
		error: null,
		requestedOn: new Date().toISOString(),
		finishedOn: null,
	};
}

async function runJob(
	jobId: string,
	identity: Identity,
	policyId: string,
	compiled: {
		sql: string;
		params: Record<string, unknown>;
		columns: string[];
	},
	request: ExportRequest,
): Promise<void> {
	const startedAt = Date.now();

	await sql(
		`UPDATE export_jobs
		 SET status = 'running', started_on = now(), progress_on = now()
		 WHERE job_id = $1`,
		[jobId],
	);

	let seq = 0;
	let written = 0;
	let bytes = 0;
	let truncated = false;

	// The header is chunk zero.
	const header = csvHeader(compiled.columns);
	await sql(
		`INSERT INTO export_chunks (job_id, seq, body) VALUES ($1, $2, $3)`,
		[jobId, seq++, header],
	);
	bytes += Buffer.byteLength(header);

	try {
		const limit = maxExportRows;

		const consume = async (batch: Record<string, unknown>[]) => {
			if (written >= limit) {
				truncated = true;
				return;
			}
			// The query asked for one row past the ceiling, so the last batch
			// can carry the row that proves the result was cut short.
			const room = limit - written;
			const usable = batch.length > room ? batch.slice(0, room) : batch;
			if (batch.length > room) truncated = true;

			const body = csvRows(compiled.columns, usable);
			await sql(
				`INSERT INTO export_chunks (job_id, seq, body) VALUES ($1, $2, $3)`,
				[jobId, seq++, body],
			);

			written += usable.length;
			bytes += Buffer.byteLength(body);

			// Progress, so a page watching this can show a count rather than a
			// spinner that means nothing, and so the sweep can tell a slow
			// export from an abandoned one.
			await sql(
				`UPDATE export_jobs
				 SET row_count = $2, byte_count = $3, progress_on = now()
				 WHERE job_id = $1`,
				[jobId, written, bytes],
			);
		};

		if (identity.userToken) {
			await queryAsUserBatches(
				identity.userToken,
				compiled.sql,
				compiled.params,
				batchRows,
				consume,
			);
		} else {
			// Development only. Runs as the local Databricks credentials, so
			// row filtering reflects that identity rather than the caller's.
			const { queryLocally } = await import("../data/localSession");
			const all = await queryLocally(compiled.sql, compiled.params);
			for (let i = 0; i < all.length; i += batchRows) {
				await consume(all.slice(i, i + batchRows));
			}
		}

		await sql(
			`UPDATE export_jobs
			 SET status = 'complete', row_count = $2, byte_count = $3,
			     truncated = $4, finished_on = now()
			 WHERE job_id = $1`,
			[jobId, written, bytes, truncated],
		);

		const durationMs = Date.now() - startedAt;

		// Completion is recorded separately from the request, so an audit shows
		// both what was asked for and what actually left the platform.
		await insertLog({
			recordType: "export",
			recordId: jobId,
			action: "completed",
			changedBy: identity.email,
			newValue: JSON.stringify({
				rowCount: written,
				columns: compiled.columns.length,
				bytes,
				truncated,
			}),
			notes: `${written} rows`,
		});

		record({
			occurredOn: new Date().toISOString(),
			userEmail: identity.email,
			policyClass: policyId,
			eventType: "export",
			sourceKey: request.spec.sourceKey,
			reportId: request.reportId ?? null,
			pageId: request.pageId ?? null,
			visualId: request.visualId ?? null,
			rowCount: written,
			durationMs,
			queryMs: durationMs,
			cacheHit: false,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message.slice(0, 400) : "unknown";

		await sql(
			`UPDATE export_jobs
			 SET status = 'failed', error = $2, finished_on = now()
			 WHERE job_id = $1`,
			[jobId, message],
		);
		// The partial file is not a partial answer, it is a misleading one.
		await sql(`DELETE FROM export_chunks WHERE job_id = $1`, [jobId]);

		await insertLog({
			recordType: "export",
			recordId: jobId,
			action: "failed",
			changedBy: identity.email,
			notes: message,
		});
		record({
			occurredOn: new Date().toISOString(),
			userEmail: identity.email,
			policyClass: policyId,
			eventType: "error",
			sourceKey: request.spec.sourceKey,
			reportId: request.reportId ?? null,
			errorMessage: "export failed",
		});
	}
}

// One job, and only for the person who asked for it. Ownership is checked here
// rather than at the route, so no caller can forget to.
export async function getExportJob(
	identity: Identity,
	jobId: string,
): Promise<ExportJob | null> {
	const rows = await sql<JobRow>(
		`SELECT job_id, status, filename, row_count, byte_count, truncated,
		        error, requested_on, finished_on
		 FROM export_jobs
		 WHERE job_id = $1 AND requested_by = $2`,
		[jobId, identity.email],
	);
	const row = rows[0];
	if (!row) return null;
	return toJob(row);
}

// What this person has going on, so a page can show an export they started
// somewhere else and offer them the file.
export async function listExportJobs(
	identity: Identity,
	limit = 10,
): Promise<ExportJob[]> {
	const rows = await sql<JobRow>(
		`SELECT job_id, status, filename, row_count, byte_count, truncated,
		        error, requested_on, finished_on
		 FROM export_jobs
		 WHERE requested_by = $1 AND expires_on > now()
		 ORDER BY requested_on DESC
		 LIMIT $2`,
		[identity.email, Math.min(Math.max(limit, 1), 50)],
	);
	return rows.map(toJob);
}

// The file, one chunk at a time.
//
// A generator rather than a string: the whole point of writing it in pieces was
// to never hold it whole, and reading it back into one buffer to send it would
// undo that at the last step.
export async function* readExportChunks(
	identity: Identity,
	jobId: string,
): AsyncGenerator<string> {
	const owned = await getExportJob(identity, jobId);
	if (!owned || owned.status !== "complete") return;

	// Paged by sequence rather than held open as a cursor, because a pooled
	// connection kept for the length of a download is a connection no other
	// request can have.
	const pageSize = 8;
	let after = -1;

	for (;;) {
		const rows = await sql<{ seq: number; body: string }>(
			`SELECT seq, body FROM export_chunks
			 WHERE job_id = $1 AND seq > $2
			 ORDER BY seq
			 LIMIT $3`,
			[jobId, after, pageSize],
		);
		if (rows.length === 0) return;
		for (const row of rows) {
			after = row.seq;
			yield row.body;
		}
	}
}

// Marks a collected file as gone, so the table does not hold data somebody
// already has. Called after a successful download.
export async function releaseExport(
	identity: Identity,
	jobId: string,
): Promise<void> {
	await sql(
		`UPDATE export_jobs SET expires_on = now()
		 WHERE job_id = $1 AND requested_by = $2`,
		[jobId, identity.email],
	);
}
