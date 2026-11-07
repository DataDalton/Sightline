"use client";

import { DataGrid } from "../visuals/DataGrid";
import { Modal } from "../components/shared/Modal";
import { useMemo, useState } from "react";
import Link from "../components/AppLink";
import useSWR from "swr";
import { EmptyState, emptyIcons } from "../components/shared/EmptyState";
import { Select } from "../components/shared/Select";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import form from "../authoring/Authoring.module.css";
import styles from "./Quality.module.css";

// Data status's Quality tab. Rules on each source a person can read, how each last went,
// and what is open. Where a source has a row filter, pass or fail is shown without
// counts, since a count could reveal rows outside what that person can see.

type Kind =
	| "unique"
	| "notBlank"
	| "range"
	| "allowedValues"
	| "crossField"
	| "matchesTable"
	| "rowCountShift"
	| "distributionShift"
	| "reconcile"
	| "schema";

interface Params {
	columns?: string[];
	column?: string;
	min?: number | null;
	max?: number | null;
	values?: string[];
	left?: string;
	op?: string;
	right?: string;
	otherTable?: string;
	otherColumn?: string;
	shiftPercent?: number;
	tolerancePercent?: number;
	expectedColumns?: { name: string; type: string }[];
}

interface Rule {
	ruleId: string;
	sourceKey: string;
	table: string;
	name: string;
	kind: Kind;
	params: Params;
	severity: "warning" | "critical";
	owner: string | null;
	groupBy: string | null;
	recentColumn: string | null;
	recentDays: number | null;
	schedule: string;
	budgetSeconds: number;
	allowFailing: number;
}

interface RuleView {
	rule: Rule;
	last: {
		status: "pass" | "fail" | "error";
		runOn: string;
		failing: number | null;
		checked: number | null;
		groups: { label: string; failing: number; checked: number }[];
		detail: string | null;
		error: string | null;
		durationMs: number;
	} | null;
	history: { runOn: string; status: string; failing: number | null }[];
	incident: {
		incidentId: string;
		status: "open" | "acknowledged";
		openedOn: string;
		acknowledgedBy: string | null;
		mutedUntil: string | null;
		note: string | null;
	} | null;
	lastResolved: {
		resolvedBy: string;
		resolvedOn: string;
		note: string | null;
	} | null;
}

interface SourceQuality {
	sourceKey: string;
	title: string;
	protected: boolean;
	score: number | null;
	rules: RuleView[];
	affects: { slug: string; title: string }[];
	canManage: boolean;
	tables: string[];
}

const kindWords: Record<Kind, string> = {
	unique: "Unique on chosen columns",
	notBlank: "Not blank",
	range: "Within a range",
	allowedValues: "Allowed values",
	crossField: "Compare two columns",
	matchesTable: "Matches another table",
	rowCountShift: "Row count shift",
	distributionShift: "Distribution shift",
	reconcile: "Two totals agree",
	schema: "Columns stay as they are",
};

const statusWords = {
	pass: "Passing",
	fail: "Failing",
	error: "Could not run",
};

