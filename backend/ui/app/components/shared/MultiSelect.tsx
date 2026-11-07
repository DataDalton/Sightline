"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Select.module.css";

// The application's dropdown for choosing several. The field says what is chosen and the list
// stays open while choosing, with a tick on each. Drawn with the same styles as Select.

const listGap = 4;
const listRoom = 280;

export function MultiSelect({
	options,
	value,
	onChange,
	placeholder = "Choose",
	ariaLabel,
	searchable,
	disabled,
}: {
	options: string[];
	value: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
	ariaLabel?: string;
	searchable?: boolean;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [box, setBox] = useState<{
		left: number;
		width: number;
		top?: number;
		bottom?: number;
	} | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	const close = useCallback(() => {
		setOpen(false);
		setSearch("");
	}, []);

	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			const target = event.target as Node;
			if (
				!wrapRef.current?.contains(target) &&
				!listRef.current?.contains(target)
			) {
				close();
			}
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				close();
			}
		};
		// A list fixed to the screen would be left behind by the field it belongs to.
		const moved = (event: Event) => {
			if (!listRef.current?.contains(event.target as Node)) close();
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", key, true);
		window.addEventListener("scroll", moved, true);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", key, true);
			window.removeEventListener("scroll", moved, true);
			window.removeEventListener("resize", close);
		};
	}, [open, close]);

	const toggleOpen = () => {
		if (open) {
			close();
			return;
		}
		const field = wrapRef.current?.getBoundingClientRect();
		if (!field) return;
		const fitsBelow = window.innerHeight - field.bottom > listRoom;
		setBox(
			fitsBelow || field.top < listRoom
				? {
						left: field.left,
						width: field.width,
						top: field.bottom + listGap,
					}
				: {
						left: field.left,
						width: field.width,
						bottom: window.innerHeight - field.top + listGap,
					},
		);
		setOpen(true);
	};

	const needle = search.trim().toLowerCase();
	const shown = needle
		? options.filter((option) => option.toLowerCase().includes(needle))
		: options;
	const words = value.join(", ");

	return (
		<div className={styles.wrap} ref={wrapRef}>
			<button
				type="button"
				className={`${styles.trigger} ${open ? styles.triggerOpen : ""}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				title={words || undefined}
				disabled={disabled}
				onClick={toggleOpen}
			>
				<span
					className={`${styles.value} ${value.length === 0 ? styles.placeholder : ""}`}
				>
					{words || placeholder}
				</span>
				<svg
					className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M6 9l6 6 6-6" />
				</svg>
			</button>

			{open &&
				box &&
				createPortal(
					<div
						className={styles.list}
						data-placement={
							box.bottom === undefined ? "below" : "above"
						}
						role="listbox"
						aria-multiselectable="true"
						ref={listRef}
						style={{
							left: box.left,
							minWidth: box.width,
							maxWidth: `calc(100vw - ${box.left}px - 12px)`,
							...(box.top !== undefined
								? { top: box.top }
								: { bottom: box.bottom }),
						}}
					>
						{searchable && (
							<input
								type="text"
								autoFocus
								className={styles.search}
								value={search}
								placeholder="Filter"
								onChange={(e) => setSearch(e.target.value)}
							/>
						)}
						{shown.length === 0 && (
							<div className={styles.empty}>
								Nothing to choose
							</div>
						)}
						{shown.map((option) => {
							const chosen = value.includes(option);
							return (
								<button
									key={option}
									type="button"
									role="option"
									aria-selected={chosen}
									className={`${styles.option} ${chosen ? styles.optionSelected : ""}`}
									onClick={() =>
										onChange(
											chosen
												? value.filter(
														(held) =>
															held !== option,
													)
												: [...value, option],
										)
									}
								>
									<span className={styles.tick}>
										{chosen && (
											<svg
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="3"
												strokeLinecap="round"
												strokeLinejoin="round"
												aria-hidden="true"
											>
												<path d="M5 13l4 4L19 7" />
											</svg>
										)}
									</span>
									<span className={styles.optionLabel}>
										{option}
									</span>
								</button>
							);
						})}
					</div>,
					document.body,
				)}
		</div>
	);
}
