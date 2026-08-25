"use client";

import { useEffect, memo } from "react";
import { createPortal } from "react-dom";
import styles from "./ActionStatusModal.module.css";

export type ActionStatus = "processing" | "success";

interface ActionStatusModalProps {
	isOpen: boolean;
	status: ActionStatus;
	message: string;
	onClose: () => void;
	autoDismissMs?: number;
}

export const ActionStatusModal = memo(function ActionStatusModal({
	isOpen,
	status,
	message,
	onClose,
	autoDismissMs = 1500,
}: ActionStatusModalProps) {
	useEffect(() => {
		if (!isOpen) return;
		// Only the success phase is dismissable. While processing we keep the
		// overlay up so the user cannot double-click the underlying button and
		// fire the request a second time.
		if (status !== "success") return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		const t = window.setTimeout(onClose, autoDismissMs);
		return () => {
			document.removeEventListener("keydown", onKey);
			window.clearTimeout(t);
		};
	}, [isOpen, status, autoDismissMs, onClose]);

	if (!isOpen) return null;

	const handleOverlayClick = status === "success" ? onClose : undefined;

	return createPortal(
		<div
			className={styles.overlay}
			onClick={handleOverlayClick}
			role="alertdialog"
			aria-live="polite"
			aria-busy={status === "processing"}
			aria-label={message}
		>
			<div className={styles.card} onClick={(e) => e.stopPropagation()}>
				{status === "processing" ? (
					<div className={styles.spinner} aria-hidden="true" />
				) : (
					<svg
						className={styles.check}
						viewBox="0 0 52 52"
						aria-hidden="true"
					>
						<circle
							className={styles.circle}
							cx="26"
							cy="26"
							r="24"
							fill="none"
						/>
						<path
							className={styles.path}
							d="M14 27 l8 8 l16 -18"
							fill="none"
						/>
					</svg>
				)}
				<div className={styles.message}>{message}</div>
			</div>
		</div>,
		document.body,
	);
});
