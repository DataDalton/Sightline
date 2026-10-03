"use client";

import Link from "../components/AppLink";
import type { Card } from "../../lib/briefing/card";
import type { WatchItem } from "../../lib/briefing/watch";
import {
	driverText,
	movementText,
	periodLabel,
	settlingText,
	toneOf,
	usualLabel,
	waitingText,
} from "../../lib/briefing/words";
import { formatCompact } from "../../lib/format";
import { AddToBoard } from "../boards/AddToBoard";
import { Trend } from "./Trend";
import styles from "./Briefing.module.css";

// One figure in the briefing, at one of three sizes. A lead card carries the
// sentence about what moved it and the way into the breakdown, a moving card
// the figure and its trend, a steady tile only enough to see it is fine.

export type CardSize = "hero" | "lead" | "moving" | "steady";

// Pin and hide, as two small buttons. A pinned figure stays in the briefing
// whatever else is chosen, a hidden one leaves it until it is shown again.
export interface Moves {
	earlier: (() => void) | null;
	later: (() => void) | null;
}

function Arrow({ up }: { up: boolean }) {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={up ? "M12 19V5M6 11l6-6 6 6" : "M12 5v14M6 13l6 6 6-6"} />
		</svg>
	);
}

// A clock, for a period still waiting for its load.
function Clock() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</svg>
	);
}

// A circle with a mark in it, for why the figure reads the way it does.
function Info() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v5M12 8h.01" />
		</svg>
	);
}

// An hourglass, for a figure that may still fill in.
function Filling() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M6 3h12M6 21h12M7 3v4a5 5 0 0 0 10 0V3M7 21v-4a5 5 0 0 1 10 0v4" />
		</svg>
	);
}

function Tools({
	item,
	measure,
	pinned,
	onPin,
	onHide,
	onMove,
}: {
	item: WatchItem;
	measure: string;
	pinned: boolean;
	onPin: () => void;
	onHide: () => void;
	onMove?: Moves;
}) {
	return (
		<span className={styles.tools}>
			{onMove && (
				<>
					<button
						type="button"
						className={styles.tool}
						aria-label={`Move ${measure} earlier`}
						title="Move earlier"
						disabled={!onMove.earlier}
						onClick={onMove.earlier ?? undefined}
					>
						<Arrow up />
					</button>
					<button
						type="button"
						className={styles.tool}
						aria-label={`Move ${measure} later`}
						title="Move later"
						disabled={!onMove.later}
						onClick={onMove.later ?? undefined}
					>
						<Arrow up={false} />
					</button>
				</>
			)}
			<button
				type="button"
				className={styles.tool}
				data-on={pinned || undefined}
				aria-pressed={pinned}
				aria-label={pinned ? `Unpin ${measure}` : `Pin ${measure}`}
				title={pinned ? "Unpin" : "Pin to your briefing"}
				onClick={onPin}
			>
				<svg
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill={pinned ? "currentColor" : "none"}
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" />
				</svg>
			</button>
			<AddToBoard
				className={styles.tool}
				piece={() => ({
					visual: {
						visualType: "lineChart",
						title: measure,
						sourceKey: item.sourceKey,
						config: {
							dimensions: [item.timeField],
							measures: [measure],
						},
					},
					origin: {
						reportId: item.reportId,
						slug: item.slug,
						title: item.reportTitle,
					},
				})}
			/>
			<button
				type="button"
				className={styles.tool}
				aria-label={`Hide ${measure}`}
				title="Hide from your briefing"
				onClick={onHide}
			>
				<svg
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.4 3.5M6.3 6.3C4.2 7.7 2.7 9.8 2 12c1 2.5 5 7 10 7 1.7 0 3.3-.5 4.7-1.3" />
				</svg>
			</button>
		</span>
	);
}

