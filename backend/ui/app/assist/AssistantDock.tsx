"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useUser } from "../context/UserContext";
import { useAssistant } from "./AssistantContext";
import { AssistantComposer } from "./AssistantComposer";
import { AssistantPreferences } from "./AssistantPreferences";
import { AssistantThread } from "./AssistantThread";
import { ConversationList } from "./ConversationList";
import { PagePicker } from "./PagePicker";
import styles from "./Assist.module.css";

// The assistant, from any page.
//
// A button in the corner that opens a panel down the right edge. The page stays
// where it is behind it, which is the point: a question asked from a report is
// usually about that report, and the assistant is told which report and page
// are open so "why is this down" means this. Parts of the page can be pointed
// at and added to a question.
//
// Absent entirely where no endpoint is configured, and on the full assistant
// page, which is the same conversation at full width.

const examples = [
	"Summarise this page",
	"Explain what these charts show",
	"Break this down by month",
];

// How wide the panel opens, and the bounds a drag of its edge may take it to.
// Wide enough by default for a table of results to be read without scrolling
// sideways, and never so wide the page it is asking about disappears.
const defaultWidth = 600;
const minWidth = 380;
const widthKey = "sightline.assistant.width";

function maxWidth(): number {
	return Math.max(minWidth, Math.round(window.innerWidth * 0.7));
}

function storedWidth(): number {
	try {
		const held = Number(window.localStorage.getItem(widthKey));
		if (Number.isFinite(held) && held >= minWidth) {
			return Math.min(held, maxWidth());
		}
	} catch {
		// Storage blocked. The default is used.
	}
	return defaultWidth;
}

type View = "chat" | "preferences";

// The conversation list, down the panel's own left side. The panel grows by
// its width rather than squeezing the chat, so opening the list never makes
// the answer harder to read.
const sidebarWidth = 240;
const sidebarKey = "sightline.assistant.sidebar";

function Icon({ d }: { d: string }) {
	return (
		<svg
			width="16"
			height="16"
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

function HeadButton({
	label,
	active,
	onClick,
	disabled,
	children,
}: {
	label: string;
	active?: boolean;
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className={`${styles.iconButton} ${active ? styles.iconButtonOn : ""}`}
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
			aria-pressed={active}
		>
			{children}
		</button>
	);
}

export function AssistantDock() {
	const { user } = useUser();
	const pathname = usePathname() ?? "";
	const { panelOpen, setPanelOpen, busy, newConversation, picking } =
		useAssistant();
	const [view, setView] = useState<View>("chat");
	const [sidebar, setSidebar] = useState(false);

	const [width, setWidth] = useState(defaultWidth);
	const dragging = useRef(false);

	// Read after mount, so the server render and the first client render agree.
	useEffect(() => {
		setWidth(storedWidth());
		try {
			setSidebar(window.localStorage.getItem(sidebarKey) === "open");
		} catch {
			// Storage blocked. The list starts closed.
		}
	}, []);

	const toggleSidebar = () =>
		setSidebar((open) => {
			try {
				window.localStorage.setItem(
					sidebarKey,
					open ? "closed" : "open",
				);
			} catch {
				// Not kept past this visit.
			}
			return !open;
		});

	// Ctrl+I, or Cmd+I, opens and closes it from anywhere. Escape closes it,
	// unless the picker is on, where Escape belongs to the picker.
	useEffect(() => {
		if (!user?.assistant) return;
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
				e.preventDefault();
				setPanelOpen(!panelOpen);
			} else if (e.key === "Escape" && panelOpen && !picking) {
				setPanelOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [user?.assistant, panelOpen, setPanelOpen, picking]);

	// Dragging the left edge sets the width, measured from the right edge of
	// the window since that is the side the panel is pinned to.
	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		dragging.current = true;
		const move = (ev: PointerEvent) => {
			if (!dragging.current) return;
			setWidth(
				Math.min(
					maxWidth(),
					Math.max(minWidth, window.innerWidth - ev.clientX - 12),
				),
			);
		};
		const up = () => {
			dragging.current = false;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			document.body.style.userSelect = "";
			setWidth((w) => {
				try {
					window.localStorage.setItem(widthKey, String(w));
				} catch {
					// Not kept past this visit.
				}
				return w;
			});
		};
		document.body.style.userSelect = "none";
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	if (!user?.assistant) return null;
	if (pathname.startsWith("/assist")) return null;

	return (
		<>
			<PagePicker />

			{!panelOpen && (
				<button
					type="button"
					className={`${styles.dockButton} ${busy ? styles.dockBusy : ""}`}
					onClick={() => setPanelOpen(true)}
					aria-label="Open the assistant"
					title="Assistant (Ctrl+I)"
					data-assistant-ui
				>
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
						<path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
					</svg>
					<span>Ask</span>
				</button>
			)}

			{panelOpen && (
				<aside
					className={styles.dock}
					aria-label="Assistant"
					style={{ width: width + (sidebar ? sidebarWidth : 0) }}
					data-assistant-ui
				>
					{/* Drag to make the panel wider or narrower. */}
					<div
						className={styles.dockResize}
						onPointerDown={startResize}
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize the assistant"
						title="Drag to resize"
					/>
					<header className={styles.dockHead}>
						<span className={styles.dockTitleRow}>
							<HeadButton
								label={
									sidebar
										? "Hide conversations"
										: "Show conversations"
								}
								active={sidebar}
								onClick={toggleSidebar}
							>
								<Icon d="M3 4h18v16H3zM9 4v16" />
							</HeadButton>
							<span className={styles.dockTitle}>
								{view === "preferences"
									? "Preferences"
									: "Assistant"}
							</span>
						</span>
						<span className={styles.dockActions}>
							<HeadButton
								label="New conversation"
								disabled={busy}
								onClick={() => {
									newConversation();
									setView("chat");
								}}
							>
								<Icon d="M12 5v14M5 12h14" />
							</HeadButton>
							<HeadButton
								label="Preferences"
								active={view === "preferences"}
								onClick={() =>
									setView(
										view === "preferences"
											? "chat"
											: "preferences",
									)
								}
							>
								<Icon d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
							</HeadButton>
							<Link
								href="/assist"
								className={styles.iconButton}
								onClick={() => setPanelOpen(false)}
								title="Open full page"
								aria-label="Open full page"
							>
								<Icon d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
							</Link>
							<HeadButton
								label="Close (Esc)"
								onClick={() => setPanelOpen(false)}
							>
								<Icon d="M6 6l12 12M18 6L6 18" />
							</HeadButton>
						</span>
					</header>

					<div className={styles.dockColumns}>
						{sidebar && (
							<nav
								className={styles.dockSide}
								style={{ width: sidebarWidth }}
								aria-label="Conversations"
							>
								<ConversationList
									compact
									onOpened={() => setView("chat")}
								/>
							</nav>
						)}

						<div className={styles.dockMain}>
							<div className={styles.dockBody}>
								{view === "chat" && (
									<AssistantThread
										compact
										examples={examples}
									/>
								)}
								{view === "preferences" && (
									<AssistantPreferences />
								)}
							</div>

							{view === "chat" && (
								<div className={styles.dockFoot}>
									<AssistantComposer
										compact
										autoFocus
										pickable
									/>
								</div>
							)}
						</div>
					</div>
				</aside>
			)}
		</>
	);
}
