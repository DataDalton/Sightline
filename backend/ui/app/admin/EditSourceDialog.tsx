"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { TabStrip } from "../components/shared/TabStrip";
import styles from "./Admin.module.css";

// Correcting how a source and its fields are presented.
//
// Registration and deactivation were the only two operations, so everything a
// report author saw came out of the catalogue verbatim: a column named badly
// upstream was a field named badly in every visual built on it, and the only
// fix was in Unity Catalog.
//
// Presentation only. The field name is the key a stored report refers to, so
// renaming it would break every visual that names it. What changes here is the
// label, the description and the format, which is what a reader sees.
//
// A sync writes only fields it has not seen before, so a correction made here
// survives the next catalogue walk.

interface Field {
	name: string;
	displayName: string | null;
	dataType: string | null;
	description: string | null;
	formatHint: string | null;
}

interface SourceDetail {
	sourceKey: string;
	title: string;
	description: string | null;
	kind: string;
	defaultTimeField: string | null;
	cacheTtlSeconds: number;
	dimensions: Field[];
	measures: Field[];
}

// Matches what the formatter understands. Anything else is passed through, so
// a hint set elsewhere is not silently dropped by this list.
const formatHints = [
	{ value: "", label: "Default for the type" },
	{ value: "currency", label: "Currency" },
	{ value: "percent", label: "Percent" },
	{ value: "integer", label: "Whole number" },
	{ value: "decimal", label: "Decimal" },
	{ value: "date", label: "Date" },
	{ value: "datetime", label: "Date and time" },
];

// Seconds, said the way somebody thinks about a refresh schedule.
function describeTtl(seconds: number): string {
	if (seconds < 60) return `About ${seconds} seconds`;
	if (seconds < 3600) return `About ${Math.round(seconds / 60)} minutes`;
	if (seconds < 86400) {
		const hours = seconds / 3600;
		return `About ${hours % 1 === 0 ? hours : hours.toFixed(1)} hours`;
	}
	const days = seconds / 86400;
	return `About ${days % 1 === 0 ? days : days.toFixed(1)} days`;
}

