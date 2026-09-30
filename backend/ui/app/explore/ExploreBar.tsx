"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
	describeCondition,
	openDepth,
	withoutBracket,
	withoutCondition,
	parseCondition,
	type Condition,
	type KnownField,
} from "../../lib/explore/conditions";
import type { SourceMeta } from "../visuals/types";
import styles from "./Explore.module.css";

// One bar that holds the whole question.
//
// A source, the columns wanted, and the conditions on them, each as a chip in
// the order it reads: "Sales · Category, Revenue · where Region is West
// or Region is East". Typing does everything: a field name adds a column, a
// field followed by an operator becomes a condition, "or" and "not" in front of
// a condition join or invert it, and a source name switches to that source.
// Nothing needs a separate panel, and the answer updates as the chips change.

interface Suggestion {
	key: string;
	group: "Filter" | "Operator" | "Fields" | "Sources" | "Values";
	label: string;
	hint?: string;
	// Shown beside the name for a field, so what picking it does is read in
	// the same glance as what it is called.
	kind?: "dimension" | "measure";
	// Already a column in the table.
	added?: boolean;
	// The comparison's sign, drawn in front of an operator choice.
	symbol?: string;
	apply: () => void;
	// Starts a condition on this field rather than adding it as a column.
	filter?: () => void;
}

// Values offered while a condition's value is typed. A handful: this is for
// finding the spelling, not browsing the column.
const valueSuggestions = 8;

// The comparisons offered once a field is chosen to filter by, so nobody has
// to know that "not equal" is typed != or that a range is >=. Each is written
// into the box in the spelling the bar reads, so what was picked can still be
// edited by hand.
interface OperatorChoice {
	// What is typed after the field.
	word: string;
	symbol: string;
	label: string;
	// Takes no value, so choosing it adds the condition at once.
	valueless?: boolean;
	// Takes a list of values separated by commas.
	many?: boolean;
}

const operators: Record<string, OperatorChoice> = {
	eq: { word: "=", symbol: "=", label: "is" },
	neq: { word: "!=", symbol: "≠", label: "is not" },
	gt: { word: ">", symbol: ">", label: "greater than" },
	gte: { word: ">=", symbol: "≥", label: "at least" },
	lt: { word: "<", symbol: "<", label: "less than" },
	lte: { word: "<=", symbol: "≤", label: "at most" },
	in: { word: "in", symbol: "∈", label: "any of", many: true },
	notIn: { word: "not in", symbol: "∉", label: "none of", many: true },
	contains: { word: "contains", symbol: "⊃", label: "contains" },
	starts: { word: "starts with", symbol: "a…", label: "starts with" },
	ends: { word: "ends with", symbol: "…z", label: "ends with" },
	empty: {
		word: "is empty",
		symbol: "∅",
		label: "is empty",
		valueless: true,
	},
	filled: {
		word: "is not empty",
		symbol: "≠∅",
		label: "is not empty",
		valueless: true,
	},
};

// Which comparisons make sense for a field. A measure is a number worked out
// per group, so it is compared, never searched. A dimension holding numbers or
// dates is compared and matched, and one holding text is matched and
// searched.
function operatorsFor(
	kind: "dimension" | "measure" | undefined,
	dataType: string | null | undefined,
): OperatorChoice[] {
	const o = operators;
	if (kind === "measure") return [o.gt, o.gte, o.lt, o.lte, o.eq, o.neq];
	const ordered =
		/int|double|decimal|float|long|numeric|date|timestamp/i.test(
			dataType ?? "",
		);
	return ordered
		? [
				o.eq,
				o.neq,
				o.gt,
				o.gte,
				o.lt,
				o.lte,
				o.in,
				o.notIn,
				o.empty,
				o.filled,
			]
		: [
				o.eq,
				o.neq,
				o.contains,
				o.starts,
				o.ends,
				o.in,
				o.notIn,
				o.empty,
				o.filled,
			];
}

