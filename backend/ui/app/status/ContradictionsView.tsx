"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "../components/AppLink";
import useSWR from "swr";
import { EmptyState, emptyIcons } from "../components/shared/EmptyState";
import styles from "./Quality.module.css";

// Data status's Contradictions tab. Two published reports showing one measure in ways that
// can disagree, why they might, and whether they do once both are run as this reader. Each
// pair is compared as the tab opens, so the summary at the top is an answer rather than a
// list of things to go and press.

interface Side {
	visualId: string;
	reportTitle: string;
	reportSlug: string;
	pageTitle: string;
	title: string | null;
	link: string;
}

interface Candidate {
	key: string;
	pairKey: string;
	sourceKey: string;
	measure: string;
	left: Side;
	right: Side;
	differences: string[];
	// How many more visuals on these two reports differ the same way.
	alsoOn: number;
	canDecide: boolean;
	intended: { note: string; by: string; on: string } | null;
}

interface Answer {
	left: number;
	right: number;
	disagree: boolean;
}

type Filter = "all" | "disagree" | "agree" | "intended";

// How many pairs are compared at once. Each runs two queries as this reader.
const comparedAtOnce = 3;

function SideCard({ side, figure }: { side: Side; figure: number | null }) {
	return (
		<div className={styles.pairSide}>
			<Link href={side.link}>{side.reportTitle}</Link>
			<span className={styles.hint}>
				{side.title
					? `${side.pageTitle}, ${side.title}`
					: side.pageTitle}
			</span>
			<span className={styles.pairFigure}>
				{figure === null ? "..." : figure.toLocaleString()}
			</span>
		</div>
	);
}

function Pair({
	candidate,
	answer,
	failure,
	onChanged,
}: {
	candidate: Candidate;
	answer: Answer | null;
	failure: string | null;
	onChanged: () => void;
}) {
	const [marking, setMarking] = useState(false);
	const [note, setNote] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const { left, right } = candidate;

	const decide = async (action: "intended" | "reopen") => {
		setProblem(null);
		const response = await fetch("/api/contradictions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action,
				leftVisualId: left.visualId,
				rightVisualId: right.visualId,
				measure: candidate.measure,
				note,
			}),
		});
		const detail = await response.json().catch(() => null);
		if (!response.ok) {
			setProblem(detail?.error ?? "That did not save.");
			return;
		}
		setMarking(false);
		setNote("");
		onChanged();
	};

	const status = candidate.intended
		? { word: "Meant to differ", tone: styles.statuspass }
		: !answer
			? null
			: answer.disagree
				? { word: "Disagree", tone: styles.statusfail }
				: { word: "Agree", tone: styles.statuspass };

	return (
		<div className={styles.rule}>
			<div className={styles.ruleHead}>
				{status && (
					<span className={`${styles.status} ${status.tone}`}>
						{status.word}
					</span>
				)}
				<strong className={styles.ruleName}>{candidate.measure}</strong>
				{candidate.alsoOn > 0 && (
					<span className={styles.hint}>
						and {candidate.alsoOn} more visual
						{candidate.alsoOn === 1 ? "" : "s"} on these reports
					</span>
				)}
			</div>
			<div className={styles.pairSides}>
				<SideCard side={left} figure={answer?.left ?? null} />
				<SideCard side={right} figure={answer?.right ?? null} />
			</div>
			<ul className={styles.groups}>
				{candidate.differences.map((difference) => (
					<li key={difference}>{difference}</li>
				))}
			</ul>
			{failure && <p className={styles.failure}>{failure}</p>}

			{candidate.intended && (
				<div className={styles.fixBox}>
					<p>
						{candidate.intended.by} said these are meant to differ:{" "}
						{candidate.intended.note}
					</p>
					{candidate.canDecide && (
						<button
							type="button"
							className={styles.button}
							onClick={() => void decide("reopen")}
						>
							Look at this again
						</button>
					)}
				</div>
			)}

			{!candidate.intended && answer?.disagree && (
				<div className={styles.fixBox}>
					<p>
						<strong>To fix this</strong>, open whichever report is
						wrong and change the setting named above so both ask the
						same question. If both are right, say why, and this
						stops being counted.
					</p>
					<div className={styles.actions}>
						<Link className={styles.button} href={left.link}>
							Open {left.reportTitle}
						</Link>
						<Link className={styles.button} href={right.link}>
							Open {right.reportTitle}
						</Link>
						{candidate.canDecide && !marking && (
							<button
								type="button"
								className={styles.button}
								onClick={() => setMarking(true)}
							>
								They are meant to differ
							</button>
						)}
					</div>
					{marking && (
						<div className={styles.actions}>
							<input
								className={styles.reasonInput}
								value={note}
								placeholder="Why they differ, for whoever reads this next"
								aria-label="Why they differ"
								onChange={(e) => setNote(e.target.value)}
							/>
							<button
								type="button"
								className={styles.primary}
								disabled={!note.trim()}
								onClick={() => void decide("intended")}
							>
								Save
							</button>
						</div>
					)}
					{!candidate.canDecide && (
						<p className={styles.hint}>
							A Maintainer of either report can mark these as
							meant to differ.
						</p>
					)}
				</div>
			)}
			{problem && <p className={styles.failure}>{problem}</p>}
		</div>
	);
}

