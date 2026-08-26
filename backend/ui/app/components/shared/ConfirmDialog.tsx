"use client";

import { useEffect, useRef } from "react";
import { Modal } from "./Modal";
import styles from "./ConfirmDialog.module.css";

// Confirming something that cannot be undone.
//
// A browser confirm cannot be styled, cannot say which thing is about to go,
// and in some browsers is suppressed entirely after a few uses, which turns a
// destructive action into one that happens without asking.

export function ConfirmDialog({
	title,
	body,
	confirmLabel = "Delete",
	busy,
	onConfirm,
	onCancel,
}: {
	title: string;
	// What is about to happen, and to whom. Not a restatement of the title.
	body: React.ReactNode;
	confirmLabel?: string;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	// Focus starts on Cancel. The destructive button is the one a stray Enter
	// would otherwise land on, and this dialog exists to make that keystroke
	// cost nothing.
	const cancelRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	return (
		<Modal isOpen onClose={onCancel} title={title} width="440px">
			<div className={styles.body}>{body}</div>
			<div className={styles.actions}>
				<button
					ref={cancelRef}
					type="button"
					className={styles.cancel}
					onClick={onCancel}
					disabled={busy}
				>
					Cancel
				</button>
				<button
					type="button"
					className={styles.confirm}
					onClick={onConfirm}
					disabled={busy}
				>
					{busy ? "Working" : confirmLabel}
				</button>
			</div>
		</Modal>
	);
}
