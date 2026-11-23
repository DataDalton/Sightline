import { createHash } from "node:crypto";
import { sql, transaction } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import type { ReportDetail } from "../platform/reports";
import { editingFacts, maintainersOf } from "../platform/permissionStore";
import { getSource } from "../semantic/registry";
import { readableUpdates } from "../updates/store";
import { mentionedFields } from "./mentions";
import {
	guideFileProblem,
	guideFileType,
	maxGuideFileBytes,
} from "./fileRules";

// A report's guide and everything shown beside it.
//
// The author's part is Markdown kept on the report. The rest is worked out
// each time it is read, so it is never out of date: the definition of every
// field the report uses, where its data comes from and how fresh it is, who
// looks after it, recent updates about its data, and the fields the guide
// talks about that changed since somebody last confirmed it.

export class GuideError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export interface GuideFile {
	fileId: string;
	hash: string;
	fileName: string;
	contentType: string;
	size: number;
	uploadedBy: string;
	uploadedOn: string;
}

export interface GuideDefinition {
	sourceKey: string;
	name: string;
	label: string;
	kind: "dimension" | "measure";
	description: string | null;
}

export interface GuideSource {
	sourceKey: string;
	title: string;
	description: string | null;
	dataChangedOn: string | null;
	checkedOn: string | null;
}

export interface GuideChange {
	updateId: string;
	title: string;
	postedOn: string;
}

export interface GuideView {
	guide: string | null;
	reviewedOn: string | null;
	reviewedBy: string | null;
	// Who last changed the text and when.
	editedOn: string | null;
	editedBy: string | null;
	canEdit: boolean;
	files: GuideFile[];
	definitions: GuideDefinition[];
	sources: GuideSource[];
	maintainers: { kind: "user" | "group"; name: string }[];
	changes: GuideChange[];
	// Fields the guide mentions whose definition, name or presence changed
	// since it was last confirmed.
	changedSince: { field: string; what: string; on: string }[];
}

// How far back the updates listed beside a guide reach.
const changeDays = 90;
const maxChanges = 8;

// The parts of a report a guide reads: its pages, their visuals and the source
// each falls back to.
export type GuideReport = Pick<ReportDetail, "sourceKey" | "pages">;

// The source each visual reads, falling back to its page's and the report's.
function sourceOf(
	report: GuideReport,
	pageSource: string | null,
	visualSource: string | null,
): string | null {
	return visualSource ?? pageSource ?? report.sourceKey ?? null;
}

// Every field the report puts in front of a reader, by source, in the order
// they first appear.
export function fieldsOnReport(
	report: GuideReport,
): Map<string, { measures: string[]; dimensions: string[] }> {
	const bySource = new Map<
		string,
		{ measures: string[]; dimensions: string[] }
	>();
	const add = (
		sourceKey: string | null,
		kind: "measures" | "dimensions",
		name: unknown,
	) => {
		if (!sourceKey || typeof name !== "string" || !name) return;
		const entry = bySource.get(sourceKey) ?? {
			measures: [],
			dimensions: [],
		};
		if (!entry[kind].includes(name)) entry[kind].push(name);
		bySource.set(sourceKey, entry);
	};
	for (const page of report.pages) {
		for (const visual of page.visuals) {
			const key = sourceOf(report, page.sourceKey, visual.sourceKey);
			for (const m of visual.config.measures ?? [])
				add(key, "measures", m);
			for (const d of visual.config.dimensions ?? [])
				add(key, "dimensions", d);
		}
	}
	return bySource;
}

export function definitionsFor(report: GuideReport): GuideDefinition[] {
	const out: GuideDefinition[] = [];
	for (const [sourceKey, fields] of fieldsOnReport(report)) {
		const source = getSource(sourceKey);
		if (!source) continue;
		const byName = new Map(
			[...source.measures, ...source.dimensions].map((f) => [f.name, f]),
		);
		for (const name of [...fields.measures, ...fields.dimensions]) {
			const field = byName.get(name);
			if (!field) continue;
			out.push({
				sourceKey,
				name,
				label: field.displayName ?? name,
				kind: field.kind,
				description: field.description,
			});
		}
	}
	return out;
}

export interface GuideRow {
	guide: string | null;
	reviewedOn: string | null;
	reviewedBy: string | null;
	editedOn: string | null;
	editedBy: string | null;
	// The report's version, read with the text so a save can be made against
	// exactly what was checked.
	version: number;
}

