"use client";

import { useMemo } from "react";
import {
	paletteTokens,
	rampFor,
	scaleRamps,
	type ColorScale,
	type ScaleRamp,
	type ColorSpec,
	type ConditionOperator,
	type ConditionRule,
	type VisualStyle,
} from "../../lib/visuals/style";
import { mix, readThemeColors } from "../visuals/colors";
import { Select } from "../components/shared/Select";
import styles from "./Editor.module.css";

// Authoring conditional formatting.
//
// Two kinds, because they answer different questions. A rule is a threshold:
// "negative margin is red". A scale is a gradient across a column's range:
// "show me where the extremes are". A stack of rules is precise but tedious
// past three or four; a scale reads instantly but cannot express a specific
// cut-off.
//
// Every rule offers a marker alongside the colour. Colour alone fails for a
// reader with colour vision deficiency and fails again the moment someone
// prints the page, so the marker is offered next to the colour rather than
// buried somewhere an author will not find it.

const operatorLabels: Record<ConditionOperator, string> = {
	gt: "greater than",
	gte: "at least",
	lt: "less than",
	lte: "at most",
	eq: "equals",
	neq: "does not equal",
	between: "between",
	top: "in the top N",
	bottom: "in the bottom N",
};

const markerSuggestions = ["▲", "▼", "●", "!", "★", "✓", "✕"];

// The gradient a ramp actually produces, not a prettier version of it.
//
// The grid washes a cell by mixing the surface toward the endpoint by up to
// seven tenths, so the preview mixes the same way. A swatch showing the pure
// endpoint would promise a saturation the table never reaches, and an author
// would pick by a colour they are not going to get.
function rampGradient(
	ramp: Pick<ScaleRamp, "kind" | "low" | "high">,
	colors: ReturnType<typeof readThemeColors>,
	asDataBar: boolean,
): string {
	const strength = asDataBar ? 0.25 : 0.7;
	const base = colors.surface;
	const high = mix(
		base,
		colors.resolve(ramp.high, colors.positive),
		strength,
	);

	if (ramp.kind === "sequential") {
		return `linear-gradient(90deg, ${base}, ${high})`;
	}

	const low = mix(base, colors.resolve(ramp.low, colors.negative), strength);
	return `linear-gradient(90deg, ${low}, ${base} 50%, ${high})`;
}

interface ConditionsEditorProps {
	style: VisualStyle;
	// Fields a rule can test. For a KPI row these are the measures on the
	// tiles; for a table, every column on show.
	availableFields: string[];
	// Scales only make sense where there is a column of values to compare
	// across, so a KPI row does not offer them.
	allowScales: boolean;
	onChange: (patch: Partial<VisualStyle>) => void;
}

