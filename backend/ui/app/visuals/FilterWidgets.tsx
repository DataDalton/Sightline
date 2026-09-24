"use client";

import {
	Children,
	Fragment,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { usePageFilters, type FilterClause } from "./PageFilters";
import { RangeSlider } from "./RangeSlider";
import { usePostResource } from "../hooks/usePostResource";
import { useValuePages } from "../hooks/useValuePages";
import { DatePicker } from "../components/shared/DatePicker";
import { FilterChip } from "./FilterChip";
import { Select } from "../components/shared/Select";
import styles from "./Filters.module.css";

// Filter widgets an editor can place on a page.
//
// Each one writes into the shared page filter state under its own visual id,
// so removing a widget removes its effect and no widget has to know about the
// others. Value lists come from the warehouse rather than from loaded rows,
// because with paging the loaded rows are only a window.
//
// Matching is case-insensitive throughout: the query builder lowercases both
// sides for text comparisons, so a reader never has to guess at the casing
// stored in the source.

interface BaseProps {
	visualId: string;
	sourceKey: string;
	label?: string | null;
}

// --- Dropdown --------------------------------------------------------------

interface DropdownProps extends BaseProps {
	field: string;
	// Single select is the right default for a field a reader thinks of as
	// "which one"; multi for "which of these".
	multiple?: boolean;
	// Keeps the chosen values, or drops them. Excluding is the shorter way to
	// say "everything except these two" when the field has forty values, and it
	// stays correct as values are added: a new one is included by default,
	// where an include list would silently leave it out.
	exclude?: boolean;
}

export function DropdownFilter({
	visualId,
	sourceKey,
	field,
	label,
	multiple = true,
	exclude = false,
}: DropdownProps) {
	const { setWidgetFilter, clausesExcept, byWidget } = usePageFilters();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [debounced, setDebounced] = useState("");

	const selected = useMemo(
		() => byWidget[visualId]?.[0]?.values ?? [],
		[byWidget, visualId],
	);

	useEffect(() => {
		const timer = setTimeout(() => setDebounced(search), 250);
		return () => clearTimeout(timer);
	}, [search]);

	// Other widgets narrow this list; this widget does not narrow itself, or a
	// reader could pick one value and then find no others available.
	const others = clausesExcept(visualId);

	// Asked while the chip is open, a page at a time, with the next page
	// fetched as the reader reaches the end of the last. Nothing is asked for
	// until the chip is opened, so a page carrying a dozen filters runs no
	// warehouse query until somebody looks at one.
	const {
		values,
		more,
		loading,
		error: valuesError,
		sentinelRef,
	} = useValuePages(
		open ? { sourceKey, field, search: debounced, filters: others } : null,
	);

	const apply = (next: string[]) => {
		setWidgetFilter(
			visualId,
			next.length > 0
				? [{ field, op: exclude ? "neq" : "eq", values: next }]
				: [],
		);
	};

	const toggle = (value: string) => {
		if (!multiple) {
			apply(selected[0] === value ? [] : [value]);
			setOpen(false);
			return;
		}
		apply(
			selected.includes(value)
				? selected.filter((v) => v !== value)
				: [...selected, value],
		);
	};

	// Selected values stay listed even when a search would exclude them, so a
	// reader can always see and undo what they picked.
	const listed = useMemo(() => {
		const set = new Set(values);
		return [...selected.filter((v) => !set.has(v)), ...values];
	}, [values, selected]);

	// Said rather than implied. A control set to exclude looks identical to one
	// set to include until the reader notices the numbers are wrong, so the
	// trigger says which it is doing whenever anything is chosen.
	const summary =
		selected.length === 0
			? "All"
			: exclude
				? selected.length === 1
					? `Not ${selected[0]}`
					: `Excluding ${selected.length}`
				: selected.length === 1
					? selected[0]
					: `${selected.length} selected`;

	return (
		<FilterChip
			label={label ?? field}
			value={selected.length > 0 ? summary : null}
			onClear={() => apply([])}
			onOpenChange={setOpen}
		>
			{(close) => (
				<>
					<input
						type="text"
						className={styles.input}
						placeholder="Search values"
						value={search}
						autoFocus
						onChange={(e) => setSearch(e.target.value)}
					/>

					{multiple && listed.length > 0 && (
						<div className={styles.panelActions}>
							<button
								type="button"
								className={styles.miniButton}
								onClick={() => apply(listed)}
							>
								Select all
							</button>
							<button
								type="button"
								className={styles.miniButton}
								onClick={() => apply([])}
							>
								Clear
							</button>
						</div>
					)}

					{valuesError ? (
						<div className={styles.state}>{valuesError}</div>
					) : loading && listed.length === 0 ? (
						<div className={styles.state}>Loading values</div>
					) : listed.length === 0 ? (
						<div className={styles.state}>No matching values</div>
					) : (
						<div className={styles.list} role="listbox">
							{listed.map((value) => {
								const isSelected = selected.includes(value);
								return (
									<button
										key={value}
										type="button"
										role="option"
										aria-selected={isSelected}
										className={styles.option}
										onClick={() => {
											toggle(value);
											if (!multiple) close();
										}}
									>
										<span
											className={`${styles.checkbox} ${
												multiple ? "" : styles.radio
											} ${isSelected ? styles.checked : ""}`}
											aria-hidden="true"
										>
											<svg
												width="9"
												height="9"
												viewBox="0 0 16 16"
												fill="none"
											>
												<path
													d="M3 8.5l3.5 3.5L13 5"
													stroke="currentColor"
													strokeWidth="2.5"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										</span>
										<span className={styles.optionLabel}>
											{value}
										</span>
									</button>
								);
							})}

							{/* Watched rather than clicked. Reaching the end of
							    the list is the request for more of it. */}
							{more && (
								<div
									ref={sentinelRef}
									className={styles.more}
									role="status"
								>
									{loading
										? "Loading more"
										: "Scroll for more"}
								</div>
							)}
						</div>
					)}
				</>
			)}
		</FilterChip>
	);
}

// --- Free text search ------------------------------------------------------

interface SearchProps extends BaseProps {
	// Fields the text is matched against. Several fields become an OR.
	fields: string[];
	placeholder?: string;
}

export function SearchFilter({
	visualId,
	fields,
	label,
	placeholder,
}: SearchProps) {
	const { setWidgetFilter } = usePageFilters();
	const [text, setText] = useState("");

	useEffect(() => {
		const timer = setTimeout(() => {
			const trimmed = text.trim();
			if (trimmed === "") {
				setWidgetFilter(visualId, []);
				return;
			}
			// One clause per field. The query builder combines a widget's
			// clauses with AND, so multi-field search is expressed as a single
			// clause against the first field until grouped filters are
			// supported end to end.
			setWidgetFilter(visualId, [
				{ field: fields[0], op: "contains", value: trimmed },
			]);
		}, 300);
		return () => clearTimeout(timer);
	}, [text, fields, visualId, setWidgetFilter]);

	// The one control that stays in the strip rather than behind a chip.
	// Everything else opens to be read; this one is typed into, and putting a
	// text box behind a click adds a step to the only filter somebody reaches
	// for without looking.
	return (
		<input
			type="search"
			className={styles.chipSearch}
			placeholder={placeholder ?? label ?? "Type to search"}
			aria-label={label ?? `Search ${fields[0] ?? ""}`}
			value={text}
			onChange={(e) => setText(e.target.value)}
		/>
	);
}

// --- Bulk value paste ------------------------------------------------------

interface BulkProps extends BaseProps {
	field: string;
}

export function BulkFilter({ visualId, field, label }: BulkProps) {
	const { setWidgetFilter, byWidget } = usePageFilters();
	const [text, setText] = useState("");
	const applied = byWidget[visualId]?.[0]?.values?.length ?? 0;

	// Splits on newlines, commas, tabs and semicolons, which covers a column
	// pasted out of a spreadsheet as well as a hand-typed list.
	const parse = (raw: string): string[] =>
		Array.from(
			new Set(
				raw
					.split(/[\n,;\t]+/)
					.map((v) => v.trim())
					.filter((v) => v.length > 0),
			),
		);

	const pending = parse(text);

	return (
		<FilterChip
			label={label ?? `${field} list`}
			value={applied > 0 ? `${applied} pasted` : null}
			onClear={() => {
				setText("");
				setWidgetFilter(visualId, []);
			}}
			width={280}
		>
			{() => (
				<>
					<textarea
						className={styles.textarea}
						placeholder={`Paste ${field} values, one per line`}
						value={text}
						autoFocus
						onChange={(e) => setText(e.target.value)}
					/>
					<div className={styles.row}>
						<button
							type="button"
							className={styles.miniButton}
							onClick={() =>
								setWidgetFilter(
									visualId,
									pending.length > 0
										? [{ field, op: "eq", values: pending }]
										: [],
								)
							}
							disabled={pending.length === 0}
						>
							Apply{" "}
							{pending.length > 0 ? `(${pending.length})` : ""}
						</button>
						<button
							type="button"
							className={styles.miniButton}
							onClick={() => {
								setText("");
								setWidgetFilter(visualId, []);
							}}
						>
							Clear
						</button>
					</div>
					{applied > 0 && (
						<span className={styles.hint}>
							{applied} {applied === 1 ? "value" : "values"}{" "}
							applied
						</span>
					)}
				</>
			)}
		</FilterChip>
	);
}

// --- Date range ------------------------------------------------------------

export type DateRangeMode = "presets" | "calendar" | "slider" | "combined";

interface DateRangeProps extends BaseProps {
	field: string;
	// How the control is presented. The right choice depends on the question:
	// a preset answers "the last quarter", a calendar answers "that specific
	// week", and a slider answers "roughly here, let me feel the edges".
	mode?: DateRangeMode;
	// The preset applied when the page opens, by its short label. Empty means
	// everything, which is the widest query the page can run and the one it ran
	// on every arrival before this existed.
	defaultPreset?: string;
}

interface Preset {
	label: string;
	title: string;
	// Which kind of question this one answers. A rule is drawn where the kind
	// changes, so the eight options read as three short groups rather than one
	// undifferentiated row.
	group: "rolling" | "toDate" | "named";
	resolve: (now: Date) => [Date, Date];
}

const startOfDay = (d: Date) =>
	new Date(d.getFullYear(), d.getMonth(), d.getDate());
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Grouped by how people actually ask: a rolling window, a period to date, or a
// named period. Rolling and to-date are different questions and are often
// confused, so both are offered explicitly rather than approximated.
const presets: Preset[] = [
	{
		label: "7d",
		title: "Last 7 days",
		group: "rolling",
		resolve: (n) => [new Date(n.getTime() - 7 * 864e5), n],
	},
	{
		label: "30d",
		title: "Last 30 days",
		group: "rolling",
		resolve: (n) => [new Date(n.getTime() - 30 * 864e5), n],
	},
	{
		label: "90d",
		title: "Last 90 days",
		group: "rolling",
		resolve: (n) => [new Date(n.getTime() - 90 * 864e5), n],
	},
	{
		label: "12m",
		title: "Last 12 months",
		group: "rolling",
		resolve: (n) => [
			new Date(n.getFullYear() - 1, n.getMonth(), n.getDate()),
			n,
		],
	},
	{
		label: "MTD",
		title: "Month to date",
		group: "toDate",
		resolve: (n) => [new Date(n.getFullYear(), n.getMonth(), 1), n],
	},
	{
		label: "QTD",
		title: "Quarter to date",
		group: "toDate",
		resolve: (n) => [
			new Date(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3, 1),
			n,
		],
	},
	{
		label: "YTD",
		title: "Year to date",
		group: "toDate",
		resolve: (n) => [new Date(n.getFullYear(), 0, 1), n],
	},
	{
		label: "Last yr",
		title: "The whole of last calendar year",
		group: "named",
		resolve: (n) => [
			new Date(n.getFullYear() - 1, 0, 1),
			new Date(n.getFullYear() - 1, 11, 31),
		],
	},
];

export function DateRangeFilter({
	visualId,
	sourceKey,
	field,
	label,
	mode = "combined",
	defaultPreset,
}: DateRangeProps) {
	const { setWidgetFilter, clausesExcept } = usePageFilters();
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [activePreset, setActivePreset] = useState<string | null>(null);

	// The boxes and the highlighted preset, brought into line with the range the
	// page opened on. The filter itself is already applied: it was in the
	// opening state before this rendered, which is what stopped the visuals
	// asking for everything first. This only makes the control say so.
	const shown = useRef(false);
	useEffect(() => {
		if (shown.current) return;
		shown.current = true;
		if (!defaultPreset) return;

		const preset = presets.find((p) => p.label === defaultPreset);
		if (!preset) return;

		const [start, end] = preset.resolve(startOfDay(new Date()));
		setFrom(iso(start));
		setTo(iso(end));
		setActivePreset(preset.label);
	}, [defaultPreset]);

	const showPresets = mode === "presets" || mode === "combined";
	const showCalendar = mode === "calendar" || mode === "combined";
	const showSlider = mode === "slider";

	const others = clausesExcept(visualId);

	// A slider needs the real extent of the column, so it is fetched rather
	// than assumed. The other modes do not need it and do not pay for it.
	const rangeResource = usePostResource<{
		min: string | null;
		max: string | null;
	}>(
		"/api/query/range",
		showSlider ? { sourceKey, field, filters: others } : null,
	);

	const bounds =
		rangeResource.data?.min && rangeResource.data?.max
			? {
					min: rangeResource.data.min.slice(0, 10),
					max: rangeResource.data.max.slice(0, 10),
				}
			: null;

	const apply = (nextFrom: string, nextTo: string) => {
		const clauses: FilterClause[] = [];
		if (nextFrom) clauses.push({ field, op: "gte", value: nextFrom });
		if (nextTo) clauses.push({ field, op: "lte", value: nextTo });
		setWidgetFilter(visualId, clauses);
	};

	const applyPreset = (preset: Preset) => {
		const [start, end] = preset.resolve(startOfDay(new Date()));
		setFrom(iso(start));
		setTo(iso(end));
		setActivePreset(preset.label);
		apply(iso(start), iso(end));
	};

	const clear = () => {
		setFrom("");
		setTo("");
		setActivePreset(null);
		setWidgetFilter(visualId, []);
	};

	const sliderValue = useMemo((): [number, number] => {
		if (!bounds) return [0, 1];
		const lo = new Date(from || bounds.min).getTime();
		const hi = new Date(to || bounds.max).getTime();
		return [lo, hi];
	}, [from, to, bounds]);

	// What the chip says when the range is set. The preset's own name where one
	// was chosen, because "12m" is what the reader picked and is shorter than
	// the two dates it resolves to.
	const short = (value: string) => {
		const date = value ? new Date(`${value}T00:00:00`) : null;
		return date && !Number.isNaN(date.getTime())
			? date.toLocaleDateString(undefined, {
					day: "numeric",
					month: "short",
					year: "2-digit",
				})
			: "";
	};
	const summary = activePreset
		? presets.find((p) => p.label === activePreset)?.title || activePreset
		: from && to
			? `${short(from)} to ${short(to)}`
			: from
				? `from ${short(from)}`
				: to
					? `to ${short(to)}`
					: null;

	return (
		<FilterChip
			label={label ?? field}
			value={summary}
			onClear={clear}
			width={showSlider ? 340 : 300}
		>
			{() => (
				<>
					{showPresets && (
						<div className={styles.segmented} role="group">
							{presets.map((preset, index) => (
								<Fragment key={preset.label}>
									{index > 0 &&
										presets[index - 1].group !==
											preset.group && (
											<span
												className={
													styles.segmentDivider
												}
												aria-hidden="true"
											/>
										)}
									<button
										type="button"
										title={preset.title}
										aria-pressed={
											activePreset === preset.label
										}
										className={`${styles.segment} ${styles.presetSegment} ${
											activePreset === preset.label
												? styles.segmentOn
												: ""
										}`}
										onClick={() => applyPreset(preset)}
									>
										{preset.label}
									</button>
								</Fragment>
							))}
						</div>
					)}

					{showCalendar && (
						<div className={styles.dateRow}>
							<DatePicker
								value={from}
								max={to || undefined}
								ariaLabel="From"
								placeholder="Any start"
								onChange={(next) => {
									setFrom(next);
									setActivePreset(null);
									apply(next, to);
								}}
							/>
							<span
								className={styles.rangeDash}
								aria-hidden="true"
							>
								to
							</span>
							<DatePicker
								value={to}
								min={from || undefined}
								ariaLabel="To"
								placeholder="Any end"
								onChange={(next) => {
									setTo(next);
									setActivePreset(null);
									apply(from, next);
								}}
							/>
						</div>
					)}

					{showSlider &&
						(bounds ? (
							<RangeSlider
								label={label ?? field}
								min={new Date(bounds.min).getTime()}
								max={new Date(bounds.max).getTime()}
								value={sliderValue}
								// A day, so a drag lands on a date rather than a time.
								step={864e5}
								format={(v) => iso(new Date(v))}
								onChange={([lo, hi]) => {
									setFrom(iso(new Date(lo)));
									setTo(iso(new Date(hi)));
									setActivePreset(null);
								}}
								// The query waits for the drag to finish: one per
								// pointer move would be a query per pixel.
								onCommit={([lo, hi]) =>
									apply(iso(new Date(lo)), iso(new Date(hi)))
								}
							/>
						) : (
							<span className={styles.hint}>
								Reading the date range
							</span>
						))}
				</>
			)}
		</FilterChip>
	);
}

// --- Numeric range ---------------------------------------------------------

export type NumericRangeMode = "inputs" | "slider" | "combined";

interface NumericRangeProps extends BaseProps {
	field: string;
	mode?: NumericRangeMode;
}

export function NumericRangeFilter({
	visualId,
	sourceKey,
	field,
	label,
	mode = "combined",
}: NumericRangeProps) {
	const { setWidgetFilter, clausesExcept } = usePageFilters();
	const [min, setMin] = useState("");
	const [max, setMax] = useState("");
	const others = clausesExcept(visualId);

	// Requested whenever a slider was asked for, so the fallback is decided
	// before anything renders rather than after a broken slider appears.
	const rangeResource = usePostResource<{
		min: string | null;
		max: string | null;
		degenerate?: boolean;
	}>(
		"/api/query/range",
		mode === "inputs" ? null : { sourceKey, field, filters: others },
	);

	const lo = Number(rangeResource.data?.min);
	const hi = Number(rangeResource.data?.max);
	const degenerate = rangeResource.data
		? Boolean(rangeResource.data.degenerate) || !(hi > lo)
		: false;
	const bounds =
		!degenerate && Number.isFinite(lo) && Number.isFinite(hi)
			? { min: lo, max: hi }
			: null;

	// A field whose bounds collapse to a single value cannot be sliced with a
	// slider. Rather than render one that spans nothing, the control falls back
	// to boxes and says why.
	const showInputs = mode === "inputs" || mode === "combined" || degenerate;
	const showSlider =
		(mode === "slider" || mode === "combined") && !degenerate;

	const apply = (lo: string, hi: string) => {
		const clauses: FilterClause[] = [];
		if (lo.trim() !== "")
			clauses.push({ field, op: "gte", value: lo.trim() });
		if (hi.trim() !== "")
			clauses.push({ field, op: "lte", value: hi.trim() });
		setWidgetFilter(visualId, clauses);
	};

	// Typing is debounced; dragging commits on release. Both avoid a query per
	// keystroke or per pixel.
	useEffect(() => {
		if (!showInputs) return;
		const timer = setTimeout(() => apply(min, max), 350);
		return () => clearTimeout(timer);
	}, [min, max, showInputs]);

	const sliderValue = useMemo((): [number, number] => {
		if (!bounds) return [0, 1];
		const lo = min === "" ? bounds.min : Number(min);
		const hi = max === "" ? bounds.max : Number(max);
		return [
			Number.isFinite(lo) ? lo : bounds.min,
			Number.isFinite(hi) ? hi : bounds.max,
		];
	}, [min, max, bounds]);

	// A step fine enough to reach any meaningful value without the handle
	// snapping in visible jumps.
	const step = bounds ? Math.max((bounds.max - bounds.min) / 500, 0.01) : 1;

	const compact = (v: number) =>
		Math.abs(v) >= 1e9
			? `${(v / 1e9).toFixed(1)}B`
			: Math.abs(v) >= 1e6
				? `${(v / 1e6).toFixed(1)}M`
				: Math.abs(v) >= 1e4
					? `${(v / 1e3).toFixed(0)}K`
					: v.toFixed(Math.abs(v) < 10 ? 2 : 0);

	const summary =
		min && max
			? `${compact(Number(min))} to ${compact(Number(max))}`
			: min
				? `over ${compact(Number(min))}`
				: max
					? `under ${compact(Number(max))}`
					: null;

	return (
		<FilterChip
			label={label ?? field}
			value={summary}
			onClear={() => {
				setMin("");
				setMax("");
				setWidgetFilter(visualId, []);
			}}
			width={showSlider ? 300 : 240}
		>
			{() => (
				<>
					{showSlider &&
						(bounds ? (
							<RangeSlider
								label={label ?? field}
								min={bounds.min}
								max={bounds.max}
								value={sliderValue}
								step={step}
								format={compact}
								onChange={([lo, hi]) => {
									setMin(String(lo));
									setMax(String(hi));
								}}
								onCommit={([lo, hi]) =>
									apply(String(lo), String(hi))
								}
							/>
						) : (
							<span className={styles.hint}>
								Reading the value range
							</span>
						))}

					{degenerate && mode !== "inputs" && (
						<span className={styles.hint}>
							This field has no spread to slide across, so it
							takes a minimum and maximum instead.
						</span>
					)}

					{showInputs && (
						<div className={styles.row}>
							<input
								type="number"
								className={styles.input}
								placeholder={
									bounds ? compact(bounds.min) : "Min"
								}
								value={min}
								aria-label="Minimum"
								onChange={(e) => setMin(e.target.value)}
							/>
							<span
								className={styles.rangeDash}
								aria-hidden="true"
							>
								to
							</span>
							<input
								type="number"
								className={styles.input}
								placeholder={
									bounds ? compact(bounds.max) : "Max"
								}
								value={max}
								aria-label="Maximum"
								onChange={(e) => setMax(e.target.value)}
							/>
						</div>
					)}
				</>
			)}
		</FilterChip>
	);
}

// --- Threshold -------------------------------------------------------------

interface ThresholdProps extends BaseProps {
	// The measure or numeric dimension the cutoff is tested against.
	field: string;
	// Which side of the cutoff to keep. An author picks the sense of the
	// question once; the reader only moves the number.
	direction?: "above" | "below";
	// Where the control starts, so a page opens on a useful answer rather than
	// on everything.
	defaultValue?: number | null;
}

// Keeps rows on one side of a cutoff the reader sets.
//
// Separate from the numeric range filter because a threshold is one bound, not
// two, and asking a reader to leave the other box empty to express "above
// 50,000" makes a simple question look like a form.
export function ThresholdFilter({
	visualId,
	field,
	label,
	direction = "above",
	defaultValue = null,
}: ThresholdProps) {
	const { setWidgetFilter } = usePageFilters();
	const [value, setValue] = useState(
		defaultValue === null ? "" : String(defaultValue),
	);
	const [sense, setSense] = useState<"above" | "below">(direction);

	const op = sense === "above" ? "gte" : "lte";

	// Debounced, so typing a five figure number is one query rather than five.
	useEffect(() => {
		const timer = setTimeout(() => {
			const trimmed = value.trim();
			setWidgetFilter(
				visualId,
				trimmed === "" || !Number.isFinite(Number(trimmed))
					? []
					: [{ field, op, value: trimmed }],
			);
		}, 350);
		return () => clearTimeout(timer);
	}, [value, op, field, visualId, setWidgetFilter]);

	return (
		<FilterChip
			label={label ?? field}
			value={value ? `${sense === "above" ? "≥" : "≤"} ${value}` : null}
			onClear={() => setValue("")}
			width={230}
		>
			{() => (
				<div className={styles.row}>
					<button
						type="button"
						className={styles.miniButton}
						onClick={() =>
							setSense(sense === "above" ? "below" : "above")
						}
						title="Switch which side of the cutoff is kept"
					>
						{sense === "above" ? "≥" : "≤"}
					</button>
					<input
						type="number"
						className={styles.input}
						placeholder="Any"
						value={value}
						autoFocus
						aria-label={`${label ?? field} threshold`}
						onChange={(e) => setValue(e.target.value)}
					/>
				</div>
			)}
		</FilterChip>
	);
}

// --- Filter group ----------------------------------------------------------

interface FilterGroupProps extends BaseProps {
	fields: string[];
}

// Several dropdowns an author grouped together.
//
// Each one carries its own widget key so the clauses stack rather than
// replacing each other, and so every dropdown can offer values narrowed by the
// others without narrowing by itself.
export function FilterGroup({ visualId, sourceKey, fields }: FilterGroupProps) {
	return (
		<>
			{fields.map((field) => (
				<DropdownFilter
					key={field}
					visualId={`${visualId}:${field}`}
					sourceKey={sourceKey}
					field={field}
					label={field}
					multiple
				/>
			))}
		</>
	);
}

// --- Toggle ----------------------------------------------------------------

interface ToggleProps extends BaseProps {
	field: string;
	// The value the field takes when the answer is yes. Configured rather than
	// assumed, because a flag is spelled differently in every warehouse: true,
	// Y, 1, "Active".
	onValue?: string;
	// Whether it starts on. A page whose whole subject is open orders should
	// open on open orders.
	defaultOn?: boolean;
}

// One condition, on or off.
//
// A dropdown can express this and reads badly for it: a list of two values
// where one of them is the whole point, behind a control that has to be opened
// to find out which is set. A flag the reader can see the state of without
// opening anything is a different control, not a configuration of that one.
export function ToggleFilter({
	visualId,
	field,
	label,
	onValue = "true",
	defaultOn = false,
}: ToggleProps) {
	const { setWidgetFilter, byWidget } = usePageFilters();
	const on = (byWidget[visualId]?.length ?? 0) > 0;

	// The opening state is seeded by lib/visuals/pageDefaults, so this only has
	// to report what is already applied. See the note there on why a default
	// applied after mount costs the page its widest query.
	void defaultOn;

	// A chip that switches where it stands. Everything else in the strip opens
	// something because it has a value to choose; this one has two states and
	// opening a popover to pick between them is the longer way round.
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			className={`${styles.chip} ${on ? styles.chipSet : ""}`}
			onClick={() =>
				setWidgetFilter(
					visualId,
					on ? [] : [{ field, op: "eq", values: [onValue] }],
				)
			}
		>
			<span className={styles.switchTrack} aria-hidden="true">
				<span
					className={`${styles.switchKnob} ${
						on ? styles.switchKnobOn : ""
					}`}
				/>
			</span>
			<span className={styles.chipLabel}>{label ?? field}</span>
		</button>
	);
}