function when(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

async function post(body: Record<string, unknown>) {
	const response = await fetch("/api/data-rules", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const detail = await response.json().catch(() => null);
	if (!response.ok) throw new Error(detail?.error ?? "That did not work.");
	return detail;
}

const blankDraft = (sourceKey: string, table: string) => ({
	sourceKey,
	table,
	name: "",
	kind: "notBlank" as Kind,
	params: {} as Params,
	severity: "warning" as Rule["severity"],
	groupBy: "",
	recentColumn: "",
	recentDays: "",
	schedule: "afterLoad",
	budgetSeconds: "300",
	allowFailing: "0",
	owner: "",
});

type Draft = ReturnType<typeof blankDraft> & { ruleId?: string };

interface RuleTemplate {
	templateId: string;
	name: string;
	kind: Kind;
	params: Params;
	severity: Rule["severity"];
	groupBy: string | null;
	recentColumn: string | null;
	recentDays: number | null;
	schedule: string;
	budgetSeconds: number;
	allowFailing: number;
	canRemove: boolean;
}

function RuleDialog({
	draft: start,
	tables,
	onSaved,
	onClose,
}: {
	draft: Draft;
	tables: string[];
	onSaved: () => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState(start);
	const [failure, setFailure] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [savedAsTemplate, setSavedAsTemplate] = useState(false);
	const [templateId, setTemplateId] = useState("");
	const { data: templateData, mutate: reloadTemplates } = useSWR<{
		templates: RuleTemplate[];
	}>("/api/data-rules?templates=1");
	const templates = templateData?.templates ?? [];
	const chosenTemplate = templates.find(
		(template) => template.templateId === templateId,
	);
	const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
	// Everything but where it runs and who looks after it, which belong to this rule.
	const useTemplate = (id: string) => {
		setTemplateId(id);
		const template = templates.find((item) => item.templateId === id);
		if (!template) return;
		set({
			name: template.name,
			kind: template.kind,
			params: template.params,
			severity: template.severity,
			groupBy: template.groupBy ?? "",
			recentColumn: template.recentColumn ?? "",
			recentDays: String(template.recentDays ?? ""),
			schedule: template.schedule,
			budgetSeconds: String(template.budgetSeconds),
			allowFailing: String(template.allowFailing),
		});
	};
	const setParam = (patch: Partial<Params>) =>
		set({ params: { ...draft.params, ...patch } });
	const list = (value: string) =>
		value
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean);
	const textField = (
		label: string,
		value: string | undefined,
		onChange: (next: string) => void,
		placeholder?: string,
	) => (
		<label className={form.field}>
			<span className={form.label}>{label}</span>
			<input
				className={form.input}
				value={value ?? ""}
				placeholder={placeholder}
				onChange={(e) => onChange(e.target.value)}
			/>
		</label>
	);
	const numberField = (
		label: string,
		value: number | null | undefined,
		onChange: (next: number | null) => void,
	) => (
		<label className={form.field}>
			<span className={form.label}>{label}</span>
			<input
				type="number"
				className={form.input}
				value={value ?? ""}
				onChange={(e) =>
					onChange(
						e.target.value === "" ? null : Number(e.target.value),
					)
				}
			/>
		</label>
	);
	const p = draft.params;

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={draft.ruleId ? "Change this rule" : "New data rule"}
			width="620px"
		>
			<div className={form.form}>
				{!draft.ruleId && templates.length > 0 && (
					<div className={styles.suggestRow}>
						<label className={form.field}>
							<span className={form.label}>
								Start from a template
							</span>
							<Select
								value={templateId}
								onChange={useTemplate}
								options={[
									{ value: "", label: "None" },
									...templates.map((template) => ({
										value: template.templateId,
										label: template.name,
									})),
								]}
							/>
						</label>
						{chosenTemplate?.canRemove && (
							<button
								type="button"
								className={styles.button}
								onClick={async () => {
									setFailure(null);
									try {
										await post({
											action: "removeTemplate",
											templateId,
										});
										setTemplateId("");
										void reloadTemplates();
									} catch (error) {
										setFailure(
											error instanceof Error
												? error.message
												: "That did not work.",
										);
									}
								}}
							>
								Remove template
							</button>
						)}
					</div>
				)}
				{textField("Name", draft.name, (name) => set({ name }))}
				<div className={form.row}>
					<label className={form.field}>
						<span className={form.label}>Kind</span>
						<Select
							value={draft.kind}
							onChange={(kind) =>
								set({ kind: kind as Kind, params: {} })
							}
							options={(Object.keys(kindWords) as Kind[]).map(
								(kind) => ({
									value: kind,
									label: kindWords[kind],
								}),
							)}
						/>
					</label>
					<label className={form.field}>
						<span className={form.label}>Table</span>
						{tables.length > 0 ? (
							<Select
								value={draft.table}
								onChange={(table) => set({ table })}
								options={tables.map((table) => ({
									value: table,
									label: table,
								}))}
							/>
						) : (
							<input
								className={form.input}
								value={draft.table}
								onChange={(e) => set({ table: e.target.value })}
							/>
						)}
					</label>
				</div>

				{draft.kind === "unique" &&
					textField(
						"Columns, with commas between",
						(p.columns ?? []).join(", "),
						(value) => setParam({ columns: list(value) }),
						"order_id",
					)}
				{(draft.kind === "notBlank" ||
					draft.kind === "range" ||
					draft.kind === "allowedValues" ||
					draft.kind === "distributionShift" ||
					draft.kind === "matchesTable" ||
					draft.kind === "reconcile") &&
					textField("Column", p.column, (column) =>
						setParam({ column }),
					)}
				{draft.kind === "range" && (
					<div className={form.row}>
						{numberField("Lowest allowed", p.min, (min) =>
							setParam({ min }),
						)}
						{numberField("Highest allowed", p.max, (max) =>
							setParam({ max }),
						)}
					</div>
				)}
				{draft.kind === "allowedValues" &&
					textField(
						"Allowed values, with commas between",
						(p.values ?? []).join(", "),
						(value) => setParam({ values: list(value) }),
					)}
				{draft.kind === "crossField" && (
					<div className={form.row}>
						{textField("This column", p.left, (left) =>
							setParam({ left }),
						)}
						<label className={form.field}>
							<span className={form.label}>Should be</span>
							<Select
								value={p.op ?? ""}
								placeholder="Choose one"
								onChange={(op) => setParam({ op })}
								options={[
									{
										value: "<",
										label: "before or less than",
									},
									{ value: "<=", label: "at most" },
									{ value: "=", label: "the same as" },
									{ value: "!=", label: "different from" },
									{ value: ">=", label: "at least" },
									{ value: ">", label: "after or more than" },
								]}
							/>
						</label>
						{textField("That column", p.right, (right) =>
							setParam({ right }),
						)}
					</div>
				)}
				{(draft.kind === "matchesTable" ||
					draft.kind === "reconcile") && (
					<div className={form.row}>
						{textField(
							"Other table",
							p.otherTable,
							(otherTable) => setParam({ otherTable }),
							"catalog.schema.table",
						)}
						{textField("Its column", p.otherColumn, (otherColumn) =>
							setParam({ otherColumn }),
						)}
					</div>
				)}
				{(draft.kind === "rowCountShift" ||
					draft.kind === "distributionShift") &&
					numberField(
						"Points it can move between checks",
						p.shiftPercent ?? 20,
						(shiftPercent) =>
							setParam({
								shiftPercent: shiftPercent ?? undefined,
							}),
					)}
				{draft.kind === "reconcile" &&
					numberField(
						"Points they can be apart",
						p.tolerancePercent ?? 0,
						(tolerancePercent) =>
							setParam({
								tolerancePercent: tolerancePercent ?? undefined,
							}),
					)}
				{draft.kind === "schema" &&
					textField(
						"Expected columns, as name type with commas between",
						(p.expectedColumns ?? [])
							.map((c) => `${c.name} ${c.type}`)
							.join(", "),
						(value) =>
							setParam({
								expectedColumns: list(value).map((pair) => {
									const [name, ...type] = pair.split(/\s+/);
									return { name, type: type.join(" ") };
								}),
							}),
					)}

				<div className={form.row}>
					<label className={form.field}>
						<span className={form.label}>Severity</span>
						<Select
							value={draft.severity}
							onChange={(severity) =>
								set({ severity: severity as Rule["severity"] })
							}
							options={[
								{ value: "warning", label: "Warning" },
								{ value: "critical", label: "Critical" },
							]}
						/>
					</label>
					<label className={form.field}>
						<span className={form.label}>Check</span>
						<Select
							value={draft.schedule}
							onChange={(schedule) => set({ schedule })}
							options={[
								{
									value: "afterLoad",
									label: "After each load",
								},
								{ value: "hourly", label: "Every hour" },
								{ value: "daily", label: "Every day" },
							]}
						/>
					</label>
				</div>
				<div className={form.row}>
					{textField(
						"Check per group of",
						draft.groupBy,
						(groupBy) => set({ groupBy }),
						"region",
					)}
					{textField(
						"Failures allowed",
						draft.allowFailing,
						(allowFailing) => set({ allowFailing }),
					)}
				</div>
				<div className={form.row}>
					{textField(
						"Only rows dated by",
						draft.recentColumn,
						(recentColumn) => set({ recentColumn }),
						"order_date",
					)}
					{textField(
						"From the last, in days",
						draft.recentDays,
						(recentDays) => set({ recentDays }),
					)}
				</div>
				<div className={form.row}>
					{textField("Who looks after it", draft.owner, (owner) =>
						set({ owner }),
					)}
					{textField(
						"Budget, in seconds",
						draft.budgetSeconds,
						(budgetSeconds) => set({ budgetSeconds }),
					)}
				</div>

				{failure && <div className={form.failure}>{failure}</div>}
				{savedAsTemplate && (
					<p className={styles.hint}>
						Saved as a template, for anyone making a rule.
					</p>
				)}
				<div className={form.actions}>
					<button
						type="button"
						className={form.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={form.secondary}
						disabled={busy || !draft.name.trim()}
						onClick={async () => {
							setBusy(true);
							setFailure(null);
							try {
								await post({
									action: "saveTemplate",
									...draft,
								});
								setSavedAsTemplate(true);
								void reloadTemplates();
							} catch (error) {
								setFailure(
									error instanceof Error
										? error.message
										: "That did not save.",
								);
							} finally {
								setBusy(false);
							}
						}}
					>
						Save as template
					</button>
					<button
						type="button"
						className={form.primary}
						disabled={busy || !draft.name.trim() || !draft.table}
						onClick={async () => {
							setBusy(true);
							setFailure(null);
							try {
								await post({ action: "save", ...draft });
								onSaved();
							} catch (error) {
								setFailure(
									error instanceof Error
										? error.message
										: "That did not save.",
								);
							} finally {
								setBusy(false);
							}
						}}
					>
						Save
					</button>
				</div>
			</div>
		</Modal>
	);
}

type IncidentStep = "acknowledge" | "resolve" | "mute";

// What each step does, said before it is taken and again once it is done.
const incidentSteps: Record<
	IncidentStep,
	{ title: string; does: string; confirm: string; done: string }
> = {
	acknowledge: {
		title: "Acknowledge this failure",
		does: "Shows everyone that you are looking into it. The rule stays failing and open until the data is fixed or you resolve it.",
		confirm: "Acknowledge",
		done: "Acknowledged. Everyone looking at this rule can see you have it.",
	},
	resolve: {
		title: "Resolve this failure",
		does: "Closes it. If the next check still fails, it opens again and people are told. A check that passes closes it without this.",
		confirm: "Resolve",
		done: "Resolved. It opens again if the next check still fails.",
	},
	mute: {
		title: "Mute this rule for a week",
		does: "Nobody is told when this rule fails for the next seven days. It keeps being checked and still shows here and on its reports.",
		confirm: "Mute for a week",
		done: "Muted for a week. It keeps being checked, and nobody is told.",
	},
};

function IncidentDialog({
	step,
	onConfirm,
	onClose,
}: {
	step: IncidentStep;
	onConfirm: (note: string) => Promise<void>;
	onClose: () => void;
}) {
	const words = incidentSteps[step];
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Modal
			isOpen
			onClose={onClose}
			title={words.title}
			footer={
				<>
					<button
						type="button"
						className={styles.button}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={styles.primary}
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							await onConfirm(note);
							setBusy(false);
						}}
					>
						{words.confirm}
					</button>
				</>
			}
		>
			<p className={styles.incidentDoes}>{words.does}</p>
			<label className={styles.incidentNote}>
				<span>Note, shown with this rule</span>
				<textarea
					autoFocus
					rows={3}
					value={note}
					placeholder="What is going on, or what was done about it"
					onChange={(e) => setNote(e.target.value)}
				/>
			</label>
		</Modal>
	);
}

