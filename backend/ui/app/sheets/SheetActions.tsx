"use client";

import { useEffect, useRef, useState } from "react";
import type { Sheet, SheetPermission } from "../../lib/sheets/store";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import styles from "./Sheets.module.css";

// What can be done to a whole sheet: copy it, or get rid of it. Its owner
// deletes it for everybody. Somebody it was shared with only takes it off
// their own list, and the owner and everyone else keep it.

export function SheetActions({
	id,
	title,
	permission,
	onDeleted,
	onDuplicated,
}: {
	id: string;
	title: string;
	permission: SheetPermission;
	onDeleted: () => void;
	onDuplicated: (newId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const box = useRef<HTMLSpanElement>(null);
	const owner = permission === "owner";

	useEffect(() => {
		if (!open) return;
		const away = (e: MouseEvent) => {
			if (!box.current?.contains(e.target as Node)) setOpen(false);
		};
		const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", key);
		};
	}, [open]);

	const duplicate = async () => {
		setOpen(false);
		setBusy(true);
		setProblem(null);
		try {
			const current = await fetch(`/api/sheets/${id}`);
			const body = (await current.json()) as { sheet?: Sheet };
			if (!current.ok || !body.sheet) throw new Error();
			const response = await fetch("/api/sheets", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: `${title} copy`,
					definition: body.sheet.definition,
				}),
			});
			const created = await response.json().catch(() => null);
			if (!response.ok) {
				setProblem(created?.error ?? "The copy could not be made.");
				return;
			}
			onDuplicated(created.sheet.id);
		} catch {
			setProblem("The copy could not be made.");
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		setBusy(true);
		setProblem(null);
		try {
			const response = await fetch(`/api/sheets/${id}`, {
				method: "DELETE",
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setProblem(body?.error ?? "The sheet could not be deleted.");
				return;
			}
			setConfirming(false);
			onDeleted();
		} finally {
			setBusy(false);
		}
	};

	return (
		<span className={styles.actionsWrap} ref={box}>
			<button
				type="button"
				className={styles.actionsButton}
				aria-label={`Actions for ${title}`}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={busy}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					setOpen((v) => !v);
				}}
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="currentColor"
					aria-hidden="true"
				>
					<circle cx="5" cy="12" r="1.8" />
					<circle cx="12" cy="12" r="1.8" />
					<circle cx="19" cy="12" r="1.8" />
				</svg>
			</button>
			{open && (
				<span
					className={styles.actionsMenu}
					role="menu"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
					}}
				>
					<button
						type="button"
						role="menuitem"
						className={styles.menuItem}
						onClick={duplicate}
					>
						Make a copy
					</button>
					<button
						type="button"
						role="menuitem"
						className={`${styles.menuItem} ${styles.menuDanger}`}
						onClick={() => {
							setOpen(false);
							setConfirming(true);
						}}
					>
						{owner ? "Delete" : "Remove from my sheets"}
					</button>
				</span>
			)}
			{problem && (
				<span className={styles.actionsProblem}>{problem}</span>
			)}
			{confirming && (
				<ConfirmDialog
					title={owner ? "Delete this sheet?" : "Remove this sheet?"}
					body={
						owner
							? `${title} is deleted for you and everyone it is shared with, notes included. The dataset it reads is not affected.`
							: `${title} comes off your list. Its owner and everyone else it is shared with keep it.`
					}
					confirmLabel={owner ? "Delete" : "Remove"}
					busy={busy}
					onConfirm={remove}
					onCancel={() => setConfirming(false)}
				/>
			)}
		</span>
	);
}
