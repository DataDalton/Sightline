"use client";

import { useState, type ReactNode } from "react";
import useSWR from "swr";
import { describeFetchError } from "../../lib/swr";
import {
	defaultConfig,
	type Choice,
	type ColumnDef,
	type EffortChoice,
	type RequiredField,
	type WorkConfig,
	type WorkTypeChoice,
} from "../../lib/work/model";
import { SkeletonText } from "../components/shared/Skeleton";
import { Toggle } from "../components/shared/Toggle";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import styles from "./Admin.module.css";
import pane from "./WorkQueuePane.module.css";

// How the work queue is set up. Edits a local copy of the configuration and
// saves the whole of it in one request.

const defaultColumnIds = new Set(defaultConfig.columns.map((c) => c.id));

const requiredLabels: Record<RequiredField, string> = {
	workType: "Work type",
	priority: "Priority",
	effort: "Effort",
	domain: "Domain",
	layer: "Layer",
	assignees: "Somebody assigned",
	reviewer: "Reviewer",
	approver: "Approver",
	target: "Target date",
	criteria: "Acceptance criteria",
};

const requiredFields = Object.keys(requiredLabels) as RequiredField[];

// A camelCase id from a label, such as "Ready to ship" to "readyToShip",
// numbered when the plain form is already taken.
function idFromLabel(label: string, taken: Iterable<string>): string {
	const words = label
		.trim()
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase());
	let base = words
		.map((word, index) =>
			index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1),
		)
		.join("");
	if (!base || /^[0-9]/.test(base)) base = `item${base}`;
	const used = new Set(taken);
	if (!used.has(base)) return base;
	let n = 2;
	while (used.has(`${base}${n}`)) n++;
	return `${base}${n}`;
}

function moved<T>(list: T[], index: number, by: -1 | 1): T[] {
	const to = index + by;
	if (to < 0 || to >= list.length) return list;
	const next = [...list];
	[next[index], next[to]] = [next[to], next[index]];
	return next;
}

function withoutKey<V>(record: Record<string, V>, key: string) {
	const next = { ...record };
	delete next[key];
	return next;
}

// --- Icons ------------------------------------------------------------------

function Icon({ children }: { children: ReactNode }) {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

const upIcon = (
	<Icon>
		<path d="M18 15l-6-6-6 6" />
	</Icon>
);
const downIcon = (
	<Icon>
		<path d="M6 9l6 6 6-6" />
	</Icon>
);
const removeIcon = (
	<Icon>
		<path d="M18 6L6 18M6 6l12 12" />
	</Icon>
);

// --- Building blocks --------------------------------------------------------

function Group({
	title,
	blurb,
	children,
}: {
	title: string;
	blurb: string;
	children: ReactNode;
}) {
	return (
		<section className={styles.settingGroup}>
			<div className={styles.settingGroupHead}>
				<h3 className={styles.settingGroupTitle}>{title}</h3>
				<p className={styles.settingGroupBlurb}>{blurb}</p>
			</div>
			{children}
		</section>
	);
}

function SwitchRow({
	label,
	hint,
	checked,
	onChange,
}: {
	label: string;
	hint: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<div className={styles.switchSetting}>
			<div className={styles.switchText}>
				<span className={styles.fieldLabel}>{label}</span>
				<span className={styles.fieldHint}>{hint}</span>
			</div>
			<Toggle checked={checked} onChange={onChange} ariaLabel={label} />
		</div>
	);
}

// Move up, move down and remove for one row of a list.
function RowButtons({
	label,
	index,
	count,
	onMove,
	onRemove,
}: {
	label: string;
	index: number;
	count: number;
	onMove: (by: -1 | 1) => void;
	onRemove?: () => void;
}) {
	return (
		<span className={pane.rowButtons}>
			<button
				type="button"
				className={pane.iconButton}
				onClick={() => onMove(-1)}
				disabled={index === 0}
				aria-label={`Move ${label} up`}
				title="Move up"
			>
				{upIcon}
			</button>
			<button
				type="button"
				className={pane.iconButton}
				onClick={() => onMove(1)}
				disabled={index === count - 1}
				aria-label={`Move ${label} down`}
				title="Move down"
			>
				{downIcon}
			</button>
			{onRemove ? (
				<button
					type="button"
					className={`${pane.iconButton} ${pane.removeButton}`}
					onClick={onRemove}
					aria-label={`Remove ${label}`}
					title="Remove"
				>
					{removeIcon}
				</button>
			) : (
				<span className={pane.iconSpacer} />
			)}
		</span>
	);
}

// A text box and a button that adds a named entry, cleared once added.
function AddRow({
	placeholder,
	onAdd,
}: {
	placeholder: string;
	onAdd: (label: string) => void;
}) {
	const [text, setText] = useState("");
	const add = () => {
		const label = text.trim();
		if (!label) return;
		onAdd(label);
		setText("");
	};
	return (
		<div className={pane.addRow}>
			<input
				className={styles.input}
				value={text}
				placeholder={placeholder}
				aria-label={placeholder}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						add();
					}
				}}
			/>
			<button
				type="button"
				className={pane.addButton}
				onClick={add}
				disabled={!text.trim()}
			>
				Add
			</button>
		</div>
	);
}

