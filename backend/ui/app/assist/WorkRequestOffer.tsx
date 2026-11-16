"use client";

import { useState } from "react";
import type { WorkOffer } from "../../lib/assistant/events";
import { useAssistantStatus } from "./AssistantContext";
import styles from "./Assist.module.css";

// The assistant's offer to ask the data engineers for work the data cannot
// answer yet. Nothing is sent until the person presses Send, and they can change
// the wording first or open the full request form instead.
export function WorkRequestOfferCard({ offer }: { offer: WorkOffer }) {
	const { conversationId } = useAssistantStatus();
	const [title, setTitle] = useState(offer.title);
	const [description, setDescription] = useState(offer.description);
	const [state, setState] = useState<
		"open" | "sending" | "sent" | "declined"
	>("open");
	const [key, setKey] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const send = async () => {
		setState("sending");
		setFailure(null);
		try {
			const response = await fetch("/api/work", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title,
					description,
					links: offer.sourceKey
						? [{ kind: "source", target: offer.sourceKey }]
						: [],
					origin: { kind: "assistant", conversationId },
				}),
			});
			const body = (await response.json().catch(() => null)) as {
				item?: { key: string };
				error?: string;
			} | null;
			if (!response.ok || !body?.item) {
				throw new Error(body?.error ?? "It could not be sent.");
			}
			setKey(body.item.key);
			setState("sent");
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "It could not be sent.",
			);
			setState("open");
		}
	};

	if (state === "declined") {
		return (
			<p className={styles.offerNote}>
				Not sent. You can ask the data engineers from Requests at any
				time.
			</p>
		);
	}

	if (state === "sent" && key) {
		return (
			<a href={`/work/${key}`} className={styles.created}>
				<span className={styles.createdKind}>Request {key} sent</span>
				<span className={styles.createdTitle}>{title}</span>
				<span className={styles.createdOpen}>Open it</span>
			</a>
		);
	}

	const formLink = `/work?${new URLSearchParams({
		new: "1",
		title,
		description,
		...(offer.sourceKey ? { source: offer.sourceKey } : {}),
		origin: JSON.stringify({ kind: "assistant", conversationId }),
	})}`;

	return (
		<div className={styles.offer}>
			<span className={styles.createdKind}>Ask the data engineers</span>
			<p className={styles.offerLead}>
				This needs work on the data itself
				{offer.sourceTitle ? ` in ${offer.sourceTitle}` : ""}. Sending
				it adds it to the request queue, and you hear when it moves.
			</p>
			<label className={styles.offerField}>
				<span>Title</span>
				<input
					className={styles.offerInput}
					value={title}
					maxLength={200}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<label className={styles.offerField}>
				<span>Details</span>
				<textarea
					className={styles.offerInput}
					rows={4}
					value={description}
					onChange={(e) => setDescription(e.target.value)}
				/>
			</label>
			{failure && <p className={styles.failure}>{failure}</p>}
			<div className={styles.offerActions}>
				<button
					type="button"
					className={styles.offerSecondary}
					onClick={() => setState("declined")}
				>
					Not now
				</button>
				<a href={formLink} className={styles.offerSecondary}>
					Open the full form
				</a>
				<button
					type="button"
					className={styles.offerPrimary}
					disabled={state === "sending" || !title.trim()}
					onClick={() => void send()}
				>
					{state === "sending" ? "Sending" : "Send request"}
				</button>
			</div>
		</div>
	);
}
