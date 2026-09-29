"use client";

import { useEffect, useRef, useState } from "react";
import type { AssistantEvent } from "../../lib/assistant/events";
import { useUser } from "../context/UserContext";
import styles from "./AssistPrompt.module.css";

// One line to describe what should go in a form, above the form.
//
// The question goes to the assistant with the form's current contents, and the
// draft that comes back is handed to the form to fill in. Nothing is saved. The
// person reads what was filled in, changes what they want, and saves it the
// way they would have by hand. While it works, the step it is on is shown
// under the box, and once it is done its one line of explanation is.
//
// Absent where no assistant is configured.

type Status =
	| { kind: "idle" }
	| { kind: "working"; step: string }
	| { kind: "done"; message: string; filled: boolean }
	| { kind: "failed"; message: string };

export function AssistPrompt({
	kind,
	state,
	onDraft,
	placeholder,
	sourceKey,
	label = "Describe it",
}: {
	kind: "alert" | "formula";
	// Read when the question is sent.
	state: () => unknown;
	onDraft: (draft: unknown) => void;
	placeholder: string;
	sourceKey?: string;
	label?: string;
}) {
	const { user } = useUser();
	const [question, setQuestion] = useState("");
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const abortRef = useRef<AbortController | null>(null);

	// A dialog closed part way through stops the answer with it.
	useEffect(() => () => abortRef.current?.abort(), []);

	if (!user?.assistant) return null;

	const busy = status.kind === "working";

	const ask = async () => {
		const asked = question.trim();
		if (!asked || busy) return;
		const abort = new AbortController();
		abortRef.current = abort;
		setStatus({ kind: "working", step: "Reading the question" });

		let text = "";
		let filled = false;
		let failure: string | null = null;
		try {
			const response = await fetch("/api/assist", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					question: asked,
					history: [],
					sourceKey: sourceKey || undefined,
					path: window.location.pathname,
					title: document.title,
					surface: { kind, state: state() },
				}),
				signal: abort.signal,
			});
			if (!response.ok || !response.body) {
				const body = await response.json().catch(() => null);
				setStatus({
					kind: "failed",
					message:
						body?.error ?? "The assistant could not be reached.",
				});
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffered = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline).trim();
					buffered = buffered.slice(newline + 1);
					newline = buffered.indexOf("\n");
					if (!line) continue;
					let event: AssistantEvent;
					try {
						event = JSON.parse(line) as AssistantEvent;
					} catch {
						continue;
					}
					if (event.type === "step") {
						// Text before a step is the assistant saying what it
						// is about to do, not the answer.
						text = "";
						setStatus({ kind: "working", step: event.label });
					} else if (event.type === "text") {
						text += event.delta;
					} else if (event.type === "draft" && event.kind === kind) {
						filled = true;
						onDraft(event.draft);
					} else if (event.type === "error") {
						failure = event.message;
					}
				}
			}
		} catch (error) {
			if (abort.signal.aborted) return;
			failure =
				error instanceof Error
					? error.message
					: "The assistant could not be reached.";
		} finally {
			if (abortRef.current === abort) abortRef.current = null;
		}

		if (failure) {
			setStatus({ kind: "failed", message: failure });
		} else {
			setStatus({
				kind: "done",
				filled,
				message:
					text.trim() ||
					(filled
						? "Filled in below."
						: "Nothing was filled in. Try describing it differently."),
			});
		}
	};

	return (
		<div className={styles.prompt}>
			<form
				className={styles.row}
				onSubmit={(e) => {
					e.preventDefault();
					void ask();
				}}
			>
				<span className={styles.icon} aria-hidden="true">
					<svg
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
						<path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" />
					</svg>
				</span>
				<input
					className={styles.input}
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					placeholder={placeholder}
					aria-label={label}
					maxLength={1000}
					disabled={busy}
				/>
				{busy ? (
					<button
						type="button"
						className={styles.button}
						onClick={() => {
							abortRef.current?.abort();
							setStatus({ kind: "idle" });
						}}
					>
						Stop
					</button>
				) : (
					<button
						type="submit"
						className={styles.button}
						disabled={!question.trim()}
					>
						Fill in
					</button>
				)}
			</form>
			{status.kind !== "idle" && (
				<p
					className={`${styles.status} ${
						status.kind === "failed" ? styles.statusFailed : ""
					} ${status.kind === "working" ? styles.statusWorking : ""}`}
					aria-live="polite"
				>
					{status.kind === "working" ? status.step : status.message}
				</p>
			)}
		</div>
	);
}
