"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
	describeCondition,
	parseCondition,
	type Condition,
	type KnownField,
} from "../../lib/explore/conditions";
import type { SourceMeta } from "../visuals/types";
import styles from "./Explore.module.css";

// One bar that holds the whole question.
//
// A source, the columns wanted, and the conditions on them, each as a chip in
// the order it reads: "Sales · Division, Revenue · where Region is West
// or Region is East". Typing does everything: a field name adds a column, a
// field followed by an operator becomes a condition, "or" and "not" in front of
// a condition join or invert it, and a source name switches to that source.
// Nothing needs a separate panel, and the answer updates as the chips change.

interface Suggestion {
	key: string;
	group: "Filter" | "Fields" | "Sources" | "Values";
	label: string;
	hint?: string;
	// Shown beside the name for a field, so what picking it does is read in
	// the same glance as what it is called.
	kind?: "dimension" | "measure";
	// Already a column in the table.
	added?: boolean;
	apply: () => void;
	// Starts a condition on this field rather than adding it as a column.
	filter?: () => void;
}

// Values offered while a condition's value is typed. A handful: this is for
// finding the spelling, not browsing the column.
const valueSuggestions = 8;

export function ExploreBar({
	sources,
	source,
	columns,
	conditions,
	onSource,
	onColumns,
	onConditions,
}: {
	sources: SourceMeta[];
	source: SourceMeta | undefined;
	columns: string[];
	conditions: Condition[];
	onSource: (key: string) => void;
	onColumns: (next: string[]) => void;
	onConditions: (next: Condition[]) => void;
}) {
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	// "filter" when the Filter button opened the list, so choosing a field
	// starts a condition on it instead of adding it as a column.
	const [mode, setMode] = useState<"all" | "filter">("all");
	// How the next filter joins the ones already there. Chosen with the switch
	// in the list, and overridden by an "and" or "or" typed in front of it.
	const [nextJoin, setNextJoin] = useState<"and" | "or">("and");
	const [active, setActive] = useState(0);
	const [values, setValues] = useState<string[]>([]);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	const known: KnownField[] = useMemo(
		() =>
			source
				? [
						...source.dimensions.map((f) => ({
							name: f.name,
							kind: "dimension" as const,
						})),
						...source.measures.map((f) => ({
							name: f.name,
							kind: "measure" as const,
						})),
					]
				: [],
		[source],
	);
	const kindOf = useMemo(
		() => new Map(known.map((f) => [f.name, f.kind])),
		[known],
	);

	const parsed = useMemo(
		() => (source ? parseCondition(text, known) : null),
		[text, known, source],
	);

	// Values of the field being filtered, matching what has been typed after
	// the operator. Looked up in the warehouse under the reader's own access,
	// so it offers only values they could filter to.
	const lookupField =
		parsed &&
		kindOf.get(parsed.condition.field) === "dimension" &&
		["eq", "neq", "contains", "starts_with"].includes(parsed.condition.op)
			? parsed.condition.field
			: null;
	const lookupText = parsed?.typedValue ?? "";

	useEffect(() => {
		if (!source || !lookupField) {
			setValues([]);
			return;
		}
		let live = true;
		const timer = setTimeout(() => {
			void fetch("/api/query/values", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sourceKey: source.sourceKey,
					field: lookupField,
					search: lookupText || undefined,
					limit: valueSuggestions,
				}),
			})
				.then((r) => (r.ok ? r.json() : { values: [] }))
				.then((body) => {
					if (live)
						setValues(
							Array.isArray(body?.values) ? body.values : [],
						);
				})
				.catch(() => {
					if (live) setValues([]);
				});
		}, 200);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [source, lookupField, lookupText]);

	const reset = () => {
		setText("");
		setActive(0);
		inputRef.current?.focus();
	};

	const addCondition = (condition: Condition) => {
		const typedJoin = /^\s*(or|and)\s+/i.test(text);
		onConditions([
			...conditions,
			typedJoin ? condition : { ...condition, join: nextJoin },
		]);
		reset();
	};

	const suggestions: Suggestion[] = useMemo(() => {
		const out: Suggestion[] = [];
		const needle = text.trim().toLowerCase();

		// No source yet: the first thing to choose. Fields across every
		// source are offered too, so somebody who knows the measure but not
		// the dataset can start from the measure.
		if (!source) {
			for (const s of sources) {
				if (!needle || s.title.toLowerCase().includes(needle)) {
					out.push({
						key: `s:${s.sourceKey}`,
						group: "Sources",
						label: s.title,
						apply: () => {
							onSource(s.sourceKey);
							reset();
						},
					});
				}
			}
			if (needle.length >= 2) {
				for (const s of sources) {
					for (const f of [...s.dimensions, ...s.measures]) {
						if (out.length > 60) break;
						const label = f.displayName ?? f.name;
						if (!label.toLowerCase().includes(needle)) continue;
						out.push({
							key: `sf:${s.sourceKey}:${f.name}`,
							group: "Fields",
							label,
							hint: s.title,
							apply: () => {
								onSource(s.sourceKey);
								onColumns([f.name]);
								reset();
							},
						});
					}
				}
			}
			return out.slice(0, 60);
		}

		// A condition, complete or with its value still being typed.
		if (parsed) {
			const { condition, partial } = parsed;
			if (!partial) {
				out.push({
					key: "f:typed",
					group: "Filter",
					label: describeCondition(condition),
					hint:
						condition.join === "or" && conditions.length > 0
							? "or"
							: undefined,
					apply: () => addCondition(condition),
				});
			}
			for (const v of values) {
				const many = condition.values !== undefined;
				const chosen: Condition = many
					? {
							...condition,
							values: [
								...(condition.values ?? []).slice(0, -1),
								v,
							].filter((x, i, all) => all.indexOf(x) === i),
						}
					: { ...condition, value: v };
				out.push({
					key: `v:${v}`,
					group: "Values",
					label: describeCondition(chosen),
					apply: () => addCondition(chosen),
				});
			}
			return out;
		}

		const fieldsList = source
			? [
					...source.dimensions.map((f) => ({ f, kind: "dimension" })),
					...source.measures.map((f) => ({ f, kind: "measure" })),
				]
			: [];

		for (const { f, kind } of fieldsList) {
			const label = f.displayName ?? f.name;
			if (needle && !label.toLowerCase().includes(needle)) continue;
			const added = columns.includes(f.name);

			// Finishes the field name and leaves the cursor after an
			// operator, so the next thing typed is the value.
			const filter = () => {
				setText(
					`${text.match(/^\s*(or|and)\s+/i)?.[0] ?? ""}${f.name} ${
						kind === "measure" ? ">" : "="
					} `,
				);
				setMode("all");
				setOpen(true);
				inputRef.current?.focus();
			};

			out.push({
				key: `f:${f.name}`,
				group: "Fields",
				label,
				kind: kind as "dimension" | "measure",
				added,
				filter,
				apply:
					mode === "filter" || added
						? filter
						: () => {
								onColumns([...columns, f.name]);
								reset();
							},
			});
		}

		if (needle) {
			for (const s of sources) {
				if (s.sourceKey === source?.sourceKey) continue;
				if (!s.title.toLowerCase().includes(needle)) continue;
				out.push({
					key: `s:${s.sourceKey}`,
					group: "Sources",
					label: `Switch to ${s.title}`,
					apply: () => {
						onSource(s.sourceKey);
						reset();
					},
				});
			}
		}

		// Filters first when the text is heading that way, columns first
		// otherwise, which is the order somebody reading down expects.
		const order = ["Filter", "Values", "Fields", "Sources"];
		return out
			.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
			.slice(0, 60);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text, source, sources, columns, conditions, parsed, values, mode]);

	useEffect(() => {
		setActive(0);
	}, [text, source?.sourceKey]);

	// Closes on a press anywhere outside the bar and its list.
	useEffect(() => {
		if (!open) return;
		const away = (e: MouseEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) {
				setOpen(false);
				setMode("all");
			}
		};
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, [open]);

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setOpen(true);
			setActive((n) => Math.min(n + 1, suggestions.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((n) => Math.max(n - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			// Shift+Enter filters by the highlighted field instead of adding
			// it, so both are reachable without the mouse.
			const chosen = suggestions[active];
			if (e.shiftKey && chosen?.filter) chosen.filter();
			else chosen?.apply();
		} else if (e.key === "Escape") {
			setOpen(false);
		} else if (e.key === "Backspace" && text === "") {
			// Takes back the last thing added, the way removing the last
			// token works in any address field.
			if (conditions.length > 0) {
				onConditions(conditions.slice(0, -1));
			} else if (columns.length > 0) {
				onColumns(columns.slice(0, -1));
			}
		}
	};

	const measureNames = new Set(source?.measures.map((m) => m.name) ?? []);
	const label = (name: string) => {
		const f = [
			...(source?.dimensions ?? []),
			...(source?.measures ?? []),
		].find((x) => x.name === name);
		return f?.displayName ?? name;
	};

	let lastGroup = "";

	return (
		<div className={styles.barWrap} ref={wrapRef}>
			<div
				className={styles.bar}
				onClick={() => {
					inputRef.current?.focus();
					setOpen(true);
				}}
			>
				<svg
					className={styles.barIcon}
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="7" />
					<path d="M21 21l-4.3-4.3" />
				</svg>

				{source && (
					<span className={`${styles.chip} ${styles.chipSource}`}>
						{source.title}
						<button
							type="button"
							className={styles.chipX}
							aria-label="Clear the source"
							onClick={(e) => {
								e.stopPropagation();
								onSource("");
							}}
						>
							×
						</button>
					</span>
				)}

				{columns.map((name) => (
					<span
						key={name}
						className={`${styles.chip} ${
							measureNames.has(name) ? styles.chipMeasure : ""
						}`}
					>
						{label(name)}
						<button
							type="button"
							className={styles.chipX}
							aria-label={`Remove ${label(name)}`}
							onClick={(e) => {
								e.stopPropagation();
								onColumns(columns.filter((c) => c !== name));
							}}
						>
							×
						</button>
					</span>
				))}

				{conditions.length > 0 && (
					<span className={styles.where}>where</span>
				)}

				{conditions.map((condition, i) => (
					<span key={i} className={styles.conditionRun}>
						{i > 0 && (
							// Joins this condition to the one before. A click
							// flips it, which is the whole of choosing AND or
							// OR.
							<button
								type="button"
								className={`${styles.join} ${
									condition.join === "or" ? styles.joinOr : ""
								}`}
								title={
									condition.join === "or"
										? "OR: rows matching either side are kept. Click for AND."
										: "AND: rows must match both. Click for OR."
								}
								onClick={(e) => {
									e.stopPropagation();
									onConditions(
										conditions.map((c, n) =>
											n === i
												? {
														...c,
														join:
															c.join === "or"
																? "and"
																: "or",
													}
												: c,
										),
									);
								}}
							>
								{condition.join}
							</button>
						)}
						<span
							className={`${styles.chip} ${styles.chipCondition} ${
								condition.negate ? styles.chipNegated : ""
							}`}
						>
							<button
								type="button"
								className={`${styles.not} ${
									condition.negate ? styles.notOn : ""
								}`}
								title="Exclude instead of include"
								aria-pressed={condition.negate}
								onClick={(e) => {
									e.stopPropagation();
									onConditions(
										conditions.map((c, n) =>
											n === i
												? { ...c, negate: !c.negate }
												: c,
										),
									);
								}}
							>
								not
							</button>
							{/* Clicking the text puts it back in the box to
							    edit, which is quicker than a form for a
							    condition that was typed in the first place. */}
							<button
								type="button"
								className={styles.chipText}
								title="Edit"
								onClick={(e) => {
									e.stopPropagation();
									setText(
										`${i > 0 && condition.join === "or" ? "or " : ""}${describeCondition(condition)}`,
									);
									onConditions(
										conditions.filter((_, n) => n !== i),
									);
									inputRef.current?.focus();
									setOpen(true);
								}}
							>
								{describeCondition({
									...condition,
									negate: false,
								})}
							</button>
							<button
								type="button"
								className={styles.chipX}
								aria-label="Remove this condition"
								onClick={(e) => {
									e.stopPropagation();
									onConditions(
										conditions.filter((_, n) => n !== i),
									);
								}}
							>
								×
							</button>
						</span>
					</span>
				))}

				<input
					ref={inputRef}
					className={styles.barInput}
					value={text}
					placeholder={
						!source
							? "Search a dataset or a field"
							: columns.length === 0
								? "Add columns, or type a filter like Division = Hardware"
								: "Add a column, or a filter: Region = West, or Revenue > 1000, not Status = DRAFT"
					}
					aria-label="Build a query"
					aria-expanded={open}
					aria-autocomplete="list"
					onFocus={() => setOpen(true)}
					onChange={(e) => {
						setText(e.target.value);
						setOpen(true);
					}}
					onKeyDown={onKeyDown}
				/>

				{source && (
					<button
						type="button"
						className={`${styles.barFilter} ${
							mode === "filter" && open ? styles.barFilterOn : ""
						}`}
						onClick={(e) => {
							e.stopPropagation();
							setText("");
							setMode("filter");
							setOpen(true);
							inputRef.current?.focus();
						}}
						title="Filter by a field"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M3 5h18l-7 8v6l-4 2v-8z" />
						</svg>
						Filter
					</button>
				)}
			</div>

			{open && suggestions.length > 0 && (
				<ul className={styles.suggestions} role="listbox">
					{conditions.length > 0 && (
						<li
							className={styles.joinSwitchRow}
							role="presentation"
						>
							<span className={styles.joinSwitchLabel}>
								Next filter joins with
							</span>
							<span
								className={styles.joinSwitch}
								role="group"
								aria-label="Join the next filter with"
							>
								{(["and", "or"] as const).map((j) => (
									<button
										key={j}
										type="button"
										className={`${styles.joinOption} ${
											nextJoin === j
												? styles.joinOptionOn
												: ""
										}`}
										aria-pressed={nextJoin === j}
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => setNextJoin(j)}
									>
										{j}
									</button>
								))}
							</span>
							<span className={styles.joinSwitchHint}>
								{nextJoin === "and"
									? "rows must match every filter"
									: "rows may match either side"}
							</span>
						</li>
					)}
					{suggestions.map((s, i) => {
						const heading = s.group !== lastGroup ? s.group : null;
						lastGroup = s.group;
						return (
							<li key={s.key} role="presentation">
								{heading && (
									<div className={styles.suggestionGroup}>
										{heading}
									</div>
								)}
								<div
									className={`${styles.suggestionRow} ${
										i === active ? styles.suggestionOn : ""
									}`}
									onMouseEnter={() => setActive(i)}
								>
									<button
										type="button"
										role="option"
										aria-selected={i === active}
										className={styles.suggestion}
										onMouseDown={(e) => e.preventDefault()}
										onClick={s.apply}
									>
										<span
											className={styles.suggestionLabel}
										>
											{s.label}
										</span>
										{s.kind && (
											<span
												className={`${styles.kindBadge} ${
													s.kind === "measure"
														? styles.kindMeasure
														: ""
												}`}
											>
												{s.kind}
											</span>
										)}
										{s.added && (
											<span className={styles.addedTag}>
												in table
											</span>
										)}
										{s.hint && (
											<span
												className={
													styles.suggestionHint
												}
											>
												{s.hint}
											</span>
										)}
									</button>
									{s.filter && (
										<button
											type="button"
											className={styles.filterAction}
											onMouseDown={(e) =>
												e.preventDefault()
											}
											onClick={s.filter}
											title={`Filter by ${s.label}`}
											tabIndex={-1}
										>
											<svg
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
												aria-hidden="true"
											>
												<path d="M3 5h18l-7 8v6l-4 2v-8z" />
											</svg>
											Filter
										</button>
									)}
								</div>
							</li>
						);
					})}
					{source && suggestions.some((x) => x.filter) && (
						<li
							className={styles.suggestionFoot}
							role="presentation"
						>
							{mode === "filter"
								? "Choose a field to filter by"
								: "Enter adds a column · Shift+Enter or Filter narrows the rows"}
						</li>
					)}
				</ul>
			)}
		</div>
	);
}
