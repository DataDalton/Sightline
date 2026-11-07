"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { isPageControl } from "../../lib/visuals/catalog";
import {
	slideLayouts,
	slideSlots,
	type Deck,
	type DeckStep,
} from "../../lib/visuals/deck";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { Slide } from "../r/DeckPlayer";
import { PageFilterProvider } from "../visuals/PageFilters";
import type { SourceMeta } from "../visuals/types";
import styles from "./SlideEditor.module.css";

// Designing slides. Slides down the left, the slide as it will show in the middle with live
// figures, and what is on it on the right. A slide shows published visuals, so a change to
// one of them on its report's page reaches the slide too.

export type DeckDraft = Omit<Deck, "deckId" | "epoch"> & { deckId?: string };

interface ReportVisual {
	visualId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: Record<string, unknown>;
}

interface ReportAnswer {
	reportId: string;
	pages: { pageId: string; title: string; visuals: ReportVisual[] }[];
}

// A tile row often has no title of its own, so it is known by what it shows.
function visualName(visual: ReportVisual): string {
	if (visual.title) return visual.title;
	const shown = visual.config.measures;
	return Array.isArray(shown) && shown.length > 0
		? shown.join(", ")
		: "Untitled";
}

const blankSlide = (pageId: string): DeckStep => ({
	id: crypto.randomUUID(),
	title: "",
	text: "",
	pageId,
	visualId: null,
	filters: {},
	mark: null,
	visualIds: [],
	layout: "one",
});

function LayoutPicture({ layout }: { layout: string }) {
	const found = slideLayouts.find((held) => held.id === layout);
	return (
		<span className={styles.picture} aria-hidden="true">
			{found?.textBeside && <span className={styles.pictureText} />}
			{found?.rects.length === 0 && (
				<span className={styles.pictureTitle} />
			)}
			<span className={styles.pictureSlots}>
				{found?.rects.map((rect, index) => (
					<span
						key={index}
						className={styles.pictureSlot}
						style={{
							left: `${(rect.x / 12) * 100}%`,
							top: `${(rect.y / 10) * 100}%`,
							width: `${(rect.w / 12) * 100}%`,
							height: `${(rect.h / 10) * 100}%`,
						}}
					/>
				))}
			</span>
		</span>
	);
}

