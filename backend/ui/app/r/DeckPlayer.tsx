"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { decksKey } from "../../lib/query/requestKey";
import {
	popoverPosition,
	shouldOffer,
	stepIndex,
	stepParams,
	type Deck,
	type DeckStep,
	placeSlide,
	slideLayouts,
	withPageSteps,
} from "../../lib/visuals/deck";
import { FilterGateProvider, PageFilterProvider } from "../visuals/PageFilters";
import { VisualRenderer } from "../visuals/VisualRenderer";
import { ViewScaleProvider } from "./ViewScale";
import { ReportGrid } from "./ReportGrid";
import type { SourceMeta } from "../visuals/types";
import styles from "./Deck.module.css";

// What a reader sees while taking a tour or going through slides
// someone else. Each one moves through steps and puts the real report on screen, so
// every number is live and under the reader's own access.

async function postTo(address: string, body: unknown): Promise<Response> {
	return fetch(address, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

export interface DecksAnswer {
	decks: Deck[];
	seen: Record<string, number>;
	stats: { deckId: string; started: number; finished: number }[];
}

export function useDecks(slug: string) {
	return useSWR<DecksAnswer>(decksKey(slug));
}

function noteProgress(slug: string, deckId: string, stage: string): void {
	void postTo(`/api/report/${encodeURIComponent(slug)}/decks`, {
		action: "progress",
		deckId,
		stage,
	}).catch(() => {});
}

function useStepKeys(
	onNext: () => void,
	onBack: () => void,
	onExit: () => void,
) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as Partial<HTMLElement> | null;
			if (target?.closest?.("input, textarea, select")) return;
			if (event.key === "ArrowRight" || event.key === "PageDown") {
				event.preventDefault();
				onNext();
			} else if (event.key === "ArrowLeft" || event.key === "PageUp") {
				event.preventDefault();
				onBack();
			} else if (event.key === "Escape") {
				onExit();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onNext, onBack, onExit]);
}

// --- Walkthroughs ----------------------------------------------------------------

function sameRect(a: DOMRect | null, b: DOMRect): boolean {
	return (
		a !== null &&
		a.top === b.top &&
		a.left === b.left &&
		a.width === b.width &&
		a.height === b.height
	);
}

// Frames a newly found visual must hold still before the spotlight moves to it.
const settleFrames = 4;
// How long to wait for a visual to hold still before moving to it regardless.
const settleLimitMs = 1500;
// How long to keep looking for a visual that has not appeared.
const findLimitMs = 4000;

// Where the step's target is on screen, the visual it spotlights or, on a step that
// moves to another page, that page's tab.
//
// Keeps the previous step's place until the new visual has been found and has
// stopped moving. A step on another page first switches the page, and while it
// does the visual is missing, then laid out from the grid's corner into its
// cell. Following it through that made the spotlight vanish and then grow out
// of the top left. Holding the old place instead lets the spotlight glide from
// one visual to the next, the same as a step on the same page.
function useTargetRect(selector: string | null, stepKey: string) {
	const [rect, setRect] = useState<DOMRect | null>(null);
	useEffect(() => {
		if (!selector) {
			setRect(null);
			return;
		}
		let frame = 0;
		let settled = false;
		let steady = 0;
		let lastSeen: DOMRect | null = null;
		const startedAt = Date.now();
		const look = () => {
			const element = document.querySelector<HTMLElement>(selector);
			if (element) {
				const next = element.getBoundingClientRect();
				if (!settled) {
					steady =
						next.width > 0 && sameRect(lastSeen, next)
							? steady + 1
							: 0;
					lastSeen = next;
					if (
						steady >= settleFrames ||
						Date.now() - startedAt > settleLimitMs
					) {
						settled = true;
						element.scrollIntoView({ block: "center" });
					}
				} else {
					setRect((held) => (sameRect(held, next) ? held : next));
				}
			}
			// Keeps watching once found, since a chart may still be growing into
			// its place and the page may scroll.
			if (element || Date.now() - startedAt < findLimitMs) {
				frame = requestAnimationFrame(look);
			}
		};
		frame = requestAnimationFrame(look);
		return () => cancelAnimationFrame(frame);
	}, [selector, stepKey]);
	return rect;
}

// The gap under a visual marked with an arrow. It holds the arrow's height and room
// either side of it, so the explanation sits below the arrow rather than over it.
const arrowClearance = 40;