export default function ContradictionsView() {
	const { data, error, mutate } = useSWR<{ candidates: Candidate[] }>(
		"/api/contradictions",
	);
	const [answers, setAnswers] = useState<Record<string, Answer>>({});
	const [failures, setFailures] = useState<Record<string, string>>({});
	const [filter, setFilter] = useState<Filter>("disagree");
	const candidates = useMemo(() => data?.candidates ?? [], [data]);

	// Every pair not yet answered, a few at a time, so a long list fills in as it goes.
	useEffect(() => {
		const waiting = candidates.filter(
			(candidate) =>
				!answers[candidate.pairKey] && !failures[candidate.pairKey],
		);
		if (waiting.length === 0) return;
		let live = true;
		const queue = [...waiting];
		const worker = async () => {
			for (let next = queue.shift(); next && live; next = queue.shift()) {
				const held = next;
				try {
					const response = await fetch("/api/contradictions", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							leftVisualId: held.left.visualId,
							rightVisualId: held.right.visualId,
							measure: held.measure,
						}),
					});
					const detail = await response.json().catch(() => null);
					if (!live) return;
					if (response.ok) {
						setAnswers((was) => ({
							...was,
							[held.pairKey]: detail,
						}));
					} else {
						setFailures((was) => ({
							...was,
							[held.pairKey]:
								detail?.error ?? "These could not be compared.",
						}));
					}
				} catch {
					if (live) {
						setFailures((was) => ({
							...was,
							[held.pairKey]: "These could not be compared.",
						}));
					}
				}
			}
		};
		void Promise.all(Array.from({ length: comparedAtOnce }, worker));
		return () => {
			live = false;
		};
		// Started again only when the list itself changes. Answers arriving are this filling in.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [candidates]);

	if (error) {
		return <p className={styles.hint}>These could not be loaded.</p>;
	}
	if (!data) return null;
	if (candidates.length === 0) {
		return (
			<EmptyState icon={emptyIcons.check} title="Nothing to compare">
				No two reports you can open show the same measure set up in ways
				that could disagree.
			</EmptyState>
		);
	}

	const kindOf = (candidate: Candidate): Filter | "waiting" => {
		if (candidate.intended) return "intended";
		const answer = answers[candidate.pairKey];
		if (!answer) return "waiting";
		return answer.disagree ? "disagree" : "agree";
	};
	const counts = { disagree: 0, agree: 0, intended: 0, waiting: 0 };
	for (const candidate of candidates)
		counts[kindOf(candidate) as keyof typeof counts] += 1;
	const shown = candidates.filter(
		(candidate) => filter === "all" || kindOf(candidate) === filter,
	);
	const tiles: {
		id: Filter;
		label: string;
		value: number;
		tone?: string;
	}[] = [
		{
			id: "disagree",
			label: "Disagree",
			value: counts.disagree,
			tone: counts.disagree > 0 ? styles.summaryValueBad : undefined,
		},
		{
			id: "agree",
			label: "Agree",
			value: counts.agree,
			tone: styles.summaryValueGood,
		},
		{ id: "intended", label: "Meant to differ", value: counts.intended },
		{ id: "all", label: "Compared", value: candidates.length },
	];

	return (
		<div className={styles.quality}>
			<div className={styles.summary}>
				{tiles.map((tile) => (
					<button
						key={tile.id}
						type="button"
						aria-pressed={filter === tile.id}
						className={`${styles.summaryTile} ${filter === tile.id ? styles.summaryTileOn : ""}`}
						onClick={() => setFilter(tile.id)}
					>
						<span
							className={`${styles.summaryValue} ${tile.tone ?? ""}`}
						>
							{tile.value}
						</span>
						<span className={styles.summaryLabel}>
							{tile.label}
						</span>
					</button>
				))}
			</div>
			<p className={styles.hint}>
				Each pair is one measure on one source, set up differently in
				two reports. Both are run as you, so a difference here is one
				your own access shows.
				{counts.waiting > 0
					? ` Still comparing ${counts.waiting}.`
					: ""}
			</p>
			{shown.length === 0 && counts.waiting === 0 && (
				<EmptyState icon={emptyIcons.check} title="Nothing here">
					{filter === "disagree"
						? "Every pair you can see agrees or is meant to differ."
						: "No pairs in this group."}
				</EmptyState>
			)}
			{shown.map((candidate) => (
				<Pair
					key={candidate.key}
					candidate={candidate}
					answer={answers[candidate.pairKey] ?? null}
					failure={failures[candidate.pairKey] ?? null}
					onChanged={() => void mutate()}
				/>
			))}
		</div>
	);
}