export function EditSourceDialog({
	sourceKey,
	onClose,
	onSaved,
}: {
	sourceKey: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const { data } = useSWR<{ source?: SourceDetail }>(
		`/api/admin?section=source&sourceKey=${encodeURIComponent(sourceKey)}`,
	);
	const source = data?.source;

	const [tab, setTab] = useState<"source" | "fields">("source");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [timeField, setTimeField] = useState("");
	const [cacheTtl, setCacheTtl] = useState("0");
	const [edits, setEdits] = useState<Record<string, Partial<Field>>>({});
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	// Seeded once the source arrives. Held as state rather than read through,
	// so typing does not fight the revalidation.
	useEffect(() => {
		if (!source) return;
		setTitle(source.title);
		setDescription(source.description ?? "");
		setTimeField(source.defaultTimeField ?? "");
		setCacheTtl(String(source.cacheTtlSeconds ?? 0));
	}, [source]);

	const fields = [...(source?.dimensions ?? []), ...(source?.measures ?? [])];

	const editField = (name: string, patch: Partial<Field>) =>
		setEdits((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));

	const valueFor = (field: Field, key: keyof Field): string => {
		const edited = edits[field.name]?.[key];
		if (edited !== undefined) return String(edited ?? "");
		return String(field[key] ?? "");
	};

	const save = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const send = async (body: Record<string, unknown>) => {
				const response = await fetch("/api/admin/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					const detail = await response.json().catch(() => null);
					throw new Error(detail?.error ?? "Could not save.");
				}
			};

			await send({
				action: "update",
				sourceKey,
				title,
				description,
				defaultTimeField: timeField,
				cacheTtlSeconds: Number(cacheTtl) || 0,
			});

			const changed = Object.entries(edits).map(([name, patch]) => ({
				fieldName: name,
				...patch,
			}));
			if (changed.length > 0) {
				await send({
					action: "updateFields",
					sourceKey,
					fields: changed,
				});
			}

			onSaved();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "Could not save.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal isOpen onClose={onClose} title="Edit source" width="760px">
			{!source ? (
				<div className={styles.state}>Loading</div>
			) : (
				<>
					<div className={styles.paneNav}>
						<TabStrip
							label="Source"
							value={tab}
							onChange={setTab}
							tabs={[
								{ id: "source", label: "Source" },
								{
									id: "fields",
									label: "Fields",
									count: fields.length,
								},
							]}
						/>
					</div>

					{tab === "source" ? (
						<div className={styles.fieldRow}>
							<label className={styles.field}>
								<span className={styles.fieldLabel}>Title</span>
								<input
									className={styles.input}
									value={title}
									onChange={(e) => setTitle(e.target.value)}
								/>
								<span className={styles.fieldHint}>
									What report authors see when they pick a
									source.
								</span>
							</label>

							<label className={styles.field}>
								<span className={styles.fieldLabel}>
									Description
								</span>
								<input
									className={styles.input}
									value={description}
									placeholder="What is in here"
									onChange={(e) =>
										setDescription(e.target.value)
									}
								/>
							</label>

							<label className={styles.field}>
								<span className={styles.fieldLabel}>
									Default time field
								</span>
								<Select
									value={timeField}
									onChange={setTimeField}
									placeholder="None"
									options={[
										{ value: "", label: "None" },
										...(source.dimensions ?? []).map(
											(f) => ({
												value: f.name,
												label: f.displayName ?? f.name,
												note: f.dataType ?? undefined,
											}),
										),
									]}
								/>
								<span className={styles.fieldHint}>
									What a date range filters on when a visual
									does not name one.
								</span>
							</label>

							<label className={styles.field}>
								<span className={styles.fieldLabel}>
									Reuse an answer for
								</span>
								<span className={styles.numberBox}>
									<input
										type="number"
										min={0}
										className={styles.numberInput}
										value={cacheTtl}
										onChange={(e) =>
											setCacheTtl(e.target.value)
										}
									/>
									<span className={styles.numberUnit}>
										seconds
									</span>
								</span>
								<span className={styles.fieldHint}>
									{Number(cacheTtl) > 0
										? `Overrides the platform setting for this source. ${describeTtl(Number(cacheTtl))}.`
										: "Zero uses the platform setting under Configuration, Performance."}{" "}
									Set this to match how often the data
									actually lands.
								</span>
							</label>
						</div>
					) : (
						<div className={styles.tableWrap}>
							<table className={styles.table}>
								<thead>
									<tr>
										<th>Field</th>
										<th>Shown as</th>
										<th>Description</th>
										<th>Format</th>
									</tr>
								</thead>
								<tbody>
									{fields.map((field) => (
										<tr key={field.name}>
											<td className={styles.mono}>
												{field.name}
												<div
													className={styles.fieldHint}
												>
													{field.dataType ?? ""}
												</div>
											</td>
											<td>
												<input
													className={styles.input}
													value={valueFor(
														field,
														"displayName",
													)}
													placeholder={field.name}
													onChange={(e) =>
														editField(field.name, {
															displayName:
																e.target.value,
														})
													}
												/>
											</td>
											<td>
												<input
													className={styles.input}
													value={valueFor(
														field,
														"description",
													)}
													placeholder="Optional"
													onChange={(e) =>
														editField(field.name, {
															description:
																e.target.value,
														})
													}
												/>
											</td>
											<td>
												<Select
													value={valueFor(
														field,
														"formatHint",
													)}
													onChange={(v) =>
														editField(field.name, {
															formatHint: v,
														})
													}
													options={formatHints}
												/>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}

					{failure && (
						<div className={styles.saveError}>{failure}</div>
					)}

					<div className={styles.rowActions}>
						<button
							type="button"
							className={styles.linkButton}
							onClick={onClose}
							disabled={busy}
						>
							Cancel
						</button>
						<button
							type="button"
							className={styles.saveButton}
							onClick={save}
							disabled={busy || !title.trim()}
						>
							{busy ? "Saving" : "Save"}
						</button>
					</div>
				</>
			)}
		</Modal>
	);
}
