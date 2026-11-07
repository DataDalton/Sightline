"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import {
	readLinks,
	suggestTargets,
	type LinkTarget,
	type ReportLink,
} from "../../lib/visuals/reportLinks";
import { CloseIcon, Hint } from "./PanelSection";
import { Select } from "../components/shared/Select";
import styles from "./Editor.module.css";

// Choosing which reports a visual leads to.
//
// Reports that can take a filter on this visual's fields are offered first,
// because those are the ones a click can really carry over to. Anything else can
// still be chosen, which is what a row of navigation links wants, and the note
// under it says that a click will not filter it.

export function ReportLinksEditor({
	value,
	fields,
	requireReceiver,
	onChange,
}: {
	value: unknown;
	// The fields a click on this visual can carry. Empty for navigation links.
	fields: string[];
	// Whether a target has to be able to take the click to be of any use.
	requireReceiver: boolean;
	onChange: (links: ReportLink[] | undefined) => void;
}) {
	const links = readLinks(value);
	const [adding, setAdding] = useState("");
	const { data, error } = useSWR<{ targets: LinkTarget[] }>(
		"/api/report-links",
	);
	const targets = useMemo(() => data?.targets ?? [], [data]);

	const { suggested, others } = useMemo(
		() =>
			suggestTargets(
				targets.filter((t) => !links.some((l) => l.slug === t.slug)),
				fields,
			),
		[targets, links, fields],
	);

	const store = (next: ReportLink[]) =>
		onChange(next.length > 0 ? next : undefined);

	const add = (slug: string) => {
		const target = targets.find((t) => t.slug === slug);
		if (!target) return;
		store([...links, { slug: target.slug, title: target.title }]);
		setAdding("");
	};

	const receives = (slug: string) =>
		suggestTargets(
			targets.filter((t) => t.slug === slug),
			fields,
		).suggested.length > 0;

	return (
		<>
			{links.map((link, index) => (
				<div key={link.slug} className={styles.ruleCard}>
					<div className={styles.ruleHeader}>
						<span className={styles.ruleNumber}>{link.title}</span>
						<div className={styles.spacer} />
						<button
							type="button"
							className={`${styles.iconButton} ${styles.iconRemove}`}
							onClick={() =>
								store(links.filter((_, i) => i !== index))
							}
							aria-label={`Remove ${link.title}`}
						>
							<CloseIcon />
						</button>
					</div>
					<div className={styles.field}>
						<label className={styles.fieldLabel}>Shown as</label>
						<input
							className={styles.input}
							value={link.label ?? ""}
							placeholder={link.title}
							onChange={(e) =>
								store(
									links.map((held, i) =>
										i === index
											? {
													...held,
													label:
														e.target.value ||
														undefined,
												}
											: held,
									),
								)
							}
						/>
					</div>
					{requireReceiver &&
						targets.length > 0 &&
						!receives(link.slug) && (
							<Hint>
								This report has no filter on{" "}
								{fields.join(" or ")}, so it will not be offered
								when someone clicks here. Add that filter to the
								report to connect them.
							</Hint>
						)}
				</div>
			))}

			{error ? (
				<Hint>The list of reports could not be read.</Hint>
			) : (
				<div className={styles.field}>
					<label className={styles.fieldLabel}>Add a report</label>
					<Select
						value={adding}
						onChange={add}
						ariaLabel="Add a report"
						searchable={targets.length > 12}
						options={[
							{ value: "", label: "Choose a report" },
							...suggested.map((t) => ({
								value: t.slug,
								label: requireReceiver
									? `${t.title} (can filter to this)`
									: t.title,
							})),
							...others.map((t) => ({
								value: t.slug,
								label: t.title,
							})),
						]}
					/>
				</div>
			)}
		</>
	);
}
