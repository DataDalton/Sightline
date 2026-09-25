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
	"Show revenue by business unit this year",
	"Summarise order volume by division",
	"How are rebate payouts split across programs?",
];

export default function AssistView() {
	usePageTitle("Assistant");
	const { newConversation, busy } = useAssistant();
	const [preferences, setPreferences] = useState(false);

	return (
		<div className={styles.fullPage}>
			<aside className={styles.fullSide}>
				<button
					type="button"
					className={styles.newChatWide}
					onClick={() => {
						newConversation();
						setPreferences(false);
					}}
					disabled={busy}
				>
					New conversation
				</button>
				<button
					type="button"
					className={`${styles.sideLink} ${preferences ? styles.sideLinkOn : ""}`}
					onClick={() => setPreferences((v) => !v)}
				>
					Preferences
				</button>
				<ConversationList onOpened={() => setPreferences(false)} />
			</aside>

			<div className={styles.page}>
				<header className={styles.header}>
					<div>
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
