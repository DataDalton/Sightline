"use client";

import { formatValue, type FormatHint } from "../../lib/format";
import type { PivotLayout, PivotTable } from "../../lib/sheets/definition";
import { Select } from "../components/shared/Select";
import type { SourceMeta } from "../visuals/types";
import styles from "./Sheets.module.css";

// A pivot: fields down the side, one across the top, measures in the cells.
// Every figure, totals included, is the warehouse's own answer for that group,
// so an average's total is the average and not a sum of averages.

const maxDown = 4;

export function PivotBuilder({
	source,
	layout,
	editable,
	onChange,
}: {
	source: SourceMeta | undefined;
	layout: PivotLayout;
	editable: boolean;
	onChange: (next: PivotLayout) => void;
}) {
	if (!source) return null;
	const dims = source.dimensions.map((d) => ({
		value: d.name,
		label: d.displayName ?? d.name,
	}));
	const measures = source.measures.map((m) => ({
		value: m.name,
		label: m.displayName ?? m.name,
	}));

	const chips = (items: string[], remove: (name: string) => void) =>
		items.map((name) => (
			<span key={name} className={styles.pivotChip}>
				{name}
				{editable && (
					<button
						type="button"
						aria-label={`Remove ${name}`}
						onClick={() => remove(name)}
					>
						×
					</button>
				)}
			</span>
		));

	return (
		<div className={styles.pivotBuilder}>
			<div className={styles.pivotSlot}>
				<span className={styles.pivotSlotLabel}>Rows</span>
				<div className={styles.pivotChips}>
					{chips(layout.rows, (n) =>
						onChange({
							...layout,
							rows: layout.rows.filter((r) => r !== n),
						}),
					)}
					{editable && layout.rows.length < maxDown && (
						<Select
							options={dims.filter(
								(d) =>
									!layout.rows.includes(d.value) &&
									d.value !== layout.columns,
							)}
							value=""
							onChange={(v) =>
								v &&
								onChange({
									...layout,
									rows: [...layout.rows, v],
								})
							}
							placeholder="Add a field"
							searchable
							ariaLabel="Add a field down the side"
						/>
					)}
				</div>
			</div>
			<div className={styles.pivotSlot}>
				<span className={styles.pivotSlotLabel}>Columns</span>
				<div className={styles.pivotChips}>
					{editable ? (
						<Select
							options={[
								{ value: "", label: "None" },
								...dims.filter(
									(d) => !layout.rows.includes(d.value),
								),
							]}
							value={layout.columns ?? ""}
							onChange={(v) =>
								onChange({ ...layout, columns: v || null })
							}
							searchable
							ariaLabel="Field across the top"
						/>
					) : (
						<span>{layout.columns ?? "None"}</span>
					)}
				</div>
			</div>
			<div className={styles.pivotSlot}>
				<span className={styles.pivotSlotLabel}>Values</span>
				<div className={styles.pivotChips}>
					{chips(layout.values, (n) =>
						onChange({
							...layout,
							values: layout.values.filter((v) => v !== n),
						}),
					)}
					{editable && layout.values.length < 8 && (
						<Select
							options={measures.filter(
								(m) => !layout.values.includes(m.value),
							)}
							value=""
							onChange={(v) =>
								v &&
								onChange({
									...layout,
									values: [...layout.values, v],
								})
							}
							placeholder="Add a measure"
							searchable
							ariaLabel="Add a measure"
						/>
					)}
				</div>
			</div>
		</div>
	);
}

export function PivotGrid({
	table,
	hints,
	clipped,
}: {
	table: PivotTable;
	hints: Map<string, FormatHint>;
	clipped: boolean;
}) {
	if (table.columns.length === 0) {
		return (
			<div className={styles.empty}>
				Choose at least one measure under Values to fill the pivot.
			</div>
		);
	}
	return (
		<div className={styles.gridFrame}>
			<div className={styles.pivotScroller}>
				<table className={styles.pivotTable}>
					<thead>
						<tr>
							{table.down.map((d, i) => (
								<th
									key={d}
									className={styles.pivotRowHead}
									style={{ left: i * 160 }}
								>
									{d}
								</th>
							))}
							{table.columns.map((c) => (
								<th
									key={`${c.across}\u0000${c.measure}`}
									className={`${styles.pivotColHead} ${c.across === null ? styles.pivotTotalCol : ""}`}
								>
									{c.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{table.rows.map((row, ri) => (
							<tr
								key={ri}
								className={
									row.total ? styles.pivotTotalRow : ""
								}
							>
								{table.down.map((d, i) => (
									<th
										key={d}
										scope="row"
										className={styles.pivotRowHead}
										style={{ left: i * 160 }}
									>
										{row.total
											? i === 0
												? "Total"
												: ""
											: (row.keys[i] ?? "(blank)")}
									</th>
								))}
								{row.cells.map((v, ci) => {
									const column = table.columns[ci];
									return (
										<td
											key={ci}
											className={`${styles.pivotCell} ${column.across === null ? styles.pivotTotalCol : ""}`}
										>
											{v === null || v === undefined
												? ""
												: formatValue(
														v,
														hints.get(
															column.measure,
														) ?? "decimal",
													)}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className={styles.statusBar}>
				<span>
					{table.rows.filter((r) => !r.total).length.toLocaleString()}{" "}
					rows
				</span>
				{clipped && (
					<span className={styles.statusError}>
						The field across the top has more values than fit. The
						first 60 are shown.
					</span>
				)}
			</div>
		</div>
	);
}
