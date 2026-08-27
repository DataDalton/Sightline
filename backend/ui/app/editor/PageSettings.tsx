"use client";

import type { SourceMeta } from "../visuals/types";
import type { PageConfig } from "./ReportEditor";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { Hint, Section } from "./PanelSection";
import styles from "./Editor.module.css";

// Settings that belong to the page rather than to any visual on it.
//
// Shown in the properties panel when nothing is selected, which is the right
// default: the panel is where an author looks to change something, and with no
// visual chosen the page itself is what they are looking at.
//
// Grouped rather than stacked. Five fields in a row, each with a line of
// explanation under it, read as one long paragraph with inputs in it, and the
// two that decide the freshness stamp were not visibly a pair.

interface PageSettingsProps {
	source: SourceMeta | undefined;
	config: PageConfig;
	pageTitle: string;
	onChange: (next: PageConfig) => void;
	onPageTitleChange: (next: string) => void;
}

export function PageSettings({
	source,
	config,
	pageTitle,
	onChange,
	onPageTitleChange,
}: PageSettingsProps) {
	// Date-like fields first, since a freshness stamp is almost always a date,
	// but every dimension stays available: some sources carry the load stamp
	// as a string.
	const dimensions = source?.dimensions ?? [];
	const dateFields = dimensions.filter(
		(f) =>
			(f.dataType ?? "").startsWith("date") ||
			(f.dataType ?? "").startsWith("timestamp"),
	);
	const otherFields = dimensions.filter((f) => !dateFields.includes(f));

	const freshness = config.freshness ?? {};
	const setFreshness = (next: {
		field?: string | null;
		label?: string | null;
	}) => onChange({ ...config, freshness: { ...freshness, ...next } });

	const stampCount = [
		Boolean(freshness.field),
		Boolean(freshness.label),
	].filter(Boolean).length;
	const behaviourCount = [
		config.stickyFilters === true,
		Boolean(config.emptyText),
	].filter(Boolean).length;

	return (
		<>
			<Section id="page-about" title="About">
				<div className={styles.field}>
					<label className={styles.fieldLabel} htmlFor="page-name">
						Page name
					</label>
					<input
						id="page-name"
						type="text"
						className={styles.input}
						value={pageTitle}
						onChange={(e) => onPageTitleChange(e.target.value)}
					/>
					<Hint>
						Shown on the page tab when a report has more than one
						page.
					</Hint>
				</div>
			</Section>

			{/* Which column means "when this was true" is a judgement only
			    someone who knows the data can make: an order date, a payment
			    date and a load timestamp all answer different questions, and
			    picking the wrong one tells readers the data is fresher or
			    staler than it is. So it is offered as a choice rather than
			    guessed at, with the source's own time field as the start. */}
			<Section
				id="page-stamp"
				title="Data through stamp"
				count={stampCount}
			>
				<div className={styles.field}>
					<label className={styles.fieldLabel}>Column</label>
					<Select
						value={freshness.field ?? ""}
						onChange={(v) => setFreshness({ field: v || null })}
						ariaLabel="Freshness field"
						searchable={dateFields.length + otherFields.length > 12}
						options={[
							{
								value: "",
								label: source?.defaultTimeField
									? `Source default (${source.defaultTimeField})`
									: "None",
							},
							...dateFields.map((f) => ({
								value: f.name,
								label: f.name,
								group: "Dates",
							})),
							...otherFields.map((f) => ({
								value: f.name,
								label: f.name,
								group: "Other fields",
							})),
						]}
					/>
					<Hint>
						The stamp shows the largest value this column takes,
						ignoring the page filters.
					</Hint>
				</div>

				<div className={styles.field}>
					<label className={styles.fieldLabel} htmlFor="stamp-words">
						Wording
					</label>
					<input
						id="stamp-words"
						type="text"
						className={styles.input}
						placeholder="Data through"
						value={freshness.label ?? ""}
						onChange={(e) =>
							setFreshness({ label: e.target.value || null })
						}
					/>
				</div>
			</Section>

			<Section
				id="page-behaviour"
				title="Behaviour"
				defaultOpen={false}
				count={behaviourCount}
			>
				<div className={styles.field}>
					<Toggle
						checked={config.stickyFilters === true}
						onChange={(next) =>
							onChange({ ...config, stickyFilters: next })
						}
						label="Keep the filters in view"
					/>
					<Hint>
						For a page long enough that the controls scroll away. On
						a short page it costs height and buys nothing.
					</Hint>
				</div>

				<div className={styles.field}>
					<label className={styles.fieldLabel} htmlFor="empty-text">
						When there is nothing to show
					</label>
					<input
						id="empty-text"
						type="text"
						className={styles.input}
						placeholder="This page has no visuals configured yet."
						value={(config.emptyText as string) ?? ""}
						onChange={(e) =>
							onChange({
								...config,
								emptyText: e.target.value || undefined,
							})
						}
					/>
					<Hint>
						The default is written for whoever is building the page,
						which is the wrong audience once it is published.
					</Hint>
				</div>
			</Section>
		</>
	);
}