export function ConditionsEditor({
	style,
	availableFields,
	allowScales,
	onChange,
}: ConditionsEditorProps) {
	const rules = style.conditions ?? [];
	const scales = style.colorScales ?? [];

	// Resolved once. The previews have to mix real colours to be honest about
	// what the table will look like, and reading a custom property per swatch
	// would be a layout read per render.
	const themeColors = useMemo(
		() => (typeof window === "undefined" ? null : readThemeColors()),
		[],
	);

	const swatches = useMemo(() => {
		if (typeof window === "undefined") return [];
		const colors = readThemeColors();
		// Semantic tokens first: a conditional rule almost always means good,
		// bad or needs attention, and those should be one click away.
		const ordered = [
			"success",
			"danger",
			"warning",
			"info",
			...paletteTokens.filter(
				(t) => !["success", "danger", "warning", "info"].includes(t),
			),
		] as typeof paletteTokens;

		return ordered.map((token) => ({
			token,
			hex: colors.resolve({ token }, colors.series[0]),
		}));
	}, []);

	const updateRule = (index: number, patch: Partial<ConditionRule>) => {
		const next = [...rules];
		next[index] = { ...next[index], ...patch };
		onChange({ conditions: next });
	};

	const addRule = () => {
		onChange({
			conditions: [
				...rules,
				{
					field: availableFields[0] ?? "",
					operator: "gt",
					value: 0,
					textColor: { token: "success" },
				},
			],
		});
	};

	const removeRule = (index: number) => {
		onChange({ conditions: rules.filter((_, i) => i !== index) });
	};

	const moveRule = (from: number, to: number) => {
		if (to < 0 || to >= rules.length) return;
		const next = [...rules];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		onChange({ conditions: next });
	};

	const updateScale = (index: number, patch: Partial<ColorScale>) => {
		const next = [...scales];
		next[index] = { ...next[index], ...patch };
		onChange({ colorScales: next });
	};

	if (availableFields.length === 0) {
		return (
			<div className={styles.section}>
				<div className={styles.sectionTitle}>
					Conditional formatting
				</div>
				<p className={styles.guidance}>
					Add a measure on the Data tab first. A rule needs a value to
					test.
				</p>
			</div>
		);
	}

	return (
		<>
			<div className={styles.section}>
				<div className={styles.sectionTitle}>
					Conditional formatting
				</div>
				<p className={styles.guidance}>
					Rules are applied in order and later ones win, so put the
					general rule first and the specific one after it.
				</p>

				{rules.map((rule, index) => (
					<div key={index} className={styles.ruleCard}>
						<div className={styles.ruleHeader}>
							<span className={styles.ruleNumber}>
								{index + 1}
							</span>
							<button
								type="button"
								className={styles.chipRemove}
								onClick={() => moveRule(index, index - 1)}
								disabled={index === 0}
								aria-label="Move rule up"
							>
								↑
							</button>
							<button
								type="button"
								className={styles.chipRemove}
								onClick={() => moveRule(index, index + 1)}
								disabled={index === rules.length - 1}
								aria-label="Move rule down"
							>
								↓
							</button>
							<div className={styles.spacer} />
							<button
								type="button"
								className={styles.chipRemove}
								onClick={() => removeRule(index)}
								aria-label="Remove rule"
							>
								✕
							</button>
						</div>

						<div className={styles.field}>
							<label className={styles.fieldLabel}>When</label>
							<Select
								value={rule.field}
								onChange={(v) =>
									updateRule(index, { field: v })
								}
								ariaLabel="Field"
								searchable={availableFields.length > 12}
								options={availableFields.map((f) => ({
									value: f,
									label: f,
								}))}
							/>
						</div>

						<div className={styles.row}>
							<Select
								value={rule.operator}
								onChange={(v) =>
									updateRule(index, {
										operator: v as ConditionOperator,
									})
								}
								ariaLabel="Operator"
								options={Object.entries(operatorLabels).map(
									([value, label]) => ({ value, label }),
								)}
							/>
							<input
								type="number"
								className={styles.input}
								value={rule.value ?? 0}
								onChange={(e) =>
									updateRule(index, {
										value: Number(e.target.value),
									})
								}
								aria-label="Threshold"
							/>
							{rule.operator === "between" && (
								<input
									type="number"
									className={styles.input}
									value={rule.value2 ?? 0}
									onChange={(e) =>
										updateRule(index, {
											value2: Number(e.target.value),
										})
									}
									aria-label="Upper bound"
								/>
							)}
						</div>

						<div className={styles.field} style={{ marginTop: 8 }}>
							<label className={styles.fieldLabel}>
								Text colour
							</label>
							<div className={styles.swatchGrid}>
								<button
									type="button"
									className={`${styles.swatch} ${
										!rule.textColor
											? styles.swatchActive
											: ""
									}`}
									style={{
										background: "transparent",
										borderStyle: "dashed",
									}}
									title="No colour"
									onClick={() =>
										updateRule(index, {
											textColor: undefined,
										})
									}
								/>
								{swatches.map((s) => {
									const active =
										rule.textColor &&
										"token" in rule.textColor &&
										rule.textColor.token === s.token;
									return (
										<button
											key={s.token}
											type="button"
											className={`${styles.swatch} ${active ? styles.swatchActive : ""}`}
											style={{ background: s.hex }}
											title={s.token}
											onClick={() =>
												updateRule(index, {
													textColor: {
														token: s.token,
													} as ColorSpec,
												})
											}
										/>
									);
								})}
							</div>
						</div>

						<div className={styles.field}>
							<label className={styles.fieldLabel}>
								Background
							</label>
							<div className={styles.swatchGrid}>
								<button
									type="button"
									className={`${styles.swatch} ${
										!rule.background
											? styles.swatchActive
											: ""
									}`}
									style={{
										background: "transparent",
										borderStyle: "dashed",
									}}
									title="No background"
									onClick={() =>
										updateRule(index, {
											background: undefined,
										})
									}
								/>
								{swatches.map((s) => {
									const active =
										rule.background &&
										"token" in rule.background &&
										rule.background.token === s.token;
									return (
										<button
											key={s.token}
											type="button"
											className={`${styles.swatch} ${active ? styles.swatchActive : ""}`}
											style={{ background: s.hex }}
											title={s.token}
											onClick={() =>
												updateRule(index, {
													background: {
														token: s.token,
													} as ColorSpec,
												})
											}
										/>
									);
								})}
							</div>
						</div>

						<div className={styles.field}>
							<label className={styles.fieldLabel}>
								Marker, shown before the value
							</label>
							<div className={styles.row}>
								<input
									className={styles.input}
									value={rule.marker ?? ""}
									placeholder="none"
									maxLength={3}
									onChange={(e) =>
										updateRule(index, {
											marker: e.target.value || undefined,
										})
									}
								/>
								{markerSuggestions.map((m) => (
									<button
										key={m}
										type="button"
										className={styles.markerButton}
										onClick={() =>
											updateRule(index, { marker: m })
										}
										aria-label={`Use ${m}`}
									>
										{m}
									</button>
								))}
							</div>
							{/* Not a nag: colour alone disappears in greyscale and
							    for a reader with colour vision deficiency, and
							    this is the one place to catch it. */}
							{(rule.textColor || rule.background) &&
								!rule.marker && (
									<p
										className={styles.guidance}
										style={{ marginTop: 6 }}
									>
										This rule uses colour only. A marker
										keeps it readable in print and for
										readers who cannot distinguish the hue.
									</p>
								)}
						</div>

						<button
							type="button"
							className={styles.checkRow}
							onClick={() =>
								updateRule(index, { bold: !rule.bold })
							}
						>
							<span
								className={`${styles.checkbox} ${rule.bold ? styles.checked : ""}`}
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
							Bold the value
						</button>
					</div>
				))}

				<button
					type="button"
					className={styles.toolButton}
					onClick={addRule}
					style={{ width: "100%", justifyContent: "center" }}
				>
					+ Add rule
				</button>
			</div>

			{allowScales && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Colour scale</div>
					<p className={styles.guidance}>
						A gradient across the column range, for finding extremes
						rather than testing a threshold. A data bar compares
						more precisely and reads without colour at all.
					</p>

					{scales.map((scale, index) => (
						<div key={index} className={styles.ruleCard}>
							<div className={styles.ruleHeader}>
								<span className={styles.ruleNumber}>
									{scale.field}
								</span>
								<div className={styles.spacer} />
								<button
									type="button"
									className={styles.chipRemove}
									onClick={() =>
										onChange({
											colorScales: scales.filter(
												(_, i) => i !== index,
											),
										})
									}
									aria-label="Remove scale"
								>
									✕
								</button>
							</div>

							<div className={styles.field}>
								<label className={styles.fieldLabel}>
									Column
								</label>
								<Select
									value={scale.field}
									onChange={(v) =>
										updateScale(index, { field: v })
									}
									ariaLabel="Field"
									searchable={availableFields.length > 12}
									options={availableFields.map((f) => ({
										value: f,
										label: f,
									}))}
								/>
							</div>

							{themeColors &&
								(["sequential", "diverging"] as const).map(
									(kind) => {
										const ramps = scaleRamps.filter(
											(r) => r.kind === kind,
										);
										const active = rampFor(scale);
										return (
											<div
												key={kind}
												className={styles.field}
											>
												<label
													className={
														styles.fieldLabel
													}
												>
													{kind === "sequential"
														? "Low to high"
														: "Diverging from a midpoint"}
												</label>
												<div
													className={styles.rampGrid}
												>
													{ramps.map((ramp) => (
														<button
															key={ramp.id}
															type="button"
															className={`${styles.ramp} ${
																active?.id ===
																ramp.id
																	? styles.rampActive
																	: ""
															}`}
															title={
																ramp.note ??
																ramp.label
															}
															aria-pressed={
																active?.id ===
																ramp.id
															}
															onClick={() =>
																updateScale(
																	index,
																	{
																		kind: ramp.kind,
																		low: ramp.low,
																		high: ramp.high,
																		// A diverging ramp needs a
																		// pivot; zero is what makes
																		// profit and loss read right.
																		midpoint:
																			ramp.kind ===
																			"diverging"
																				? (scale.midpoint ??
																					0)
																				: undefined,
																	},
																)
															}
														>
															<span
																className={
																	styles.rampSwatch
																}
																style={{
																	background:
																		rampGradient(
																			ramp,
																			themeColors,
																			Boolean(
																				scale.asDataBar,
																			),
																		),
																}}
																aria-hidden="true"
															/>
															<span
																className={
																	styles.rampLabel
																}
															>
																{ramp.label}
															</span>
														</button>
													))}
												</div>
											</div>
										);
									},
								)}

							{themeColors && rampFor(scale)?.note && (
								<p className={styles.guidance}>
									{rampFor(scale)?.note}
								</p>
							)}

							{/* What the column will actually look like, at the
							    width it will be read at. */}
							{themeColors && (
								<div className={styles.field}>
									<label className={styles.fieldLabel}>
										Preview
									</label>
									<div
										className={styles.rampPreview}
										style={{
											background: rampGradient(
												scale,
												themeColors,
												Boolean(scale.asDataBar),
											),
										}}
										aria-hidden="true"
									/>
									<div className={styles.rampEnds}>
										<span>Lowest</span>
										{scale.kind === "diverging" && (
											<span>{scale.midpoint ?? 0}</span>
										)}
										<span>Highest</span>
									</div>
								</div>
							)}

							{scale.kind === "diverging" && (
								<div className={styles.field}>
									<label className={styles.fieldLabel}>
										Midpoint
									</label>
									<input
										type="number"
										className={styles.input}
										value={scale.midpoint ?? 0}
										onChange={(e) =>
											updateScale(index, {
												midpoint: Number(
													e.target.value,
												),
											})
										}
									/>
								</div>
							)}

							<button
								type="button"
								className={styles.checkRow}
								onClick={() =>
									updateScale(index, {
										asDataBar: !scale.asDataBar,
									})
								}
							>
								<span
									className={`${styles.checkbox} ${scale.asDataBar ? styles.checked : ""}`}
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
								Show as a data bar
							</button>
						</div>
					))}

					<button
						type="button"
						className={styles.toolButton}
						onClick={() =>
							onChange({
								colorScales: [
									...scales,
									{
										field: availableFields[0] ?? "",
										// The neutral default: intensity, with
										// no implication that high is good or
										// bad until an author says so.
										kind: "sequential",
										high: { token: "info" },
										asDataBar: false,
									},
								],
							})
						}
						style={{ width: "100%", justifyContent: "center" }}
					>
						+ Add colour scale
					</button>
				</div>
			)}
		</>
	);
}