// A list of strings edited as text, split on commas or on lines. The text is
// held locally so a trailing separator survives while typing, and is reset
// when the list changes from outside, such as after a discard.
function ListText({
	value,
	onChange,
	split,
	label,
	placeholder,
}: {
	value: string[];
	onChange: (value: string[]) => void;
	split: "comma" | "line";
	label: string;
	placeholder?: string;
}) {
	const joiner = split === "comma" ? ", " : "\n";
	const parse = (text: string) =>
		text
			.split(split === "comma" ? "," : "\n")
			.map((part) => part.trim())
			.filter(Boolean);
	const joined = value.join(joiner);
	const [text, setText] = useState(joined);
	const [seen, setSeen] = useState(joined);
	if (joined !== seen) {
		setSeen(joined);
		if (parse(text).join(joiner) !== joined) setText(joined);
	}
	const change = (next: string) => {
		setText(next);
		onChange(parse(next));
	};
	return split === "comma" ? (
		<input
			className={styles.input}
			value={text}
			placeholder={placeholder}
			aria-label={label}
			onChange={(e) => change(e.target.value)}
		/>
	) : (
		<textarea
			className={`${styles.input} ${pane.textarea}`}
			value={text}
			placeholder={placeholder}
			aria-label={label}
			rows={Math.max(2, value.length + 1)}
			onChange={(e) => change(e.target.value)}
		/>
	);
}

// A whole number, or blank for none.
function OptionalNumber({
	value,
	onChange,
	label,
	unit,
}: {
	value: number | null | undefined;
	onChange: (value: number | null) => void;
	label: string;
	unit: string;
}) {
	return (
		<span className={styles.numberBox}>
			<input
				type="number"
				min={0}
				className={styles.numberInput}
				value={value ?? ""}
				placeholder="None"
				aria-label={label}
				onChange={(e) => {
					const raw = e.target.value.trim();
					const number = Number(raw);
					onChange(
						raw === "" || !Number.isFinite(number)
							? null
							: Math.max(0, number),
					);
				}}
			/>
			<span className={styles.numberUnit}>{unit}</span>
		</span>
	);
}

function CheckList({
	options,
	selected,
	onChange,
	empty,
}: {
	options: { id: string; label: string }[];
	selected: string[];
	onChange: (selected: string[]) => void;
	empty?: string;
}) {
	if (options.length === 0) {
		return (
			<p className={styles.fieldHint}>{empty ?? "Nothing to pick."}</p>
		);
	}
	return (
		<div className={pane.checks}>
			{options.map((option) => (
				<label key={option.id} className={pane.check}>
					<input
						type="checkbox"
						checked={selected.includes(option.id)}
						onChange={(e) =>
							onChange(
								e.target.checked
									? [...selected, option.id]
									: selected.filter((id) => id !== option.id),
							)
						}
					/>
					{option.label}
				</label>
			))}
		</div>
	);
}