// What leads a condition in the box: a join, brackets, a "not". Kept when the
// field or the operator is written after it.
const leadPattern = /^\s*((or|and)\s+)?(\(+\s*)?(not\s+)?(\(+\s*)?/i;

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
	// Values looked up for one field, kept with the field they belong to so a
	// list read for the previous field is never offered for the next one.
	const [lookedUp, setLookedUp] = useState<{
		field: string;
		values: string[];
	} | null>(null);
	// A column chip whose menu is open.
	const [chipMenu, setChipMenu] = useState<string | null>(null);
	// A column being swapped for another: the next field picked takes its
	// place rather than being added at the end.
	const [replacing, setReplacing] = useState<string | null>(null);
	// Datasets offered on their own, after a click on the dataset chip.
	const [switching, setSwitching] = useState(false);
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
	const typeOf = useMemo(
		() =>
			new Map(
				[
					...(source?.dimensions ?? []),
					...(source?.measures ?? []),
				].map((f) => [f.name, f.dataType]),
			),
		[source],
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
	const values = useMemo(
		() =>
			lookedUp && lookedUp.field === lookupField ? lookedUp.values : [],
		[lookedUp, lookupField],
	);

	useEffect(() => {
		if (!source || !lookupField) {
			setLookedUp(null);
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
						setLookedUp({
							field: lookupField,
							values: Array.isArray(body?.values)
								? body.values
								: [],
						});
				})
				.catch(() => {
					if (live) setLookedUp(null);
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
		setReplacing(null);
		setSwitching(false);
		inputRef.current?.focus();
	};

	// A field named with nothing after it yet, which is the moment to offer
	// the comparisons.
	const lead = leadPattern.exec(text)?.[0] ?? "";
	const fieldOnly = useMemo(() => {
		if (!source) return null;
		const rest = text.slice(lead.length).trim().toLowerCase();
		if (!rest) return null;
		return known.find((f) => f.name.toLowerCase() === rest) ?? null;
	}, [text, lead, known, source]);

	// Starts a filter on a field: its name in the box, the comparisons in the
	// list.
	const startFilter = (name: string) => {
		setText(`${lead}${name} `);
		setMode("all");
		setOpen(true);
		setChipMenu(null);
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

		if (switching && source) {
			for (const s of sources) {
				if (needle && !s.title.toLowerCase().includes(needle)) continue;
				out.push({
					key: `s:${s.sourceKey}`,
					group: "Sources",
					label: s.title,
					added: s.sourceKey === source.sourceKey,
					apply: () => {
						if (s.sourceKey !== source.sourceKey)
							onSource(s.sourceKey);
						reset();
					},
				});
			}
			return out.slice(0, 60);
		}

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

		// A field on its own: how to compare it.
		if (fieldOnly && !parsed) {
			for (const o of operatorsFor(
				fieldOnly.kind,
				typeOf.get(fieldOnly.name),
			)) {
				const body = `${lead}${fieldOnly.name} ${o.word}`;
				out.push({
					key: `o:${o.word}`,
					group: "Operator",
					label: `${fieldOnly.name} ${o.label}`,
					symbol: o.symbol,
					apply: () => {
						if (o.valueless) {
							const done = parseCondition(body, known);
							if (done) addCondition(done.condition);
							return;
						}
						setText(`${body} `);
						inputRef.current?.focus();
					},
				});
			}
			return out;
		}

		// A condition, complete or with its value still being typed.
		if (parsed) {
			const { condition, partial } = parsed;
			if (!partial) {
				out.push({
					key: "f:typed",
					group: "Filter",
					label: describeCondition(condition, true),
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
					label: describeCondition(chosen, true),
					apply: () => addCondition(chosen),
				});
			}

			// The other comparisons for the same field, keeping what was typed
			// after the operator, so changing "is" to "is not" is a click.
			const typed = condition.values?.join(", ") ?? condition.value ?? "";
			for (const o of operatorsFor(
				kindOf.get(condition.field),
				typeOf.get(condition.field),
			)) {
				const body = `${lead}${condition.field} ${o.word}`;
				const next = o.valueless ? body : `${body} ${typed}`;
				const reparsed = parseCondition(next, known);
				if (
					reparsed &&
					reparsed.condition.op === condition.op &&
					Boolean(reparsed.condition.values) ===
						Boolean(condition.values)
				) {
					continue;
				}
				out.push({
					key: `o:${o.word}`,
					group: "Operator",
					label: `${condition.field} ${o.label}${!o.valueless && typed ? ` ${typed}` : ""}`,
					symbol: o.symbol,
					apply: () => {
						if (reparsed && !reparsed.partial) {
							setText(next);
						} else {
							setText(`${body} `);
						}
						inputRef.current?.focus();
					},
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

			// Names the field and lists how it can be compared.
			const filter = () => startFilter(f.name);

			out.push({
				key: `f:${f.name}`,
				group: "Fields",
				label,
				kind: kind as "dimension" | "measure",
				added,
				filter,
				apply: replacing
					? () => {
							onColumns(
								added
									? columns.filter((c) => c !== replacing)
									: columns.map((c) =>
											c === replacing ? f.name : c,
										),
							);
							reset();
						}
					: mode === "filter" || added
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
		const order = ["Filter", "Values", "Operator", "Fields", "Sources"];
		return out
			.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
			.slice(0, 60);
	}, [
		text,
		source,
		sources,
		columns,
		conditions,
		parsed,
		values,
		mode,
		fieldOnly,
		replacing,
		switching,
	]);

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
				setReplacing(null);
				setSwitching(false);
			}
		};
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, [open]);

	// A column's menu closes on a press anywhere outside it.
	useEffect(() => {
		if (!chipMenu) return;
		const away = () => setChipMenu(null);
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, [chipMenu]);

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
			setChipMenu(null);
			setReplacing(null);
			setSwitching(false);
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
						<button
							type="button"
							className={styles.chipText}
							title="Switch to another dataset"
							onClick={(e) => {
								e.stopPropagation();
								setText("");
								setSwitching(true);
								setChipMenu(null);
								setOpen(true);
								inputRef.current?.focus();
							}}
						>
							<svg
								className={styles.sourceIcon}
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<ellipse cx="12" cy="5" rx="8" ry="3" />
								<path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
							</svg>
							{source.title}
						</button>
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

				{columns.map((name, index) => (
					<span
						key={name}
						className={`${styles.chip} ${styles.chipColumn} ${
							measureNames.has(name) ? styles.chipMeasure : ""
						} ${replacing === name ? styles.chipReplacing : ""}`}
					>
						<button
							type="button"
							className={styles.chipText}
							aria-haspopup="menu"
							aria-expanded={chipMenu === name}
							onMouseDown={(e) => e.stopPropagation()}
							title="Filter, replace, move or remove"
							onClick={(e) => {
								e.stopPropagation();
								setChipMenu(chipMenu === name ? null : name);
								setOpen(false);
							}}
						>
							{label(name)}
						</button>
						{chipMenu === name && (
							<span
								className={styles.chipMenu}
								role="menu"
								onClick={(e) => e.stopPropagation()}
								onMouseDown={(e) => e.stopPropagation()}
							>
								<button
									type="button"
									role="menuitem"
									className={styles.chipMenuItem}
									onClick={() => startFilter(name)}
								>
									Filter by {label(name)}
								</button>
								<button
									type="button"
									role="menuitem"
									className={styles.chipMenuItem}
									onClick={() => {
										setChipMenu(null);
										setReplacing(name);
										setText("");
										setMode("all");
										setOpen(true);
										inputRef.current?.focus();
									}}
								>
									Replace with another field
								</button>
								{index > 0 && (
									<button
										type="button"
										role="menuitem"
										className={styles.chipMenuItem}
										onClick={() => {
											const next = [...columns];
											next.splice(
												index - 1,
												0,
												next.splice(index, 1)[0],
											);
											onColumns(next);
											setChipMenu(null);
										}}
									>
										Move left
									</button>
								)}
								{index < columns.length - 1 && (
									<button
										type="button"
										role="menuitem"
										className={styles.chipMenuItem}
										onClick={() => {
											const next = [...columns];
											next.splice(
												index + 1,
												0,
												next.splice(index, 1)[0],
											);
											onColumns(next);
											setChipMenu(null);
										}}
									>
										Move right
									</button>
								)}
								<button
									type="button"
									role="menuitem"
									className={`${styles.chipMenuItem} ${styles.chipMenuDanger}`}
									onClick={() => {
										onColumns(
											columns.filter((c) => c !== name),
										);
										setChipMenu(null);
									}}
								>
									Remove
								</button>
							</span>
						)}
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
						{Array.from({ length: condition.open ?? 0 }, (_, b) => (
							<button
								key={`o${b}`}
								type="button"
								className={styles.bracket}
								title="Remove this bracket and its pair"
								onClick={(e) => {
									e.stopPropagation();
									onConditions(
										withoutBracket(
											conditions,
											i,
											"open",
											b,
										),
									);
								}}
							>
								(
							</button>
						))}
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
										`${i > 0 && condition.join === "or" ? "or " : ""}${describeCondition(condition, true)}`,
									);
									// Taken out whole, brackets and all, since
									// the text carries them back in.
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
										withoutCondition(conditions, i),
									);
								}}
							>
								×
							</button>
						</span>
						{Array.from(
							{ length: condition.close ?? 0 },
							(_, b) => (
								<button
									key={`c${b}`}
									type="button"
									className={styles.bracket}
									title="Remove this bracket and its pair"
									onClick={(e) => {
										e.stopPropagation();
										onConditions(
											withoutBracket(
												conditions,
												i,
												"close",
												b,
											),
										);
									}}
								>
									)
								</button>
							),
						)}
					</span>
				))}

				<input
					ref={inputRef}
					className={styles.barInput}
					value={text}
					placeholder={
						switching
							? "Search the datasets"
							: replacing
								? `Replace ${label(replacing)} with`
								: !source
									? "Search a dataset or a field"
									: columns.length === 0
										? "Add columns, or type a filter like Category = Hardware"
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
							<span
								className={styles.bracketTools}
								role="group"
								aria-label="Group filters"
							>
								<button
									type="button"
									className={styles.joinOption}
									title="Open a bracket before the next filter"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => {
										setText((t) => {
											const lead =
												/^\s*((or|and)\s+)?/i.exec(
													t,
												)?.[0] ?? "";
											return `${lead}(${t.slice(lead.length)}`;
										});
										inputRef.current?.focus();
									}}
								>
									(
								</button>
								<button
									type="button"
									className={styles.joinOption}
									title="Close the open bracket after the last filter"
									disabled={
										openDepth(conditions) === 0 &&
										!text.includes("(")
									}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => {
										if (text.trim()) {
											setText((t) => `${t.trimEnd()})`);
										} else if (openDepth(conditions) > 0) {
											const last = conditions.length - 1;
											onConditions(
												conditions.map((c, n) =>
													n === last
														? {
																...c,
																close:
																	(c.close ??
																		0) + 1,
															}
														: c,
												),
											);
										}
										inputRef.current?.focus();
									}}
								>
									)
								</button>
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
										{s.symbol && (
											<span
												className={styles.operatorSign}
												aria-hidden="true"
											>
												{s.symbol}
											</span>
										)}
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
							{replacing
								? `Choose the field to put in place of ${label(replacing)}`
								: mode === "filter"
									? "Choose a field to filter by"
									: "Enter adds a column · Shift+Enter or Filter narrows the rows · ( ) groups filters"}
						</li>
					)}
				</ul>
			)}
		</div>
	);
}
