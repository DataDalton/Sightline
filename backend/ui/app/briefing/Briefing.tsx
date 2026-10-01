"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import useSWR from "swr";
import type { Card } from "../../lib/briefing/card";
import type { BriefingChoice } from "../../lib/briefing/choices";
import type { BriefingPlan } from "../../lib/briefing/plan";
import type { WatchItem } from "../../lib/briefing/watch";
import { headline } from "../../lib/briefing/words";
import { formatCompact } from "../../lib/format";
import { BriefingCard } from "./BriefingCard";
import { Trend } from "./Trend";
import { useReorder } from "./useReorder";
import styles from "./Briefing.module.css";

const ExplainDialog = dynamic(
	() => import("../explain/ExplainDialog").then((m) => m.ExplainDialog),
	{ ssr: false },
);

// The home page, saying what changed across everything the reader can see.
//
// The plan arrives first and says which figures to read, then each figure is
// read on its own so the page fills in as answers come back rather than
// waiting on the slowest. A figure that moves outside its usual range leads,
// one that moved noticeably follows, and the rest sit in a strip of tiles
// below.

// Figures read at once. The reader's warehouse session answers a few
// questions at a time, and the rest queue behind them either way.
const parallel = 4;

// A figure moving this far from usual counts as on the move.
const movingAt = 0.1;

// Answers kept for the rest of the day, so returning to the home page shows
// them at once. The key carries the date, so a new day reads afresh.
const answered = new Map<string, Card | null>();

// Applies a change that moves cards, letting the browser carry each card from
// where it was to where it lands, so a pin is seen going up rather than the
// page simply being different. Each card names itself for this. See
// transitionName.
function moved(update: () => void) {
	const start = (
		document as Document & {
			startViewTransition?: (callback: () => void) => unknown;
		}
	).startViewTransition;
	const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (!start || still) {
		update();
		return;
	}
	start.call(document, () => flushSync(update));
}

// A name for one card that holds across renders and is a valid identifier.
export function transitionName(id: string): string {
	let hash = 0;
	for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return `brief-${(hash >>> 0).toString(36)}`;
}

function zone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

function todayKey(): string {
	return new Date().toLocaleDateString("en-CA");
}

// Said by the reader's own clock.
function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) return "Good evening";
	if (hour < 12) return "Good morning";
	if (hour < 18) return "Good afternoon";
	return "Good evening";
}

function dateLine(): string {
	return new Date().toLocaleDateString(undefined, {
		weekday: "long",
		day: "numeric",
		month: "long",
	});
}

function ago(iso: string): string {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

async function readCard(item: WatchItem, tz: string): Promise<Card | null> {
	const response = await fetch("/api/briefing/item/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ item, tz }),
	});
	if (!response.ok) return null;
	const body = (await response.json().catch(() => null)) as {
		card?: Card | null;
	} | null;
	return body?.card ?? null;
}