// The failing rows in the shared grid. Each column takes its format from what the rows hold.
function FailingRows({
	rows,
	sourceKey,
}: {
	rows: Record<string, unknown>[];
	sourceKey: string;
}) {
	const columns = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
	const fields = useMemo(
		() =>
			new Map(
				columns.map((name) => [
					name,
					{
						name,
						dataType: null,
						description: null,
						formatHint:
							typeof rows[0]?.[name] === "number"
								? "decimal"
								: "text",
					},
				]),
			),
		[columns, rows],
	);
	return (
		<DataGrid
			sourceKey={sourceKey}
			suppliedRows={rows}
			dimensions={columns}
			measures={[]}
			fields={fields}
			height={420}
		/>
	);
}

function RuleCard({
	view,
	source,
	onChanged,
	onEdit,
}: {
	view: RuleView;
	source: SourceQuality;
	onChanged: () => void;
	onEdit: (rule: Rule) => void;
}) {
	const { rule, last, incident, lastResolved } = view;
	const [step, setStep] = useState<IncidentStep | null>(null);
	const [told, setTold] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
	const [removing, setRemoving] = useState(false);
	const [looked, setLooked] = useState<
		| {
				day: string;
				failing: number | null;
				checked: number | null;
				note: string | null;
		  }[]
		| null
	>(null);

	const act = async (
		body: Record<string, unknown>,
		then?: (answer: never) => void,
	) => {
		setBusy(true);
		setFailure(null);
		try {
			const answer = await post({ ruleId: rule.ruleId, ...body });
			then?.(answer as never);
			onChanged();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
		} finally {
			setBusy(false);
		}
	};
	const status = last?.status ?? "none";

	return (
		<div className={styles.rule}>
			<div className={styles.ruleHead}>
				<span
					className={`${styles.status} ${styles[`status${status}`]}`}
				>
					{last ? statusWords[last.status] : "Not checked yet"}
				</span>
				<strong className={styles.ruleName}>{rule.name}</strong>
				{rule.severity === "critical" && (
					<span className={styles.critical}>Critical</span>
				)}
				{source.canManage && (
					<div className={styles.ruleTools}>
						<button
							type="button"
							className={styles.ruleTool}
							disabled={busy}
							title="Run this check against the data now"
							onClick={() => void act({ action: "run" })}
						>
							{busy ? "Checking" : "Check now"}
						</button>
						{[
							"unique",
							"notBlank",
							"range",
							"allowedValues",
							"crossField",
							"matchesTable",
						].includes(rule.kind) && (
							<button
								type="button"
								className={styles.ruleTool}
								disabled={busy}
								title="See how this rule would have gone on each of the last 14 days"
								onClick={() =>
									void act(
										{ action: "backtest", days: 14 },
										(answer) =>
											setLooked(
												(
													answer as {
														results: NonNullable<
															typeof looked
														>;
													}
												).results,
											),
									)
								}
							>
								Look back
							</button>
						)}
						<button
							type="button"
							className={styles.ruleTool}
							disabled={busy}
							onClick={() => onEdit(rule)}
						>
							Change
						</button>
						<button
							type="button"
							className={`${styles.ruleTool} ${styles.ruleToolDanger}`}
							disabled={busy}
							onClick={() => setRemoving(true)}
						>
							Remove
						</button>
					</div>
				)}
			</div>
			<p className={styles.hint}>
				{kindWords[rule.kind]} on {rule.table}
				{last ? `. Checked ${when(last.runOn)}` : ""}
				{rule.owner ? `. ${rule.owner} looks after it` : ""}.
			</p>

			{last?.failing != null && last.status !== "error" && (
				<p className={styles.figure}>
					{last.failing.toLocaleString()} failing of{" "}
					{last.checked?.toLocaleString()} checked
				</p>
			)}
			{source.protected && last && (
				<p className={styles.hint}>
					Counts are hidden on this source, because it has a row
					filter.
				</p>
			)}
			{last?.detail && <p className={styles.hint}>{last.detail}</p>}
			{last?.error && <p className={styles.failure}>{last.error}</p>}
			{last && last.groups.length > 0 && (
				<ul className={styles.groups}>
					{last.groups.map((group) => (
						<li key={group.label}>
							{group.label}: {group.failing.toLocaleString()} of{" "}
							{group.checked.toLocaleString()}
						</li>
					))}
				</ul>
			)}

			{view.history.length > 1 && (
				<div className={styles.history} aria-label="Recent checks">
					{[...view.history].reverse().map((run) => (
						<span
							key={run.runOn}
							className={`${styles.tick} ${styles[`status${run.status}`]}`}
							title={`${when(run.runOn)}, ${run.status}`}
						/>
					))}
				</div>
			)}

			{(incident || last?.status === "fail") && (
				<div className={styles.incidentBar}>
					<div className={styles.incidentWords}>
						{incident ? (
							<>
								<strong>
									{incident.acknowledgedBy
										? `${incident.acknowledgedBy} is looking into this`
										: "Nobody has picked this up yet"}
								</strong>
								<span className={styles.hint}>
									Open since {when(incident.openedOn)}
									{incident.mutedUntil
										? `, muted until ${when(incident.mutedUntil)}`
										: ""}
									.
								</span>
								{incident.note && (
									<span className={styles.incidentSaid}>
										{incident.note}
									</span>
								)}
							</>
						) : (
							<strong>This check is failing.</strong>
						)}
					</div>
					<div className={styles.incidentActions}>
						{last?.status === "fail" && (
							<button
								type="button"
								className={styles.incidentAction}
								disabled={busy}
								onClick={() =>
									rows
										? setRows(null)
										: void act(
												{ action: "failingRows" },
												(answer) =>
													setRows(
														(
															answer as {
																rows: Record<
																	string,
																	unknown
																>[];
															}
														).rows,
													),
											)
								}
							>
								{rows ? "Hide the rows" : "See the rows"}
							</button>
						)}
						{source.canManage && incident?.status === "open" && (
							<button
								type="button"
								className={styles.incidentAction}
								disabled={busy}
								onClick={() => setStep("acknowledge")}
							>
								Acknowledge
							</button>
						)}
						{source.canManage && incident && (
							<>
								<button
									type="button"
									className={styles.incidentAction}
									disabled={busy}
									onClick={() => setStep("resolve")}
								>
									Resolve
								</button>
								<button
									type="button"
									className={styles.incidentAction}
									disabled={busy}
									onClick={() => setStep("mute")}
								>
									Mute for a week
								</button>
							</>
						)}
					</div>
				</div>
			)}
			{lastResolved && (
				<p className={styles.hint}>
					Last resolved by {lastResolved.resolvedBy},{" "}
					{when(lastResolved.resolvedOn)}
					{lastResolved.note ? `. ${lastResolved.note}` : ""}
				</p>
			)}
			{told && (
				<p className={styles.incidentTold} role="status">
					{told}
				</p>
			)}
			{failure && <p className={styles.failure}>{failure}</p>}

			{looked && (
				<ul className={styles.groups}>
					{looked.map((row) => (
						<li key={row.day}>
							{row.day}:{" "}
							{row.note ??
								`${row.failing?.toLocaleString()} failing of ${row.checked?.toLocaleString()}`}
						</li>
					))}
				</ul>
			)}

			{rows &&
				(rows.length === 0 ? (
					<p className={styles.hint}>
						Nothing failing that you can see. Your access may not
						include the rows involved.
					</p>
				) : (
					<FailingRows rows={rows} sourceKey={rule.sourceKey} />
				))}

			{step && (
				<IncidentDialog
					step={step}
					onClose={() => setStep(null)}
					onConfirm={async (note) => {
						await act({
							action: step,
							note,
							...(step === "mute" ? { days: 7 } : {}),
						});
						setTold(incidentSteps[step].done);
						setStep(null);
					}}
				/>
			)}

			{removing && (
				<ConfirmDialog
					title="Remove this rule"
					body={
						<>
							<strong>{rule.name}</strong> stops being checked,
							and anything open on it is closed.
						</>
					}
					confirmLabel="Remove rule"
					busy={busy}
					onConfirm={async () => {
						await act({ action: "remove" });
						setRemoving(false);
					}}
					onCancel={() => setRemoving(false)}
				/>
			)}
		</div>
	);
}