export function BriefingCard({
	item,
	card,
	updating = false,
	size,
	onExplain,
	onAsk,
	onPin,
	onHide,
	onMove,
	transition,
}: {
	item: WatchItem;
	card: Card;
	// Shown from before while newer figures are worked out.
	updating?: boolean;
	size: CardSize;
	onExplain: () => void;
	// Asks the assistant about this figure, when the assistant is on.
	onAsk?: () => void;
	onPin: () => void;
	onHide: () => void;
	// Only on a pinned card, which the reader orders.
	onMove?: Moves;
	// The name the card moves under when the page rearranges. See moved in
	// Briefing.
	transition?: string;
}) {
	const named = transition
		? ({ viewTransitionName: transition } as React.CSSProperties)
		: undefined;
	const tools = (
		<Tools
			item={item}
			measure={item.measure}
			pinned={item.pinned}
			onPin={onPin}
			onHide={onHide}
			onMove={onMove}
		/>
	);
	const tone = toneOf(card, item.better);
	const href = `/r/${item.slug}/`;
	const updatingMark = updating ? (
		<span
			className={styles.updating}
			title="These are the last figures. Newer ones are being worked out."
		>
			Updating
		</span>
	) : null;

	// What the card is waiting for, and why it reads the way it does.
	const waiting = card.waiting
		? waitingText(card.waiting, card.spacing)
		: null;
	const why = settlingText(card);

	if (size === "steady") {
		return (
			<div className={styles.tile} style={named}>
				<Link href={href} className={styles.tileLink}>
					<span className={styles.tileName}>{item.measure}</span>
					<span className={styles.tileValue}>
						{formatCompact(card.value, item.hint)}
					</span>
					<Trend
						series={card.series}
						low={card.low}
						high={card.high}
						tone={tone}
						compact
					/>
					{waiting && (
						<span className={styles.tileNote}>{waiting}</span>
					)}
					<span className={styles.tileMeta}>
						{item.reportTitle}
						{updatingMark}
					</span>
				</Link>
				{tools}
			</div>
		);
	}

	const trend = (
		<Trend
			series={card.series}
			low={card.low}
			high={card.high}
			tone={tone}
		/>
	);

	return (
		<article
			className={`${styles.card} ${size !== "moving" ? styles.cardLead : ""} ${size === "hero" ? styles.cardHero : ""}`}
			data-tone={tone}
			data-unusual={card.unusual || undefined}
			data-early={card.early || undefined}
			style={named}
		>
			{size === "hero" && <div className={styles.heroTrend}>{trend}</div>}
			<div className={styles.cardTop}>
				<Link href={href} className={styles.cardReport}>
					{item.reportTitle}
				</Link>
				<span className={styles.cardMarks}>
					{card.unusual && (
						<span className={styles.flag}>Unusual</span>
					)}
					{card.early && (
						<span
							className={styles.flagEarly}
							title="Far below where it usually is by now, though its data may still be loading"
						>
							<Filling />
							Early signal
						</span>
					)}
					{tools}
				</span>
			</div>
			<h3 className={styles.cardName}>{item.measure}</h3>
			<div className={styles.figureRow}>
				<span className={styles.figure}>
					{formatCompact(card.value, item.hint)}
				</span>
				<span className={styles.move} data-tone={tone}>
					{movementText(card)}
				</span>
			</div>
			<div className={styles.period}>
				{periodLabel(card.period, card.spacing)}
				{card.usual !== null && (
					<span
						title={`Usual is the middle of ${usualLabel(card.spacing)}`}
					>
						{" "}
						· usual {formatCompact(card.usual, item.hint)}
					</span>
				)}
				{updatingMark}
			</div>
			{why && (
				<p className={styles.note}>
					<Info />
					<span>{why}</span>
				</p>
			)}
			{waiting && (
				<p className={styles.note}>
					<Clock />
					<span>{waiting}</span>
				</p>
			)}
			{size !== "hero" && trend}
			{card.driver && (
				<p className={styles.driver}>
					{driverText(card.driver, item.hint)}
				</p>
			)}
			<div className={styles.cardActions}>
				<span className={styles.cardButtons}>
					{card.previousWindow && (
						<button
							type="button"
							className={styles.why}
							onClick={onExplain}
						>
							Why did it move?
						</button>
					)}
					{onAsk && (
						<button
							type="button"
							className={styles.why}
							onClick={onAsk}
							title="Ask the assistant about this figure"
						>
							Ask about it
						</button>
					)}
				</span>
				<Link href={href} className={styles.open}>
					Open report
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M5 12h14M13 6l6 6-6 6" />
					</svg>
				</Link>
			</div>
		</article>
	);
}
