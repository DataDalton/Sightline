"use client";

import { useEffect, useId, useRef, memo } from "react";
import { createPortal } from "react-dom";
import styles from "./Modal.module.css";

interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
	footer?: React.ReactNode;
	width?: string;
	// On a phone, fill the screen from top to bottom rather than rising only
	// as high as the content. For a dialog whose content is a long list read
	// by scrolling, where a partial sheet leaves little room to read it.
	fullHeightOnPhone?: boolean;
}

// Open modals in the order they opened. Escape closes only the last one, so a
// dialog opened from another dialog does not close both.
const openStack: string[] = [];

// How many modals hold the body scroll lock. The page scrolls again only when
// the last one closes, rather than when the first nested one does.
let scrollLocks = 0;

const focusableSelector = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled]):not([type='hidden'])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableIn(root: HTMLElement): HTMLElement[] {
	return Array.from(
		root.querySelectorAll<HTMLElement>(focusableSelector),
	).filter((el) => el.getClientRects().length > 0);
}

export const Modal = memo(function Modal({
	isOpen,
	onClose,
	title,
	children,
	footer,
	width = "560px",
	fullHeightOnPhone = false,
}: ModalProps) {
	const id = useId();
	const titleId = `${id}-title`;
	const dialogRef = useRef<HTMLDivElement | null>(null);
	// Read through a ref so a new callback from the parent does not reopen
	// the dialog's effects, which would move the focus again.
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	// Set when a press starts on the overlay itself. A click closes only when
	// it both started and ended there, so a text selection dragged out of the
	// dialog and released over the overlay leaves it open.
	const pressedOverlayRef = useRef(false);

	useEffect(() => {
		if (!isOpen) return;

		openStack.push(id);
		scrollLocks += 1;
		document.body.style.overflow = "hidden";

		// Focus goes into the dialog and comes back to whatever had it
		// before, so a keyboard user is not left at the top of the page.
		const previous =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		// The first control in the body rather than the close button, which
		// comes first in the markup. Left alone when a child has already taken
		// the focus for itself.
		const dialog = dialogRef.current;
		if (dialog && !dialog.contains(document.activeElement)) {
			const body = dialog.querySelector<HTMLElement>(`.${styles.body}`);
			const first = body ? focusableIn(body)[0] : undefined;
			(first ?? dialog).focus();
		}

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			if (openStack[openStack.length - 1] !== id) return;
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKeyDown);

		return () => {
			document.removeEventListener("keydown", onKeyDown);
			const at = openStack.lastIndexOf(id);
			if (at >= 0) openStack.splice(at, 1);
			scrollLocks = Math.max(0, scrollLocks - 1);
			if (scrollLocks === 0) document.body.style.overflow = "";
			if (previous && previous.isConnected) previous.focus();
		};
	}, [isOpen, id]);

	// Tab and Shift+Tab cycle within the dialog rather than walking out into
	// the page behind the overlay.
	const trapTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "Tab") return;
		const dialog = dialogRef.current;
		if (!dialog) return;
		const items = focusableIn(dialog);
		if (items.length === 0) {
			e.preventDefault();
			dialog.focus();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		// A portalled dropdown opened from inside the dialog sits outside it
		// in the document and handles its own keys.
		if (!dialog.contains(active)) return;
		if (e.shiftKey && (active === first || active === dialog)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	};

	if (!isOpen) return null;

	return createPortal(
		<div
			className={styles.overlay}
			onMouseDown={(e) => {
				pressedOverlayRef.current = e.target === e.currentTarget;
			}}
			onClick={(e) => {
				const startedHere = pressedOverlayRef.current;
				pressedOverlayRef.current = false;
				if (startedHere && e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={dialogRef}
				className={`${styles.modal} ${
					fullHeightOnPhone ? styles.fullHeightOnPhone : ""
				}`}
				style={{ maxWidth: width, outline: "none" }}
				role="dialog"
				aria-modal="true"
				aria-labelledby={title ? titleId : undefined}
				tabIndex={-1}
				onKeyDown={trapTab}
				// Kept from reaching whatever rendered the modal, since React
				// bubbles portal events through the component tree.
				onClick={(e) => e.stopPropagation()}
			>
				<div className={styles.header}>
					<h2
						id={title ? titleId : undefined}
						className={styles.title}
					>
						{title}
					</h2>
					<button
						type="button"
						className={styles.closeButton}
						onClick={onClose}
						aria-label="Close"
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							aria-hidden="true"
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