export async function guideRow(reportId: string): Promise<GuideRow | null> {
	const rows = await sql<{
		guide: string | null;
		guide_reviewed_on: string | null;
		guide_reviewed_by: string | null;
		guide_edited_on: string | null;
		guide_edited_by: string | null;
		version: string;
	}>(
		`SELECT guide, guide_reviewed_on::text, guide_reviewed_by,
		        guide_edited_on::text, guide_edited_by, version
		 FROM reports WHERE report_id = $1`,
		[reportId],
	);
	const row = rows[0];
	if (!row) return null;
	return {
		guide: row.guide,
		reviewedOn: row.guide_reviewed_on,
		reviewedBy: row.guide_reviewed_by,
		editedOn: row.guide_edited_on,
		editedBy: row.guide_edited_by,
		version: Number(row.version),
	};
}

export async function listFiles(reportId: string): Promise<GuideFile[]> {
	const rows = await sql<{
		file_id: string;
		hash: string;
		file_name: string;
		content_type: string;
		size: number;
		uploaded_by: string;
		uploaded_on: string;
	}>(
		`SELECT file_id::text, hash, file_name, content_type, size,
		        uploaded_by, uploaded_on::text
		 FROM report_guide_files WHERE report_id = $1
		 ORDER BY file_name`,
		[reportId],
	);
	return rows.map((row) => ({
		fileId: row.file_id,
		hash: row.hash,
		fileName: row.file_name,
		contentType: row.content_type,
		size: Number(row.size),
		uploadedBy: row.uploaded_by,
		uploadedOn: row.uploaded_on,
	}));
}

export async function readGuide(
	report: ReportDetail,
	policy: PolicyClass,
	identity: Identity,
): Promise<GuideView> {
	const row = await guideRow(report.reportId);
	const definitions = definitionsFor(report);
	const sourceKeys = [...fieldsOnReport(report).keys()];

	const [files, sources, facts, updates, changed] = await Promise.all([
		listFiles(report.reportId),
		sql<{
			source_key: string;
			title: string;
			description: string | null;
			data_changed_on: string | null;
			checked_on: string | null;
		}>(
			`SELECT source_key, title, description, data_changed_on::text, checked_on::text
			 FROM data_sources WHERE source_key = ANY($1::text[]) AND is_active`,
			[sourceKeys],
		),
		editingFacts(),
		readableUpdates(policy, identity).catch(() => []),
		row?.guide
			? sql<{ field: string; kind: string; finished_on: string }>(
					`SELECT action->>'field' AS field, kind, finished_on::text
					 FROM upkeep_actions
					 WHERE state = 'done'
					   AND kind IN ('definition', 'rename', 'remove')
					   AND action->>'sourceKey' = ANY($1::text[])
					   AND finished_on > COALESCE($2::timestamptz, 'epoch'::timestamptz)
					 ORDER BY finished_on DESC`,
					[sourceKeys, row.reviewedOn],
				)
			: Promise.resolve([]),
	]);

	const maintainers = maintainersOf(facts, report).map((subject) => ({
		kind:
			subject.subjectType === "group"
				? ("group" as const)
				: ("user" as const),
		name: subject.subjectId,
	}));
	if (maintainers.length === 0 && report.ownerEmail) {
		maintainers.push({ kind: "user", name: report.ownerEmail });
	}

	const since = Date.now() - changeDays * 86_400_000;
	const sourceSet = new Set(sourceKeys);
	const changes = updates
		.filter((update) => new Date(update.postedOn).getTime() >= since)
		.filter((update) =>
			(update.about ?? []).some(
				(item) =>
					(item.kind === "source" && sourceSet.has(item.id)) ||
					(item.kind === "field" &&
						item.sourceKey !== undefined &&
						sourceSet.has(item.sourceKey)) ||
					(item.kind === "report" && item.id === report.reportId),
			),
		)
		.sort(
			(a, b) =>
				new Date(b.postedOn).getTime() - new Date(a.postedOn).getTime(),
		)
		.slice(0, maxChanges)
		.map((update) => ({
			updateId: update.updateId,
			title: update.title,
			postedOn: String(update.postedOn),
		}));

	// Only fields the guide actually names. A change to a field it never
	// mentions leaves it as current as it was.
	const changedSince: GuideView["changedSince"] = [];
	if (row?.guide) {
		const names = [...new Set(changed.map((c) => c.field).filter(Boolean))];
		const mentioned = new Set(mentionedFields(row.guide, names));
		const seen = new Set<string>();
		for (const change of changed) {
			if (!mentioned.has(change.field) || seen.has(change.field))
				continue;
			seen.add(change.field);
			changedSince.push({
				field: change.field,
				what:
					change.kind === "rename"
						? "renamed"
						: change.kind === "remove"
							? "removed"
							: "redefined",
				on: change.finished_on,
			});
		}
	}

	return {
		guide: row?.guide ?? null,
		reviewedOn: row?.reviewedOn ?? null,
		reviewedBy: row?.reviewedBy ?? null,
		editedOn: row?.editedOn ?? null,
		editedBy: row?.editedBy ?? null,
		canEdit: report.editMode === "edit",
		files,
		definitions,
		sources: sources.map((source) => ({
			sourceKey: source.source_key,
			title: source.title,
			description: source.description,
			dataChangedOn: source.data_changed_on,
			checkedOn: source.checked_on,
		})),
		maintainers,
		changes,
		changedSince,
	};
}

