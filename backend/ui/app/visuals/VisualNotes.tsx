"use client";

import { useState } from "react";
import useSWR from "swr";
import { maxNoteLength, type VisualNote } from "../../lib/platform/noteTypes";
import styles from "./Visual.module.css";

// Commentary on a visual, read and written where the visual is.
//
// "The dip in March was the system migration" is the context that makes a
// figure readable, and it lived in email, so the same question came back every
// quarter and the answer went to one person rather than to the page.
//
// Anyone who can open the report can leave one. That is deliberate: a note is
// context rather than a change to the report, and requiring edit rights would
// mean the people who know why a figure moved are the ones who cannot say so.
//
// The whole page's notes arrive in one request and each visual picks out its
// own, so a page of eight visuals costs one round trip rather than eight.

interface VisualNotesProps {
	reportId: string;
	pageId: string;
	visualId: string;
	notes: VisualNote[];
	// Refetches the page's notes after a change, since they are held together.
	onChanged: () => void;
	onClose: () => void;
}

function when(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "";
	return at.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

export function VisualNotes({
	reportId,
	pageId,
	visualId,
	notes,
	onChanged,
	onClose,
}: VisualNotesProps) {
	const [draft, setDraft] = useState("");
	const [anchor, setAnchor] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const add = async () => {
		const body = draft.trim();
		if (body === "" || busy) return;

		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/notes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					reportId,
					pageId,
					visualId,
					body,
					anchoredOn: anchor || null,
				}),
			});
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				setFailure(detail?.error ?? "The note could not be saved.");
				return;
			}
			setDraft("");
			setAnchor("");
			onChanged();
		} catch {
			setFailure("The note could not be saved. Please try again.");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (noteId: string) => {
		setFailure(null);
		try {
			const response = await fetch(
				`/api/notes?noteId=${encodeURIComponent(noteId)}`,
				{ method: "DELETE" },
			);
			if (!response.ok) {
				setFailure("The note could not be removed.");
				return;
			}
			onChanged();
		} catch {
			setFailure("The note could not be removed. Please try again.");
		}
	};

	return (
		<div className={styles.notesPanel}>
			<div className={styles.notesHead}>
				<span className={styles.notesTitle}>Notes</span>
				<button
					type="button"
					className={styles.frameAction}
					onClick={onClose}
					title="Close"
					aria-label="Close notes"
				>
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M18 6 6 18M6 6l12 12" />
					</svg>
				</button>
			</div>

			{notes.length === 0 && (
				<p className={styles.notesEmpty}>
					Nothing here yet. A note explaining why a figure moved saves
					the next reader asking.
				</p>
			)}

			{notes.map((note) => (
				<div key={note.noteId} className={styles.note}>
					<div className={styles.noteMeta}>
						<span>{note.authorEmail}</span>
						<span>
							{note.anchoredOn
								? `about ${note.anchoredOn}`
								: when(note.createdOn)}
						</span>
						<button
							type="button"
							className={styles.noteRemove}
							onClick={() => remove(note.noteId)}
							title="Remove this note"
							aria-label="Remove this note"
						>
							&times;
						</button>
					</div>
					<p className={styles.noteBody}>{note.body}</p>
				</div>
			))}

			<textarea
				className={styles.noteInput}
				value={draft}
				maxLength={maxNoteLength}
				placeholder="What happened here?"
				onChange={(e) => setDraft(e.target.value)}
			/>
			<div className={styles.noteActions}>
				{/* Optional, and the reason it is worth asking: a note about
				    one point on a line is far more useful when it says which
				    point. */}
				<input
					type="date"
					className={styles.noteDate}
					value={anchor}
					onChange={(e) => setAnchor(e.target.value)}
					title="The date this is about, if it is about one"
					aria-label="The date this note is about"
				/>
				<button
					type="button"
					className={styles.noteSave}
					onClick={add}
					disabled={busy || draft.trim() === ""}
				>
					{busy ? "Saving" : "Add note"}
				</button>
			</div>

			{failure && (
				<p className={styles.notesFailure} role="status">
					{failure}
				</p>
			)}
		</div>
	);
}

// The control that opens the panel, with the count on it.
//
// The count is the point: a visual carrying commentary should say so without
// being opened, or nobody finds the note that was left for them.
export function NotesAction({
	count,
	available,
	onOpen,
}: {
	count: number;
	// Notes are attached to a saved page, so there is nowhere to put one on a
	// visual drawn outside a report.
	available: boolean;
	onOpen: () => void;
}) {
	if (!available) return null;

	return (
		<button
			type="button"
			className={`${styles.frameAction} ${count > 0 ? styles.frameActionMarked : ""}`}
			onClick={onOpen}
			title={
				count === 0
					? "Add a note about this"
					: count === 1
						? "1 note"
						: `${count} notes`
			}
			aria-label={count === 0 ? "Add a note" : `${count} notes`}
		>
			<svg
				width="13"
				height="13"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			</svg>
			{count > 0 && <span className={styles.noteCount}>{count}</span>}
		</button>
	);
}

// Every note on a page, fetched once and shared by every visual on it.
export function usePageNotes(reportId: string | null, pageId: string | null) {
	const key =
		reportId && pageId
			? `/api/notes?reportId=${encodeURIComponent(reportId)}&pageId=${encodeURIComponent(pageId)}`
			: null;

	const { data, mutate } = useSWR<{ notes: VisualNote[] }>(key);
	return { notes: data?.notes ?? [], refresh: () => void mutate() };
}