// --- Presence --------------------------------------------------------------

interface PresenceProps extends BaseProps {
	field: string;
}

type Presence = "any" | "present" | "missing";

// Whether the field has a value at all.
//
// Not a value filter with a blank in the list: a missing value is not one of
// the values, and a dropdown reading distinct values will never offer it.
// Finding the rows nobody filled in is a common question and there was no way
// to ask it.
export function PresenceFilter({ visualId, field, label }: PresenceProps) {
	const { setWidgetFilter, byWidget } = usePageFilters();

	const current: Presence =
		byWidget[visualId]?.[0]?.op === "is_empty"
			? "missing"
			: byWidget[visualId]?.[0]?.op === "is_not_empty"
				? "present"
				: "any";

	const choose = (next: Presence) => {
		if (next === "any") {
			setWidgetFilter(visualId, []);
			return;
		}
		setWidgetFilter(visualId, [
			{ field, op: next === "missing" ? "is_empty" : "is_not_empty" },
		]);
	};

	const choices: { value: Presence; label: string }[] = [
		{ value: "any", label: "Any" },
		{ value: "present", label: "Has a value" },
		{ value: "missing", label: "Missing" },
	];

	return (
		<FilterChip
			label={label ?? field}
			value={
				current === "any"
					? null
					: (choices.find((c) => c.value === current)?.label ?? null)
			}
			onClear={() => choose("any")}
			width={220}
		>
			{(close) => (
				<div className={styles.segmented} role="group">
					{choices.map((choice) => (
						<button
							key={choice.value}
							type="button"
							aria-pressed={current === choice.value}
							className={`${styles.segment} ${
								current === choice.value ? styles.segmentOn : ""
							}`}
							onClick={() => {
								choose(choice.value);
								close();
							}}
						>
							{choice.label}
						</button>
					))}
				</div>
			)}
		</FilterChip>
	);
}