// Somebody confirming the guide is current, with or without changing it.
export async function markReviewed(
	reportId: string,
	email: string,
): Promise<void> {
	await sql(
		`UPDATE reports SET guide_reviewed_on = now(), guide_reviewed_by = $2
		 WHERE report_id = $1`,
		[reportId, email],
	);
}

export async function addFile(
	reportId: string,
	email: string,
	file: { bytes: Buffer; fileName: string; contentType: string },
): Promise<GuideFile> {
	const contentType = guideFileType(file.fileName, file.contentType);
	const problem = guideFileProblem({
		size: file.bytes.length,
		type: contentType,
		name: file.fileName,
	});
	if (problem) {
		throw new GuideError(
			problem,
			file.bytes.length > maxGuideFileBytes ? 413 : 415,
		);
	}
	const hash = createHash("sha256").update(file.bytes).digest("hex");
	const fileName =
		file.fileName
			.replace(/[\\/\r\n]/g, "_")
			.trim()
			.slice(0, 200) || "file";
	const type = contentType;

	const fileId = await transaction(async (client) => {
		await client.query(
			`INSERT INTO report_guide_file_data (hash, bytes) VALUES ($1, $2)
			 ON CONFLICT (hash) DO NOTHING`,
			[hash, file.bytes],
		);
		// A file of the same name is replaced, so uploading a new copy of a
		// deck keeps every link to it in the guide working.
		const result = await client.query<{ file_id: string }>(
			`INSERT INTO report_guide_files
			   (report_id, hash, file_name, content_type, size, uploaded_by)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (report_id, file_name) DO UPDATE SET
			   hash = EXCLUDED.hash, content_type = EXCLUDED.content_type,
			   size = EXCLUDED.size, uploaded_by = EXCLUDED.uploaded_by,
			   uploaded_on = now()
			 RETURNING file_id::text`,
			[reportId, hash, fileName, type, file.bytes.length, email],
		);
		await dropUnused(client);
		return result.rows[0].file_id;
	});
	return {
		fileId,
		hash,
		fileName,
		contentType: type,
		size: file.bytes.length,
		uploadedBy: email,
		uploadedOn: new Date().toISOString(),
	};
}

export async function removeFile(
	reportId: string,
	fileId: string,
): Promise<boolean> {
	return await transaction(async (client) => {
		const removed = await client.query(
			`DELETE FROM report_guide_files
			 WHERE report_id = $1 AND file_id::text = $2`,
			[reportId, fileId],
		);
		await dropUnused(client);
		return (removed.rowCount ?? 0) > 0;
	});
}

// Bytes no guide uses any more.
async function dropUnused(client: {
	query: (text: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
	await client.query(
		`DELETE FROM report_guide_file_data d
		 WHERE NOT EXISTS (SELECT 1 FROM report_guide_files f WHERE f.hash = d.hash)`,
	);
}

// One file of a report's guide, by its hash. The caller has already checked
// the reader can open the report.
export async function readFile(
	reportId: string,
	hash: string,
): Promise<{ bytes: Buffer; contentType: string; fileName: string } | null> {
	if (!/^[0-9a-f]{64}$/.test(hash)) return null;
	const rows = await sql<{
		bytes: Buffer;
		content_type: string;
		file_name: string;
	}>(
		`SELECT d.bytes, f.content_type, f.file_name
		 FROM report_guide_files f JOIN report_guide_file_data d ON d.hash = f.hash
		 WHERE f.report_id = $1 AND f.hash = $2
		 LIMIT 1`,
		[reportId, hash],
	);
	const row = rows[0];
	return row
		? {
				bytes: row.bytes,
				contentType: row.content_type,
				fileName: row.file_name,
			}
		: null;
}

// The text of the guide's readable files, for the assistant: Markdown, plain
// text and CSV, each cut short so a large file cannot crowd out the question.
export async function readableFileText(
	reportId: string,
	perFile = 4000,
): Promise<{ fileName: string; text: string }[]> {
	const rows = await sql<{ file_name: string; bytes: Buffer }>(
		`SELECT f.file_name, d.bytes
		 FROM report_guide_files f JOIN report_guide_file_data d ON d.hash = f.hash
		 WHERE f.report_id = $1
		   AND f.content_type IN ('text/markdown', 'text/plain', 'text/csv')
		 ORDER BY f.file_name
		 LIMIT 6`,
		[reportId],
	);
	return rows.map((row) => ({
		fileName: row.file_name,
		text: row.bytes.toString("utf8").slice(0, perFile),
	}));
}
