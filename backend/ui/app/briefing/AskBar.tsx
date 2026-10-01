"use client";

import { useState } from "react";
import { useAssistant } from "../assist/AssistantContext";
import styles from "./Briefing.module.css";

// The question box on the home page. The briefing says what moved, and this
// is where a reader asks why, or anything else, without leaving the page. The
// answer opens in the assistant's panel as a new conversation, and its charts
// can be pinned to a board or watched as an alert from there.

export function AskBar({ suggestions }: { suggestions: string[] }) {
	const { ask } = useAssistant();
	const [question, setQuestion] = useState("");

	const submit = (asked: string) => {
		const trimmed = asked.trim();
		if (!trimmed) return;
		ask(trimmed);
		setQuestion("");
	};

	return (
		<div className={styles.ask}>
			<form
				className={styles.askForm}
				onSubmit={(e) => {
					e.preventDefault();
					submit(question);
				}}
			>
				<svg
					className={styles.askIcon}
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
					<path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" />
				</svg>
				<input
					className={styles.askInput}
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					placeholder="Ask anything about your data"
					aria-label="Ask a question about your data"
					maxLength={4000}
				/>
				<button
					type="submit"
					className={styles.askSend}
					disabled={!question.trim()}
				>
					Ask
				</button>
			</form>
			{suggestions.length > 0 && (
				<div
					className={styles.askSuggestions}
					aria-label="Questions to start from"
				>
					{suggestions.map((suggestion) => (
						<button
							key={suggestion}
							type="button"
							className={styles.askChip}
							onClick={() => submit(suggestion)}
						>
							{suggestion}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
