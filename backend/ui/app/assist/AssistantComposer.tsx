"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Select } from "../components/shared/Select";
import type { SourceMeta } from "../visuals/types";
import { useAssistant } from "./AssistantContext";
import styles from "./Assist.module.css";

// Where a question is typed. While an answer is being written the send button
// becomes a stop button, because the moment somebody sees it heading the wrong
// way is the moment they want it to stop.
//
// Parts of the page picked with the pointer sit above the box as chips, and go
// with the next question.

export function AssistantComposer({
	compact = false,
	autoFocus = false,
	pickable = false,
}: {
	compact?: boolean;
	autoFocus?: boolean;
	// Whether there is a page behind this to point at. The full assistant page
	// has nothing on it worth pointing at but the conversation.
	pickable?: boolean;
}) {
	const { send, stop, busy, attachments, detach, picking, setPicking } =
		useAssistant();
	const { data } = useSWR<{ sources: SourceMeta[] }>("/api/authoring");
	const sources = [...(data?.sources ?? [])].sort((a, b) =>
		a.title.localeCompare(b.title),
	);
	const [question, setQuestion] = useState("");
	const [sourceKey, setSourceKey] = useState("");
	const ref = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		if (autoFocus) ref.current?.focus();
	}, [autoFocus]);

	const submit = () => {
		if (busy || !question.trim()) return;
		send(question, sourceKey);
		setQuestion("");
	};

	return (
		<form
			className={`${styles.ask} ${compact ? styles.askCompact : ""}`}
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			{attachments.length > 0 && (
				<div className={styles.attachments}>
					{attachments.map((a) => (
						<span
							key={a.id}
							className={styles.attachment}
							title={a.text}
						>
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								aria-hidden="true"
							>
								<path d="M3 3l7 17 2.5-7.5L20 10z" />
							</svg>
							<span className={styles.attachmentLabel}>
								{a.label}
							</span>
							<button
								type="button"
								className={styles.chipX}
								aria-label={`Remove ${a.label}`}
								onClick={() => detach(a.id)}
							>
								×
							</button>
						</span>
					))}
				</div>
			)}
			<textarea
				ref={ref}
				className={styles.question}
				value={question}
				rows={compact ? 2 : 3}
				placeholder="Ask about your data"
				aria-label="Your question"
				onChange={(e) => setQuestion(e.target.value)}
				onKeyDown={(e) => {
					// Enter sends and shift+enter breaks the line, as in every
					// chat box somebody has used before.
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						submit();
					}
				}}
			/>
			<div className={styles.askControls}>
				{pickable && (
					<button
						type="button"
						className={`${styles.pickButton} ${picking ? styles.pickButtonOn : ""}`}
						onClick={() => setPicking(!picking)}
						aria-pressed={picking}
						title="Point at part of the page to ask about it"
					>
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
							<path d="M3 3l7 17 2.5-7.5L20 10z" />
						</svg>
						{picking ? "Picking" : "Point"}
					</button>
				)}
				<Select
					value={sourceKey}
					onChange={setSourceKey}
					placeholder="Any dataset"
					searchable
					ariaLabel="Restrict to one dataset"
					options={[
						{ value: "", label: "Any dataset" },
						...sources.map((s) => ({
							value: s.sourceKey,
							label: s.title,
						})),
					]}
				/>
				{busy ? (
					<button
						type="button"
						className={styles.stop}
						onClick={stop}
					>
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
						>
							<rect x="5" y="5" width="14" height="14" rx="2" />
						</svg>
						Stop
					</button>
				) : (
					<button
						type="submit"
						className={styles.submit}
						disabled={question.trim().length === 0}
					>
						Ask
					</button>
				)}
			</div>
		</form>
	);
}
