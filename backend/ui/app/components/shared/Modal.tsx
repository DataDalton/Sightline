"use client";

import { useEffect, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import styles from "./Modal.module.css";

interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
	footer?: React.ReactNode;
	width?: string;
}

export const Modal = memo(function Modal({
	isOpen,
	onClose,
	title,
	children,
	footer,
	width = "560px",
}: ModalProps) {
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		},
		[onClose],
	);

	useEffect(() => {
		if (isOpen) {
			document.addEventListener("keydown", handleKeyDown);
			document.body.style.overflow = "hidden";
		}
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.body.style.overflow = "";
		};
	}, [isOpen, handleKeyDown]);

	if (!isOpen) return null;

	return createPortal(
		<div className={styles.overlay} onClick={onClose}>
			<div
				className={styles.modal}
				style={{ maxWidth: width }}
				onClick={(e) => e.stopPropagation()}
			>
				<div className={styles.header}>
					<h2 className={styles.title}>{title}</h2>
					<button
						type="button"
						className={styles.closeButton}
						onClick={onClose}
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
				<div className={styles.body}>{children}</div>
				{footer && <div className={styles.footer}>{footer}</div>}
			</div>
		</div>,
		document.body,
	);
});
