"use client";

import { visualByType } from "../../lib/visuals/catalog";
import { palettePresets } from "../../lib/visuals/style";
import type { VisualStyle } from "../../lib/visuals/style";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { CloseIcon, Hint } from "./PanelSection";
import type { EditableVisual } from "./types";
import styles from "./Editor.module.css";

// Changing several selected visuals at once.
//
// Offers only what at least one of them supports, and each change lands only on
// the ones that support it, so a selection of a chart and a table can still set
// the chart's legend without writing a meaningless setting onto the table. Fields
// and queries stay out of this, because they belong to one visual at a time.

type Supports = (typeof visualByType)[string]["supports"];

function styleOf(visual: EditableVisual): VisualStyle {
	return ((visual.config as { style?: VisualStyle }).style ??
		{}) as VisualStyle;
}

export function MultiEditPanel({
	visuals,
	readOnly,
	onApply,
	onClose,
}: {
	visuals: EditableVisual[];
	readOnly: boolean;
	onApply: (next: EditableVisual[]) => void;
	onClose: () => void;
}) {
	const supportsOf = (visual: EditableVisual): Supports =>
		visualByType[visual.visualType]?.supports ?? {};
	const holding = (flag: (s: Supports) => unknown) =>
		visuals.filter((visual) => Boolean(flag(supportsOf(visual))));

	const applyStyle = (
		flag: (s: Supports) => unknown,
		patch: (style: VisualStyle) => Partial<VisualStyle>,
	) =>
		onApply(
			holding(flag).map((visual) => ({
				...visual,
				config: {
					...visual.config,
					style: { ...styleOf(visual), ...patch(styleOf(visual)) },
				},
			})),
		);

	const applySize = (w: number) =>
		onApply(
			visuals.map((visual) => ({
				...visual,
				layout: { ...visual.layout, w },
			})),
		);

	// What a setting reads when the selection agrees on it, and nothing when it
	// does not, so a mixed selection does not claim one value for all of them.
	const shared = <T,>(
		list: EditableVisual[],
		read: (style: VisualStyle) => T,
	): T | null => {
		if (list.length === 0) return null;
		const first = read(styleOf(list[0]));
		return list.every((visual) => read(styleOf(visual)) === first)
			? first
			: null;
	};

	const withLegend = holding((s) => s.legend);
	const withAxes = holding((s) => s.axisBounds);
	const withRounding = holding((s) => s.rounding);
	const withRows = holding((s) => s.rowShading);
	const withColour = holding((s) => s.color || s.paletteOnly);

	return (
		<aside
			className={`${styles.panel} ${readOnly ? styles.panelReadOnly : ""}`}
			aria-label="Selected visuals"
		>
			<div className={styles.ruleHeader} style={{ padding: 12 }}>
				<span className={styles.fieldLabel}>
					{visuals.length} visuals selected
				</span>
				<div className={styles.spacer} />
				<button
					type="button"
					className={styles.iconButton}
					onClick={onClose}
					aria-label="Clear the selection"
				>
					<CloseIcon />
				</button>
			</div>

			<div className={styles.panelBody} style={{ padding: 12 }}>
				<Hint>
					A change applies to every selected visual that supports it.
				</Hint>

				<div className={styles.field}>
					<label className={styles.fieldLabel}>Width</label>
					<Select
						value=""
						onChange={(v) => {
							if (v) applySize(Number(v));
						}}
						ariaLabel="Width"
						options={[
							{ value: "", label: "Set the same width" },
							{ value: "3", label: "Quarter of the page" },
							{ value: "4", label: "Third of the page" },
							{ value: "6", label: "Half of the page" },
							{ value: "12", label: "Full width" },
						]}
					/>
				</div>

				{withColour.length > 0 && (
					<div className={styles.field}>
						<label className={styles.fieldLabel}>Colours</label>
						<Select
							value=""
							onChange={(id) => {
								const preset = palettePresets.find(
									(p) => p.id === id,
								);
								if (preset) {
									applyStyle(
										(s) => s.color || s.paletteOnly,
										() => ({ palette: preset.tokens }),
									);
								}
							}}
							ariaLabel="Colours"
							options={[
								{ value: "", label: "Choose a set of colours" },
								...palettePresets.map((p) => ({
									value: p.id,
									label: p.label,
								})),
							]}
						/>
					</div>
				)}

				{withLegend.length > 0 && (
					<>
						<div className={styles.field}>
							<Toggle
								checked={
									shared(
										withLegend,
										(s) => s.legend?.show !== false,
									) ?? true
								}
								onChange={(show) =>
									applyStyle(
										(s) => s.legend,
										(style) => ({
											legend: { ...style.legend, show },
										}),
									)
								}
								label="Show the legend"
							/>
						</div>
						<div className={styles.field}>
							<label className={styles.fieldLabel}>
								Legend position
							</label>
							<Select
								value={
									shared(withLegend, (s) =>
										s.legend?.position === "bottom"
											? "bottom"
											: "top",
									) ?? ""
								}
								onChange={(position) => {
									if (position) {
										applyStyle(
											(s) => s.legend,
											(style) => ({
												legend: {
													...style.legend,
													position: position as
														| "top"
														| "bottom",
												},
											}),
										);
									}
								}}
								ariaLabel="Legend position"
								options={[
									{ value: "", label: "Mixed" },
									{ value: "top", label: "Above the chart" },
									{
										value: "bottom",
										label: "Below the chart",
									},
								]}
							/>
						</div>
					</>
				)}

				{withAxes.length > 0 && (
					<div className={styles.field}>
						<Toggle
							checked={
								shared(
									withAxes,
									(s) => s.yAxis?.showGrid !== false,
								) ?? true
							}
							onChange={(showGrid) =>
								applyStyle(
									(s) => s.axisBounds,
									(style) => ({
										yAxis: { ...style.yAxis, showGrid },
									}),
								)
							}
							label="Show gridlines"
						/>
					</div>
				)}

				{withRounding.length > 0 && (
					<div className={styles.field}>
						<label className={styles.fieldLabel}>
							Corner rounding
						</label>
						<input
							type="range"
							className={styles.range}
							min={0}
							max={12}
							step={1}
							value={
								shared(
									withRounding,
									(s) => s.cornerRadius ?? 2,
								) ?? 2
							}
							onChange={(e) =>
								applyStyle(
									(s) => s.rounding,
									() => ({
										cornerRadius: Number(e.target.value),
									}),
								)
							}
						/>
					</div>
				)}

				{withRows.length > 0 && (
					<div className={styles.field}>
						<Toggle
							checked={
								shared(
									withRows,
									(s) => s.stripedRows !== false,
								) ?? true
							}
							onChange={(stripedRows) =>
								applyStyle(
									(s) => s.rowShading,
									() => ({ stripedRows }),
								)
							}
							label="Shade alternate rows"
						/>
					</div>
				)}
			</div>
		</aside>
	);
}
