"use client";

import { useMemo, useRef, useState } from "react";
import {
	computeColumns,
	functionNames,
	isError,
	parse,
	type FormulaColumn,
} from "../../lib/sheets/formula";
import { Modal } from "../components/shared/Modal";
import styles from "./Sheets.module.css";

// Writing a formula column: a name, the formula, the columns it can read one
// click away, and the result on the first rows as it is typed.

const help: { name: string; example: string; says: string }[] = [
	{
		name: "IF",
		example: "IF([Units] > 0, [Revenue] / [Units], 0)",
		says: "One value or another",
	},
	{
		name: "SHARE",
		example: "SHARE([Revenue])",
		says: "This row's share of the column total",
	},
	{
		name: "RANK",
		example: "RANK([Revenue])",
		says: "1 for the largest in the column",
	},
	{
		name: "PREVIOUS",
		example: "[Revenue] - PREVIOUS([Revenue])",
		says: "The row above",
	},
	{
		name: "RUNNING",
		example: "RUNNING([Revenue])",
		says: "Running total down the column",
	},
	{
		name: "TOTAL",
		example: "TOTAL([Revenue])",
		says: "The whole column added up",
	},
	{
		name: "ROUND",
		example: "ROUND([Margin], 2)",
		says: "Round to decimal places",
	},
	{
		name: "IFERROR",
		example: "IFERROR([A] / [B], 0)",
		says: "A fallback for an error",
	},
	{
		name: "CONCAT",
		example: '[Region] & " · " & [Category]',
		says: "Join text, or use &",
	},
];

export function FormulaDialog({
	editing,
	columns,
	formulas,
	sampleRows,
	onSave,
	onClose,
}: {
	editing: FormulaColumn | null;
	// Every column a formula can read, by name.
	columns: string[];
	formulas: FormulaColumn[];
	sampleRows: Record<string, unknown>[];
	onSave: (column: FormulaColumn) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState(editing?.name ?? "");
	const [formula, setFormula] = useState(editing?.formula ?? "");
	const input = useRef<HTMLTextAreaElement>(null);

	const taken = new Set(
		[
			...columns,
			...formulas.filter((f) => f.id !== editing?.id).map((f) => f.name),
		].map((n) => n.toLowerCase()),
	);
	const nameProblem = !name.trim()
		? "Give the column a name."
		: taken.has(name.trim().toLowerCase())
			? "Another column already has that name."
			: null;

	const syntax = useMemo(() => {
		if (!formula.trim()) return null;
		try {
			parse(formula);
			return null;
		} catch (error) {
			return error instanceof Error
				? error.message
				: "The formula cannot be read.";
		}
	}, [formula]);

	// The result on the first rows, computed with every other formula in
	// place, since this one may read them.
	const preview = useMemo(() => {
		if (!formula.trim() || syntax || sampleRows.length === 0) return [];
		const id = editing?.id ?? "__new";
		const label = name.trim() || "__preview";
		const others = formulas.filter((f) => f.id !== id);
		const out = computeColumns(sampleRows.slice(0, 200), columns, [
			...others,
			{ id, name: label, formula },
		]);
		return out.values.slice(0, 5).map((v) => v[label]);
	}, [formula, syntax, sampleRows, columns, formulas, editing?.id, name]);

	const insert = (text: string) => {
		const el = input.current;
		if (!el) {
			setFormula((f) => f + text);
			return;
		}
		const start = el.selectionStart ?? formula.length;
		const end = el.selectionEnd ?? formula.length;
		const next = formula.slice(0, start) + text + formula.slice(end);
		setFormula(next);
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(start + text.length, start + text.length);
		});
	};

	const save = () => {
		if (nameProblem || syntax || !formula.trim()) return;
		onSave({
			id: editing?.id ?? Math.random().toString(36).slice(2, 10),
			name: name.trim(),
			formula: formula.trim(),
		});
	};

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={editing ? "Edit formula column" : "New formula column"}
			width="680px"
			footer={
				<>
					<button
						type="button"
						className={styles.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={styles.primary}
						onClick={save}
						disabled={Boolean(
							nameProblem || syntax || !formula.trim(),
						)}
					>
						{editing ? "Save" : "Add column"}
					</button>
				</>
			}
		>
			<div className={styles.form}>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Name</span>
					<input
						className={styles.input}
						value={name}
						maxLength={80}
						autoFocus={!editing}
						onChange={(e) => setName(e.target.value)}
						placeholder="Margin"
					/>
					{name && nameProblem && (
						<span className={styles.formError}>{nameProblem}</span>
					)}
				</label>

				<label className={styles.field}>
					<span className={styles.fieldLabel}>Formula</span>
					<textarea
						ref={input}
						className={`${styles.input} ${styles.formulaInput}`}
						value={formula}
						rows={3}
						spellCheck={false}
						onChange={(e) => setFormula(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey))
								save();
						}}
						placeholder="[Revenue] - [Cost]"
					/>
					{syntax ? (
						<span className={styles.formError}>{syntax}</span>
					) : (
						<span className={styles.fieldHint}>
							Columns go in square brackets. Ctrl+Enter saves.
						</span>
					)}
				</label>

				<div className={styles.field}>
					<span className={styles.fieldLabel}>Columns</span>
					<div className={styles.insertList}>
						{[
							...columns,
							...formulas
								.filter((f) => f.id !== editing?.id)
								.map((f) => f.name),
						].map((c) => (
							<button
								key={c}
								type="button"
								className={styles.insertChip}
								onClick={() => insert(`[${c}]`)}
							>
								{c}
							</button>
						))}
					</div>
				</div>

				{preview.length > 0 && (
					<div className={styles.previewBox} aria-live="polite">
						<span className={styles.fieldLabel}>First rows</span>
						<ol className={styles.previewValues}>
							{preview.map((v, i) => (
								<li
									key={i}
									className={
										isError(v) ? styles.cellError : ""
									}
									title={isError(v) ? v.detail : undefined}
								>
									{isError(v)
										? v.code
										: v === null
											? "(blank)"
											: typeof v === "number"
												? Math.round(v * 1e6) / 1e6
												: String(v)}
								</li>
							))}
						</ol>
					</div>
				)}

				<details className={styles.helpBox}>
					<summary>Functions</summary>
					<ul className={styles.helpList}>
						{help.map((h) => (
							<li key={h.name}>
								<button
									type="button"
									className={styles.helpInsert}
									onClick={() => insert(h.example)}
								>
									<code>{h.example}</code>
								</button>
								<span>{h.says}</span>
							</li>
						))}
					</ul>
					<p className={styles.fieldHint}>
						Also{" "}
						{functionNames
							.filter((f) => !help.some((h) => h.name === f))
							.join(", ")}
						. Arithmetic with + - * / ^, comparisons with = &lt;&gt;
						&lt; &gt; &lt;= &gt;=, and 15% for 0.15.
					</p>
				</details>
			</div>
		</Modal>
	);
}
