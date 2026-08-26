"use client";

import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import styles from "./Select.module.css";

// One dropdown for the whole application.
//
// A native select cannot style the list it opens: the browser draws it, so it
// carries none of the theme and looks like part of the operating system rather
// than part of the page. It also cannot show a group heading that reads as one,
// or a note beside an option, both of which several pickers here need.
//
// The trigger keeps a native select's keyboard behaviour, because that is what
// people expect of something shaped like one: arrows move, Enter and Space open
// and choose, Escape closes, Home and End jump, and typing letters jumps to a
// matching option.

export interface SelectOption {
	value: string;
	label: string;
	// Shown to the right, quieter. For the qualifier that would otherwise be
	// wedged into the label.
	note?: string;
	// Heading this option sits under. Consecutive options sharing one are drawn
	// together, so the order of the list decides the grouping.
	group?: string;
	disabled?: boolean;
}

export function Select({
	options,
	value,
	onChange,
	placeholder = "Choose one",
	disabled,
	searchable,
	id,
	ariaLabel,
	className,
	bare,
}: {
	options: SelectOption[];
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	// Adds a filter box. Worth it past a couple of dozen options and clutter
	// below that, so the caller decides rather than a threshold guessing.
	searchable?: boolean;
	id?: string;
	ariaLabel?: string;
	className?: string;
	// Drops the field's own border and background.
	//
	// For a toolbar, where the strip is already a bordered surface in the same
	// colour: a bordered field inside it reads as a box inside a box rather
	// than as a control. The container supplies the edge instead.
	bare?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	const [search, setSearch] = useState("");
	// Where to draw the list, in viewport coordinates.
	//
	// The list is portalled to the body rather than placed inside the field.
	// A dialog scrolls its own body, so a list positioned within one is clipped
	// by it: choosing from the last field of a form showed two options and cut
	// the rest off. Nothing above the portal can clip it, and fixed coordinates
	// mean it stays on the trigger.
	const [box, setBox] = useState<{
		left: number;
		width: number;
		top?: number;
		bottom?: number;
	} | null>(null);

	const wrapRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	// Letters typed in quick succession, for jumping to an option by name.
	const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });

	const listId = useId();

	const shown = useMemo(() => {
		if (!searchable || !search.trim()) return options;
		const needle = search.trim().toLowerCase();
		return options.filter((o) => o.label.toLowerCase().includes(needle));
	}, [options, search, searchable]);

	const selected = options.find((o) => o.value === value) ?? null;

	const close = useCallback(() => {
		setOpen(false);
		setSearch("");
		setActive(-1);
	}, []);

	// Closing on an outside press rather than on blur, so moving focus into the
	// list does not close the thing being reached for.
	useEffect(() => {
		if (!open) return;
		const away = (e: MouseEvent) => {
			const target = e.target as Node;
			if (
				!wrapRef.current?.contains(target) &&
				!listRef.current?.contains(target)
			) {
				close();
			}
		};
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, [open, close]);

	// Measured from the trigger, and again whenever anything moves under it.
	// Opens upward where there is no room below, which in a dialog is where the
	// last field always is.
	const place = useCallback(() => {
		const trigger = wrapRef.current?.getBoundingClientRect();
		if (!trigger) return;
		const below = window.innerHeight - trigger.bottom;
		const upward = below < 300 && trigger.top > below;
		setBox({
			left: trigger.left,
			width: trigger.width,
			...(upward
				? { bottom: window.innerHeight - trigger.top + 4 }
				: { top: trigger.bottom + 4 }),
		});
	}, []);

	useEffect(() => {
		if (!open) return;
		place();
		if (searchable) searchRef.current?.focus();
		setActive(shown.findIndex((o) => o.value === value));

		// Capture, so a scroll inside the dialog is seen as well as one on the
		// page. A fixed list does not move with what it is anchored to, so it
		// has to be told.
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => {
			window.removeEventListener("scroll", place, true);
			window.removeEventListener("resize", place);
		};
	}, [open, place, searchable, shown, value]);

	// Keeps the highlighted option in view while arrowing past the fold.
	useEffect(() => {
		if (!open || active < 0) return;
		listRef.current
			?.querySelectorAll("[data-option]")
			[active]?.scrollIntoView({ block: "nearest" });
	}, [active, open]);

	const choose = (option: SelectOption) => {
		if (option.disabled) return;
		onChange(option.value);
		close();
	};

	const step = (by: number) => {
		if (shown.length === 0) return;
		setActive((current) => {
			let next = current;
			// Skips whatever cannot be chosen, rather than stopping on it.
			for (let i = 0; i < shown.length; i++) {
				next = (next + by + shown.length) % shown.length;
				if (!shown[next]?.disabled) return next;
			}
			return current;
		});
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (disabled) return;

		if (!open) {
			if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
				e.preventDefault();
				setOpen(true);
			}
			return;
		}

		switch (e.key) {
			case "Escape":
				e.preventDefault();
				close();
				return;
			case "ArrowDown":
				e.preventDefault();
				step(1);
				return;
			case "ArrowUp":
				e.preventDefault();
				step(-1);
				return;
			case "Home":
				e.preventDefault();
				setActive(shown.findIndex((o) => !o.disabled));
				return;
			case "End":
				e.preventDefault();
				setActive(shown.length - 1);
				return;
			case "Enter":
			case " ":
				// Space types a space in the filter box rather than choosing.
				if (e.key === " " && searchable) return;
				e.preventDefault();
				if (shown[active]) choose(shown[active]);
				return;
			case "Tab":
				close();
				return;
		}

		// Typeahead, for the list somebody knows the shape of. A pause of more
		// than a second starts a new word rather than extending the last.
		if (e.key.length === 1 && !searchable) {
			const now = Date.now();
			const text =
				now - typed.current.at > 1000
					? e.key.toLowerCase()
					: typed.current.text + e.key.toLowerCase();
			typed.current = { text, at: now };
			const found = shown.findIndex(
				(o) => !o.disabled && o.label.toLowerCase().startsWith(text),
			);
			if (found >= 0) setActive(found);
		}
	};

	return (
		<div
			className={`${styles.wrap} ${className ?? ""}`}
			ref={wrapRef}
			onKeyDown={onKeyDown}
		>
			<button
				type="button"
				id={id}
				className={`${styles.trigger} ${bare ? styles.triggerBare : ""} ${
					open ? styles.triggerOpen : ""
				}`}
				onClick={() => (open ? close() : setOpen(true))}
				disabled={disabled}
				role="combobox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-haspopup="listbox"
				aria-label={ariaLabel}
			>
				<span
					className={`${styles.value} ${
						selected ? "" : styles.placeholder
					}`}
				>
					{selected ? selected.label : placeholder}
				</span>
				<svg
					className={`${styles.chevron} ${
						open ? styles.chevronOpen : ""
					}`}
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
						id={listId}
						role="listbox"
						ref={listRef}
						style={{
							left: box.left,
							// The field's width is a floor, not a fixed size.
							// Pinning the list to it meant a select in a narrow
							// slot, such as the editor toolbar, opened a list too
							// narrow to read its own options in, and every label
							// arrived truncated.
							minWidth: box.width,
							maxWidth: `calc(100vw - ${box.left}px - 12px)`,
							...(box.top !== undefined
								? { top: box.top }
								: { bottom: box.bottom }),
						}}
						// Keyed here as well as on the field, because the portal
						// moves the list out of the wrapper the handler sits on.
						onKeyDown={onKeyDown}
					>
						{searchable && (
							<input
								ref={searchRef}
								type="text"
								className={styles.search}
								value={search}
								placeholder="Filter"
								onChange={(e) => {
									setSearch(e.target.value);
									setActive(0);
								}}
							/>
						)}

						{shown.length === 0 && (
							<div className={styles.empty}>
								Nothing to choose
							</div>
						)}

						{shown.map((option, i) => {
							const heading =
								option.group &&
								option.group !== shown[i - 1]?.group;
							return (
								<div key={`${option.value}-${i}`}>
									{heading && (
										<div className={styles.group}>
											{option.group}
										</div>
									)}
									<button
										type="button"
										data-option
										className={`${styles.option} ${
											i === active
												? styles.optionActive
												: ""
										} ${
											option.value === value
												? styles.optionSelected
												: ""
										}`}
										role="option"
										aria-selected={option.value === value}
										disabled={option.disabled}
										onMouseEnter={() => setActive(i)}
										onClick={() => choose(option)}
									>
										<span className={styles.tick}>
											{option.value === value ? "✓" : ""}
										</span>
										<span className={styles.optionLabel}>
											{option.label}
										</span>
										{option.note && (
											<span className={styles.optionNote}>
												{option.note}
											</span>
										)}
									</button>
								</div>
							);
						})}
					</div>,
					document.body,
				)}
		</div>
	);
}
