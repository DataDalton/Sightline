import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { insertLog } from "@/lib/activityLog";
import { sql } from "@/lib/data/lakebase";
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

export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const action = String(body.action ?? "");

	try {
		const reachable = await reachableSet(identity);
		const readable = (key: string) => !reachable || reachable.has(key);

		if (action === "lookup") {
			const sourceKey = String(body.sourceKey ?? "");
			if (!readable(sourceKey)) return privateJson({ notes: [] });
			const shown = Array.isArray(body.shown)
				? (body.shown as { field?: unknown; value?: unknown }[])
				: [];
			const fields = shown.map((item) => String(item.field));
			const values = shown.map((item) => String(item.value));
			if (fields.length === 0) return privateJson({ notes: [] });
			const rows = await sql<NoteRow>(
				`SELECT n.note_id::text AS note_id, n.source_key, n.field, n.value, n.body,
				        n.author_email, n.created_on, n.expires_on,
				        COALESCE((
				          SELECT jsonb_agg(jsonb_build_object(
				            'author', r.author_email, 'body', r.body, 'at', r.created_on
				          ) ORDER BY r.created_on)
				          FROM value_note_replies r WHERE r.note_id = n.note_id
				        ), '[]'::jsonb) AS replies
				 FROM value_notes n
				 JOIN unnest($2::text[], $3::text[]) AS asked(field, value)
				   ON asked.field = n.field AND asked.value = n.value
				 WHERE n.is_active AND n.source_key = $1
				   AND (n.expires_on IS NULL OR n.expires_on > now())
				 ORDER BY n.created_on DESC`,
				[sourceKey, fields, values],
			);
			return privateJson({
				notes: rows.map((row) => ({
					noteId: row.note_id,
					field: row.field,
					value: row.value,
					body: row.body,
					author: row.author_email,
					createdOn: row.created_on,
					expiresOn: row.expires_on,
					replies: row.replies,
				})),
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
