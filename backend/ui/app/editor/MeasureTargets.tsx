"use client";

import { createContext, useContext, useState } from "react";
import type {
	KpiTarget,
	KpiTargets,
	TargetBasis,
	TargetDirection,
	TargetPeriod,
} from "../../lib/visuals/kpiTargets";
import { Select } from "../components/shared/Select";
import type { SourceMeta } from "../visuals/types";
import { Hint } from "./PanelSection";
import styles from "./Editor.module.css";

// A target for each measure on a row of KPI tiles.
//
// One row per encoded measure, so the list always matches the tiles. A target
// is a fixed figure, the same measure over an earlier window of the page's
// date range, or another measure on the source, and a relative one can be
// moved up or down by a percentage or an amount.

const directionChoices: { value: TargetDirection; label: string }[] = [
	{ value: "higher", label: "Higher is better" },
	{ value: "lower", label: "Lower is better" },
];

// What a target is taken from, as one choice. The periods are listed
// separately so the whole basis is one pick rather than two.
type BasisChoice = "none" | "fixed" | TargetPeriod | "measure";

const basisChoices: { value: BasisChoice; label: string }[] = [
	{ value: "none", label: "No target" },
	{ value: "fixed", label: "A fixed figure" },
	{ value: "year", label: "Same window last year" },
	{ value: "quarter", label: "Same window last quarter" },
	{ value: "month", label: "Same window last month" },
	{ value: "previous", label: "The period before" },
	{ value: "measure", label: "Another measure" },
];

// Whether the page being edited opens on a date range, supplied by the editor.
// A target from an earlier period shifts that range back, so without one it
// only shows once a reader picks dates.
export const PageDateRangeContext = createContext(true);

function choiceOf(target: KpiTarget | undefined): BasisChoice {
	if (!target) return "none";
	if (target.basis.kind === "period") return target.basis.period;
	return target.basis.kind;
}