export function SlideEditor({
	slug,
	start,
	currentPageId,
	sources,
	pageSourceKey,
	busy,
	failure,
	onSave,
	onClose,
}: {
	slug: string;
	start: DeckDraft;
	currentPageId: string;
	sources: Record<string, SourceMeta>;
	pageSourceKey: string | null;
	busy: boolean;
	failure: string | null;
	onSave: (deck: DeckDraft) => void;
	onClose: () => void;
}) {
	const [deck, setDeck] = useState<DeckDraft>(() =>
		start.steps.length > 0
			? start
			: { ...start, steps: [blankSlide(currentPageId)] },
	);
	const [index, setIndex] = useState(0);
	const { data } = useSWR<ReportAnswer | { report: ReportAnswer }>(
		`/api/report/${encodeURIComponent(slug)}`,
	);
	const report =
		data && "report" in data ? data.report : (data as ReportAnswer);

	const visuals = (report?.pages ?? []).flatMap((page) =>
		page.visuals
			.filter(
				(visual) =>
					!isPageControl(visual.visualType) &&
					visual.visualType !== "group",
			)
			.map((visual) => ({ ...visual, pageTitle: page.title })),
	);
	const byId = new Map(visuals.map((visual) => [visual.visualId, visual]));
	const slide = deck.steps[index] ?? deck.steps[0];
	const slots = slide ? slideSlots(slide.layout) : 0;
	const source = pageSourceKey ? sources[pageSourceKey] : undefined;

	const setSlide = (patch: Partial<DeckStep>) =>
		setDeck((held) => ({
			...held,
			steps: held.steps.map((step, i) =>
				i === index ? { ...step, ...patch } : step,
			),
		}));
	const move = (by: number) => {
		setDeck((held) => {
			const steps = [...held.steps];
			const [step] = steps.splice(index, 1);
			steps.splice(index + by, 0, step);
			return { ...held, steps };
		});
		setIndex(index + by);
	};

	// Drawn at the top of the document, so it covers the app's header as well.
	return createPortal(
		<div
			className={styles.overlay}
			role="dialog"
			aria-modal="true"
			aria-label="Slide editor"
		>
			<header className={styles.head}>
				<input
					className={styles.deckName}
					value={deck.title}
					placeholder="Name these slides"
					aria-label="Name"
					onChange={(e) =>
						setDeck({ ...deck, title: e.target.value })
					}
				/>
				<label className={styles.record}>
					<span>A viewer picks a record from</span>
					<Select
						value={deck.recordField ?? ""}
						onChange={(recordField) =>
							setDeck({
								...deck,
								recordField: recordField || null,
								recordSource: recordField
									? pageSourceKey
									: null,
							})
						}
						options={[
							{ value: "", label: "Nothing to pick" },
							...(source?.dimensions ?? []).map((field) => ({
								value: field.name,
								label: field.name,
							})),
						]}
					/>
				</label>
				{deck.recordField && (
					<Toggle
						label="Wait until one is picked"
						checked={deck.requireRecord}
						onChange={(requireRecord) =>
							setDeck({ ...deck, requireRecord })
						}
					/>
				)}
				<span className={styles.spacer} />
				{failure && <span className={styles.failure}>{failure}</span>}
				<button
					type="button"
					className={styles.button}
					onClick={onClose}
				>
					Cancel
				</button>
				<button
					type="button"
					className={styles.primary}
					disabled={busy || !deck.title.trim()}
					title={deck.title.trim() ? undefined : "Name them first"}
					onClick={() => onSave(deck)}
				>
					{busy ? "Saving" : "Save slides"}
				</button>
			</header>

			<div className={styles.body}>
				<nav className={styles.strip} aria-label="Slides">
					{deck.steps.map((step, i) => (
						<button
							key={step.id}
							type="button"
							className={`${styles.thumb} ${i === index ? styles.thumbOn : ""}`}
							aria-current={i === index}
							onClick={() => setIndex(i)}
						>
							<span className={styles.thumbNumber}>{i + 1}</span>
							<LayoutPicture layout={step.layout ?? "one"} />
							<span className={styles.thumbTitle}>
								{step.title || "Untitled"}
							</span>
						</button>
					))}
					<button
						type="button"
						className={styles.button}
						onClick={() => {
							setDeck((held) => ({
								...held,
								steps: [
									...held.steps,
									blankSlide(currentPageId),
								],
							}));
							setIndex(deck.steps.length);
						}}
					>
						Add a slide
					</button>
				</nav>

				<main className={styles.stage}>
					{slide && report && (
						<div className={styles.canvas}>
							<PageFilterProvider key={slide.id}>
								<Slide
									step={slide}
									byId={byId}
									sources={sources}
									reportId={report.reportId}
								/>
							</PageFilterProvider>
							{slots > 0 &&
								slide.visualIds.filter(Boolean).length ===
									0 && (
									<p className={styles.canvasHint}>
										Choose what this slide shows, on the
										right.
									</p>
								)}
						</div>
					)}
				</main>

				{slide && (
					<aside className={styles.side}>
						<label className={styles.field}>
							<span className={styles.label}>Title</span>
							<input
								className={styles.input}
								value={slide.title}
								onChange={(e) =>
									setSlide({ title: e.target.value })
								}
							/>
						</label>
						<label className={styles.field}>
							<span className={styles.label}>
								What to say on it
							</span>
							<textarea
								className={styles.input}
								rows={3}
								value={slide.text}
								onChange={(e) =>
									setSlide({ text: e.target.value })
								}
							/>
						</label>

						<div className={styles.field}>
							<span className={styles.label}>Layout</span>
							<div className={styles.layouts}>
								{slideLayouts.map((layout) => (
									<button
										key={layout.id}
										type="button"
										title={layout.label}
										aria-label={layout.label}
										aria-pressed={
											slide.layout === layout.id
										}
										className={`${styles.layout} ${slide.layout === layout.id ? styles.layoutOn : ""}`}
										onClick={() =>
											setSlide({
												layout: layout.id,
												visualIds:
													slide.visualIds.slice(
														0,
														layout.rects.length,
													),
											})
										}
									>
										<LayoutPicture layout={layout.id} />
									</button>
								))}
							</div>
						</div>

						{Array.from({ length: slots }, (_, slot) => (
							<label key={slot} className={styles.field}>
								<span className={styles.label}>
									{slots === 1
										? "What it shows"
										: `Place ${slot + 1}`}
								</span>
								<Select
									value={slide.visualIds[slot] ?? ""}
									placeholder="Choose a visual"
									searchable
									onChange={(visualId) => {
										const visualIds = Array.from(
											{ length: slots },
											(__, i) => slide.visualIds[i] ?? "",
										);
										visualIds[slot] = visualId;
										setSlide({ visualIds });
									}}
									options={[
										{ value: "", label: "Nothing here" },
										...visuals.map((visual) => ({
											value: visual.visualId,
											label: `${visualName(visual)}, on ${visual.pageTitle}`,
										})),
									]}
								/>
							</label>
						))}

						<div className={styles.slideActions}>
							<button
								type="button"
								className={styles.button}
								disabled={index === 0}
								onClick={() => move(-1)}
							>
								Move up
							</button>
							<button
								type="button"
								className={styles.button}
								disabled={index === deck.steps.length - 1}
								onClick={() => move(1)}
							>
								Move down
							</button>
							<button
								type="button"
								className={styles.button}
								onClick={() => {
									const copy = {
										...slide,
										id: crypto.randomUUID(),
									};
									setDeck((held) => {
										const steps = [...held.steps];
										steps.splice(index + 1, 0, copy);
										return { ...held, steps };
									});
									setIndex(index + 1);
								}}
							>
								Duplicate
							</button>
							<button
								type="button"
								className={styles.button}
								disabled={deck.steps.length === 1}
								onClick={() => {
									setDeck((held) => ({
										...held,
										steps: held.steps.filter(
											(_, i) => i !== index,
										),
									}));
									setIndex(Math.max(0, index - 1));
								}}
							>
								Remove
							</button>
						</div>
					</aside>
				)}
			</div>
		</div>,
		document.body,
	);
}
