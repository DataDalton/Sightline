import { sql } from "../data/lakebase";
import { maxNoteLength, type VisualNote } from "./noteTypes";

// Re-exported so a server caller reads one module rather than two.
export { maxNoteLength };
export type { VisualNote };

// Commentary pinned to a visual.
//
// "The dip in March was the system migration" is the context that makes a
// figure readable, and it lived in email. So the same question came back every
// quarter, and whoever answered it last was rarely the person being asked the
// next time.
//
// Attached to the visual rather than to the report, because that is the grain
// the question is actually asked at, and carrying an optional date so a note
// about one point on a line can say which point.

// Every note on a page, in one query.
//
// A page at a time rather than a visual at a time: a reader opens a page with
// eight visuals on it, and eight requests for a handful of rows each is eight
// round trips for something one covers.
export async function listPageNotes(pageId: string): Promise<VisualNote[]> {
	const rows = await sql<{
		note_id: string;
		visual_id: string;
		author_email: string;
		body: string;
		anchored_on: string | null;
		created_on: string;
	}>(
		`SELECT note_id::text, visual_id::text, author_email, body,
		        anchored_on::text, created_on::text
		 FROM visual_notes
		 WHERE page_id = $1
		 ORDER BY created_on`,
		[pageId],
	);

	return rows.map((row) => ({
		noteId: row.note_id,
		visualId: row.visual_id,
		authorEmail: row.author_email,
		body: row.body,
		anchoredOn: row.anchored_on,
		createdOn: row.created_on,
	}));
}

export async function addNote(input: {
	reportId: string;
	pageId: string;
	visualId: string;
	authorEmail: string;
	body: string;
	anchoredOn: string | null;
}): Promise<VisualNote | null> {
	const body = input.body.trim();
	if (body === "" || body.length > maxNoteLength) return null;

	const rows = await sql<{
		note_id: string;
		created_on: string;
	}>(
		`INSERT INTO visual_notes
		   (report_id, page_id, visual_id, author_email, body, anchored_on)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING note_id::text, created_on::text`,
		[
			input.reportId,
			input.pageId,
			input.visualId,
			input.authorEmail.toLowerCase(),
			body,
			input.anchoredOn,
		],
	);

	const created = rows[0];
	if (!created) return null;

	return {
		noteId: created.note_id,
		visualId: input.visualId,
		authorEmail: input.authorEmail.toLowerCase(),
		body,
		anchoredOn: input.anchoredOn,
		createdOn: created.created_on,
	};
}

// Removes a note, and says whether there was one to remove.
//
// The author is part of the condition rather than checked beforehand, so two
// people deleting at once cannot both be told they succeeded. Whoever may
// delete somebody else's note is the caller's decision, passed in as a flag
// rather than worked out here: this module has no view of the access model.
export async function removeNote(
	noteId: string,
	requesterEmail: string,
	canRemoveAny: boolean,
): Promise<boolean> {
	const rows = canRemoveAny
		? await sql<{ note_id: string }>(
				`DELETE FROM visual_notes WHERE note_id = $1
				 RETURNING note_id::text`,
				[noteId],
			)
		: await sql<{ note_id: string }>(
				`DELETE FROM visual_notes
				 WHERE note_id = $1 AND author_email = $2
				 RETURNING note_id::text`,
				[noteId, requesterEmail.toLowerCase()],
			);

	return rows.length > 0;
}

// Which report a note belongs to, so the caller can check access against it
// before touching it.
export async function noteReport(noteId: string): Promise<string | null> {
	const rows = await sql<{ report_id: string }>(
		`SELECT report_id::text FROM visual_notes WHERE note_id = $1`,
		[noteId],
	);
	return rows[0]?.report_id ?? null;
}
