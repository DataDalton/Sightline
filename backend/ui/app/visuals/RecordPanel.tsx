"use client";

import { useMemo } from "react";
import { useVisualQuery } from "../hooks/useVisualQuery";
import { queryForVisual } from "../../lib/query/visualSpec";
import { formatValue, type FormatHint } from "../../lib/format";
import { VisualLoadingState } from "./LoadingState";
import { VisualEmpty, VisualError } from "./VisualFrame";
import { fieldTooltip, type FieldMeta } from "./types";
import { evaluateConditions, type VisualStyle } from "../../lib/visuals/style";
import { readThemeColors, withAlpha } from "./colors";
import { useTheme } from "../context/ThemeContext";
import styles from "./Visual.module.css";

// One record, laid out as label and value.
//
// Two shapes of the same thing. A header runs across the top of a detail page
// and names what the page is about; a list is a panel of everything known
// about that record. Both were rendering as a scrolling data grid, complete
// with a search box and an export button, squeezed into a couple of rows. A
// grid is for looking something up among many rows, which is the opposite of
// what a page about one record needs.
//
// Where the query returns more than one row the page has not been narrowed to
// a single record. That is said rather than hidden, because quietly showing
// the first row of many looks exactly like showing the right one.

interface RecordPanelProps {
	sourceKey: string;
	// The stored type, not the layout. The query shape is decided from it in
	// lib/query/visualSpec, which is also what the server warms against, so a
	// name invented here would key on a query nobody asks for.
	visualType: string;
	dimensions: string[];
	measures: string[];
	filters: unknown[];
	fields: Map<string, FieldMeta>;
	layout: "header" | "list";
	style?: VisualStyle;
}

export function RecordPanel({
	sourceKey,
	visualType,
	dimensions,
	measures,
	filters,
	fields,
	layout,
	style,
}: RecordPanelProps) {
	// Two rows asked for rather than one, so the panel can tell the difference
	// between "this is the record" and "this is one of several".
	const { rows, error, isLoading } = useVisualQuery(
		queryForVisual(visualType, {
			sourceKey,
			dimensions,
			measures,
			filters,
		}),
	);

	const rules = style?.conditions ?? [];
	const { resolved: resolvedTheme } = useTheme();
	const colors = useMemo(
		() => (typeof window === "undefined" ? null : readThemeColors()),
		// The palette is read off the document, so a theme switch reads it again.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[resolvedTheme],
	);

	if (error) return <VisualError error={error} />;

	const names = [...dimensions, ...measures];

	if (isLoading && rows.length === 0) {
		return (
			<div
				className={
					layout === "header"
						? styles.recordHeader
						: styles.recordList
				}
			>
				{names.map((name) => (
					<div key={name} className={styles.recordField}>
						<span className={styles.recordLabel}>{name}</span>
						<VisualLoadingState
							variant={style?.loadingAnimation ?? "skeleton"}
							height={20}
							rows={1}
						/>
					</div>
				))}
			</div>
		);
	}

	if (rows.length === 0) return <VisualEmpty />;

	const record = rows[0];
	const ambiguous = rows.length > 1;

	return (
		<>
			{ambiguous && (
				<div className={styles.recordNotice} role="status">
					Showing the first of several matching records. Add a filter
					to this page to pick one.
				</div>
			)}

			<div
				className={
					layout === "header"
						? styles.recordHeader
						: styles.recordList
				}
			>
				{names.map((name) => {
					const field = fields.get(name);
					const hint = (field?.formatHint as FormatHint) ?? "text";
					const match = colors
						? evaluateConditions(rules, record, name)
						: null;
					return (
						<div
							key={name}
							className={styles.recordField}
							title={fieldTooltip(field, name)}
						>
							<span className={styles.recordLabel}>
								{field?.displayName ?? name}
							</span>
							<span
								className={styles.recordValue}
								style={
									match && colors
										? {
												color: match.textColor
													? colors.resolve(
															match.textColor,
															colors.text,
														)
													: undefined,
												background: match.background
													? withAlpha(
															colors.resolve(
																match.background,
																colors
																	.series[0],
															),
															0.18,
														)
													: undefined,
												fontWeight: match.bold
													? 700
													: undefined,
											}
										: undefined
								}
							>
								{match?.marker && (
									<span className={styles.kpiMarker}>
										{match.marker}
									</span>
								)}
								{formatValue(record[name], hint)}
							</span>
						</div>
					);
				})}
			</div>
		</>
	);
}
