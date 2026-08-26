"use client";

import { useEffect, useMemo } from "react";
import {
	slotCandidates,
	suggestedSlots,
	templateByKey,
	templatesFor,
	type CandidateSource,
} from "../../lib/visuals/templates";
import { Select } from "../components/shared/Select";
import styles from "./Authoring.module.css";

// Choosing the shape a page starts in, and the fields that fill it.
//
// Shared by the new-report dialog and the add-page one, because they are the
// same question asked at two moments. Reading the templates from the same module
// the server builds from means the picker cannot offer a shape the server would
// then refuse.

export interface ChooserSource extends CandidateSource {
	sourceKey: string;
	title: string;
}

export function TemplateChooser({
	source,
	template,
	slots,
	onTemplate,
	onSlots,
}: {
	source: ChooserSource | null;
	// Null is a blank page, which stays available because no set of templates
	// covers everything somebody wants to build.
	template: string | null;
	slots: Record<string, string>;
	onTemplate: (key: string | null) => void;
	onSlots: (slots: Record<string, string>) => void;
}) {
	// Only the templates this source can complete. Offering one whose slots
	// cannot be filled wastes the choice: the author picks it, discovers there
	// is no date on this source, and starts again.
	const offered = useMemo(
		() => (source ? templatesFor(source) : []),
		[source],
	);

	const chosen = template ? templateByKey[template] : null;

	// A template chosen against one source and then a different source picked.
	// Cleared rather than left pointing at a shape this source cannot fill.
	useEffect(() => {
		if (!template) return;
		if (!offered.some((t) => t.key === template)) onTemplate(null);
	}, [template, offered, onTemplate]);

	if (!source) {
		return (
			<p className={styles.hint}>
				Choose a source to see the layouts available.
			</p>
		);
	}

	const pick = (key: string | null) => {
		onTemplate(key);
		// Suggested where there is a defensible suggestion and left empty
		// otherwise. See suggestedSlots: a source names its own time field, so
		// a date is not a guess, and a breakdown would be.
		const next = key ? templateByKey[key] : null;
		onSlots(next ? suggestedSlots(next, source) : {});
	};

	return (
		<>
			<div className={styles.field}>
				<span className={styles.label}>Start from</span>
				<div className={styles.templates}>
					{offered.map((t) => (
						<button
							key={t.key}
							type="button"
							className={`${styles.template} ${
								template === t.key ? styles.templateOn : ""
							}`}
							onClick={() => pick(t.key)}
							aria-pressed={template === t.key}
						>
							<span className={styles.templateName}>
								{t.label}
							</span>
							<span className={styles.templateBlurb}>
								{t.blurb}
							</span>
						</button>
					))}

					<button
						type="button"
						className={`${styles.template} ${
							template === null ? styles.templateOn : ""
						}`}
						onClick={() => pick(null)}
						aria-pressed={template === null}
					>
						<span className={styles.templateName}>Blank</span>
						<span className={styles.templateBlurb}>
							Start with nothing on it.
						</span>
					</button>
				</div>
			</div>

			{chosen && (
				<div className={styles.slots}>
					{chosen.slots.map((slot) => {
						const candidates = slotCandidates(slot, source);
						return (
							<label key={slot.key} className={styles.field}>
								<span className={styles.label}>
									{slot.label}
									{!slot.required && (
										<span className={styles.optional}>
											optional
										</span>
									)}
								</span>
								<Select
									value={slots[slot.key] ?? ""}
									onChange={(v) =>
										onSlots({ ...slots, [slot.key]: v })
									}
									placeholder={
										slot.required
											? "Choose one"
											: "Leave out"
									}
									options={candidates.map((f) => ({
										value: f.name,
										label: f.displayName || f.name,
									}))}
								/>
								{slot.help && (
									<span className={styles.hint}>
										{slot.help}
									</span>
								)}
							</label>
						);
					})}
				</div>
			)}
		</>
	);
}

// Whether every required slot is filled, so a dialog can say so before the
// server does.
export function slotsComplete(
	template: string | null,
	slots: Record<string, string>,
): boolean {
	if (!template) return true;
	const found = templateByKey[template];
	if (!found) return false;
	return found.slots
		.filter((s) => s.required)
		.every((s) => Boolean(slots[s.key]));
}