export function Briefing({ firstName }: { firstName: string | null }) {
	const tz = useMemo(zone, []);
	const {
		data: plan,
		error,
		mutate: refreshPlan,
	} = useSWR<BriefingPlan>(`/api/briefing/?tz=${encodeURIComponent(tz)}`, {
		revalidateOnFocus: false,
	});
	const [cards, setCards] = useState<Record<string, Card | null>>({});
	const [explaining, setExplaining] = useState<{
		item: WatchItem;
		card: Card;
	} | null>(null);

	const [choiceError, setChoiceError] = useState<string | null>(null);
	const [showHidden, setShowHidden] = useState(false);

	// Pins and hides made on this page, applied here at once and saved behind.
	// The plan is not read again, because a new plan would choose its figures
	// afresh and move cards the reader did not touch.
	const [local, setLocal] = useState<BriefingChoice[] | null>(null);
	const choices = useMemo(() => local ?? plan?.choices ?? [], [local, plan]);
	const pinIds = useMemo(
		() =>
			choices
				.filter((c) => c.choice === "pin")
				.map((c) => `${c.reportId}:${c.measure}`),
		[choices],
	);
	const hiddenIds = useMemo(
		() =>
			new Set(
				choices
					.filter((c) => c.choice === "hide")
					.map((c) => `${c.reportId}:${c.measure}`),
			),
		[choices],
	);

	// The figures to read. Keyed by their ids, so a pin, which changes only
	// how a figure is shown, does not start the reading again.
	const planItems = plan?.items;
	const itemKey = (planItems ?? [])
		.filter((i) => !hiddenIds.has(i.id))
		.map((i) => i.id)
		.join("|");
	const items = useMemo(
		() =>
			(planItems ?? []).filter((i) => itemKey.split("|").includes(i.id)),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[itemKey],
	);

	const save = async (
		body: unknown,
		method: "PUT" | "POST",
		failed: string,
	) => {
		try {
			const response = await fetch("/api/briefing/choices/", {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error("refused");
		} catch {
			setChoiceError(failed);
			// What the store holds, since the change shown here did not land.
			moved(() => setLocal(null));
			await refreshPlan();
		}
	};

	const choose = (
		target: { reportId: string; measure: string },
		choice: "pin" | "hide" | null,
	) => {
		setChoiceError(null);
		const rest = choices.filter(
			(c) =>
				!(
					c.reportId === target.reportId &&
					c.measure === target.measure
				),
		);
		const next =
			choice === null
				? rest
				: choice === "pin"
					? [
							...rest.filter((c) => c.choice === "pin"),
							{ ...target, choice },
							...rest.filter((c) => c.choice === "hide"),
						]
					: [...rest, { ...target, choice }];
		moved(() =>
			setLocal(
				next.map((c) => ({
					reportId: c.reportId,
					measure: c.measure,
					choice: c.choice,
				})),
			),
		);
		void save(
			{ reportId: target.reportId, measure: target.measure, choice },
			"PUT",
			"That could not be saved. Try again.",
		);
	};

	useEffect(() => {
		if (items.length === 0) return;
		let live = true;
		const day = todayKey();
		const keyOf = (item: WatchItem) => `${day}|${tz}|${item.id}`;
		const held: Record<string, Card | null> = {};
		for (const item of items) {
			if (answered.has(keyOf(item)))
				held[item.id] = answered.get(keyOf(item)) ?? null;
		}
		setCards(held);
		const queue = items.filter((item) => !answered.has(keyOf(item)));
		const work = async () => {
			while (live && queue.length > 0) {
				const item = queue.shift() as WatchItem;
				let card: Card | null = null;
				try {
					card = await readCard(item, tz);
				} catch {
					card = null;
				}
				answered.set(keyOf(item), card);
				if (live) setCards((prev) => ({ ...prev, [item.id]: card }));
			}
		};
		void Promise.all(Array.from({ length: parallel }, work));
		return () => {
			live = false;
		};
	}, [items, tz]);

	const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
	const read = items.filter((i) => i.id in cards);
	const reading = !plan || read.length < items.length;
	const shown = read
		.map((item) => ({ item, card: cards[item.id] }))
		.filter((x): x is { item: WatchItem; card: Card } => x.card !== null);

	// The reader's pins, in their order. A pin whose figure the plan does not
	// carry, such as one made before this page loaded and since unpinned
	// elsewhere, is left out.
	const pinned = pinIds
		.map((id) => byId.get(id))
		.filter((i): i is WatchItem => i !== undefined)
		.map((i) => ({ ...i, pinned: true }));
	const pinnedSet = new Set(pinned.map((i) => i.id));

	const move = (id: string, to: number) => {
		const ids = pinned.map((i) => i.id);
		const from = ids.indexOf(id);
		if (from < 0 || to < 0 || to >= ids.length || from === to) return;
		ids.splice(to, 0, ...ids.splice(from, 1));
		setChoiceError(null);
		const order = ids.map((pin) => {
			const item = byId.get(pin) as WatchItem;
			return { reportId: item.reportId, measure: item.measure };
		});
		moved(() =>
			setLocal([
				...order.map((o) => ({ ...o, choice: "pin" as const })),
				...choices.filter((c) => c.choice === "hide"),
			]),
		);
		void save(
			{ order },
			"POST",
			"The new order could not be saved. Try again.",
		);
	};

	const { drag, start } = useReorder(move);
	const lifted = drag ? byId.get(drag.id) : undefined;
	const liftedCard = drag ? cards[drag.id] : undefined;

	// Everything not pinned, judged by the day's movement.
	const automatic = shown
		.filter((x) => !pinnedSet.has(x.item.id))
		.map((x) => ({ ...x, item: { ...x.item, pinned: false } }));
	const unusualCount = shown.filter((x) => x.card.unusual).length;
	const lead = automatic
		.filter((x) => x.card.unusual)
		.sort((a, b) => b.card.weight - a.card.weight);
	const moving = automatic
		.filter(
			(x) =>
				!x.card.unusual &&
				Math.abs(x.card.againstUsual ?? 0) >= movingAt,
		)
		.sort((a, b) => b.card.weight - a.card.weight);
	const steady = automatic.filter(
		(x) => !x.card.unusual && Math.abs(x.card.againstUsual ?? 0) < movingAt,
	);

	const hidden = choices.filter((c) => c.choice === "hide");
	const titleOf = new Map(
		(plan?.reports ?? []).map((r) => [r.reportId, r.title]),
	);
	const late = plan?.late ?? [];
	const fired = plan?.alerts ?? [];
	const yours = (plan?.reports ?? [])
		.filter((r) => r.why !== null && r.why !== "popular")
		.slice(0, 6);
	const popular = (plan?.reports ?? [])
		.filter((r) => r.why === "popular")
		.slice(0, 4);

	const sentence = headline({
		unusual: unusualCount,
		moving: moving.length,
		late: late.length,
		fired: fired.length,
		reading,
	});

	const progress = items.length ? read.length / items.length : 0;

	return (
		<section className={styles.briefing} aria-label="Your briefing">
			<header className={styles.masthead}>
				<div className={styles.eyebrow}>{dateLine()}</div>
				<h1 className={styles.headline}>
					<span className={styles.greeting}>
						{greeting()}
						{firstName ? `, ${firstName}` : ""}.
					</span>{" "}
					{error
						? "Your briefing could not be put together"
						: sentence}
				</h1>
				{plan && items.length > 0 && (
					<div
						className={styles.progress}
						data-done={!reading || undefined}
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={items.length}
						aria-valuenow={read.length}
						aria-label="Figures read"
					>
						<span style={{ width: `${progress * 100}%` }} />
					</div>
				)}
				{plan && (
					<p className={styles.standfirst}>
						{reading
							? `Reading ${items.length} headline figures from your reports.`
							: `${items.length} headline figures from your reports, each judged against its own history.`}
					</p>
				)}
			</header>

			<div className={styles.layout}>
				<div className={styles.main}>
					{pinned.length > 0 && (
						<section className={styles.section}>
							<div className={styles.sectionHead}>
								<h2 className={styles.sectionTitle}>Pinned</h2>
								{pinned.length > 1 && (
									<span className={styles.sectionHint}>
										Drag a card to reorder, or use its
										arrows. The first is shown largest.
									</span>
								)}
							</div>
							<div className={styles.leadGrid}>
								{pinned.map((item, i) => {
									const card = cards[item.id];
									return (
										<div
											key={item.id}
											className={`${styles.pinSlot} ${i === 0 ? styles.pinSlotFirst : ""}`}
											style={
												{
													viewTransitionName:
														transitionName(item.id),
												} as React.CSSProperties
											}
											data-pin-index={i}
											data-lifted={
												drag?.id === item.id ||
												undefined
											}
											data-over={
												(drag !== null &&
													drag.over === i &&
													drag.id !== item.id) ||
												undefined
											}
											onPointerDown={start(item.id)}
										>
											{card ? (
												<BriefingCard
													item={item}
													card={card}
													size={
														i === 0
															? "hero"
															: "lead"
													}
													onExplain={() =>
														setExplaining({
															item,
															card,
														})
													}
													onPin={() =>
														void choose(item, null)
													}
													onHide={() =>
														void choose(
															item,
															"hide",
														)
													}
													onMove={{
														earlier:
															i > 0
																? () =>
																		void move(
																			item.id,
																			i -
																				1,
																		)
																: null,
														later:
															i <
															pinned.length - 1
																? () =>
																		void move(
																			item.id,
																			i +
																				1,
																		)
																: null,
													}}
												/>
											) : card === null ? (
												<div
													className={styles.pinEmpty}
												>
													<span
														className={
															styles.cardReport
														}
													>
														{item.reportTitle}
													</span>
													<span
														className={
															styles.cardName
														}
													>
														{item.measure}
													</span>
													<span
														className={
															styles.period
														}
													>
														No finished period to
														show yet.
													</span>
													<button
														type="button"
														className={styles.why}
														onClick={() =>
															void choose(
																item,
																null,
															)
														}
													>
														Unpin
													</button>
												</div>
											) : (
												<div
													className={
														styles.placeholder
													}
													aria-hidden="true"
												/>
											)}
										</div>
									);
								})}
							</div>
						</section>
					)}

					{lead.length > 0 && (
						<section className={styles.section}>
							<h2 className={styles.sectionTitle}>
								{pinned.length > 0
									? "Also needs a look"
									: "Needs a look"}
							</h2>
							<div className={styles.leadGrid}>
								{lead.map(({ item, card }, i) => (
									<BriefingCard
										key={item.id}
										transition={transitionName(item.id)}
										item={item}
										card={card}
										size={
											i === 0 && pinned.length === 0
												? "hero"
												: "lead"
										}
										onExplain={() =>
											setExplaining({ item, card })
										}
										onPin={() =>
											void choose(
												item,
												item.pinned ? null : "pin",
											)
										}
										onHide={() => void choose(item, "hide")}
									/>
								))}
							</div>
						</section>
					)}

					{moving.length > 0 && (
						<section className={styles.section}>
							<h2 className={styles.sectionTitle}>On the move</h2>
							<div className={styles.movingGrid}>
								{moving.map(({ item, card }) => (
									<BriefingCard
										key={item.id}
										transition={transitionName(item.id)}
										item={item}
										card={card}
										size="moving"
										onExplain={() =>
											setExplaining({ item, card })
										}
										onPin={() =>
											void choose(
												item,
												item.pinned ? null : "pin",
											)
										}
										onHide={() => void choose(item, "hide")}
									/>
								))}
							</div>
						</section>
					)}

					{reading && (
						<div className={styles.placeholders} aria-hidden="true">
							{Array.from({
								length:
									Math.min(
										Math.max(items.length - read.length, 0),
										4,
									) || (plan ? 0 : 4),
							}).map((_, i) => (
								<div key={i} className={styles.placeholder} />
							))}
						</div>
					)}

					{steady.length > 0 && (
						<section className={styles.section}>
							<h2 className={styles.sectionTitle}>Steady</h2>
							<div className={styles.tiles}>
								{steady.map(({ item, card }) => (
									<BriefingCard
										key={item.id}
										transition={transitionName(item.id)}
										item={item}
										card={card}
										size="steady"
										onExplain={() =>
											setExplaining({ item, card })
										}
										onPin={() =>
											void choose(
												item,
												item.pinned ? null : "pin",
											)
										}
										onHide={() => void choose(item, "hide")}
									/>
								))}
							</div>
						</section>
					)}

					{plan && items.length === 0 && (
						<p className={styles.quiet}>
							None of your reports has a scorecard on a dated
							dataset yet, so there is nothing to judge against
							its history. Your reports are below.
						</p>
					)}
					{choiceError && (
						<p className={styles.choiceError} role="alert">
							{choiceError}
						</p>
					)}

					{hidden.length > 0 && (
						<div className={styles.hiddenBar}>
							<button
								type="button"
								className={styles.hiddenToggle}
								aria-expanded={showHidden}
								onClick={() => setShowHidden((v) => !v)}
							>
								{hidden.length === 1
									? "One figure hidden"
									: `${hidden.length} figures hidden`}
							</button>
							{showHidden && (
								<ul className={styles.hiddenList}>
									{hidden.map((c) => (
										<li key={`${c.reportId}:${c.measure}`}>
											<span>
												{c.measure}
												<span
													className={
														styles.hiddenFrom
													}
												>
													{titleOf.get(c.reportId) ??
														""}
												</span>
											</span>
											<button
												type="button"
												className={styles.hiddenShow}
												onClick={() =>
													void choose(c, null)
												}
											>
												Show again
											</button>
										</li>
									))}
								</ul>
							)}
						</div>
					)}
				</div>

				<aside className={styles.rail}>
					<section className={styles.railBlock}>
						<h2 className={styles.railTitle}>Alerts that fired</h2>
						{fired.length === 0 ? (
							<p className={styles.railEmpty}>
								None in the last three days.
							</p>
						) : (
							<ul className={styles.railList}>
								{fired.slice(0, 6).map((alert) => (
									<li key={alert.id}>
										<Link
											href={alert.link ?? "/inbox/"}
											className={styles.railItem}
											data-unread={
												!alert.readOn || undefined
											}
										>
											<span
												className={styles.railItemTitle}
											>
												{alert.title}
											</span>
											<span
												className={styles.railItemMeta}
											>
												{ago(alert.createdOn)}
											</span>
										</Link>
									</li>
								))}
							</ul>
						)}
					</section>

					{late.length > 0 && (
						<section
							className={styles.railBlock}
							data-tone="warning"
						>
							<h2 className={styles.railTitle}>
								Data running late
							</h2>
							<ul className={styles.railList}>
								{late.map((source) => (
									<li key={source.sourceKey}>
										<Link
											href="/status/"
											className={styles.railItem}
										>
											<span
												className={styles.railItemTitle}
											>
												{source.title}
											</span>
											<span
												className={styles.railItemMeta}
											>
												{source.lastChanged
													? `Last arrived ${ago(source.lastChanged)}`
													: "Not arrived"}
											</span>
										</Link>
									</li>
								))}
							</ul>
						</section>
					)}

					{yours.length > 0 && (
						<section className={styles.railBlock}>
							<h2 className={styles.railTitle}>Your reports</h2>
							<ul className={styles.railList}>
								{yours.map((report) => (
									<li key={report.reportId}>
										<Link
											href={`/r/${report.slug}/`}
											className={styles.railItem}
										>
											<span
												className={styles.railItemTitle}
											>
												{report.title}
											</span>
											<span
												className={styles.railItemMeta}
											>
												{report.why === "favourite"
													? "Favourite"
													: report.why === "yours"
														? "Yours"
														: "You open it often"}
											</span>
										</Link>
									</li>
								))}
							</ul>
						</section>
					)}
					{popular.length > 0 && (
						<section className={styles.railBlock}>
							<h2 className={styles.railTitle}>
								Popular with your team
							</h2>
							<ul className={styles.railList}>
								{popular.map((report) => (
									<li key={report.reportId}>
										<Link
											href={`/r/${report.slug}/`}
											className={styles.railItem}
										>
											<span
												className={styles.railItemTitle}
											>
												{report.title}
											</span>
											<span
												className={styles.railItemMeta}
											>
												Opened by people with your
												access
											</span>
										</Link>
									</li>
								))}
							</ul>
						</section>
					)}
				</aside>
			</div>

			{drag && lifted && (
				<div
					className={styles.dragChip}
					style={{ left: drag.x + 14, top: drag.y + 14 }}
					aria-hidden="true"
				>
					<span className={styles.dragChipReport}>
						{lifted.reportTitle}
					</span>
					<span className={styles.dragChipName}>
						{lifted.measure}
					</span>
					{liftedCard && (
						<>
							<span className={styles.dragChipValue}>
								{formatCompact(liftedCard.value, lifted.hint)}
							</span>
							<Trend
								series={liftedCard.series}
								low={liftedCard.low}
								high={liftedCard.high}
								tone="neutral"
								compact
							/>
						</>
					)}
				</div>
			)}

			{explaining && explaining.card.previousWindow && (
				<ExplainDialog
					sourceKey={explaining.item.sourceKey}
					measure={explaining.item.measure}
					hint={byId.get(explaining.item.id)?.hint ?? "decimal"}
					filters={[
						{
							field: explaining.item.timeField,
							op: "gte",
							value: explaining.card.window.gte,
						},
						{
							field: explaining.item.timeField,
							op: "lt",
							value: explaining.card.window.lt,
						},
					]}
					previousFilters={[
						{
							field: explaining.item.timeField,
							op: "gte",
							value: explaining.card.previousWindow.gte,
						},
						{
							field: explaining.item.timeField,
							op: "lt",
							value: explaining.card.previousWindow.lt,
						},
					]}
					against={
						explaining.card.spacing <= 1
							? "the same day a week before"
							: "the period before"
					}
					onClose={() => setExplaining(null)}
				/>
			)}
		</section>
	);
}