export function MeasureTargets({
	option,
	measures,
	source,
	value,
	onChange,
}: {
	option: { key: string; label: string; help?: string };
	measures: string[];
	source: SourceMeta | undefined;
	value: KpiTargets;
	onChange: (next: KpiTargets) => void;
}) {
	// What is typed, per measure and box, while it is not yet a number. Holding
	// the text lets a figure be typed through states such as "-" or "1." that
	// are not numbers on their own.
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const opensOnRange = useContext(PageDateRangeContext);

	if (measures.length === 0) {
		return (
			<div className={styles.field}>
				<label className={styles.fieldLabel}>{option.label}</label>
				<Hint>Add measures first, then give them targets.</Hint>
			</div>
		);
	}

	const isPercent = (measure: string) =>
		source?.measures.find((f) => f.name === measure)?.formatHint ===
		"percent";

	// Only entries for measures still on the visual are written back, so a
	// target left behind by a removed measure is dropped on the next edit.
	const write = (measure: string, entry: KpiTarget | null) => {
		const next: KpiTargets = {};
		for (const name of measures) {
			const current = name === measure ? entry : value[name];
			if (current) next[name] = current;
		}
		onChange(next);
	};

	const draftKey = (measure: string, box: string) => `${measure}|${box}`;
	const clearDraft = (measure: string, box: string) =>
		setDrafts((prev) => {
			const next = { ...prev };
			delete next[draftKey(measure, box)];
			return next;
		});

	// A number box that keeps what is typed until it parses.
	const numberBox = (
		measure: string,
		box: string,
		current: number | null,
		label: string,
		onNumber: (n: number | null) => void,
		placeholder: string,
	) => (
		<input
			type="number"
			inputMode="decimal"
			className={styles.input}
			value={
				drafts[draftKey(measure, box)] ??
				(current === null ? "" : String(current))
			}
			placeholder={placeholder}
			aria-label={label}
			onChange={(e) => {
				const text = e.target.value;
				setDrafts((prev) => ({
					...prev,
					[draftKey(measure, box)]: text,
				}));
				if (text.trim() === "") {
					onNumber(null);
					return;
				}
				const figure = Number(text);
				if (Number.isFinite(figure)) onNumber(figure);
			}}
			onBlur={() => clearDraft(measure, box)}
		/>
	);

	const setBasis = (measure: string, choice: BasisChoice) => {
		const current = value[measure];
		if (choice === "none") {
			write(measure, null);
			return;
		}
		const direction = current?.direction ?? "higher";
		let basis: TargetBasis;
		if (choice === "fixed") {
			basis = {
				kind: "fixed",
				value:
					current?.basis.kind === "fixed" ? current.basis.value : 0,
			};
		} else if (choice === "measure") {
			const other =
				current?.basis.kind === "measure"
					? current.basis.measure
					: (source?.measures.find((f) => f.name !== measure)?.name ??
						"");
			if (!other) return;
			basis = { kind: "measure", measure: other };
		} else {
			basis = { kind: "period", period: choice };
		}
		write(measure, {
			basis,
			change: basis.kind === "fixed" ? 0 : (current?.change ?? 0),
			changeUnit: current?.changeUnit ?? "percent",
			direction,
		});
	};

	return (
		<div className={styles.field}>
			<label className={styles.fieldLabel}>{option.label}</label>
			<div className={styles.targetList}>
				{measures.map((measure) => {
					const current = value[measure];
					const choice = choiceOf(current);
					const points = isPercent(measure);
					const others = (source?.measures ?? [])
						.filter((f) => f.name !== measure)
						.map((f) => ({ value: f.name, label: f.name }));
					return (
						<div key={measure} className={styles.targetRow}>
							<span className={styles.targetName} title={measure}>
								{measure}
							</span>
							<Select
								value={choice}
								onChange={(v) =>
									setBasis(measure, v as BasisChoice)
								}
								ariaLabel={`What the target for ${measure} is taken from`}
								options={basisChoices.filter(
									(c) =>
										c.value !== "measure" ||
										others.length > 0,
								)}
							/>
							{current?.basis.kind === "fixed" && (
								<div className={styles.targetFigure}>
									{numberBox(
										measure,
										"fixed",
										current.basis.value,
										`Target for ${measure}${
											points
												? " in percentage points"
												: ""
										}`,
										(n) =>
											n !== null &&
											write(measure, {
												...current,
												basis: {
													kind: "fixed",
													value: n,
												},
											}),
										"Target",
									)}
									{points && (
										<span className={styles.targetUnit}>
											pts
										</span>
									)}
								</div>
							)}
							{current?.basis.kind === "measure" && (
								<Select
									value={current.basis.measure}
									onChange={(v) =>
										write(measure, {
											...current,
											basis: {
												kind: "measure",
												measure: v,
											},
										})
									}
									ariaLabel={`Measure the target for ${measure} is taken from`}
									options={others}
									searchable={others.length > 8}
								/>
							)}
							{current && current.basis.kind !== "fixed" && (
								<div className={styles.targetControls}>
									{numberBox(
										measure,
										"change",
										current.change === 0
											? null
											: current.change,
										`Change from what the target for ${measure} is taken from`,
										(n) =>
											write(measure, {
												...current,
												change: n ?? 0,
											}),
										"Change, e.g. 10",
									)}
									<Select
										value={current.changeUnit}
										onChange={(v) =>
											write(measure, {
												...current,
												changeUnit:
													v === "amount"
														? "amount"
														: "percent",
											})
										}
										ariaLabel={`Whether the change for ${measure} is a percentage or an amount`}
										options={[
											{ value: "percent", label: "%" },
											{
												value: "amount",
												label: points
													? "pts"
													: "Amount",
											},
										]}
									/>
								</div>
							)}
							{current?.basis.kind === "period" &&
								!opensOnRange && (
									<Hint>
										Shows once the page has a date range.
										Set Applied on open on the date filter,
										or it appears when a reader picks dates.
									</Hint>
								)}
							{current && (
								<Select
									value={current.direction}
									onChange={(v) =>
										write(measure, {
											...current,
											direction: v as TargetDirection,
										})
									}
									ariaLabel={`Which way is better for ${measure}`}
									options={directionChoices}
								/>
							)}
						</div>
					);
				})}
			</div>
			{option.help && <Hint>{option.help}</Hint>}
		</div>
	);
}
