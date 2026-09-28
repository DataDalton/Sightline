"use client";

import { useState } from "react";
import { useUser } from "../context/UserContext";
import { Composer, type ComposerContext } from "../messages/Composer";
import styles from "./CategoryContacts.module.css";

// The people to ask about a category, shown where the question comes up.
//
// Asking goes through the application rather than by email. A message lands
// in their inbox and the reply lands in the asker's, and a group can be asked
// the same way as a person, since the application knows who is in it when
// they look. Pressing a person or a group asks just them. The ask button asks
// all of them.
//
// Two shapes. On a category it is a panel that says what to ask them about,
// since finding the right person is part of what a category page is for. On a
// report it is a compact button beside the title, since the report is what
// the page is for and a row of its own pushed the report down.

export interface CategoryContact {
	kind: "person" | "group";
	id: string;
	name: string;
}

const shownAtFirst = 3;

// How many chart colours the palette defines, in app/globals.css.
const paletteSize = 8;

function initials(name: string): string {
	const parts = name.split(/\s+/).filter(Boolean);
	return (
		parts
			.slice(0, 2)
			.map((p) => p[0].toUpperCase())
			.join("") || "?"
	);
}

// The same colour for the same person on every page, so a reader comes to
// recognise who looks after what. Taken from the address rather than the
// position in the list, which changes as people are added.
function colourFor(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) | 0;
	}
	return `var(--chart-${(Math.abs(hash) % paletteSize) + 1})`;
}

function Icon({ d, size = 12 }: { d: string; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={d} />
		</svg>
	);
}

const peoplePath =
	"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75";
const bubblePath =
	"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z";

function Avatar({ contact }: { contact: CategoryContact }) {
	return contact.kind === "person" ? (
		<span
			className={styles.avatar}
			style={{ "--person": colourFor(contact.id) } as React.CSSProperties}
			aria-hidden="true"
		>
			{initials(contact.name)}
		</span>
	) : (
		<span className={styles.groupAvatar} aria-hidden="true">
			<Icon d={peoplePath} />
		</span>
	);
}

export function CategoryContacts({
	contacts,
	context,
	variant = "compact",
}: {
	contacts: CategoryContact[] | undefined;
	context: ComposerContext;
	variant?: "compact" | "panel";
}) {
	const [expanded, setExpanded] = useState(false);
	// Who the composer is open for. Null is everyone, undefined is shut.
	const [asking, setAsking] = useState<CategoryContact | null | undefined>(
		undefined,
	);
	const { user } = useUser();

	if (!contacts || contacts.length === 0) return null;

	// Everyone but the reader, who is listed as a maintainer but has nobody
	// to ask in themselves. With nobody else, there is nothing to ask.
	const me = user?.email.toLowerCase();
	const askable = contacts.filter(
		(c) => !(c.kind === "person" && c.id === me),
	);
	const canAsk = askable.length > 0;

	const composer = asking !== undefined && (
		<Composer
			context={context}
			contacts={askable}
			only={asking ?? undefined}
			onClose={() => setAsking(undefined)}
		/>
	);

	if (variant === "compact") {
		const names = contacts.map((c) => c.name).join(", ");
		return (
			<>
				<button
					type="button"
					className={styles.compact}
					onClick={() => setAsking(null)}
					disabled={!canAsk}
					title={
						canAsk
							? `Maintained by ${names}. Ask them a question.`
							: "You maintain this report."
					}
					aria-label={
						canAsk
							? `Ask the maintainers, ${names}`
							: "Maintained by you"
					}
				>
					<span className={styles.stack}>
						{contacts.slice(0, 3).map((c) => (
							<Avatar key={`${c.kind}:${c.id}`} contact={c} />
						))}
						{contacts.length > 3 && (
							<span className={styles.stackMore}>
								+{contacts.length - 3}
							</span>
						)}
					</span>
					<span className={styles.compactLabel}>
						{canAsk ? "Ask" : "You maintain this"}
					</span>
				</button>
				{composer}
			</>
		);
	}

	const shown = expanded ? contacts : contacts.slice(0, shownAtFirst);
	const hidden = contacts.length - shown.length;

	return (
		<section className={styles.panel} aria-label="Maintained by">
			<div className={styles.panelText}>
				<span className={styles.panelIcon}>
					<Icon d={peoplePath} size={16} />
				</span>
				<div>
					<h2 className={styles.panelTitle}>
						Questions about these reports?
					</h2>
					<p className={styles.panelHint}>
						They maintain this category. Ask about a figure, or
						about a report that is missing, and the answer comes
						back to your inbox.
					</p>
				</div>
			</div>
			<ul className={styles.list}>
				{shown.map((contact) => (
					<li key={`${contact.kind}:${contact.id}`}>
						<button
							type="button"
							disabled={
								contact.kind === "person" && contact.id === me
							}
							className={`${styles.chip} ${
								contact.kind === "group" ? styles.group : ""
							}`}
							style={
								contact.kind === "person"
									? ({
											"--person": colourFor(contact.id),
										} as React.CSSProperties)
									: undefined
							}
							onClick={() => setAsking(contact)}
							title={
								contact.kind === "person"
									? `Ask ${contact.name}`
									: `Ask everyone in ${contact.name}`
							}
						>
							<Avatar contact={contact} />
							<span className={styles.name}>{contact.name}</span>
							{contact.kind === "group" && (
								<span className={styles.groupTag}>Group</span>
							)}
							<span className={styles.ask}>
								<Icon d={bubblePath} />
							</span>
						</button>
					</li>
				))}
				{hidden > 0 && (
					<li>
						<button
							type="button"
							className={styles.more}
							onClick={() => setExpanded(true)}
						>
							+{hidden} more
						</button>
					</li>
				)}
			</ul>
			{canAsk && (
				<button
					type="button"
					className={styles.askAll}
					onClick={() => setAsking(null)}
				>
					<Icon d={bubblePath} size={14} />
					Ask a question
				</button>
			)}
			{composer}
		</section>
	);
}
