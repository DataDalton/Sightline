"use client";

import { useState } from "react";
import useSWR from "swr";
import { filterWidgetsOf } from "../../lib/visuals/filterWidgets";
import {
	type Deck,
	type DeckStep,
	type MarkKind,
	type VisualMark,
} from "../../lib/visuals/deck";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import type { SourceMeta } from "../visuals/types";
import { SlideEditor, type DeckDraft } from "./SlideEditor";
import type { EditableVisual } from "./types";
import styles from "./Editor.module.css";

// Building walkthroughs and slides by working through the page in the editor, and the
// marks kept on a page for good. Saved on their own rather than through Publish, since
// none of this changes what the report's visuals show.

interface DecksAnswer {
	decks: Deck[];
	stats: { deckId: string; started: number; finished: number }[];
}

const markOptions = [
	{ value: "", label: "Just the spotlight" },
	{ value: "highlight", label: "Stronger highlight" },
	{ value: "arrow", label: "An arrow" },
];

const markNames: Record<MarkKind, string> = {
	callout: "A callout",
	arrow: "An arrow",
	highlight: "A highlight",
};

const blankDeck = (kind: Deck["kind"]): Omit<Deck, "deckId" | "epoch"> => ({
	kind,
	title: "",
	steps: [],
	promptOnce: false,
	recordField: null,
	recordSource: null,
	requireRecord: false,
});

