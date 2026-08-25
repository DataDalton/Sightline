"use client";

import { useEffect, memo } from "react";
import styles from "./Toast.module.css";

interface ToastProps {
	message: string;
	type: "success" | "error" | "warning";
	visible: boolean;
	onClose: () => void;
}

export const Toast = memo(function Toast({
	message,
	type,
	visible,
	onClose,
}: ToastProps) {
	useEffect(() => {
		if (visible) {
			const timer = setTimeout(onClose, 4000);
			return () => clearTimeout(timer);
		}
	}, [visible, onClose]);

	if (!visible) return null;

	return (
		<div className={`${styles.toast} ${styles[type]}`}>
			<span className={styles.message}>{message}</span>
			<button
				type="button"
				className={styles.closeButton}
				onClick={onClose}
			>
				<svg
					width="14"
					height="14"
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
	);
});
