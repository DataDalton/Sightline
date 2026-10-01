"use client";

import Link from "next/link";
import { createContext, useContext, useState, type ReactNode } from "react";
import useSWR from "swr";
import type { BoardOrigin, BoardVisual } from "../../lib/boards/definition";
import type { BoardSummary } from "../../lib/boards/store";
import { Modal } from "../components/shared/Modal";
import visualStyles from "../visuals/Visual.module.css";
import styles from "./Boards.module.css";

// "Add to board", wherever there is a figure or chart worth keeping.
//
// The visual is copied with exactly what it was showing, its filters folded
// into its own, so the board reads the same numbers. Only the arrangement is
// stored, never the data, and each viewer of the board reads it under their
// own access.

// The report a visual sits on, so a board can link back to it. Set by the
// report page. Elsewhere, such as Explore, the caller passes its own origin.
export const BoardOriginContext = createContext<BoardOrigin | null>(null);

export function useBoardOrigin(): BoardOrigin | null {
	return useContext(BoardOriginContext);
}

export interface BoardPiece {
	visual: BoardVisual;
	origin?: BoardOrigin | null;
}

function AddDialog({
	piece,
	onClose,
}: {
	piece: () => BoardPiece;
	onClose: () => void;
}) {
	const { data, error } = useSWR<{ boards: BoardSummary[] }>("/api/boards/");
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);
	const [added, setAdded] = useState<{ id: string; title: string } | null>(
		null,
	);

	const writable = (data?.boards ?? []).filter(
		(b) => b.permission === "owner" || b.permission === "edit",
	);

	const item = () => {
		const { visual, origin } = piece();
		return {
			kind: "visual",
			visual,
			...(origin ? { origin } : {}),
		};
	};

	const send = async (url: string, body: unknown) => {
		setBusy(true);
		setFailed(null);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const result = await response.json().catch(() => null);
			if (!response.ok) {
				setFailed(result?.error ?? "That could not be added.");
				return;
			}
			const board = result?.board as { id: string; title: string };
			setAdded({ id: board.id, title: board.title });
		} catch {
			setFailed(
				"That could not be added. Check the connection and try again.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal isOpen onClose={onClose} title="Add to board" width="440px">
			{added ? (
				<div className={styles.addDone}>
					<p>
						Added to <strong>{added.title}</strong>.
					</p>
					<div className={styles.addDoneActions}>
						<Link
							href={`/boards/${added.id}/`}
							className={styles.primary}
						>
							Open the board
						</Link>
						<button
							type="button"
							className={styles.secondary}
							onClick={onClose}
						>
							Done
						</button>
					</div>
				</div>
			) : (
				<div className={styles.addBody}>
					{error && (
						<p className={styles.formError}>
							Your boards could not be loaded.
						</p>
					)}
					{writable.length > 0 && (
						<ul className={styles.addList}>
							{writable.map((board) => (
								<li key={board.id}>
									<button
										type="button"
										className={styles.addChoice}
										disabled={busy}
										onClick={() =>
											void send(
												`/api/boards/${board.id}/items/`,
												{
													items: [item()],
												},
											)
										}
									>
										<span className={styles.addChoiceTitle}>
											{board.title}
										</span>
										<span className={styles.addChoiceMeta}>
											{board.itemCount === 1
												? "One item"
												: `${board.itemCount} items`}
											{board.permission === "edit"
												? " · shared with you"
												: ""}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
					<form
						className={styles.addNew}
						onSubmit={(e) => {
							e.preventDefault();
							void send("/api/boards/", {
								title: title.trim() || "Untitled board",
								items: [item()],
							});
						}}
					>
						<label
							className={styles.addNewLabel}
							htmlFor="new-board-title"
						>
							{writable.length > 0
								? "Or start a new board"
								: "Start a board"}
						</label>
						<div className={styles.addNewRow}>
							<input
								id="new-board-title"
								className={styles.input}
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="Board name"
								maxLength={160}
							/>
							<button
								type="submit"
								className={styles.primary}
								disabled={busy}
							>
								Create
							</button>
						</div>
					</form>
					{failed && (
						<p className={styles.formError} role="alert">
							{failed}
						</p>
					)}
				</div>
			)}
		</Modal>
	);
}

function BoardIcon() {
	return (
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
			<rect x="3" y="3" width="8" height="8" rx="1.5" />
			<rect x="13" y="3" width="8" height="5" rx="1.5" />
			<rect x="13" y="10" width="8" height="11" rx="1.5" />
			<rect x="3" y="13" width="8" height="8" rx="1.5" />
		</svg>
	);
}

// The button and its dialog. The piece is built when the dialog sends, so it
// carries the filters showing at that moment rather than when the page drew.
export function AddToBoard({
	piece,
	variant = "icon",
	className,
	unavailable,
	children,
}: {
	piece: () => BoardPiece | null;
	variant?: "icon" | "text";
	// The look of the place it sits, in place of its own.
	className?: string;
	// Why it cannot be used here, shown in place of acting.
	unavailable?: string | null;
	children?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [captured, setCaptured] = useState<BoardPiece | null>(null);
	const start = () => {
		const now = piece();
		if (!now) return;
		setCaptured(now);
		setOpen(true);
	};
	return (
		<>
			{variant === "icon" ? (
				<button
					type="button"
					className={className ?? visualStyles.frameAction}
					onClick={start}
					disabled={Boolean(unavailable)}
					title={unavailable ?? "Add to a board"}
					aria-label="Add to a board"
				>
					<BoardIcon />
				</button>
			) : (
				<button
					type="button"
					className={className ?? styles.textAction}
					onClick={start}
					disabled={Boolean(unavailable)}
					title={unavailable ?? "Add to a board"}
				>
					<BoardIcon />
					{children ?? "Add to board"}
				</button>
			)}
			{open && captured && (
				<AddDialog
					piece={() => captured}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
