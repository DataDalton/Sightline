"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./DatePicker.module.css";

// One date field for the whole application.
//
// A native date input cannot be styled past its own box: the calendar is drawn
// by the browser, so it carries none of the theme, sits in the operating
// system's own typography, and puts a light panel over a dark page on every
// engine that has not implemented color-scheme for it. It also renders its own
// text in a format the browser picks rather than the one the rest of the page
// uses.
//
// The trigger keeps the behaviour people expect of a date field: typing is not
// required, the keyboard walks the grid, Escape closes without choosing, and
// the panel is anchored to the field wherever it is on screen.

const weekdays = ["S", "M", "T", "W", "T", "F", "S"];
const yearsShown = 12;
const monthNames = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

// Parsed as a local date rather than through Date.parse, which reads a bare
// "YYYY-MM-DD" as UTC and lands on the day before anywhere west of Greenwich.
function parse(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const [, y, m, d] = match;
	const date = new Date(Number(y), Number(m) - 1, Number(d));
	// A rolled-over date means the input named a day that does not exist.
	return date.getMonth() === Number(m) - 1 ? date : null;
}

function iso(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function addMonths(date: Date, months: number): Date {
	const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
	// Clamped, so stepping back a month from the thirty first does not skip
	// one by rolling into the next.
	const lastDay = new Date(
		target.getFullYear(),
		target.getMonth() + 1,
		0,
	).getDate();
	target.setDate(Math.min(date.getDate(), lastDay));
	return target;
}

function sameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

// The six week grid a month is drawn on, always the same height so the panel
// does not change size as the reader steps through the year.
function gridFor(month: Date): Date[] {
	const first = new Date(month.getFullYear(), month.getMonth(), 1);
	const start = addDays(first, -first.getDay());
	return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function DatePicker({
	value,
	onChange,
	min,
	max,
	ariaLabel,
	placeholder = "Any date",
	className,
	size = "compact",
	disabled,
	title,
}: {
	// An ISO date, or empty for no date chosen.
	value: string;
	onChange: (value: string) => void;
	// Bounds, as ISO dates. A day outside them cannot be chosen.
	min?: string;
	max?: string;
	ariaLabel?: string;
	placeholder?: string;
	className?: string;
	// Compact in a filter strip, the height of a text input in a form.
	size?: "compact" | "form";
	disabled?: boolean;
	// Says why the field is locked, where it is.
	title?: string;
}) {
	const [open, setOpen] = useState(false);
	// Days of one month, the months of one year, or a run of years. The title
	// steps out to the wider view, and a choice there steps back in, so a date
	// years away is three clicks rather than dozens of presses on an arrow.
	const [view, setView] = useState<"days" | "months" | "years">("days");
	const [box, setBox] = useState<{
		left: number;
		top?: number;
		bottom?: number;
	} | null>(null);

	const selected = useMemo(() => parse(value), [value]);
	const lowest = useMemo(() => (min ? parse(min) : null), [min]);
	const highest = useMemo(() => (max ? parse(max) : null), [max]);
	const today = useMemo(() => startOfDay(new Date()), []);

	// The day the keyboard is on, which is the selection until the reader moves
	// off it. Held separately so arrowing around does not change the value
	// until Enter, the way a list does not choose until it is committed.
	const [cursor, setCursor] = useState<Date>(selected ?? today);
	const [month, setMonth] = useState<Date>(
		new Date(
			(selected ?? today).getFullYear(),
			(selected ?? today).getMonth(),
			1,
		),
	);

	const wrapRef = useRef<HTMLDivElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const gridRef = useRef<HTMLDivElement | null>(null);

	const close = useCallback(() => setOpen(false), []);

	const outOfRange = useCallback(
		(day: Date) =>
			(lowest !== null && day < lowest) ||
			(highest !== null && day > highest),
		[lowest, highest],
	);

	// Closing on an outside press rather than on blur, so moving focus into the
	// panel does not close the thing being reached for.
	useEffect(() => {
		if (!open) return;
		const away = (e: MouseEvent) => {
			const target = e.target as Node;
			if (
				!wrapRef.current?.contains(target) &&
				!panelRef.current?.contains(target)
			) {
				close();
			}
		};
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, [open, close]);

	// Measured from the field, and again whenever anything moves under it. The
	// panel is portalled to the body, so nothing above it can clip it and fixed
	// coordinates keep it on the field.
	const place = useCallback(() => {
		const trigger = wrapRef.current?.getBoundingClientRect();
		if (!trigger) return;
		const below = window.innerHeight - trigger.bottom;
		const upward = below < 340 && trigger.top > below;
		setBox({
			left: Math.max(8, Math.min(trigger.left, window.innerWidth - 268)),
			...(upward
				? { bottom: window.innerHeight - trigger.top + 4 }
				: { top: trigger.bottom + 4 }),
		});
	}, []);

	useEffect(() => {
		if (!open) return;
		place();
		const at = selected ?? today;
		setCursor(at);
		setMonth(new Date(at.getFullYear(), at.getMonth(), 1));
		setView("days");
		// Capture, so a scroll inside a panel is seen as well as one on the
		// page. A fixed panel does not move with what it is anchored to.
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => {
			window.removeEventListener("scroll", place, true);
			window.removeEventListener("resize", place);
		};
	}, [open, place, selected, today]);

	// Focus follows the cursor, so a screen reader announces the day the arrows
	// landed on rather than staying on the grid.
	useEffect(() => {
		if (!open) return;
		const cell = gridRef.current?.querySelector<HTMLButtonElement>(
			`[data-day="${iso(cursor)}"]`,
		);
		cell?.focus();
	}, [open, cursor]);

	const choose = (day: Date) => {
		if (outOfRange(day)) return;
		onChange(iso(day));
		close();
	};

	const onGridKey = (e: React.KeyboardEvent) => {
		const moves: Record<string, number> = {
			ArrowLeft: -1,
			ArrowRight: 1,
			ArrowUp: -7,
			ArrowDown: 7,
		};

		if (e.key in moves) {
			e.preventDefault();
			const next = addDays(cursor, moves[e.key]);
			setCursor(next);
			setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
			return;
		}
		if (e.key === "PageUp" || e.key === "PageDown") {
			e.preventDefault();
			const next = addMonths(cursor, e.key === "PageUp" ? -1 : 1);
			setCursor(next);
			setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
			return;
		}
		if (e.key === "Home" || e.key === "End") {
			e.preventDefault();
			const offset =
				e.key === "Home" ? -cursor.getDay() : 6 - cursor.getDay();
			setCursor(addDays(cursor, offset));
			return;
		}
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			choose(cursor);
			return;
		}
		if (e.key === "Escape") {
			// Kept from reaching an enclosing dialog, which would close too.
			e.preventDefault();
			e.stopPropagation();
			close();
			wrapRef.current?.querySelector("button")?.focus();
		}
	};

	const days = useMemo(() => gridFor(month), [month]);

	const year = month.getFullYear();
	// Twelve years to a page, starting on a multiple of twelve so paging
	// forward and back always lands on the same pages.
	const firstYear = Math.floor(year / yearsShown) * yearsShown;

	// A month or a year is open to choice when any day of it is.
	const monthOutOfRange = (y: number, m: number) =>
		outOfRange(new Date(y, m, 1)) && outOfRange(new Date(y, m + 1, 0));
	const yearOutOfRange = (y: number) =>
		outOfRange(new Date(y, 0, 1)) && outOfRange(new Date(y, 11, 31));

	// Opens a month in the day view, keeping the day of the month the cursor
	// was on where that month has it.
	const openMonth = (y: number, m: number) => {
		const last = new Date(y, m + 1, 0).getDate();
		setMonth(new Date(y, m, 1));
		setCursor(new Date(y, m, Math.min(cursor.getDate(), last)));
		setView("days");
	};

	const step = (direction: -1 | 1) => {
		if (view === "days") setMonth(addMonths(month, direction));
		else if (view === "months")
			setMonth(new Date(year + direction, month.getMonth(), 1));
		else
			setMonth(
				new Date(year + direction * yearsShown, month.getMonth(), 1),
			);
	};

	const stepLabel = (direction: -1 | 1) =>
		`${direction < 0 ? "Previous" : "Next"} ${
			view === "days" ? "month" : view === "months" ? "year" : "years"
		}`;

	// The field itself. Written the way the rest of the page writes a date,
	// rather than in whatever order the browser would have chosen.
	const label = selected
		? `${monthNames[selected.getMonth()].slice(0, 3)} ${selected.getDate()}, ${selected.getFullYear()}`
		: placeholder;

	return (
		<div className={styles.wrap} ref={wrapRef}>
			<button
				type="button"
				className={`${styles.field} ${
					size === "form" ? styles.fieldForm : ""
				} ${className ?? ""} ${selected ? "" : styles.empty}`}
				aria-label={ariaLabel}
				title={title}
				disabled={disabled}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "Enter") {
						e.preventDefault();
						setOpen(true);
					}
				}}
			>
				<span className={styles.fieldText}>{label}</span>
				<svg
					className={styles.icon}
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<rect x="3" y="5" width="18" height="16" rx="2" />
					<path d="M3 10h18M8 3v4M16 3v4" />
				</svg>
			</button>

			{open &&
				box &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						ref={panelRef}
						className={styles.panel}
						data-placement={
							box.bottom === undefined ? "below" : "above"
						}
						role="dialog"
						aria-label={ariaLabel ?? "Choose a date"}
						onKeyDown={(e) => {
							// Steps back out of the wider views before it closes.
							if (e.key !== "Escape") return;
							e.preventDefault();
							e.stopPropagation();
							if (view !== "days") {
								setView(view === "years" ? "months" : "days");
								return;
							}
							close();
							wrapRef.current?.querySelector("button")?.focus();
						}}
						style={{
							left: box.left,
							top: box.top,
							bottom: box.bottom,
						}}
					>
						<div className={styles.head}>
							<button
								type="button"
								className={styles.step}
								aria-label={stepLabel(-1)}
								onClick={() => step(-1)}
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.5"
									strokeLinecap="round"
									aria-hidden="true"
								>
									<path d="M15 6l-6 6 6 6" />
								</svg>
							</button>
							<button
								type="button"
								className={styles.month}
								aria-live="polite"
								disabled={view === "years"}
								aria-label={
									view === "days"
										? `${monthNames[month.getMonth()]} ${year}, choose a month`
										: view === "months"
											? `${year}, choose a year`
											: undefined
								}
								onClick={() =>
									setView(
										view === "days" ? "months" : "years",
									)
								}
							>
								{view === "days"
									? `${monthNames[month.getMonth()]} ${year}`
									: view === "months"
										? year
										: `${firstYear} to ${firstYear + yearsShown - 1}`}
							</button>
							<button
								type="button"
								className={styles.step}
								aria-label={stepLabel(1)}
								onClick={() => step(1)}
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.5"
									strokeLinecap="round"
									aria-hidden="true"
								>
									<path d="M9 6l6 6-6 6" />
								</svg>
							</button>
						</div>

						{view === "months" && (
							<div className={styles.picks}>
								{monthNames.map((name, m) => {
									const isSelected =
										selected !== null &&
										selected.getFullYear() === year &&
										selected.getMonth() === m;
									const isNow =
										today.getFullYear() === year &&
										today.getMonth() === m;
									return (
										<button
											key={name}
											type="button"
											className={`${styles.pick} ${
												isSelected
													? styles.selected
													: ""
											} ${isNow ? styles.today : ""}`}
											aria-label={`${name} ${year}`}
											aria-pressed={isSelected}
											disabled={monthOutOfRange(year, m)}
											onClick={() => openMonth(year, m)}
										>
											{name.slice(0, 3)}
										</button>
									);
								})}
							</div>
						)}

						{view === "years" && (
							<div className={styles.picks}>
								{Array.from(
									{ length: yearsShown },
									(_, i) => firstYear + i,
								).map((y) => {
									const isSelected =
										selected !== null &&
										selected.getFullYear() === y;
									return (
										<button
											key={y}
											type="button"
											className={`${styles.pick} ${
												isSelected
													? styles.selected
													: ""
											} ${
												today.getFullYear() === y
													? styles.today
													: ""
											}`}
											aria-pressed={isSelected}
											disabled={yearOutOfRange(y)}
											onClick={() => {
												setMonth(
													new Date(
														y,
														month.getMonth(),
														1,
													),
												);
												setView("months");
											}}
										>
											{y}
										</button>
									);
								})}
							</div>
						)}

						{view === "days" && (
							<>
								<div
									className={styles.weekdays}
									aria-hidden="true"
								>
									{weekdays.map((day, i) => (
										<span key={i}>{day}</span>
									))}
								</div>

								{/* Buttons rather than a grid role. A grid needs rows
						    to be valid and a date grid has none worth
						    announcing, so each day carries its own full date
						    instead and the arrows walk between them. */}
								<div
									className={styles.grid}
									ref={gridRef}
									onKeyDown={onGridKey}
								>
									{days.map((day) => {
										const outside =
											day.getMonth() !== month.getMonth();
										const disabled = outOfRange(day);
										const isSelected =
											selected !== null &&
											sameDay(day, selected);
										return (
											<button
												key={iso(day)}
												type="button"
												data-day={iso(day)}
												className={`${styles.day} ${
													outside
														? styles.outside
														: ""
												} ${isSelected ? styles.selected : ""} ${
													sameDay(day, today)
														? styles.today
														: ""
												}`}
												tabIndex={
													sameDay(day, cursor)
														? 0
														: -1
												}
												aria-label={`${monthNames[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}`}
												aria-pressed={isSelected}
												disabled={disabled}
												onClick={() => choose(day)}
											>
												{day.getDate()}
											</button>
										);
									})}
								</div>
							</>
						)}

						<div className={styles.foot}>
							<button
								type="button"
								className={styles.footAction}
								disabled={outOfRange(today)}
								onClick={() => choose(today)}
							>
								Today
							</button>
							{value !== "" && (
								<button
									type="button"
									className={styles.footAction}
									onClick={() => {
										onChange("");
										close();
									}}
								>
									Clear
								</button>
							)}
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}
