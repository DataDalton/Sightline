import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { insertLog } from "@/lib/activityLog";
import { sql } from "@/lib/data/lakebase";
import {
	cachedDefinition,
	invalidateDefinitions,
} from "@/lib/platform/definitionCache";
import { can, getExplicitContext } from "@/lib/platform/access";
import { refusedUnless } from "@/lib/platform/capabilityGuard";
import { reachableSet } from "@/lib/platform/sources";
import { caller, privateJson, readJson } from "../notifications/guard";

// Notes attached to a value, such as a customer marked as soon to be retired, shown
// wherever that value appears.
//
// A note is only ever read by naming the values already on someone's screen. Listing a
// source's notes would hand a value to somebody whose row filter hides it, and asking
// this way can only confirm what they can already see.

interface NoteRow {
	note_id: string;
	source_key: string;
	field: string;
	value: string;
	body: string;
	author_email: string;
	created_on: string;
	expires_on: string | null;
	replies: { author: string; body: string; at: string }[];
}

// Every live note on one source with its replies. Each page with a visual on the source asks
// about its values, and notes change only through this route, so a source's notes are read
// once and held until one is added, answered or removed. A source carries few notes, so the
// whole set is held and matched against what is on screen here.
const notesKey = (sourceKey: string) => `value-notes:${sourceKey}`;

function notesOn(sourceKey: string): Promise<NoteRow[]> {
	return cachedDefinition(notesKey(sourceKey), () =>
		sql<NoteRow>(
			`SELECT n.note_id::text AS note_id, n.source_key, n.field, n.value, n.body,
			        n.author_email, n.created_on, n.expires_on,
			        COALESCE((
			          SELECT jsonb_agg(jsonb_build_object(
			            'author', r.author_email, 'body', r.body, 'at', r.created_on
			          ) ORDER BY r.created_on)
			          FROM value_note_replies r WHERE r.note_id = n.note_id
			        ), '[]'::jsonb) AS replies
			 FROM value_notes n
			 WHERE n.is_active AND n.source_key = $1
			 ORDER BY n.created_on DESC`,
			[sourceKey],
		),
	);
}

// The notes on the values each lookup names, newest first. A source the caller cannot read
// answers no notes, and a note past its end date is left out.
//
// A source holds few notes and a page shows many values, so the source's notes are read
// first. A source with none answers without looking at what is shown, and otherwise each
// value shown is looked up among its notes.
async function lookupNotes(
	readable: (sourceKey: string) => boolean,
	lookups: Record<string, unknown>[],
): Promise<{ notes: ReturnType<typeof toNote>[] }[]> {
	const now = Date.now();
	return Promise.all(
		lookups.map(async (lookup) => {
			const sourceKey = String(lookup.sourceKey ?? "");
			if (!readable(sourceKey) || !Array.isArray(lookup.shown)) {
				return { notes: [] };
			}
			const live = (await notesOn(sourceKey)).filter(
				(row) =>
					!row.expires_on || new Date(row.expires_on).getTime() > now,
			);
			if (live.length === 0) return { notes: [] };
			const byValue = new Map<string, NoteRow[]>();
			for (const row of live) {
				const key = `${row.field}\u0000${row.value}`;
				byValue.set(key, [...(byValue.get(key) ?? []), row]);
			}
			const found = new Set<NoteRow>();
			for (const item of lookup.shown as {
				field?: unknown;
				value?: unknown;
			}[]) {
				const rows = byValue.get(
					`${String(item?.field)}\u0000${String(item?.value)}`,
				);
				if (rows) for (const row of rows) found.add(row);
			}
			// In the source's order, newest first.
			return { notes: live.filter((row) => found.has(row)).map(toNote) };
		}),
	);
}

function toNote(row: NoteRow) {
	return {
		noteId: row.note_id,
		field: row.field,
		value: row.value,
		body: row.body,
		author: row.author_email,
		createdOn: row.created_on,
		expiresOn: row.expires_on,
		replies: row.replies,
	};
}

export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const action = String(body.action ?? "");

	try {
		const reachable = await reachableSet(identity);
		const readable = (key: string) => !reachable || reachable.has(key);

		// One visual's values as { sourceKey, shown }, or every visual on a page at once
		// as { lookups: [{ sourceKey, shown }] }, answered as { results: [{ notes }] } in
		// the same order.
		if (action === "lookup") {
			const [notes] = await lookupNotes(readable, [body]);
			return privateJson(notes);
		}
		if (action === "lookupMany") {
			const lookups = Array.isArray(body.lookups)
				? (body.lookups as Record<string, unknown>[])
				: [];
			return privateJson({
				results: await lookupNotes(readable, lookups),
			});
		}

		const refused = await refusedUnless(identity, "note.write");
		if (refused) return refused;

		if (action === "add") {
			const sourceKey = String(body.sourceKey ?? "");
			const field = String(body.field ?? "").trim();
			const value = String(body.value ?? "").trim();
			const text = String(body.body ?? "").trim();
			if (!readable(sourceKey)) {
				return privateJson({ error: "Not found" }, 404);
			}
			if (!field || !value || !text) {
				return privateJson(
					{
						error: "A value note needs a field, a value and something to say.",
					},
					400,
				);
			}
			const rows = await sql<{ note_id: string }>(
				`INSERT INTO value_notes
				   (source_key, field, value, body, author_email, expires_on)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 RETURNING note_id::text AS note_id`,
				[
					sourceKey,
					field,
					value,
					text.slice(0, 2000),
					identity.email,
					body.expiresOn ? String(body.expiresOn) : null,
				],
			);
			invalidateDefinitions(notesKey(sourceKey));
			await insertLog({
				recordType: "value_note",
				recordId: rows[0].note_id,
				action: "add_value_note",
				changedBy: identity.email,
			});
			return privateJson({ noteId: rows[0].note_id });
		}

		const noteId = String(body.noteId ?? "");
		const held = await sql<{ source_key: string; author_email: string }>(
			`SELECT source_key, author_email FROM value_notes
			 WHERE note_id = $1 AND is_active`,
			[noteId],
		);
		if (!held[0] || !readable(held[0].source_key)) {
			return privateJson({ error: "Not found" }, 404);
		}

		if (action === "reply") {
			const text = String(body.body ?? "").trim();
			if (!text)
				return privateJson({ error: "Say something first." }, 400);
			await sql(
				`INSERT INTO value_note_replies (note_id, author_email, body)
				 VALUES ($1, $2, $3)`,
				[noteId, identity.email, text.slice(0, 2000)],
			);
			invalidateDefinitions(notesKey(held[0].source_key));
			return privateJson({ ok: true });
		}

		if (action === "remove") {
			const policy = await resolvePolicyClass(identity);
			const context = await getExplicitContext(policy, identity.email);
			const allowed =
				held[0].author_email.toLowerCase() ===
					identity.email.toLowerCase() ||
				can(
					context.capabilities,
					"note.moderate",
					null,
					context.denied,
				);
			if (!allowed) return privateJson({ error: "Not found" }, 404);
			await sql(
				`UPDATE value_notes SET is_active = FALSE WHERE note_id = $1`,
				[noteId],
			);
			invalidateDefinitions(notesKey(held[0].source_key));
			await insertLog({
				recordType: "value_note",
				recordId: noteId,
				action: "remove_value_note",
				changedBy: identity.email,
			});
			return privateJson({ ok: true });
		}

		return privateJson({ error: "Unknown action." }, 400);
	} catch (error) {
		console.error("A value note request failed:", error);
		return privateJson({ error: "Could not do that" }, 500);
	}
}