export function TourOverlay({
	slug,
	deck,
	pages,
	onStep,
	onExit,
}: {
	slug: string;
	deck: Deck;
	// The report's pages, for naming the page a step moves to.
	pages: { pageId: string; title: string }[];
	// Puts the page in the state a step asks for.
	onStep: (pageId: string | null, search: string) => void;
	onExit: () => void;
}) {
	const [index, setIndex] = useState(0);
	const steps = useMemo(
		() => withPageSteps(deck.steps, pages),
		[deck.steps, pages],
	);
	const step = steps[index] as DeckStep | undefined;
	const target = step?.pageStep
		? `[data-page-tab="${CSS.escape(step.pageId ?? "")}"]`
		: step?.visualId
			? `[data-visual-id="${CSS.escape(step.visualId)}"]`
			: null;
	const rect = useTargetRect(target, step?.id ?? "");
	const box = useRef<HTMLDivElement>(null);
	const [boxSize, setBoxSize] = useState({ width: 360, height: 180 });

	useEffect(() => {
		noteProgress(slug, deck.deckId, "started");
	}, [slug, deck.deckId]);

	useEffect(() => {
		if (step) onStep(step.pageId, stepParams(step.filters));
		// Only when the step changes. Going through this again on every render
		// would keep undoing whatever the page has just settled on.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [step?.id]);

	useEffect(() => {
		const element = box.current;
		if (!element) return;
		setBoxSize({
			width: element.offsetWidth,
			height: element.offsetHeight,
		});
	}, [index, rect]);

	const last = index >= steps.length - 1;
	const finish = useCallback(() => {
		noteProgress(slug, deck.deckId, "finished");
		onExit();
	}, [slug, deck.deckId, onExit]);
	const next = useCallback(() => {
		if (last) finish();
		else setIndex((held) => held + 1);
	}, [last, finish]);
	const back = useCallback(
		() => setIndex((held) => stepIndex(held - 1, steps.length)),
		[steps.length],
	);
	useStepKeys(next, back, onExit);

	if (!step) return null;

	const position = popoverPosition(
		rect
			? {
					top: rect.top,
					left: rect.left,
					width: rect.width,
					height: rect.height,
				}
			: null,
		boxSize,
		{ width: window.innerWidth, height: window.innerHeight },
		// Clear of the arrow, which sits in the gap under the visual.
		step.mark === "arrow" ? arrowClearance : undefined,
	);

	return (
		<div className={styles.tourLayer}>
			{rect ? (
				<div
					className={`${styles.spotlight} ${
						step.mark === "highlight" ? styles.spotlightMarked : ""
					}`}
					style={{
						top: rect.top - 6,
						left: rect.left - 6,
						width: rect.width + 12,
						height: rect.height + 12,
					}}
				/>
			) : (
				<div className={styles.tourDim} />
			)}
			{rect && step.mark === "arrow" && (
				<svg
					className={styles.tourArrow}
					style={{
						top: rect.top + rect.height + 2,
						left: rect.left + 24,
					}}
					width="28"
					height="28"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.4"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M12 21V4M5 11l7-7 7 7" />
				</svg>
			)}
			<div
				ref={box}
				className={styles.tourBox}
				role="dialog"
				aria-label={deck.title}
				style={{ top: position.top, left: position.left }}
			>
				{step.title && <strong>{step.title}</strong>}
				{step.text && <p className={styles.tourText}>{step.text}</p>}
				<div className={styles.tourActions}>
					<span className={styles.barCount}>
						{index + 1} of {steps.length}
					</span>
					<button
						type="button"
						className={styles.barButton}
						onClick={onExit}
					>
						Close
					</button>
					<button
						type="button"
						className={styles.barButton}
						disabled={index === 0}
						onClick={back}
					>
						Back
					</button>
					<button
						type="button"
						className={styles.barPrimary}
						onClick={next}
					>
						{last ? "Finish" : "Next"}
					</button>
				</div>
			</div>
		</div>
	);
}

// Offered once to somebody arriving at the report, when its author asks for that.
export function TourOffer({
	slug,
	decks,
	seen,
	onTake,
}: {
	slug: string;
	decks: Deck[];
	seen: Record<string, number>;
	onTake: (deck: Deck) => void;
}) {
	const [dismissed, setDismissed] = useState(false);
	const offered = decks.find(
		(deck) =>
			deck.kind === "walkthrough" && shouldOffer(deck, seen[deck.deckId]),
	);
	if (!offered || dismissed) return null;
	return (
		<div className={styles.offer} role="status">
			<span>
				<strong>{offered.title}</strong> is a short tour of this report.
			</span>
			<button
				type="button"
				className={styles.barButton}
				onClick={() => {
					setDismissed(true);
					noteProgress(slug, offered.deckId, "dismissed");
				}}
			>
				Not now
			</button>
			<button
				type="button"
				className={styles.barPrimary}
				onClick={() => {
					setDismissed(true);
					onTake(offered);
				}}
			>
				Take the tour
			</button>
		</div>
	);
}

// --- Slides ----------------------------------------------------------------------

interface SlideVisual {
	visualId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: Record<string, unknown>;
}

export function Slide({
	step,
	byId,
	sources,
	reportId,
}: {
	step: DeckStep;
	byId: Map<string, SlideVisual>;
	sources: Record<string, SourceMeta>;
	reportId: string;
}) {
	const placed = placeSlide(step).flatMap(({ visualId, rect }) => {
		const visual = byId.get(visualId);
		return visual ? [{ ...visual, layout: rect }] : [];
	});
	const layout = slideLayouts.find((held) => held.id === step.layout);
	const titleOnly = layout?.rects.length === 0;
	return (
		<section
			className={`${styles.slide} ${titleOnly ? styles.slideTitleOnly : ""} ${layout?.textBeside ? styles.slideBeside : ""}`}
		>
			<div className={styles.slideWords}>
				{step.title && (
					<h2 className={styles.slideTitle}>{step.title}</h2>
				)}
				{step.text && <p className={styles.slideText}>{step.text}</p>}
			</div>
			{!titleOnly && (
				<div className={styles.slideBody}>
					<ViewScaleProvider sizes={{}} onSizesChange={noSizes}>
						<ReportGrid
							visuals={placed as never}
							sources={sources}
							reportId={reportId}
							still
						/>
					</ViewScaleProvider>
				</div>
			)}
		</section>
	);
}

const noSizes = () => {};

export function SlideShow({
	slug,
	deck,
	visuals,
	sources,
	reportId,
	onPrint,
	onExit,
}: {
	slug: string;
	deck: Deck;
	visuals: SlideVisual[];
	sources: Record<string, SourceMeta>;
	reportId: string;
	onPrint: () => void;
	onExit: () => void;
}) {
	const [index, setIndex] = useState(0);
	// Paper takes the whole deck rather than the slide on screen.
	const [wholeDeck, setWholeDeck] = useState(false);
	useEffect(() => {
		const back = () => setWholeDeck(false);
		window.addEventListener("afterprint", back);
		return () => window.removeEventListener("afterprint", back);
	}, []);
	const byId = new Map(visuals.map((v) => [v.visualId, v]));
	const last = index >= deck.steps.length - 1;

	const next = useCallback(() => {
		if (last) noteProgress(slug, deck.deckId, "finished");
		setIndex((held) => stepIndex(held + 1, deck.steps.length));
	}, [last, slug, deck.deckId, deck.steps.length]);
	const back = useCallback(
		() => setIndex((held) => stepIndex(held - 1, deck.steps.length)),
		[deck.steps.length],
	);
	useStepKeys(next, back, onExit);

	useEffect(() => {
		noteProgress(slug, deck.deckId, "started");
		document.body.dataset.presenting = "1";
		return () => {
			delete document.body.dataset.presenting;
		};
	}, [slug, deck.deckId]);

	const recordFilter =
		deck.recordField && deck.recordSource
			? ({
					visualId: `deck-record-${deck.deckId}`,
					visualType: "dropdownFilter",
					title: deck.recordField,
					sourceKey: deck.recordSource,
					config: { dimensions: [deck.recordField] },
				} as never)
			: null;

	const step = deck.steps[index];

	return (
		<div className={styles.slideShow}>
			<PageFilterProvider key={deck.deckId}>
				<FilterGateProvider
					value={{
						pageRequireFilter:
							deck.requireRecord && deck.recordField
								? [deck.recordField]
								: undefined,
					}}
				>
					<div className={styles.slideHead}>
						<strong className={styles.slideDeckTitle}>
							{deck.title}
						</strong>
						{recordFilter && (
							<VisualRenderer
								visual={recordFilter}
								sources={sources}
								reportId={reportId}
							/>
						)}
						<span className={styles.slideSpacer} />
						<button
							type="button"
							className={styles.barButton}
							onClick={() => {
								setWholeDeck(true);
								onPrint();
							}}
						>
							PDF
						</button>
						<button
							type="button"
							className={styles.barButton}
							disabled={index === 0}
							onClick={back}
						>
							Back
						</button>
						<span className={styles.barCount}>
							{index + 1} of {deck.steps.length}
						</span>
						<button
							type="button"
							className={styles.barButton}
							disabled={last}
							onClick={next}
						>
							Next
						</button>
						<button
							type="button"
							className={styles.barButton}
							onClick={onExit}
						>
							Exit
						</button>
					</div>

					<div className={styles.slideScreen}>
						{(wholeDeck ? deck.steps : step ? [step] : []).map(
							(shown) => (
								<Slide
									key={shown.id}
									step={shown}
									byId={byId}
									sources={sources}
									reportId={reportId}
								/>
							),
						)}
					</div>
				</FilterGateProvider>
			</PageFilterProvider>
		</div>
	);
}
