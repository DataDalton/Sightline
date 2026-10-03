"use client";

import { boardListKey, refreshBoardList } from "./boardList";
import Link from "../components/AppLink";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import type { BoardSummary } from "../../lib/boards/store";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { ShareDialog } from "../sheets/ShareDialog";
import { KeptBadge, markKeep } from "../mine/Retention";
import styles from "../mine/MyPages.module.css";

// The boards part of My pages: the reader's own, those shared with them, and
// a new one. A board is a canvas arranged from anything worth keeping, where
// a page is a report built on one dataset.

function when(iso: string): string {
	const at = new Date(iso);
	return Number.isNaN(at.getTime())
		? ""
		: at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function BoardsSection() {
	const router = useRouter();
	const { data, mutate } = useSWR<{ boards: BoardSummary[] }>(boardListKey);
	const [creating, setCreating] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [removing, setRemoving] = useState<BoardSummary | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [sharing, setSharing] = useState<BoardSummary | null>(null);

	const boards = data?.boards ?? [];
	const mine = boards.filter((b) => b.permission === "owner");
	const shared = boards.filter((b) => b.permission !== "owner");

	const create = async () => {
		setCreating(true);
		setFailure(null);
		try {
			const response = await fetch(boardListKey, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Untitled board" }),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(body?.error ?? "Could not create a board.");
				return;
			}
			refreshBoardList();
			router.push(`/boards/${body.board.id}/`);
		} catch {
			setFailure("Could not create a board. Check the connection.");
		} finally {
			setCreating(false);
		}
	};

	const remove = async () => {
		if (!removing) return;
		setDeleting(true);
		try {
			const response = await fetch(`/api/boards/${removing.id}/`, {
				method: "DELETE",
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setFailure(body?.error ?? "Could not delete the board.");
			}
			setRemoving(null);
			await mutate();
		} catch {
			setFailure("Could not delete the board. Check the connection.");
		} finally {
			setDeleting(false);
		}
	};

	// The Keep mark, which only the owner of a board sets.
	const toggleKeep = async (board: BoardSummary) => {
		setFailure(null);
		const problem = await markKeep("board", board.id, !board.keep);
		if (problem) setFailure(problem);
		await mutate();
	};

	const card = (board: BoardSummary) => (
		<div key={board.id} className={styles.card}>
			<Link href={`/boards/${board.id}/`} className={styles.cardTitle}>
				{board.title}
			</Link>
			<span className={styles.cardMeta}>
				<span className={styles.tag}>Board</span>
				<span>
					{board.itemCount === 1
						? "One item"
						: `${board.itemCount} items`}
				</span>
				{board.permission !== "owner" ? (
					<span>{board.ownerEmail}</span>
				) : board.sharedWith > 0 ? (
					<span>
						Shared with {board.sharedWith}
						{board.sharedWith === 1 ? " person" : " people"}
					</span>
				) : null}
				{board.permission === "owner" && board.keep && <KeptBadge />}
				<span>{when(board.modifiedOn)}</span>
			</span>
			<div className={styles.cardActions}>
				{board.permission === "owner" && (
					<button
						type="button"
						className={styles.cardAction}
						onClick={() => setSharing(board)}
					>
						Share
					</button>
				)}
				{board.permission === "owner" && (
					<button
						type="button"
						className={styles.cardAction}
						onClick={() => void toggleKeep(board)}
						title={
							board.keep
								? "Let it be removed if nobody uses it for a long time"
								: "Never remove it for going unused"
						}
					>
						{board.keep ? "Stop keeping" : "Keep"}
					</button>
				)}
				<button
					type="button"
					className={styles.cardAction}
					onClick={() => setRemoving(board)}
				>
					{board.permission === "owner"
						? "Delete"
						: "Remove from my list"}
				</button>
			</div>
		</div>
	);

	return (
		<>
			<div className={styles.sectionTitle}>
				Boards
				<span className={styles.sectionNote}>
					Charts from any report, notes and arrows, arranged however
					you like
				</span>
			</div>
			{failure && (
				<p className={styles.sectionNote} role="alert">
					{failure}
				</p>
			)}
			<div className={styles.grid}>
				{mine.map(card)}
				<button
					type="button"
					className={styles.newCard}
					onClick={() => void create()}
					disabled={creating}
				>
					<span className={styles.newCardPlus} aria-hidden="true">
						+
					</span>
					New board
				</button>
			</div>
			{shared.length > 0 && (
				<>
					<div className={styles.sectionTitle}>
						Boards shared with me
					</div>
					<div className={styles.grid}>{shared.map(card)}</div>
				</>
			)}

			{removing && (
				<ConfirmDialog
					title={
						removing.permission === "owner"
							? "Delete this board"
							: "Remove this board from your list"
					}
					body={
						removing.permission === "owner" ? (
							<>
								<strong>{removing.title}</strong> will be
								deleted
								{removing.sharedWith > 0
									? `, and the ${removing.sharedWith} ${removing.sharedWith === 1 ? "person" : "people"} it is shared with will lose it.`
									: "."}
							</>
						) : (
							<>
								<strong>{removing.title}</strong> stays with its
								owner.
							</>
						)
					}
					busy={deleting}
					onConfirm={() => void remove()}
					onCancel={() => setRemoving(null)}
				/>
			)}

			{sharing && (
				<ShareDialog
					sheetId={sharing.id}
					isOwner
					sharesUrl={`/api/boards/${sharing.id}/shares/`}
					title="Share this board"
					hint="Each person sees every visual through their own access, so a chart on data they cannot read shows them nothing of it. They are told in their inbox."
					onClose={() => {
						setSharing(null);
						void mutate();
					}}
				/>
			)}
		</>
	);
}
