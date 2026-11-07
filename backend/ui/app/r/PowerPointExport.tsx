"use client";

import { useState } from "react";
import useSWR from "swr";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import form from "../authoring/Authoring.module.css";

// Taking a report away as a PowerPoint file. Everything in it can be edited there, with common
// charts as PowerPoint's own, and each export is recorded in Export audit.

interface DeckChoice {
	deckId: string;
	kind: string;
	title: string;
	recordField: string | null;
	recordSource: string | null;
}

export function PowerPointDialog({
	slug,
	pageId,
	pageTitle,
	pageCount,
	filters,
	onClose,
}: {
	slug: string;
	pageId: string | null;
	pageTitle: string;
	pageCount: number;
	// What this page is filtered to right now.
	filters: unknown[];
	onClose: () => void;
}) {
	const [choice, setChoice] = useState("page");
	const [record, setRecord] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const { data } = useSWR<{ decks: DeckChoice[] }>(
		`/api/report/${encodeURIComponent(slug)}/decks`,
	);
	const decks = (data?.decks ?? []).filter((deck) => deck.kind === "slides");
	const deck = decks.find((held) => held.deckId === choice);
	const { data: values } = useSWR<{ values: string[] }>(
		deck?.recordField && deck.recordSource
			? ["/api/query/values", deck.recordSource, deck.recordField]
			: null,
		async ([address, sourceKey, field]: [string, string, string]) => {
			const response = await fetch(address, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sourceKey,
					field,
					search: "",
					filters: [],
					limit: 200,
				}),
			});
			return response.json();
		},
	);

	const download = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch(
				`/api/report/${encodeURIComponent(slug)}/pptx`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						deck
							? {
									scope: "deck",
									deckId: deck.deckId,
									record: record || null,
								}
							: {
									scope: choice,
									pageId,
									filters,
								},
					),
				},
			);
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				throw new Error(detail?.error ?? "That did not export.");
			}
			const name = /filename="([^"]+)"/.exec(
				response.headers.get("Content-Disposition") ?? "",
			)?.[1];
			const link = document.createElement("a");
			link.href = URL.createObjectURL(await response.blob());
			link.download = name ?? "report.pptx";
			link.click();
			URL.revokeObjectURL(link.href);
			onClose();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not export.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			isOpen
			onClose={onClose}
			title="Export to PowerPoint"
			width="480px"
		>
			<div className={form.form}>
				<p className={form.hint}>
					Tables and common charts stay editable in PowerPoint, with
					their numbers under Edit Data. Other charts come as shapes
					you can move and recolour. It holds what you can see, as of
					now.
				</p>
				<label className={form.field}>
					<span className={form.label}>What to export</span>
					<Select
						value={choice}
						onChange={setChoice}
						options={[
							{
								value: "page",
								label: `This page, ${pageTitle}, with its filters`,
							},
							{
								value: "report",
								label: `The whole report, ${pageCount} page${pageCount === 1 ? "" : "s"}`,
							},
							...decks.map((held) => ({
								value: held.deckId,
								label: `Slides: ${held.title}`,
							})),
						]}
					/>
				</label>
				{deck?.recordField && (
					<label className={form.field}>
						<span className={form.label}>
							Which {deck.recordField}
						</span>
						<Select
							value={record}
							searchable
							placeholder="All of them"
							onChange={setRecord}
							options={(values?.values ?? []).map((value) => ({
								value,
								label: value,
							}))}
						/>
					</label>
				)}
				{failure && <div className={form.failure}>{failure}</div>}
				<div className={form.actions}>
					<button
						type="button"
						className={form.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={form.primary}
						disabled={busy}
						onClick={() => void download()}
					>
						{busy ? "Building" : "Download"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
