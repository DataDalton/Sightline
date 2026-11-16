import { createHash } from "node:crypto";
import { sql, transaction } from "../data/lakebase";
import { visibleParams, visibleSql, WorkError, type WorkActor } from "./access";
import { recordEvent, visibleRow } from "./store";

// Files attached to a request, such as a screenshot of the wrong figure.
//
// The bytes are kept in Postgres exactly as uploaded, never shrunk or converted,
// in a table of their own so that nothing but the file itself ever reads them.
// A file is keyed by the hash of its bytes: the same file attached twice is
// kept once, and its address never changes, so the browser keeps it for good
// and opening a request again costs neither the app nor the database anything.
// Reading one always checks that the reader can see a request it is attached
// to.

// A ceiling on one file, so a single paste cannot swell the database. It is a
// bound on size, not on how many files anyone attaches.
export const maxBytes = 10 * 1024 * 1024;

const allowedTypes = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
	"text/plain",
	"text/csv",
]);

export interface Attached {
	attachmentId: string;
	hash: string;
	fileName: string;
	contentType: string;
	size: number;
	width: number | null;
	height: number | null;
}

export async function attach(
	actor: WorkActor,
	key: string,
	file: {
		bytes: Buffer;
		fileName: string;
		contentType: string;
		width: number | null;
		height: number | null;
	},
): Promise<Attached> {
	const { row } = await visibleRow(actor, key);
	if (file.bytes.length === 0) throw new WorkError("The file is empty.");
	if (file.bytes.length > maxBytes) {
		throw new WorkError("Files up to 10 MB can be attached.", 413);
	}
	const contentType = file.contentType.split(";")[0].trim().toLowerCase();
	if (!allowedTypes.has(contentType)) {
		throw new WorkError(
			"Images, PDFs and text files can be attached.",
			415,
		);
	}
	const hash = createHash("sha256").update(file.bytes).digest("hex");
	const fileName =
		file.fileName.replace(/[\\/\r\n]/g, "_").slice(0, 200) || "file";
	const dimension = (value: number | null) =>
		value !== null &&
		Number.isInteger(value) &&
		value > 0 &&
		value < 100_000
			? value
			: null;

	const attachmentId = await transaction(async (client) => {
		// Kept once, however many times it is attached.
		await client.query(
			`INSERT INTO work_attachment_data (hash, bytes) VALUES ($1, $2)
			 ON CONFLICT (hash) DO NOTHING`,
			[hash, file.bytes],
		);
		const inserted = await client.query<{ attachment_id: string }>(
			`INSERT INTO work_attachments
			   (item_id, hash, file_name, content_type, size, width, height, uploaded_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING attachment_id::text`,
			[
				row.item_id,
				hash,
				fileName,
				contentType,
				file.bytes.length,
				dimension(file.width),
				dimension(file.height),
				actor.email,
			],
		);
		await recordEvent(
			row.item_id,
			actor.email,
			"attached",
			{ fileName, hash, contentType },
			client,
		);
		return inserted.rows[0].attachment_id;
	});
	return {
		attachmentId,
		hash,
		fileName,
		contentType,
		size: file.bytes.length,
		width: dimension(file.width),
		height: dimension(file.height),
	};
}

// One file, when the reader can see a request it is attached to.
export async function readAttachment(
	actor: WorkActor,
	hash: string,
): Promise<{ bytes: Buffer; contentType: string; fileName: string } | null> {
	if (!/^[0-9a-f]{64}$/.test(hash)) return null;
	// Visible when any request carrying the file is visible to the reader,
	// checked in one query by the same rule the lists use.
	const owners = await sql<{ content_type: string; file_name: string }>(
		`SELECT a.content_type, a.file_name
		 FROM work_attachments a JOIN work_items w ON w.item_id = a.item_id
		 WHERE a.hash = $1 AND ${visibleSql(2)}
		 LIMIT 1`,
		[hash, ...visibleParams(actor)],
	);
	const allowed = owners[0] ?? null;
	if (!allowed) return null;
	const data = await sql<{ bytes: Buffer }>(
		`SELECT bytes FROM work_attachment_data WHERE hash = $1`,
		[hash],
	);
	const row = data[0];
	if (!row) return null;
	return {
		bytes: row.bytes,
		contentType: allowed.content_type,
		fileName: allowed.file_name,
	};
}

// Takes an attachment off a request. The bytes go once nothing uses them.
export async function detach(
	actor: WorkActor,
	key: string,
	attachmentId: string,
): Promise<void> {
	const { row } = await visibleRow(actor, key);
	const rows = await sql<{
		uploaded_by: string;
		hash: string;
		file_name: string;
	}>(
		`SELECT uploaded_by, hash, file_name FROM work_attachments
		 WHERE attachment_id::text = $1 AND item_id = $2`,
		[attachmentId, row.item_id],
	);
	const attachment = rows[0];
	if (!attachment) throw new WorkError("Not found", 404);
	if (attachment.uploaded_by !== actor.email && !actor.engineer) {
		throw new WorkError(
			"Only whoever attached it, or an engineer, removes it.",
			403,
		);
	}
	await transaction(async (client) => {
		await client.query(
			`DELETE FROM work_attachments WHERE attachment_id::text = $1`,
			[attachmentId],
		);
		await client.query(
			`DELETE FROM work_attachment_data d WHERE d.hash = $1
			 AND NOT EXISTS (SELECT 1 FROM work_attachments a WHERE a.hash = d.hash)`,
			[attachment.hash],
		);
		await recordEvent(
			row.item_id,
			actor.email,
			"detached",
			{ fileName: attachment.file_name },
			client,
		);
	});
}