function Suggestions({
	source,
	onUse,
}: {
	source: SourceQuality;
	onUse: (draft: Draft) => void;
}) {
	const [table, setTable] = useState(source.tables[0] ?? "");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [found, setFound] = useState<
		{ name: string; kind: Kind; params: Params; why: string }[] | null
	>(null);
	if (source.tables.length === 0) return null;
	return (
		<div className={styles.suggest}>
			<div className={styles.suggestRow}>
				{source.tables.length > 1 && (
					<Select
						value={table}
						onChange={setTable}
						options={source.tables.map((t) => ({
							value: t,
							label: t,
						}))}
					/>
				)}
				<button
					type="button"
					className={styles.button}
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setFailure(null);
						try {
							const answer = await post({
								action: "suggest",
								sourceKey: source.sourceKey,
								table,
							});
							setFound(answer.suggestions);
						} catch (error) {
							setFailure(
								error instanceof Error
									? error.message
									: "That did not work.",
							);
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy ? "Looking" : "Suggest rules from this table"}
				</button>
			</div>
			{failure && <p className={styles.failure}>{failure}</p>}
			{found?.length === 0 && (
				<p className={styles.hint}>
					The catalogue could not be read for this table, so there is
					nothing to suggest.
				</p>
			)}
			{found?.map((suggestion) => (
				<div key={suggestion.name} className={styles.suggestion}>
					<span>
						<strong>{suggestion.name}</strong>. {suggestion.why}
					</span>
					<button
						type="button"
						className={styles.button}
						onClick={() =>
							onUse({
								...blankDraft(source.sourceKey, table),
								name: suggestion.name,
								kind: suggestion.kind,
								params: suggestion.params,
							})
						}
					>
						Use this
					</button>
				</div>
			))}
		</div>
	);
}

