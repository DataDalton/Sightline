import { createHash, randomUUID } from "node:crypto";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { insertLog } from "../activityLog";
import { record } from "../telemetry/usage";
import { queryAsUser } from "../data/userSession";
import { isDatabricksApp } from "../runtime";
import { getSource } from "../semantic/registry";
import { compileQuery } from "./builder";
import { QueryAccessError } from "./execute";
import { QuerySpecError, type QuerySpec } from "./spec";

// Export produces a file of real business data leaving the platform, so it is
// treated as a privileged action rather than a convenience:
//
//   - It bypasses the result cache. A cached page was shaped for display and
//     may be stale; an export must reflect the data at the moment it is taken.
//   - It runs under the caller's own token, so Unity Catalog filters the file
//     exactly as it filters the screen.
//   - Every export writes two records before the bytes are returned: an audit
//     row naming who took what, and a usage event carrying the cost. The audit
//     row is written first, so a crash mid-stream still leaves evidence the
//     export was attempted.
//   - Row count is capped. An unbounded export is how a reporting tool becomes
//     an exfiltration tool.

export const maxExportRows = 100000;

export interface ExportRequest {
	spec: QuerySpec;
	format: "csv";
	// Where the export was triggered from, recorded in the audit trail.
	reportId?: string | null;
	pageId?: string | null;
	visualId?: string | null;
}

export interface ExportResult {
	filename: string;
	content: string;
	rowCount: number;
	// Stable id shared by the audit row and the usage event, so the two can be
	// correlated when reviewing who exported what.
	exportId: string;
}

// RFC 4180 escaping. A cell containing a delimiter, quote or newline is
// quoted, and embedded quotes are doubled.
function escapeCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	const text = typeof value === "string" ? value : String(value);
	if (/[",\r\n]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

function buildCsv(
	columns: string[],
	rows: Record<string, unknown>[],
): string {
	const lines = [columns.map(escapeCell).join(",")];
	for (const row of rows) {
		lines.push(columns.map((c) => escapeCell(row[c])).join(","));
	}
	// A UTF-8 BOM so Excel opens non-ASCII names correctly.
	return "﻿" + lines.join("\r\n");
}

function safeFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "export";
}

export async function runExport(
	identity: Identity,
	request: ExportRequest,
): Promise<ExportResult> {
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

	const spec: QuerySpec = {
		...request.spec,
		limit: Math.min(request.spec.limit || maxExportRows, maxExportRows),
		offset: 0,
	};

	const compiled = compileQuery(source, spec);
	const exportId = randomUUID();
	const startedAt = Date.now();

	// The audit row goes in before the query runs. If the export then fails or
	// the process dies, the attempt is still on record, which is the point of
	// an audit trail.
	const descriptor = {
		sourceKey: spec.sourceKey,
		dimensions: spec.dimensions,
		measures: spec.measures,
		filters: spec.filters,
		sort: spec.sort,
		limit: spec.limit,
		reportId: request.reportId ?? null,
		pageId: request.pageId ?? null,
		policyClass: policy.id,
		// Fingerprint of the exact SQL, so an auditor can prove which query
		// produced a given file without storing the statement itself.
		queryHash: createHash("sha256").update(compiled.sql).digest("hex").slice(0, 16),
	};

	await insertLog({
		recordType: "export",
		recordId: exportId,
		action: "requested",
		changedBy: identity.email,
		newValue: JSON.stringify(descriptor),
		notes: `${request.format} export from ${spec.sourceKey}`,
	});

	let rows: Record<string, unknown>[];
	try {
		if (identity.userToken) {
			rows = await queryAsUser(identity.userToken, compiled.sql, compiled.params);
		} else if (!isDatabricksApp) {
			const { queryLocally } = await import("../data/localSession");
			rows = await queryLocally(compiled.sql, compiled.params);
		} else {
			throw new QueryAccessError(
				"A user token is required to export data.",
			);
		}
	} catch (error) {
		await insertLog({
			recordType: "export",
			recordId: exportId,
			action: "failed",
			changedBy: identity.email,
			notes: error instanceof Error ? error.message.slice(0, 400) : "unknown",
		});
		record({
			occurredOn: new Date().toISOString(),
			userEmail: identity.email,
			policyClass: policy.id,
			eventType: "error",
			sourceKey: spec.sourceKey,
			reportId: request.reportId ?? null,
			errorMessage: "export failed",
		});
		throw error;
	}

	const content = buildCsv(compiled.columns, rows);
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	const filename = `${safeFilename(spec.sourceKey)}-${stamp}.csv`;
	const durationMs = Date.now() - startedAt;

	// Completion is recorded separately from the request, so an audit shows
	// both what was asked for and what actually left the platform.
	await insertLog({
		recordType: "export",
		recordId: exportId,
		action: "completed",
		changedBy: identity.email,
		newValue: JSON.stringify({
			rowCount: rows.length,
			columns: compiled.columns.length,
			bytes: content.length,
			filename,
			truncated: rows.length >= spec.limit,
		}),
		notes: filename,
	});

	record({
		occurredOn: new Date().toISOString(),
		userEmail: identity.email,
		policyClass: policy.id,
		eventType: "export",
		sourceKey: spec.sourceKey,
		reportId: request.reportId ?? null,
		pageId: request.pageId ?? null,
		visualId: request.visualId ?? null,
		rowCount: rows.length,
		durationMs,
		queryMs: durationMs,
		cacheHit: false,
	});

	return { filename, content, rowCount: rows.length, exportId };
}
