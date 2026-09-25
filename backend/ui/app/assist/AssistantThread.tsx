"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { DataGrid } from "../visuals/DataGrid";
import { Chart } from "../visuals/chartEntry";
import { fieldMap, type SourceMeta } from "../visuals/types";
import type { ChartOut } from "../../lib/assistant/events";
import {
	useAssistant,
	type Activity,
	type Message,
	type Step,
} from "./AssistantContext";
import { Markdown } from "./Markdown";
import styles from "./Assist.module.css";

// The conversation, drawn as it arrives.
//
// Each answer shows its working above it: what the assistant said it was about
// to check, then every step with a live marker while it runs, how long it took
// and what came back, with the first rows of each result a click away. The
// answer is written underneath as the model writes it.

function seconds(from: number, to?: number): string {
	const ms = (to ?? Date.now()) - from;
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Re-renders every second while something is running, so the timers move.
function useTicking(active: boolean) {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, [active]);
}

function StepIcon({ status }: { status: Step["status"] }) {
	if (status === "running") {
		return <span className={styles.spinner} aria-label="Running" />;
	}
	return status === "ok" ? (
		<svg
			className={styles.stepOk}
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="3"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-label="Done"
		>
			<path d="M5 12l5 5L20 7" />
		</svg>
	) : (
		<svg
			className={styles.stepFailed}
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="3"
			strokeLinecap="round"
			aria-label="Failed"
		>
			<path d="M6 6l12 12M18 6L6 18" />
		</svg>
	);
}