// One editable list of choices. Extra fields for a row, such as an effort's
// hours, come from renderExtra.
function ChoiceList<T extends Choice>({
	items,
	onChange,
	onRemove,
	makeItem,
	addPlaceholder,
	emptyText,
	renderExtra,
}: {
	items: T[];
	onChange: (items: T[]) => void;
	onRemove: (item: T) => void;
	makeItem: (id: string, label: string) => T;
	addPlaceholder: string;
	emptyText?: string;
	renderExtra?: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
}) {
	const update = (index: number, patch: Partial<T>) =>
		onChange(
			items.map((item, i) =>
				i === index ? { ...item, ...patch } : item,
			),
		);
	return (
		<div className={pane.list}>
			{items.length === 0 && emptyText && (
				<p className={styles.fieldHint}>{emptyText}</p>
			)}
			{items.map((item, index) => (
				<div key={item.id} className={pane.listItem}>
					<div className={pane.row}>
						<input
							className={styles.input}
							value={item.label}
							aria-label={`Name of ${item.label || "entry"}`}
							onChange={(e) =>
								update(index, {
									label: e.target.value,
								} as Partial<T>)
							}
						/>
						<RowButtons
							label={item.label}
							index={index}
							count={items.length}
							onMove={(by) => onChange(moved(items, index, by))}
							onRemove={() => onRemove(item)}
						/>
					</div>
					{renderExtra &&
						renderExtra(item, (patch) => update(index, patch))}
				</div>
			))}
			<AddRow
				placeholder={addPlaceholder}
				onAdd={(label) =>
					onChange([
						...items,
						makeItem(
							idFromLabel(
								label,
								items.map((item) => item.id),
							),
							label,
						),
					])
				}
			/>
		</div>
	);
}

// --- The pane ---------------------------------------------------------------

