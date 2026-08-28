"use client";

import {
	paletteTokens,
	type ColorSpec,
	type ReferenceLine,
	type VisualStyle,
} from "../../lib/visuals/style";
import { Select } from "../components/shared/Select";
import { CloseIcon, Hint, Section } from "./PanelSection";
import styles from "./Editor.module.css";

// Authoring the lines drawn across a plot.
//
// Two kinds, and the difference is where the number comes from. A fixed line is
// a budget, a target or a limit: something decided outside the data, which is
// usually the whole reason the chart is being looked at. A derived line is the
// average or the highest value, which nobody has to look up and which nobody
// has to remember to update.
//
// Derived is offered first because a typed average is correct on the day it is
// typed and quietly wrong every day after.

const kindOptions: { value: ReferenceLine["kind"]; label: string }[] = [
	{ value: "average", label: "Average of the values" },
	{ value: "median", label: "Median of the values" },
	{ value: "max", label: "Highest value" },
	{ value: "min", label: "Lowest value" },
	{ value: "value", label: "A fixed number" },
];

const lineOptions: { value: string; label: string }[] = [
	{ value: "dashed", label: "Dashed" },
	{ value: "solid", label: "Solid" },
	{ value: "dotted", label: "Dotted" },
];

// The tokens worth reaching for on a reference line. A target usually carries a
// judgement, so the semantic three lead. Nothing chosen leaves the line the
// colour of the axis, which is right for a line that is only a measurement.
const swatchTokens = paletteTokens.filter((token) =>
	["warning", "danger", "success", "info", "brand"].includes(token),
);

interface ReferenceLinesEditorProps {
	style: VisualStyle;
	measures: string[];
	hasRightAxis: boolean;
	onChange: (patch: Partial<VisualStyle>) => void;
}

export function ReferenceLinesEditor({
	style,
	measures,
	hasRightAxis,
	onChange,
}: ReferenceLinesEditorProps) {
	const lines = style.referenceLines ?? [];

	const update = (id: string, patch: Partial<ReferenceLine>) =>
		onChange({
			referenceLines: lines.map((line) =>
				line.id === id ? { ...line, ...patch } : line,
			),
		});

	const add = () =>
		onChange({
			referenceLines: [
				...lines,
				{
					id:
						typeof crypto !== "undefined"
							? crypto.randomUUID()
							: `ref-${lines.length}`,
					// The average is the line most charts want and the one
					// that needs nothing typed to be useful straight away.
					kind: "average",
					line: "dashed",
				},
			],
		});

	const remove = (id: string) =>
		onChange({ referenceLines: lines.filter((line) => line.id !== id) });

	return (
		<Section
			id="visual-references"
			title="Reference lines"
			defaultOpen={false}
			count={lines.length}
		>
			<Hint>
				A line across the plot at a number worth comparing the marks to.
				Leave the label empty and it is annotated with its own value.
			</Hint>

			{lines.map((line, index) => (
				<div key={line.id} className={styles.ruleCard}>
					<div className={styles.ruleHeader}>
						<span className={styles.ruleNumber}>{index + 1}</span>
						<span className={styles.spacer} />
						<button
							type="button"
							className={styles.iconButton}
							onClick={() => remove(line.id)}
							title="Remove this line"
							aria-label="Remove this line"
						>
							<CloseIcon />
						</button>
					</div>

					<div className={styles.field}>
						<label className={styles.fieldLabel}>Drawn at</label>
						<Select
							value={line.kind}
							onChange={(next) =>
								update(line.id, {
									kind: next as ReferenceLine["kind"],
								})
							}
							options={kindOptions}
						/>
					</div>

					{line.kind === "value" && (
						<div className={styles.field}>
							<label className={styles.fieldLabel}>Number</label>
							<input
								className={styles.input}
								type="number"
								value={line.value ?? ""}
								onChange={(e) =>
									update(line.id, {
										value:
											e.target.value === ""
												? undefined
												: Number(e.target.value),
									})
								}
							/>
							<Hint>
								Until this is set the line is left off the
								chart, because a target at a position nobody
								chose still reads as a target.
							</Hint>
						</div>
					)}

					{/* Which measure a derived line is worked out from. Only
					    worth asking once there is more than one to choose
					    between. */}
					{line.kind !== "value" && measures.length > 1 && (
						<div className={styles.field}>
							<label className={styles.fieldLabel}>
								Worked out from
							</label>
							<Select
								value={line.measure ?? measures[0]}
								onChange={(next) =>
									update(line.id, { measure: next })
								}
								options={measures.map((m) => ({
									value: m,
									label: m,
								}))}
							/>
						</div>
					)}

					{hasRightAxis && (
						<div className={styles.field}>
							<label className={styles.fieldLabel}>
								Read against
							</label>
							<Select
								value={line.axis ?? "left"}
								onChange={(next) =>
									update(line.id, {
										axis: next as "left" | "right",
									})
								}
								options={[
									{ value: "left", label: "The left scale" },
									{
										value: "right",
										label: "The right scale",
									},
								]}
							/>
						</div>
					)}

					<div className={styles.field}>
						<label className={styles.fieldLabel}>Label</label>
						<input
							className={styles.input}
							value={line.label ?? ""}
							placeholder="Its own value"
							onChange={(e) =>
								update(line.id, { label: e.target.value })
							}
						/>
					</div>

					<div className={styles.field}>
						<label className={styles.fieldLabel}>Line</label>
						<Select
							value={line.line ?? "dashed"}
							onChange={(next) =>
								update(line.id, {
									line: next as ReferenceLine["line"],
								})
							}
							options={lineOptions}
						/>
					</div>

					<div className={styles.field}>
						<label className={styles.fieldLabel}>Colour</label>
						<div className={styles.swatchGrid}>
							{/* Nothing chosen is a real answer here, not an
							    unset field: it draws the line in the axis
							    colour, which is what a measurement should
							    look like. */}
							<button
								type="button"
								className={styles.markerButton}
								aria-pressed={!line.color}
								title="The axis colour"
								onClick={() =>
									update(line.id, { color: undefined })
								}
								style={{
									background: "var(--text-muted)",
									outline: !line.color
										? "2px solid var(--brand)"
										: undefined,
								}}
							/>
							{swatchTokens.map((token) => {
								const spec: ColorSpec = { token };
								const on =
									(line.color as { token?: string })
										?.token === token;
								return (
									<button
										key={token}
										type="button"
										className={styles.markerButton}
										aria-pressed={on}
										title={token}
										onClick={() =>
											update(line.id, { color: spec })
										}
										style={{
											background: `var(--${token})`,
											outline: on
												? "2px solid var(--brand)"
												: undefined,
										}}
									/>
								);
							})}
						</div>
					</div>
				</div>
			))}

			<button type="button" className={styles.addButton} onClick={add}>
				Add a reference line
			</button>
		</Section>
	);
}