function StepRow({ step }: { step: Step }) {
	const [open, setOpen] = useState(false);
	const expandable = Boolean(step.preview && step.preview.columns.length > 0);

	return (
		<li className={styles.step}>
			<button
				type="button"
				className={styles.stepHead}
				onClick={() => expandable && setOpen((v) => !v)}
				aria-expanded={expandable ? open : undefined}
				disabled={!expandable}
			>
				<StepIcon status={step.status} />
				<span className={styles.stepLabel}>{step.label}</span>
				<span className={styles.stepMeta}>
					{step.summary && <span>{step.summary}</span>}
					<span>{seconds(step.startedAt, step.finishedAt)}</span>
				</span>
			</button>

			{open && step.preview && (
				<div className={styles.previewWrap}>
					<table className={styles.preview}>
						<thead>
							<tr>
								{step.preview.columns.map((c) => (
									<th key={c}>{c}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{step.preview.rows.map((row, r) => (
								<tr key={r}>
									{row.map((cell, c) => (
										<td key={c}>{cell ?? ""}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
					{step.preview.total > step.preview.rows.length && (
						<p className={styles.previewMore}>
							First {step.preview.rows.length} of{" "}
							{step.preview.total.toLocaleString()} rows
						</p>
					)}
				</div>
			)}
		</li>
	);
}

function ActivityList({
	activity,
	running,
}: {
	activity: Activity[];
	running: boolean;
}) {
	// Collapsed once the answer is in, because the reader came for the answer.
	// Open while it runs, because watching it work is the point then.
	const [open, setOpen] = useState(true);
	const wasRunning = useRef(running);
	useEffect(() => {
		if (wasRunning.current && !running) setOpen(false);
		wasRunning.current = running;
	}, [running]);

	const steps = activity.filter((a) => a.type === "step").length;
	if (activity.length === 0) return null;

	return (
		<div className={styles.activity}>
			<button
				type="button"
				className={styles.activityToggle}
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					className={open ? styles.chevronOpen : styles.chevron}
					aria-hidden="true"
				>
					<path d="M9 6l6 6-6 6" />
				</svg>
				{running
					? "Working"
					: `${steps} ${steps === 1 ? "step" : "steps"}`}
			</button>
			{open && (
				<ol className={styles.activityList}>
					{activity.map((a, i) =>
						a.type === "narration" ? (
							<li key={i} className={styles.narration}>
								{a.text}
							</li>
						) : (
							<StepRow key={a.step.id} step={a.step} />
						),
					)}
				</ol>
			)}
		</div>
	);
}

function ChartBlock({
	chart,
	sources,
	compact,
}: {
	chart: ChartOut;
	sources: SourceMeta[];
	compact: boolean;
}) {
	const source = sources.find((s) => s.sourceKey === chart.sourceKey);
	if (!source) return null;
	const fields = fieldMap(source);

	return (
		<figure className={styles.result}>
			<figcaption className={styles.chartTitle}>{chart.title}</figcaption>
			{chart.visualType === "table" ? (
				<DataGrid
					sourceKey={chart.sourceKey}
					dimensions={chart.dimensions}
					measures={chart.measures}
					baseFilters={chart.filters}
					fields={fields}
					height={compact ? 260 : 360}
				/>
			) : (
				<Chart
					visualType={chart.visualType}
					sourceKey={chart.sourceKey}
					dimensions={chart.dimensions}
					measures={chart.measures}
					filters={chart.filters}
					limit={chart.limit}
					fields={fields}
					height={compact ? 240 : 340}
				/>
			)}
		</figure>
	);
}

// The model is asked to end on one "Next:" line. It is offered as a button that
// asks it, rather than left as text somebody has to retype.
function splitNext(answer: string): { body: string; next: string | null } {
	const match = /\n?\s*\**Next:\**\s*(.+?)\s*$/i.exec(answer);
	if (!match) return { body: answer, next: null };
	return {
		body: answer.slice(0, match.index).trimEnd(),
		next: match[1].replace(/^\*+|\*+$/g, "").trim(),
	};
}

function AnswerBlock({
	message,
	sources,
	compact,
}: {
	message: Extract<Message, { role: "assistant" }>;
	sources: SourceMeta[];
	compact: boolean;
}) {
	const { send, retry, busy } = useAssistant();
	const [copied, setCopied] = useState(false);
	const running = message.status === "streaming";
	useTicking(running);

	const text = running ? message.draft : message.answer;
	const { body, next } = running
		? { body: text, next: null }
		: splitNext(text);

	return (
		<div className={styles.assistantTurn}>
			<ActivityList activity={message.activity} running={running} />

			{body && <Markdown text={body} />}
			{running && <span className={styles.caret} aria-hidden="true" />}

			{message.charts.map((chart, c) => (
				<ChartBlock
					key={c}
					chart={chart}
					sources={sources}
					compact={compact}
				/>
			))}

			{message.status === "error" && (
				<p className={styles.failure}>{message.error}</p>
			)}
			{message.status === "stopped" && (
				<p className={styles.stopped}>Stopped.</p>
			)}

			{!running && (
				<div className={styles.answerFoot}>
					{next && (
						<button
							type="button"
							className={styles.next}
							disabled={busy}
							onClick={() => send(next)}
						>
							{next}
						</button>
					)}
					<span className={styles.footActions}>
						<span className={styles.footMeta}>
							{seconds(message.startedAt, message.finishedAt)}
						</span>
						{message.answer && (
							<button
								type="button"
								className={styles.footButton}
								onClick={() => {
									void navigator.clipboard
										?.writeText(message.answer)
										.then(() => {
											setCopied(true);
											setTimeout(
												() => setCopied(false),
												1500,
											);
										});
								}}
							>
								{copied ? "Copied" : "Copy"}
							</button>
						)}
						<button
							type="button"
							className={styles.footButton}
							disabled={busy}
							onClick={() => retry(message.id)}
						>
							Ask again
						</button>
					</span>
				</div>
			)}
		</div>
	);
}

export function AssistantThread({
	compact = false,
	examples,
}: {
	compact?: boolean;
	examples: string[];
}) {
	const { messages, send } = useAssistant();
	const { data } = useSWR<{ sources: SourceMeta[] }>("/api/authoring");
	const sources = data?.sources ?? [];
	const endRef = useRef<HTMLDivElement | null>(null);

	// Follows the answer down as it is written, the way a chat does.
	const last = messages[messages.length - 1];
	const growth =
		last?.role === "assistant"
			? last.draft.length + last.activity.length + last.charts.length
			: 0;
	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "end" });
	}, [messages.length, growth]);

	return (
		<div className={styles.thread}>
			{messages.length === 0 && (
				<div className={styles.examples}>
					{examples.map((text) => (
						<button
							key={text}
							type="button"
							className={styles.example}
							onClick={() => send(text)}
						>
							{text}
						</button>
					))}
				</div>
			)}

			{messages.map((m) =>
				m.role === "user" ? (
					<div key={m.id} className={styles.userTurn}>
						{m.attachments && m.attachments.length > 0 && (
							<span className={styles.userAttached}>
								Pointing at {m.attachments.join(", ")}
							</span>
						)}
						{m.content}
					</div>
				) : (
					<AnswerBlock
						key={m.id}
						message={m}
						sources={sources}
						compact={compact}
					/>
				),
			)}
			<div ref={endRef} />
		</div>
	);
}