export function WorkQueuePane() {
	const { data, error, isLoading, mutate } = useSWR<{ config: WorkConfig }>(
		"/api/work/config",
	);
	const showSkeleton = useDeferredLoading(isLoading);
	const [draft, setDraft] = useState<WorkConfig | null>(null);
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	if (error) {
		return (
			<div className={styles.state}>
				{describeFetchError(error, "work queue settings")}
			</div>
		);
	}
	const config = draft ?? data?.config ?? null;
	if (!config) {
		return showSkeleton ? <SkeletonText lines={6} /> : null;
	}

	const edit = (change: (current: WorkConfig) => WorkConfig) => {
		setSaved(false);
		setFailure(null);
		setDraft(change(config));
	};
	const editRules = (patch: Partial<WorkConfig["rules"]>) =>
		edit((current) => ({
			...current,
			rules: { ...current.rules, ...patch },
		}));

	const prefixProblem = !/^[A-Za-z][A-Za-z0-9]*$/.test(config.prefix)
		? "Use letters and digits, starting with a letter."
		: null;

	const save = async () => {
		if (!draft || prefixProblem) return;
		setSaving(true);
		setFailure(null);
		try {
			const response = await fetch("/api/work/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ config: draft }),
			});
			const detail = (await response.json().catch(() => null)) as {
				config?: WorkConfig;
				error?: string;
			} | null;
			if (!response.ok || !detail?.config) {
				setFailure(detail?.error ?? "Could not save.");
				return;
			}
			await mutate({ config: detail.config }, { revalidate: false });
			setDraft(null);
			setSaved(true);
		} catch (cause) {
			setFailure(
				cause instanceof Error ? cause.message : "Could not save.",
			);
		} finally {
			setSaving(false);
		}
	};

	// Removing a column also drops the rules written against it.
	const removeColumn = (id: string) =>
		edit((current) => ({
			...current,
			columns: current.columns.filter((column) => column.id !== id),
			rules: {
				...current.rules,
				required: withoutKey(current.rules.required, id),
				ageingDays: withoutKey(current.rules.ageingDays, id),
				allowedMoves: current.rules.allowedMoves
					? Object.fromEntries(
							Object.entries(current.rules.allowedMoves)
								.filter(([from]) => from !== id)
								.map(([from, to]) => [
									from,
									to.filter((target) => target !== id),
								]),
						)
					: null,
			},
		}));

	// Removing a work type or effort also drops it from the approval and
	// security review picks.
	const removeWorkType = (id: string) =>
		edit((current) => ({
			...current,
			workTypes: current.workTypes.filter((item) => item.id !== id),
			rules: {
				...current.rules,
				approval: {
					...current.rules.approval,
					workTypes: current.rules.approval.workTypes.filter(
						(item) => item !== id,
					),
				},
				securityReview: {
					...current.rules.securityReview,
					workTypes: current.rules.securityReview.workTypes.filter(
						(item) => item !== id,
					),
				},
			},
		}));
	const removeEffort = (id: string) =>
		edit((current) => ({
			...current,
			efforts: current.efforts.filter((item) => item.id !== id),
			rules: {
				...current.rules,
				approval: {
					...current.rules.approval,
					efforts: current.rules.approval.efforts.filter(
						(item) => item !== id,
					),
				},
			},
		}));
	// Removing a domain or layer also drops its owners.
	const removeOwned = (kind: "domains" | "layers", id: string) =>
		edit((current) => ({
			...current,
			[kind]: current[kind].filter((item) => item.id !== id),
			owners: {
				...current.owners,
				[kind]: withoutKey(current.owners[kind], id),
			},
		}));

	const setOwners = (
		kind: "domains" | "layers",
		id: string,
		owners: string[],
	) =>
		edit((current) => ({
			...current,
			owners: {
				...current.owners,
				[kind]:
					owners.length > 0
						? { ...current.owners[kind], [id]: owners }
						: withoutKey(current.owners[kind], id),
			},
		}));

	const ownerRows = (kind: "domains" | "layers", noun: string) =>
		config[kind].length === 0 ? (
			<p className={styles.fieldHint}>
				No {kind} yet. Add them under Lists.
			</p>
		) : (
			<div className={pane.ownerGrid}>
				{config[kind].map((item) => (
					<label key={item.id} className={pane.ownerRow}>
						<span className={styles.fieldLabel}>
							{item.label || item.id}
						</span>
						<ListText
							split="comma"
							label={`Owners of the ${item.label} ${noun}`}
							placeholder="Emails or group names, separated by commas"
							value={config.owners[kind][item.id] ?? []}
							onChange={(owners) =>
								setOwners(kind, item.id, owners)
							}
						/>
					</label>
				))}
			</div>
		);

	return (
		<div className={styles.settings}>
			<Group
				title="Request IDs"
				blurb="Every request gets a key made of this prefix and a number, such as WR-142. Changing it applies to new requests only."
			>
				<label className={pane.prefixField}>
					<span className={styles.fieldLabel}>Prefix</span>
					<input
						className={styles.input}
						value={config.prefix}
						maxLength={8}
						onChange={(e) => {
							const prefix = e.target.value
								.replace(/[^A-Za-z0-9]/g, "")
								.toUpperCase();
							edit((current) => ({ ...current, prefix }));
						}}
					/>
					<span
						className={
							prefixProblem ? pane.problem : styles.fieldHint
						}
					>
						{prefixProblem ??
							"Letters and digits, up to eight characters."}
					</span>
				</label>
			</Group>

			<Group
				title="Board columns"
				blurb="The columns a request moves through, left to right. A hidden column keeps its requests but leaves the board."
			>
				<p className={styles.paneNote}>
					Declined and Duplicate are ways of closing a request, not
					columns. Blocked is a flag on a card, so a blocked request
					stays in its column.
				</p>
				<div className={pane.list}>
					{config.columns.map((column: ColumnDef, index) => (
						<div key={column.id} className={pane.row}>
							<input
								className={styles.input}
								value={column.label}
								aria-label={`Name of the ${column.label} column`}
								onChange={(e) =>
									edit((current) => ({
										...current,
										columns: current.columns.map((c) =>
											c.id === column.id
												? {
														...c,
														label: e.target.value,
													}
												: c,
										),
									}))
								}
							/>
							<label className={pane.check}>
								<input
									type="checkbox"
									checked={Boolean(column.hidden)}
									onChange={(e) =>
										edit((current) => ({
											...current,
											columns: current.columns.map((c) =>
												c.id === column.id
													? {
															...c,
															hidden: e.target
																.checked,
														}
													: c,
											),
										}))
									}
								/>
								Hidden
							</label>
							<RowButtons
								label={column.label}
								index={index}
								count={config.columns.length}
								onMove={(by) =>
									edit((current) => ({
										...current,
										columns: moved(
											current.columns,
											index,
											by,
										),
									}))
								}
								onRemove={
									defaultColumnIds.has(column.id)
										? undefined
										: () => removeColumn(column.id)
								}
							/>
						</div>
					))}
					<AddRow
						placeholder="New column name"
						onAdd={(label) =>
							edit((current) => ({
								...current,
								columns: [
									...current.columns,
									{
										id: idFromLabel(
											label,
											current.columns.map((c) => c.id),
										),
										label,
									},
								],
							}))
						}
					/>
				</div>
				<p className={styles.fieldHint}>
					The built-in columns can be renamed, moved or hidden, but
					not removed.
				</p>
			</Group>

			<Group
				title="Work types"
				blurb="What kind of work a request is. The questions under each are what the request form asks for that kind, one per line."
			>
				<ChoiceList<WorkTypeChoice>
					items={config.workTypes}
					onChange={(workTypes) =>
						edit((current) => ({ ...current, workTypes }))
					}
					onRemove={(item) => removeWorkType(item.id)}
					makeItem={(id, label) => ({ id, label, prompts: [] })}
					addPlaceholder="New work type"
					renderExtra={(item, update) => (
						<ListText
							split="line"
							label={`Questions for ${item.label}`}
							placeholder="Questions the form asks, one per line"
							value={item.prompts}
							onChange={(prompts) => update({ prompts })}
						/>
					)}
				/>
			</Group>

			<Group
				title="Priorities"
				blurb="How urgent a request is, most urgent first."
			>
				<ChoiceList<Choice>
					items={config.priorities}
					onChange={(priorities) =>
						edit((current) => ({ ...current, priorities }))
					}
					onRemove={(item) =>
						edit((current) => ({
							...current,
							priorities: current.priorities.filter(
								(p) => p.id !== item.id,
							),
						}))
					}
					makeItem={(id, label) => ({ id, label })}
					addPlaceholder="New priority"
				/>
			</Group>

			<Group
				title="Effort"
				blurb="How big a request is. The hours are used to compare an estimate with how long the work took. Leave the most hours blank for no upper limit."
			>
				<ChoiceList<EffortChoice>
					items={config.efforts}
					onChange={(efforts) =>
						edit((current) => ({ ...current, efforts }))
					}
					onRemove={(item) => removeEffort(item.id)}
					makeItem={(id, label) => ({
						id,
						label,
						minHours: 0,
						maxHours: null,
					})}
					addPlaceholder="New effort size"
					renderExtra={(item, update) => (
						<div className={pane.effortRow}>
							<input
								className={styles.input}
								value={item.hint ?? ""}
								placeholder="Hint shown under the name"
								aria-label={`Hint for ${item.label}`}
								onChange={(e) =>
									update({
										hint: e.target.value || undefined,
									})
								}
							/>
							<OptionalNumber
								label={`Fewest hours for ${item.label}`}
								unit="hours at least"
								value={item.minHours}
								onChange={(minHours) =>
									update({ minHours: minHours ?? 0 })
								}
							/>
							<OptionalNumber
								label={`Most hours for ${item.label}`}
								unit="hours at most"
								value={item.maxHours}
								onChange={(maxHours) => update({ maxHours })}
							/>
						</div>
					)}
				/>
			</Group>

			<Group
				title="Layers"
				blurb="Your own layers, such as how your data is staged."
			>
				<ChoiceList<Choice>
					items={config.layers}
					onChange={(layers) =>
						edit((current) => ({ ...current, layers }))
					}
					onRemove={(item) => removeOwned("layers", item.id)}
					makeItem={(id, label) => ({ id, label })}
					addPlaceholder="New layer"
					emptyText="No layers yet. Requests can be filed without one."
				/>
			</Group>

			<Group
				title="Domains"
				blurb="Your own domains, such as business areas."
			>
				<ChoiceList<Choice>
					items={config.domains}
					onChange={(domains) =>
						edit((current) => ({ ...current, domains }))
					}
					onRemove={(item) => removeOwned("domains", item.id)}
					makeItem={(id, label) => ({ id, label })}
					addPlaceholder="New domain"
					emptyText="No domains yet. Requests can be filed without one."
				/>
			</Group>

			<Group
				title="Owners"
				blurb="Who a new request goes to when auto-assign is on. A request goes to its domain's owners, and to its layer's owners when its domain has none."
			>
				<SwitchRow
					label="Auto-assign new requests"
					hint="Assign each new request to the owners below."
					checked={config.rules.autoAssign}
					onChange={(autoAssign) => editRules({ autoAssign })}
				/>
				<span className={styles.fieldLabel}>Domain owners</span>
				{ownerRows("domains", "domain")}
				<span className={styles.fieldLabel}>Layer owners</span>
				{ownerRows("layers", "layer")}
			</Group>

			<Group
				title="Approval"
				blurb="A request that needs approval cannot move to In progress or later until somebody approves it."
			>
				<SwitchRow
					label="Require approval"
					hint="Applies to the efforts and work types picked below."
					checked={config.rules.approval.enabled}
					onChange={(enabled) =>
						editRules({
							approval: { ...config.rules.approval, enabled },
						})
					}
				/>
				{config.rules.approval.enabled && (
					<>
						<span className={styles.fieldLabel}>
							Efforts that need approval
						</span>
						<CheckList
							options={config.efforts}
							selected={config.rules.approval.efforts}
							onChange={(efforts) =>
								editRules({
									approval: {
										...config.rules.approval,
										efforts,
									},
								})
							}
						/>
						<span className={styles.fieldLabel}>
							Work types that need approval
						</span>
						<CheckList
							options={config.workTypes}
							selected={config.rules.approval.workTypes}
							onChange={(workTypes) =>
								editRules({
									approval: {
										...config.rules.approval,
										workTypes,
									},
								})
							}
						/>
					</>
				)}
			</Group>

			<Group
				title="Security review and deployment"
				blurb="Sign-offs DevSecOps gives before work ships."
			>
				<SwitchRow
					label="Require a security review"
					hint="The picked work types need a DevSecOps sign-off before Ready to deploy."
					checked={config.rules.securityReview.enabled}
					onChange={(enabled) =>
						editRules({
							securityReview: {
								...config.rules.securityReview,
								enabled,
							},
						})
					}
				/>
				{config.rules.securityReview.enabled && (
					<>
						<span className={styles.fieldLabel}>
							Work types that need a security review
						</span>
						<CheckList
							options={config.workTypes}
							selected={config.rules.securityReview.workTypes}
							onChange={(workTypes) =>
								editRules({
									securityReview: {
										...config.rules.securityReview,
										workTypes,
									},
								})
							}
						/>
					</>
				)}
				<SwitchRow
					label="Only DevSecOps moves requests to Done"
					hint="Engineers can take a request as far as the column before Done."
					checked={config.rules.onlyDevSecOpsDeploys}
					onChange={(onlyDevSecOpsDeploys) =>
						editRules({ onlyDevSecOpsDeploys })
					}
				/>
			</Group>

			<Group
				title="Required fields"
				blurb="What a request must have filled in before it can move into each column."
			>
				<div className={pane.columnTable}>
					{config.columns.map((column) => (
						<div key={column.id} className={pane.columnTableRow}>
							<span className={styles.fieldLabel}>
								{column.label || column.id}
							</span>
							<CheckList
								options={requiredFields.map((field) => ({
									id: field,
									label: requiredLabels[field],
								}))}
								selected={
									config.rules.required[column.id] ?? []
								}
								onChange={(fields) =>
									editRules({
										required:
											fields.length > 0
												? {
														...config.rules
															.required,
														[column.id]:
															fields as RequiredField[],
													}
												: withoutKey(
														config.rules.required,
														column.id,
													),
									})
								}
							/>
						</div>
					))}
				</div>
			</Group>

			<Group
				title="Ageing reminders"
				blurb="Days a request can sit in a column before the people on it are reminded. Leave blank for no reminder."
			>
				<div className={pane.ageingGrid}>
					{config.columns.map((column) => (
						<label key={column.id} className={styles.numberSetting}>
							<span className={styles.fieldLabel}>
								{column.label || column.id}
							</span>
							<OptionalNumber
								label={`Days in ${column.label} before a reminder`}
								unit="days"
								value={config.rules.ageingDays[column.id]}
								onChange={(days) =>
									editRules({
										ageingDays:
											days === null || days === 0
												? withoutKey(
														config.rules.ageingDays,
														column.id,
													)
												: {
														...config.rules
															.ageingDays,
														[column.id]:
															Math.round(days),
													},
									})
								}
							/>
						</label>
					))}
				</div>
			</Group>

			{(draft || failure || saved) && (
				<div className={styles.saveBar}>
					{failure ? (
						<span className={styles.saveError}>{failure}</span>
					) : (
						<span className={styles.saveNote}>
							{saved ? "Saved." : "Unsaved changes"}
						</span>
					)}
					{draft && (
						<>
							<button
								type="button"
								className={styles.linkButton}
								onClick={() => {
									setDraft(null);
									setFailure(null);
								}}
							>
								Discard
							</button>
							<button
								type="button"
								className={styles.saveButton}
								onClick={save}
								disabled={saving || Boolean(prefixProblem)}
							>
								{saving ? "Saving" : "Save changes"}
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}
