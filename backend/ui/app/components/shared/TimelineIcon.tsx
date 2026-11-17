import styles from "./Timeline.module.css";

// The mark an event takes on a timeline, by what happened. Shared by the work
// queue and updates, so the same kind of event looks the same in both.

type Tone = "good" | "bad" | "warn" | "info" | null;

const paths: Record<string, string> = {
	// Something new: a plus.
	plus: "M12 5v14M5 12h14",
	// Moved along: an arrow.
	arrow: "M5 12h14M13 6l6 6-6 6",
	// Edited: a pencil.
	pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
	// Finished well: a tick.
	check: "M20 6 9 17l-5-5",
	// Stopped: a stop sign with an exclamation.
	stop: "M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86zM12 7.5v5M12 16.5h.01",
	// Closed or taken away: a cross.
	cross: "M18 6 6 18M6 6l12 12",
	// Opened again: a circular arrow.
	reopen: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
	// Joined to something: a link.
	link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
	// A file: a paper clip.
	clip: "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
	// More people asking: two people.
	people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
	// A reminder: a bell.
	bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
	// Looked into: a magnifier.
	search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
	// Approved by security: a shield with a tick.
	shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
	// Something said: a speech bubble.
	note: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
	// A checklist line: a box with a tick.
	criterion:
		"M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
	// An open eye, for somebody looking into a thread.
	eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
	// Anything else: a dot.
	dot: "M12 12h.01",
};

const kinds: Record<string, [keyof typeof paths, Tone]> = {
	// Work queue
	created: ["plus", "info"],
	moved: ["arrow", null],
	changed: ["pencil", null],
	described: ["pencil", null],
	closed: ["cross", "bad"],
	merged: ["link", null],
	reopened: ["reopen", "info"],
	blocked: ["stop", "warn"],
	unblocked: ["check", "good"],
	approved: ["check", "good"],
	securityReviewed: ["shield", "good"],
	linked: ["link", null],
	unlinked: ["link", null],
	criterionAdded: ["criterion", null],
	criterionDone: ["criterion", "good"],
	criterionUndone: ["criterion", null],
	criterionRemoved: ["criterion", null],
	meToo: ["people", null],
	meTooRemoved: ["people", null],
	attached: ["clip", null],
	detached: ["clip", null],
	commentEdited: ["pencil", null],
	commentRemoved: ["cross", null],
	reminded: ["bell", "warn"],
	threadLooking: ["eye", "info"],
	threadNotLooking: ["eye", null],
	threadResolved: ["check", "good"],
	threadReopened: ["reopen", null],
	// Updates
	published: ["check", "good"],
	corrected: ["pencil", "info"],
	retracted: ["cross", "bad"],
	investigating: ["search", "warn"],
	identified: ["search", "info"],
	resolved: ["check", "good"],
	note: ["note", null],
};

export function TimelineIcon({ kind }: { kind: string }) {
	const [shape, tone] = kinds[kind] ?? ["dot", null];
	return (
		<span
			className={`${styles.badge} ${tone ? styles[`badge${tone}`] : ""}`}
			aria-hidden="true"
		>
			<svg
				width="15"
				height="15"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={shape === "dot" ? 6 : 2}
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d={paths[shape]} />
			</svg>
		</span>
	);
}