// --- Dimension switch ------------------------------------------------------

interface DimensionSwitchProps extends BaseProps {
	// The breakdowns an author offered, in the order they should appear.
	options: string[];
	// Which placeholder this control drives. A page may carry one of each, so
	// they are held separately rather than sharing a single selection.
	scope?: "breakdown" | "grain";
}

// Repoints several visuals at once.
//
// A page that would otherwise need one chart per breakdown ("by Division", "by
// GPO", "by Product") becomes one chart and this control. Visuals configured
// with the "<selected>" placeholder read whichever option is active, which is
// what the planning documents meant by that token.
export function DimensionSwitch({
	options,
	label,
	scope = "breakdown",
}: DimensionSwitchProps) {
	const {
		selectedDimension,
		setSelectedDimension,
		selectedGrain,
		setSelectedGrain,
	} = usePageFilters();

	const selected = scope === "grain" ? selectedGrain : selectedDimension;
	const setSelected =
		scope === "grain" ? setSelectedGrain : setSelectedDimension;
	const fallbackLabel = scope === "grain" ? "Grain" : "Break down by";

	// The first option is the default, so a page renders something sensible
	// before the reader touches anything.
	const active =
		selected && options.includes(selected) ? selected : options[0];

	useEffect(() => {
		if (!selected && options.length > 0) {
			setSelected(options[0]);
		}
	}, [selected, options, setSelected]);

	if (options.length === 0) return null;

	// A handful of options are buttons, because seeing them all at once is
	// faster than opening a menu. Beyond that a menu is the only thing that
	// fits.
	if (options.length <= 4) {
		return (
			<div className={styles.switchWrap}>
				<span className={styles.switchLabel}>
					{label ?? fallbackLabel}
				</span>
				<div className={styles.segmented} role="group">
					{options.map((option) => (
						<button
							key={option}
							type="button"
							className={`${styles.segment} ${
								option === active ? styles.segmentOn : ""
							}`}
							aria-pressed={option === active}
							onClick={() => setSelected(option)}
						>
							{option}
						</button>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className={styles.switchWrap} style={{ minWidth: 200 }}>
			<span className={styles.switchLabel}>{label ?? fallbackLabel}</span>
			<Select
				value={active}
				onChange={setSelected}
				ariaLabel={label ?? fallbackLabel}
				searchable={options.length > 12}
				options={options.map((option) => ({
					value: option,
					label: option,
				}))}
			/>
		</div>
	);
}

// --- The strip that holds them ---------------------------------------------

export function FilterBar({ children }: { children: React.ReactNode }) {
	const {
		activeClauses,
		clearAll,
		crossFilter,
		setCrossFilter,
		hasAnything,
		byWidget,
	} = usePageFilters();

	// A page with no controls and nothing selected has no strip. It used to
	// render regardless, which put an empty bar at the top of pages like the
	// fulfillment one: something that looked like a visual that had failed to
	// load, and that could not be selected in the editor because it was not
	// one.
	const hasControls = Children.toArray(children).some(Boolean);
	if (!hasControls && !hasAnything) return null;

	return (
		<div className={styles.bar}>
			{children}

			{/* A selection made by clicking a chart is shown here as well, so
			    a reader who cannot see the chart that produced it still knows
			    the page is filtered and how to undo it. */}
			{crossFilter && (
				<button
					type="button"
					className={`${styles.chip} ${styles.chipSet}`}
					onClick={() => setCrossFilter(null)}
					title="Clear this selection"
				>
					<span className={styles.chipLabel}>From selection</span>
					<span className={styles.chipValue}>
						{crossFilter.label}
					</span>
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M6 6l12 12M18 6L6 18" />
					</svg>
				</button>
			)}

			<div className={styles.barSpacer} />
			{hasAnything && (
				<button
					type="button"
					className={styles.clearAll}
					onClick={clearAll}
				>
					{activeClauses.length > 0
						? `Clear ${activeClauses.length} ${activeClauses.length === 1 ? "filter" : "filters"}`
						: "Reset"}
				</button>
			)}
		</div>
	);
}
