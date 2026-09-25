"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import styles from "./Assist.module.css";

// How somebody wants the assistant to work with them, carried into every
// conversation.
//
// Two kinds. Instructions are what they write here themselves: answer briefly,
// use British spelling, always show a table. Memories are what they asked it to
// remember in the middle of a conversation, listed so they can see exactly what
// it is carrying and take any of it back.

interface Memory {
	id: string;
	text: string;
	createdOn: string;
}

interface Profile {
	instructions: string;
	memories: Memory[];
}

const profileKey = "/api/assist/profile";
const maxInstructions = 2000;

export function AssistantPreferences() {
	const { data, isLoading, mutate } = useSWR<Profile>(profileKey);
	const [instructions, setInstructions] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	useEffect(() => {
		if (data) setInstructions(data.instructions);
	}, [data]);

	const save = async (next: Profile) => {
		setSaving(true);
		setFailure(null);
		try {
			const response = await fetch(profileKey, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(next),
			});
			const body = await response.json();
			if (!response.ok) throw new Error(body?.error ?? "Could not save");
			await mutate(body as Profile, { revalidate: false });
			setSaved(true);
			setTimeout(() => setSaved(false), 1500);
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "Could not save",
			);
		} finally {
			setSaving(false);
		}
	};

	if (isLoading || !data) {
		return <p className={styles.historyEmpty}>Loading</p>;
	}

	const dirty = instructions !== data.instructions;

	return (
		<div className={styles.prefs}>
			<section className={styles.prefsSection}>
				<h3 className={styles.prefsTitle}>Custom instructions</h3>
				<p className={styles.prefsHint}>
					Guidance the assistant follows in every conversation. For
					example: keep answers short, always include a table, report
					by fiscal quarter.
				</p>
				<textarea
					className={styles.question}
					rows={5}
					value={instructions}
					maxLength={maxInstructions}
					placeholder="Nothing set"
					onChange={(e) => setInstructions(e.target.value)}
				/>
				<div className={styles.prefsActions}>
					<span className={styles.footMeta}>
						{failure ??
							(saved
								? "Saved"
								: `${instructions.length} / ${maxInstructions}`)}
					</span>
					<button
						type="button"
						className={styles.submit}
						disabled={!dirty || saving}
						onClick={() => void save({ ...data, instructions })}
					>
						{saving ? "Saving" : "Save"}
					</button>
				</div>
			</section>

			<section className={styles.prefsSection}>
				<h3 className={styles.prefsTitle}>Saved memories</h3>
				<p className={styles.prefsHint}>
					Details you asked the assistant to remember during a
					conversation. Say &ldquo;remember that&hellip;&rdquo; to add
					one.
				</p>
				{data.memories.length === 0 && (
					<p className={styles.historyEmpty}>Nothing yet.</p>
				)}
				<ul className={styles.historyList}>
					{data.memories.map((m) => (
						<li key={m.id} className={styles.historyItem}>
							<span className={styles.memoryText}>{m.text}</span>
							<button
								type="button"
								className={styles.iconButton}
								title="Forget this"
								aria-label={`Forget: ${m.text}`}
								onClick={() =>
									void save({
										...data,
										memories: data.memories.filter(
											(x) => x.id !== m.id,
										),
									})
								}
							>
								<svg
									width="14"
									height="14"
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
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}
