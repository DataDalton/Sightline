"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import styles from "./ValueNotes.module.css";

// Notes on values showing in a visual, under it, with the thread each one started. Asked
// for by naming what is on screen, so a note can only reach someone already looking at
// the value. See app/api/value-notes.

interface ValueNote {
	noteId: string;
	field: string;
	value: string;
	body: string;
	author: string;
	expiresOn: string | null;
	replies: { author: string; body: string; at: string }[];
}

async function post(body: Record<string, unknown>) {
	const response = await fetch("/api/value-notes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const detail = await response.json().catch(() => null);
	if (!response.ok) throw new Error(detail?.error ?? "That did not work.");
	return detail;
}

// Each field and value shown, once.
export function shownValues(
	rows: Record<string, unknown>[],
	dimensions: string[],
): { field: string; value: string }[] {
	const seen = new Map<string, { field: string; value: string }>();
	for (const row of rows) {
		for (const field of dimensions) {
			const value = row[field];
			if (value === null || value === undefined || value === "") continue;
			seen.set(`${field}\u0000${String(value)}`, {
				field,
				value: String(value),
			});
		}
	}
	return [...seen.values()];
}

// Values a page is filtered to, which a tile shows through having no rows of its own.
export function filteredValues(
	filters: unknown[] | undefined,
): { field: string; value: string }[] {
	const out: { field: string; value: string }[] = [];
	for (const filter of filters ?? []) {
		const clause = (filter ?? {}) as Record<string, unknown>;
		if (clause.op !== "eq" && clause.op !== "in") continue;
		if (typeof clause.field !== "string") continue;
		const values = Array.isArray(clause.values)
			? clause.values
			: [clause.value];
		for (const value of values) {
			if (value === null || value === undefined || value === "") continue;
			out.push({ field: clause.field, value: String(value) });
		}
	}
	return out;
}

function Thread({
	note,
	onChanged,
}: {
	note: ValueNote;
	onChanged: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [reply, setReply] = useState("");
	const [failure, setFailure] = useState<string | null>(null);
	const act = async (body: Record<string, unknown>) => {
		setFailure(null);
		try {
			await post({ noteId: note.noteId, ...body });
			setReply("");
			onChanged();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
		}
	};
	return (
		<div className={styles.note}>
			<button
				type="button"
				className={styles.noteLine}
				aria-expanded={open}
				onClick={() => setOpen((held) => !held)}
			>
				<strong>{note.value}</strong>: {note.body}
				{note.replies.length > 0 && (
					<span className={styles.count}>
						{note.replies.length} repl
						{note.replies.length === 1 ? "y" : "ies"}
					</span>
				)}
			</button>
			{open && (
				<div className={styles.thread}>
					<p className={styles.meta}>
						{note.field}, from {note.author}
						{note.expiresOn
							? `, until ${new Date(note.expiresOn).toLocaleDateString()}`
							: ""}
					</p>
					{note.replies.map((held, index) => (
						<p key={index} className={styles.reply}>
							<strong>{held.author}</strong> {held.body}
						</p>
					))}
					<div className={styles.replyRow}>
						<input
							className={styles.input}
							value={reply}
							placeholder="Reply"
							aria-label={`Reply about ${note.value}`}
							onChange={(e) => setReply(e.target.value)}
						/>
						<button
							type="button"
							className={styles.button}
							disabled={!reply.trim()}
							onClick={() =>
								void act({ action: "reply", body: reply })
							}
						>
							Reply
						</button>
						<button
							type="button"
							className={styles.button}
							onClick={() => void act({ action: "remove" })}
						>
							Remove
						</button>
					</div>
					{failure && <p className={styles.failure}>{failure}</p>}
				</div>
			)}
		</div>
	);
}

export function ValueNotesStrip({
	sourceKey,
	dimensions,
	rows,
	filters,
}: {
	sourceKey: string | null | undefined;
	dimensions?: string[];
	rows?: Record<string, unknown>[];
	filters?: unknown[];
}) {
	const filterKey = JSON.stringify(filters ?? []);
	const shown = useMemo(
		() => [
			...shownValues(rows ?? [], dimensions ?? []),
			...filteredValues(JSON.parse(filterKey)),
		],
		[rows, dimensions, filterKey],
	);
	const key =
		sourceKey && shown.length > 0
			? ["value-notes", sourceKey, JSON.stringify(shown)]
			: null;
	const { data, mutate } = useSWR<{ notes: ValueNote[] }>(key, () =>
		post({ action: "lookup", sourceKey, shown }),
	);
	const notes = data?.notes ?? [];
	if (notes.length === 0) return null;
	return (
		<div className={styles.strip}>
			{notes.map((note) => (
				<Thread
					key={note.noteId}
					note={note}
					onChanged={() => void mutate()}
				/>
			))}
		</div>
	);
}

// For the visual's notes panel, where a value note starts.
export function ValueNoteComposer({
	sourceKey,
	dimensions,
	onAdded,
}: {
	sourceKey: string | null | undefined;
	dimensions: string[];
	onAdded?: () => void;
}) {
	const [field, setField] = useState(dimensions[0] ?? "");
	const [value, setValue] = useState("");
	const [body, setBody] = useState("");
	const [expiresOn, setExpiresOn] = useState("");
	const [said, setSaid] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	if (!sourceKey || dimensions.length === 0) return null;
	return (
		<div className={styles.composer}>
			<strong>A note on a value</strong>
			<p className={styles.meta}>
				Shows wherever that value appears, for anyone who can see it.
			</p>
			<div className={styles.replyRow}>
				<select
					className={styles.input}
					value={field}
					aria-label="Field"
					onChange={(e) => setField(e.target.value)}
				>
					{dimensions.map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
				<input
					className={styles.input}
					value={value}
					placeholder="The value, exactly as shown"
					aria-label="Value"
					onChange={(e) => setValue(e.target.value)}
				/>
			</div>
			<input
				className={styles.input}
				value={body}
				placeholder="Soon to be retired"
				aria-label="Note"
				onChange={(e) => setBody(e.target.value)}
			/>
			<div className={styles.replyRow}>
				<input
					type="date"
					className={styles.input}
					value={expiresOn}
					aria-label="Ends on"
					onChange={(e) => setExpiresOn(e.target.value)}
				/>
				<button
					type="button"
					className={styles.button}
					disabled={!value.trim() || !body.trim()}
					onClick={async () => {
						setFailure(null);
						try {
							await post({
								action: "add",
								sourceKey,
								field,
								value,
								body,
								expiresOn: expiresOn || null,
							});
							setSaid(`Added to ${value.trim()}.`);
							setValue("");
							setBody("");
							onAdded?.();
						} catch (error) {
							setFailure(
								error instanceof Error
									? error.message
									: "That did not save.",
							);
						}
					}}
				>
					Add
				</button>
			</div>
			{said && <p className={styles.meta}>{said}</p>}
			{failure && <p className={styles.failure}>{failure}</p>}
		</div>
	);
}