// A new rule made where the person already is. Asks which source first if nobody has said, and
// reads a source's tables only once it is chosen, since that can take a catalogue read.
export function NewRuleButton({
	sourceKey,
	column,
	fieldName,
	className,
	label = "New data rule",
	onSaved,
}: {
	sourceKey?: string | null;
	// Starts the rule on this column, for one added from a field.
	column?: string;
	fieldName?: string;
	className?: string;
	label?: string;
	onSaved?: () => void;
}) {
	const [opening, setOpening] = useState(false);
	const [picking, setPicking] = useState(false);
	const [picked, setPicked] = useState("");
	const [failure, setFailure] = useState<string | null>(null);
	const [ready, setReady] = useState<{
		draft: Draft;
		tables: string[];
		sourceKey: string;
	} | null>(null);
	const [saved, setSaved] = useState<string | null>(null);
	const { data: choices } = useSWR<{
		sources: { sourceKey: string; title: string }[];
	}>(picking ? "/api/authoring" : null);

	const open = async (key: string) => {
		setOpening(true);
		setFailure(null);
		setSaved(null);
		try {
			const response = await fetch(
				`/api/data-rules?source=${encodeURIComponent(key)}`,
			);
			const detail = await response.json().catch(() => null);
			const source: SourceQuality | undefined = detail?.sources?.[0];
			if (!response.ok || !source) {
				throw new Error(
					detail?.error ?? "This source could not be read.",
				);
			}
			if (!source.canManage) {
				throw new Error(
					"Only an administrator or a Maintainer of a report on this source can add a rule.",
				);
			}
			setPicking(false);
			setReady({
				draft: {
					...blankDraft(key, source.tables[0] ?? ""),
					...(column
						? {
								name: `${fieldName ?? column} is never blank`,
								params: { column },
							}
						: {}),
				},
				tables: source.tables,
				sourceKey: key,
			});
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "This source could not be read.",
			);
		} finally {
			setOpening(false);
		}
	};

	return (
		<>
			<button
				type="button"
				className={className ?? styles.primary}
				disabled={opening}
				onClick={() => {
					setFailure(null);
					if (sourceKey) void open(sourceKey);
					else setPicking(true);
				}}
			>
				{opening ? "Opening" : label}
			</button>
			{failure && !picking && (
				<span className={styles.failure} role="alert">
					{failure}
				</span>
			)}
			{saved && (
				<span className={styles.hint} role="status">
					Rule saved.{" "}
					<Link
						href={`/status?tab=quality&source=${encodeURIComponent(saved)}`}
					>
						See it
					</Link>
				</span>
			)}
			{picking && (
				<Modal
					isOpen
					onClose={() => setPicking(false)}
					title="Which source should this rule check?"
					width="480px"
				>
					<div className={form.form}>
						<label className={form.field}>
							<span className={form.label}>Source</span>
							<Select
								value={picked}
								placeholder="Choose a source"
								searchable
								onChange={setPicked}
								options={(choices?.sources ?? []).map(
									(held) => ({
										value: held.sourceKey,
										label: held.title,
									}),
								)}
							/>
						</label>
						{failure && (
							<div className={form.failure}>{failure}</div>
						)}
						<div className={form.actions}>
							<button
								type="button"
								className={form.secondary}
								onClick={() => setPicking(false)}
							>
								Cancel
							</button>
							<button
								type="button"
								className={form.primary}
								disabled={!picked || opening}
								onClick={() => void open(picked)}
							>
								{opening ? "Opening" : "Continue"}
							</button>
						</div>
					</div>
				</Modal>
			)}
			{ready && (
				<RuleDialog
					draft={ready.draft}
					tables={ready.tables}
					onSaved={() => {
						setSaved(ready.sourceKey);
						setReady(null);
						onSaved?.();
					}}
					onClose={() => setReady(null)}
				/>
			)}
		</>
	);
}

