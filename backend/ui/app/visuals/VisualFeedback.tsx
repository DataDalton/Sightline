"use client";

import { useState } from "react";
import { useOptionalAssistantActions } from "../assist/AssistantContext";
import styles from "./Visual.module.css";

// Telling the people who look after a report what is wrong with one visual.
//
// A few quick reasons and a sentence. What is sent is kept with everything else
// said about the visual, and the assistant reads it with the rest once a day.
// Somebody unsure whether it is a problem at all can ask the assistant instead,
// which gets this visual attached, and may well answer it there and then.

const reasons = [
	{ kind: "hardToRead", label: "Hard to read" },
	{ kind: "wrongChart", label: "Wrong chart for this" },
	{ kind: "missing", label: "Missing something" },
	{ kind: "wantInstead", label: "I'd rather see something else" },
	{ kind: "numbersOff", label: "Numbers look off" },
	{ kind: "notNeeded", label: "Don't need this" },
] as const;

export function FeedbackAction({
	available,
	onOpen,
}: {
	available: boolean;
	onOpen: () => void;
}) {
	if (!available) return null;
	return (
		<button
			type="button"
			className={styles.frameAction}
			onClick={onOpen}
			title="Feedback on this visual"
			aria-label="Feedback on this visual"
		>
			<svg
				width="13"
				height="13"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M4 4h16v12H8l-4 4z" />
				<path d="M12 7v4M12 13.5v.01" />
			</svg>
		</button>
	);
}

export function VisualFeedback({
	reportId,
	visualId,
	title,
	onClose,
}: {
	reportId: string;
	visualId: string;
	title: string | null;
	onClose: () => void;
}) {
	const assistant = useOptionalAssistantActions();
	const [kind, setKind] = useState<string | null>(null);
	const [body, setBody] = useState("");
	const [sending, setSending] = useState(false);
	const [sent, setSent] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const send = async () => {
		if (!kind) return;
		setSending(true);
		setFailure(null);
		try {
			const response = await fetch("/api/feedback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reportId, visualId, kind, body }),
			});
			if (!response.ok) {
				const answer = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(answer?.error ?? "It could not be sent.");
			}
			setSent(true);
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "It could not be sent.",
			);
		} finally {
			setSending(false);
		}
	};

	// The visual as the assistant's picker would attach it, so the question
	// arrives with what was on screen.
	const askAssistant = () => {
		if (!assistant) return;
		const element = document.querySelector<HTMLElement>(
			`[data-visual-id="${CSS.escape(visualId)}"]`,
		);
		assistant.attach({
			label: title ?? "A visual",
			visualId,
			text: element?.innerText.slice(0, 6000) ?? "",
		});
		assistant.setPanelOpen(true);
		onClose();
	};

	return (
		<div
			className={styles.feedbackPanel}
			role="dialog"
			aria-label="Feedback on this visual"
		>
			<div className={styles.notesHead}>
				<span className={styles.notesTitle}>Feedback</span>
				<button
					type="button"
					className={styles.frameAction}
					onClick={onClose}
					title="Close"
					aria-label="Close"
				>
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M6 6l12 12M18 6L6 18" />
					</svg>
				</button>
			</div>

			{sent ? (
				<p className={styles.feedbackSent}>
					Thanks. The people who look after this report will see it,
					and you will hear what comes of it.
				</p>
			) : (
				<>
					<div className={styles.feedbackReasons}>
						{reasons.map((reason) => (
							<button
								key={reason.kind}
								type="button"
								aria-pressed={kind === reason.kind}
								className={`${styles.feedbackReason} ${
									kind === reason.kind
										? styles.feedbackReasonOn
										: ""
								}`}
								onClick={() => setKind(reason.kind)}
							>
								{reason.label}
							</button>
						))}
					</div>
					<textarea
						className={styles.noteInput}
						rows={2}
						value={body}
						placeholder="Anything to add, such as what you would rather see"
						aria-label="Anything to add"
						onChange={(e) => setBody(e.target.value)}
					/>
					{failure && (
						<p className={styles.notesFailure}>{failure}</p>
					)}
					<div className={styles.noteActions}>
						{assistant && (
							<button
								type="button"
								className={styles.feedbackAsk}
								onClick={askAssistant}
							>
								Ask the assistant about it
							</button>
						)}
						<button
							type="button"
							className={styles.noteSave}
							disabled={!kind || sending}
							onClick={() => void send()}
						>
							{sending ? "Sending" : "Send"}
						</button>
					</div>
				</>
			)}
		</div>
	);
}