export function DeckPanel({
	slug,
	pageId,
	pageTitle,
	pages,
	visuals,
	selection,
	sources,
	pageSourceKey,
	canAskAssistant,
	marks,
	onMarks,
	readOnly,
	onClose,
}: {
	slug: string;
	pageId: string;
	pageTitle: string;
	pages: { pageId: string; title: string }[];
	visuals: EditableVisual[];
	selection: string[];
	sources: Record<string, SourceMeta>;
	pageSourceKey: string | null;
	canAskAssistant: boolean;
	marks: VisualMark[];
	onMarks: (next: VisualMark[]) => void;
	readOnly: boolean;
	onClose: () => void;
}) {
	const address = `/api/report/${encodeURIComponent(slug)}/decks`;
	const { data, mutate } = useSWR<DecksAnswer>(address);
	const [draft, setDraft] = useState<
		(Omit<Deck, "deckId" | "epoch"> & { deckId?: string }) | null
	>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [told, setTold] = useState<string | null>(null);
	const [markText, setMarkText] = useState("");
	const [markKind, setMarkKind] = useState<MarkKind>("callout");
	const [slideDeck, setSlideDeck] = useState<DeckDraft | null>(null);

	const post = async (body: Record<string, unknown>) => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch(address, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const detail = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(detail?.error ?? "That did not work.");
				return null;
			}
			await mutate();
			return detail;
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
			return null;
		} finally {
			setBusy(false);
		}
	};

	const widgets = filterWidgetsOf(visuals as never);
	const named = (id: string | null) =>
		visuals.find((v) => v.visualId === id)?.title ?? "a visual";
	const pageName = (id: string | null) =>
		pages.find((p) => p.pageId === id)?.title ?? "Another page";

	const setStep = (index: number, patch: Partial<DeckStep>) =>
		setDraft((held) =>
			held
				? {
						...held,
						steps: held.steps.map((step, i) =>
							i === index ? { ...step, ...patch } : step,
						),
					}
				: held,
		);
	const moveStep = (index: number, by: number) =>
		setDraft((held) => {
			if (!held) return held;
			const steps = [...held.steps];
			const [step] = steps.splice(index, 1);
			steps.splice(index + by, 0, step);
			return { ...held, steps };
		});

	// Takes where the author is standing: this page, and whatever is selected on it.
	const addStep = () =>
		setDraft((held) =>
			held
				? {
						...held,
						steps: [
							...held.steps,
							{
								id: crypto.randomUUID(),
								title: "",
								text: "",
								pageId,
								visualId: selection[0] ?? null,
								filters: {},
								mark: null,
								visualIds: [],
							},
						],
					}
				: held,
		);

	const draftWithAssistant = async () => {
		if (!draft) return;
		const detail = await post({ action: "draft" });
		if (detail?.steps) {
			setDraft((held) =>
				held ? { ...held, steps: detail.steps as DeckStep[] } : held,
			);
		}
	};

	const slideDecks = (data?.decks ?? []).filter(
		(deck) => deck.kind === "slides",
	);
	const walkthroughs = (data?.decks ?? []).filter(
		(deck) => deck.kind === "walkthrough",
	);

	const listRow = (deck: Deck) => {
		const stats = data?.stats.find((row) => row.deckId === deck.deckId);
		const count = deck.steps.length;
		const isSlides = deck.kind === "slides";
		return (
			<div key={deck.deckId} className={styles.listRow}>
				<span className={styles.listRowWords}>
					<strong>{deck.title}</strong>
					<span className={styles.panelAbout}>
						{isSlides
							? `${count} slide${count === 1 ? "" : "s"}`
							: `${count} step${count === 1 ? "" : "s"}. ${stats?.started ?? 0} started, ${stats?.finished ?? 0} finished.`}
					</span>
				</span>
				<div className={styles.listRowActions}>
					<button
						type="button"
						className={styles.rowAction}
						onClick={() =>
							isSlides ? setSlideDeck(deck) : setDraft(deck)
						}
					>
						Edit
					</button>
					{!isSlides && (
						<a
							className={styles.rowAction}
							href={`/r/${slug}?tour=${deck.deckId}`}
							target="_blank"
							rel="noreferrer"
						>
							Try it
						</a>
					)}
					{!isSlides && (
						<button
							type="button"
							className={styles.rowAction}
							disabled={busy}
							title="Offers it to everyone again and tells people who read this report lately"
							onClick={async () => {
								const detail = await post({
									action: "offerAgain",
									deckId: deck.deckId,
								});
								if (detail) {
									setTold(
										`Told ${detail.told} recent reader${detail.told === 1 ? "" : "s"}.`,
									);
								}
							}}
						>
							Show as what&apos;s new
						</button>
					)}
					<button
						type="button"
						className={styles.rowAction}
						disabled={busy}
						onClick={() =>
							void post({
								action: "remove",
								deckId: deck.deckId,
							})
						}
					>
						Remove
					</button>
				</div>
			</div>
		);
	};

	return (
		<div className={styles.panel}>
			<div className={styles.panelHead}>
				<span className={styles.panelKind}>Slides</span>
				<span className={styles.panelSubject}>
					Slides, walkthroughs and marks
				</span>
				<button
					type="button"
					className={styles.panelBack}
					onClick={onClose}
					aria-label="Close"
				>
					×
				</button>
			</div>
			<div className={styles.panelBody}>
				{!draft && (
					<div className={styles.deckSections}>
						<section className={styles.deckSection}>
							<div className={styles.deckSectionHead}>
								<h3 className={styles.deckSectionTitle}>
									Slides
								</h3>
								<button
									type="button"
									className={styles.panelAdd}
									onClick={() =>
										setSlideDeck(blankDeck("slides"))
									}
								>
									New slides
								</button>
							</div>
							<p className={styles.panelAbout}>
								Designed one at a time, then exported as a
								PowerPoint file from the report&apos;s Export
								button.
							</p>
							{slideDecks.length === 0 ? (
								<p className={styles.panelEmpty}>
									No slides on this report yet.
								</p>
							) : (
								slideDecks.map(listRow)
							)}
						</section>

						<section className={styles.deckSection}>
							<div className={styles.deckSectionHead}>
								<h3 className={styles.deckSectionTitle}>
									Walkthroughs
								</h3>
								<button
									type="button"
									className={styles.panelAdd}
									onClick={() =>
										setDraft(blankDeck("walkthrough"))
									}
								>
									New walkthrough
								</button>
							</div>
							<p className={styles.panelAbout}>
								Guides someone through the real page, one step
								at a time.
							</p>
							{walkthroughs.length === 0 ? (
								<p className={styles.panelEmpty}>
									No walkthroughs on this report yet.
								</p>
							) : (
								walkthroughs.map(listRow)
							)}
							{told && (
								<p className={styles.panelAbout}>{told}</p>
							)}
						</section>

						<section className={styles.deckSection}>
							<div className={styles.deckSectionHead}>
								<h3 className={styles.deckSectionTitle}>
									Marks on this page
								</h3>
							</div>
							<p className={styles.panelAbout}>
								A callout, arrow or highlight every reader sees
								on a visual.
							</p>
							{marks.map((mark) => (
								<div key={mark.id} className={styles.listRow}>
									<div className={styles.listRowLine}>
										<span className={styles.listRowWords}>
											<strong>
												{named(mark.visualId)}
											</strong>
											<span className={styles.panelAbout}>
												{markNames[mark.kind]}
												{mark.text
													? `, "${mark.text}"`
													: ""}
											</span>
										</span>
										<button
											type="button"
											className={styles.rowAction}
											disabled={readOnly}
											onClick={() =>
												onMarks(
													marks.filter(
														(m) => m.id !== mark.id,
													),
												)
											}
										>
											Remove
										</button>
									</div>
								</div>
							))}
							<div className={styles.panelForm}>
								<Select
									value={markKind}
									onChange={(next) =>
										setMarkKind(next as MarkKind)
									}
									options={Object.entries(markNames).map(
										([value, label]) => ({ value, label }),
									)}
								/>
								<input
									type="text"
									className={styles.input}
									value={markText}
									placeholder="What it should say"
									aria-label="What the mark should say"
									onChange={(e) =>
										setMarkText(e.target.value)
									}
								/>
								<button
									type="button"
									className={styles.panelAdd}
									disabled={
										readOnly || selection.length !== 1
									}
									onClick={() => {
										onMarks([
											...marks,
											{
												id: crypto.randomUUID(),
												visualId: selection[0],
												kind: markKind,
												text: markText.trim(),
											},
										]);
										setMarkText("");
									}}
								>
									{selection.length === 1
										? `Add to ${named(selection[0])}`
										: "Select one visual to add a mark"}
								</button>
							</div>
						</section>
					</div>
				)}

				{draft && (
					<>
						<div className={styles.field}>
							<label className={styles.fieldLabel}>Name</label>
							<input
								type="text"
								className={styles.input}
								value={draft.title}
								onChange={(e) =>
									setDraft({
										...draft,
										title: e.target.value,
									})
								}
							/>
						</div>

						{draft.kind === "walkthrough" && (
							<div className={styles.field}>
								<Toggle
									label="Offer this once to everyone arriving"
									checked={draft.promptOnce}
									onChange={(promptOnce) =>
										setDraft({ ...draft, promptOnce })
									}
								/>
							</div>
						)}

						{draft.steps.map((step, index) => (
							<div key={step.id} className={styles.listRow}>
								<strong>
									{index + 1}. {pageName(step.pageId)}
								</strong>
								<input
									type="text"
									className={styles.input}
									value={step.title}
									placeholder="Title"
									onChange={(e) =>
										setStep(index, {
											title: e.target.value,
										})
									}
								/>
								<textarea
									className={styles.input}
									rows={3}
									value={step.text}
									placeholder="What to point out"
									onChange={(e) =>
										setStep(index, { text: e.target.value })
									}
								/>
								{draft.kind === "walkthrough" && (
									<>
										<p className={styles.hint}>
											{step.visualId
												? `Spotlights ${step.pageId === pageId ? named(step.visualId) : "a visual on that page"}.`
												: "Spotlights nothing."}
										</p>
										<button
											type="button"
											className={styles.rowAction}
											disabled={selection.length !== 1}
											onClick={() =>
												setStep(index, {
													visualId: selection[0],
													pageId,
												})
											}
										>
											Use the selected visual
										</button>
										<Select
											value={step.mark ?? ""}
											onChange={(mark) =>
												setStep(index, {
													mark: (mark ||
														null) as MarkKind | null,
												})
											}
											options={markOptions}
										/>
										{step.pageId === pageId &&
											widgets.map((widget) => (
												<input
													key={widget.visualId}
													type="text"
													className={styles.input}
													placeholder={`Set ${widget.field} to, with commas between`}
													value={(
														step.filters[
															widget.field
														] ?? []
													).join(", ")}
													onChange={(e) => {
														const values =
															e.target.value
																.split(",")
																.map((v) =>
																	v.trim(),
																)
																.filter(
																	Boolean,
																);
														const filters = {
															...step.filters,
														};
														if (values.length > 0) {
															filters[
																widget.field
															] = values;
														} else {
															delete filters[
																widget.field
															];
														}
														setStep(index, {
															filters,
														});
													}}
												/>
											))}
									</>
								)}
								<div className={styles.listRowActions}>
									<button
										type="button"
										className={styles.rowAction}
										disabled={index === 0}
										onClick={() => moveStep(index, -1)}
									>
										Up
									</button>
									<button
										type="button"
										className={styles.rowAction}
										disabled={
											index === draft.steps.length - 1
										}
										onClick={() => moveStep(index, 1)}
									>
										Down
									</button>
									<button
										type="button"
										className={styles.rowAction}
										onClick={() =>
											setDraft({
												...draft,
												steps: draft.steps.filter(
													(_, i) => i !== index,
												),
											})
										}
									>
										Remove
									</button>
								</div>
							</div>
						))}

						<div className={styles.panelForm}>
							<button
								type="button"
								className={styles.panelAdd}
								onClick={addStep}
							>
								Add a step on {pageTitle}
							</button>
							<p className={styles.panelAbout}>
								Open any page and select a visual first, and the
								step starts from there.
							</p>
							{canAskAssistant &&
								draft.kind === "walkthrough" && (
									<button
										type="button"
										className={styles.panelAdd}
										disabled={busy}
										title="Replaces the steps with a draft of a tour of this report"
										onClick={() =>
											void draftWithAssistant()
										}
									>
										{busy
											? "Drafting"
											: "Ask the assistant to draft"}
									</button>
								)}
						</div>

						{failure && (
							<div className={styles.panelError}>{failure}</div>
						)}

						<div className={styles.panelActions}>
							<button
								type="button"
								className={styles.toolButton}
								onClick={() => setDraft(null)}
							>
								Back
							</button>
							<button
								type="button"
								className={styles.saveButton}
								disabled={
									busy ||
									!draft.title.trim() ||
									draft.steps.length === 0
								}
								onClick={async () => {
									const saved = await post({
										action: "save",
										deckId: draft.deckId,
										deck: draft,
									});
									if (saved) setDraft(null);
								}}
							>
								Save
							</button>
						</div>
					</>
				)}
				{!draft && !slideDeck && failure && (
					<div className={styles.panelError}>{failure}</div>
				)}
			</div>
			{slideDeck && (
				<SlideEditor
					slug={slug}
					start={slideDeck}
					currentPageId={pageId}
					sources={sources}
					pageSourceKey={pageSourceKey}
					busy={busy}
					failure={failure}
					onClose={() => {
						setSlideDeck(null);
						setFailure(null);
					}}
					onSave={async (deck) => {
						const saved = await post({
							action: "save",
							deckId: deck.deckId,
							deck,
						});
						if (saved) setSlideDeck(null);
					}}
				/>
			)}
		</div>
	);
}
