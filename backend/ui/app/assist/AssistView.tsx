"use client";

import { useState } from "react";
import { usePageTitle } from "../hooks/usePageTitle";
import { useAssistant } from "./AssistantContext";
import { AssistantComposer } from "./AssistantComposer";
import { AssistantPreferences } from "./AssistantPreferences";
import { AssistantThread } from "./AssistantThread";
import { ConversationList } from "./ConversationList";
import styles from "./Assist.module.css";

// The assistant at full width: the same conversation as the panel that opens
// from every other page, with past conversations down the side.

// Neutral on purpose. An example that asks what went wrong tells the reader
// something went wrong before anybody has looked.
const examples = [
	"Show revenue by region this year",
	"Summarise order volume by category",
	"How is revenue split across channels?",
];

export default function AssistView() {
	usePageTitle("Assistant");
	const { newConversation, busy } = useAssistant();
	const [preferences, setPreferences] = useState(false);
	// Below the width where the list sits beside the conversation, it opens
	// over it instead.
	const [sideOpen, setSideOpen] = useState(false);

	return (
		<div className={styles.fullPage}>
			{sideOpen && (
				<button
					type="button"
					className={styles.sideScrim}
					aria-label="Close conversations"
					onClick={() => setSideOpen(false)}
				/>
			)}
			<aside
				className={`${styles.fullSide} ${sideOpen ? styles.fullSideOpen : ""}`}
			>
				<button
					type="button"
					className={styles.newChatWide}
					onClick={() => {
						newConversation();
						setPreferences(false);
						setSideOpen(false);
					}}
					disabled={busy}
				>
					New conversation
				</button>
				<button
					type="button"
					className={`${styles.sideLink} ${preferences ? styles.sideLinkOn : ""}`}
					onClick={() => {
						setPreferences((v) => !v);
						setSideOpen(false);
					}}
				>
					Preferences
				</button>
				<ConversationList
					onOpened={() => {
						setPreferences(false);
						setSideOpen(false);
					}}
				/>
			</aside>

			<div className={styles.page}>
				<header className={styles.header}>
					<button
						type="button"
						className={styles.historyButton}
						onClick={() => setSideOpen(true)}
						aria-label="Conversations"
						title="Conversations"
					>
						<svg
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
							<path d="M3 4h18v16H3zM9 4v16" />
						</svg>
					</button>
					<div className={styles.headerText}>
						<h1 className={styles.title}>
							{preferences ? "Preferences" : "Assistant"}
						</h1>
						<p className={styles.subtitle}>
							{preferences
								? "How the assistant works with you, in every conversation."
								: "Ask anything about your data. It queries under your own access, so it sees exactly what you can see, and shows every step as it works."}
						</p>
					</div>
				</header>

				{preferences ? (
					<AssistantPreferences />
				) : (
					<>
						<AssistantThread examples={examples} />
						<AssistantComposer autoFocus />
					</>
				)}
			</div>
		</div>
	);
}