export default function QualityView({
	onlySource,
}: {
	onlySource: string | null;
}) {
	const address = onlySource
		? `/api/data-rules?source=${encodeURIComponent(onlySource)}`
		: "/api/data-rules";
	const { data, error, mutate } = useSWR<{ sources: SourceQuality[] }>(
		address,
		{ refreshInterval: 60_000, dedupingInterval: 5000 },
	);
	const [editing, setEditing] = useState<Draft | null>(null);

	const sources = data?.sources ?? [];

	if (error)
		return <p className={styles.hint}>Data rules could not be loaded.</p>;
	if (!data) return null;
	if (sources.length === 0) {
		return (
			<EmptyState
				icon={emptyIcons.rule}
				title="No data rules yet"
				action={
					<NewRuleButton
						sourceKey={onlySource}
						onSaved={() => void mutate()}
					/>
				}
			>
				A rule checks a source&apos;s tables after each load, such as no
				duplicate orders or no blank regions. When one fails, the
				reports on that source say so.
			</EmptyState>
		);
	}

	return (
		<div className={styles.quality}>
			<div className={styles.toolbar}>
				<NewRuleButton
					sourceKey={onlySource}
					onSaved={() => void mutate()}
				/>
			</div>
			{sources.map((source) => (
				<section key={source.sourceKey} className={styles.source}>
					<div className={styles.sourceHead}>
						{source.score !== null && (
							<span
								className={`${styles.score} ${
									source.score >= 90
										? styles.scoreGood
										: source.score >= 60
											? styles.scoreWarn
											: styles.scoreBad
								}`}
								title="Rules passing, with critical rules counting for three"
							>
								{source.score}
							</span>
						)}
						<h2 className={styles.sourceTitle}>{source.title}</h2>
						{source.canManage && (
							<button
								type="button"
								className={styles.button}
								onClick={() =>
									setEditing(
										blankDraft(
											source.sourceKey,
											source.tables[0] ?? "",
										),
									)
								}
							>
								New rule
							</button>
						)}
					</div>

					{source.rules.map((view) => (
						<RuleCard
							key={view.rule.ruleId}
							view={view}
							source={source}
							onChanged={() => void mutate()}
							onEdit={(rule) =>
								setEditing({
									...blankDraft(rule.sourceKey, rule.table),
									ruleId: rule.ruleId,
									name: rule.name,
									kind: rule.kind,
									params: rule.params,
									severity: rule.severity,
									groupBy: rule.groupBy ?? "",
									recentColumn: rule.recentColumn ?? "",
									recentDays: String(rule.recentDays ?? ""),
									schedule: rule.schedule,
									budgetSeconds: String(rule.budgetSeconds),
									allowFailing: String(rule.allowFailing),
									owner: rule.owner ?? "",
								})
							}
						/>
					))}

					{source.canManage && (
						<Suggestions source={source} onUse={setEditing} />
					)}

					{source.affects.length > 0 && (
						<p className={styles.hint}>
							Reports reading this source:{" "}
							{source.affects.map((report, index) => (
								<span key={report.slug}>
									{index > 0 && ", "}
									<Link href={`/r/${report.slug}`}>
										{report.title}
									</Link>
								</span>
							))}
							.
						</p>
					)}
				</section>
			))}

			{editing && (
				<RuleDialog
					draft={editing}
					tables={
						sources.find((s) => s.sourceKey === editing.sourceKey)
							?.tables ?? []
					}
					onSaved={() => {
						setEditing(null);
						void mutate();
					}}
					onClose={() => setEditing(null)}
				/>
			)}
		</div>
	);
}
