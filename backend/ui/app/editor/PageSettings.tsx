"use client";

import type { SourceMeta } from "../visuals/types";
import type { PageConfig } from "./ReportEditor";
import styles from "./Editor.module.css";

// Settings that belong to the page rather than to any visual on it.
//
// Shown in the properties panel when nothing is selected, which is the right
// default: the panel is where an author looks to change something, and with no
// visual chosen the page itself is what they are looking at.
//
// Today that is the data-through stamp. Which column means "when this was
// true" is a judgement only someone who knows the data can make: an order
// date, a payment date and a load timestamp all answer different questions,
// and picking the wrong one tells readers the data is fresher or staler than
// it is. So it is offered as a choice rather than guessed at, with the
// source's own time field as the starting point.

interface PageSettingsProps {
	source: SourceMeta | undefined;
	config: PageConfig;
	pageTitle: string;
	// The line under the report title, shown on every page of the report.
	reportDescription: string;
	onChange: (next: PageConfig) => void;
	onPageTitleChange: (next: string) => void;
	onDescriptionChange: (next: string) => void;
}

export function PageSettings({
	source,
	config,
	pageTitle,
	reportDescription,
	onChange,
	onPageTitleChange,
	onDescriptionChange,
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
	const setFreshness = (next: { field?: string | null; label?: string | null }) =>
		onChange({ ...config, freshness: { ...freshness, ...next } });

	return (
		<div className={styles.settingsPanel}>
			<div className={styles.settingsTitle}>Page settings</div>
			<p className={styles.settingsIntro}>
				These apply to the whole page. Select a visual to edit that instead.
			</p>

			<label className={styles.settingsField}>
				<span className={styles.settingsLabel}>Page name</span>
				<input
					type="text"
					className={styles.settingsInput}
					value={pageTitle}
					onChange={(e) => onPageTitleChange(e.target.value)}
				/>
				<span className={styles.settingsHint}>
					Shown on the page tab when a report has more than one page.
				</span>
			</label>

			<label className={styles.settingsField}>
				<span className={styles.settingsLabel}>Subtitle</span>
				<textarea
					className={styles.settingsInput}
					rows={2}
					placeholder="What this report is for"
					value={reportDescription}
					onChange={(e) => onDescriptionChange(e.target.value)}
				/>
				<span className={styles.settingsHint}>
					The line under the report title. It belongs to the report, so it
					shows on every page.
				</span>
			</label>

			<label className={styles.settingsField}>
				<span className={styles.settingsLabel}>Data through column</span>
				<select
					className={styles.settingsInput}
					value={freshness.field ?? ""}
					onChange={(e) =>
						setFreshness({ field: e.target.value || null })
					}
				>
					<option value="">
						{source?.defaultTimeField
							? `Source default (${source.defaultTimeField})`
							: "None"}
					</option>
					{dateFields.length > 0 && (
						<optgroup label="Dates">
							{dateFields.map((f) => (
								<option key={f.name} value={f.name}>
									{f.name}
								</option>
							))}
						</optgroup>
					)}
					{otherFields.length > 0 && (
						<optgroup label="Other fields">
							{otherFields.map((f) => (
								<option key={f.name} value={f.name}>
									{f.name}
								</option>
							))}
						</optgroup>
					)}
				</select>
				<span className={styles.settingsHint}>
					The stamp shows the largest value this column takes, ignoring the
					page filters.
				</span>
			</label>

			<label className={styles.settingsField}>
				<span className={styles.settingsLabel}>Stamp wording</span>
				<input
					type="text"
					className={styles.settingsInput}
					placeholder="Data through"
					value={freshness.label ?? ""}
					onChange={(e) => setFreshness({ label: e.target.value || null })}
				/>
			</label>

		</div>
	);
}
