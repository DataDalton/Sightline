"use client";

import type { ReactNode } from "react";
import type { QueryMeta } from "../hooks/useVisualQuery";
import { usePageFilters, type DrillStep } from "./PageFilters";
import { useExpand } from "./ExpandContext";
import { Skeleton } from "../components/shared/Skeleton";
import styles from "./Visual.module.css";

// Shared chrome for every visual: title, freshness, and the loading, empty and
// error states.
//
// Every visual shows where its data came from. In a tool that caches by policy
// class, "this is 4 minutes old" is information the reader needs in order to
// trust a number, so it is surfaced rather than hidden.

export interface DrillInfo {
	visualId: string;
	// The hierarchy, outermost first.
	fields: string[];
	// How far down the reader has descended.
	depth: number;
	path: DrillStep[];
}

interface VisualFrameProps {
	// Which visual this frame is around, so the header can offer the actions
	// that need to name one. Absent where a frame is drawn for something that
	// is not a placed visual, and the actions are then not offered.
	visualId?: string | null;
	// Chart or grid actions the renderer wants in the header, such as copying
	// the picture. Placed here rather than by each renderer so every visual's
	// controls sit in the same place.
	actions?: ReactNode;
	title?: string | null;
	meta?: QueryMeta;
	flush?: boolean;
	drill?: DrillInfo;
	// A caveat about the data rather than an error: the visual still renders.
	notice?: string | null;
	// Set when the reader drew a range across this visual and it narrowed to
	// it, so the frame can say so and offer the way back.
	onZoomOut?: (() => void) | null;
	children: ReactNode;
}

function freshnessLabel(meta: QueryMeta): string {
	if (meta.source === "warehouse") return "Live";
	const ageMs = Date.now() - meta.computedAt;
	const minutes = Math.floor(ageMs / 60000);
	if (minutes < 1) return "Cached just now";
	if (minutes === 1) return "Cached 1 min ago";
	if (minutes < 60) return `Cached ${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	return hours === 1 ? "Cached 1 hr ago" : `Cached ${hours} hrs ago`;
}

export function VisualFrame({
	visualId,
	actions,
	title,
	meta,
	flush,
	drill,
	notice,
	onZoomOut,
	children,
}: VisualFrameProps) {
	const { drillUp } = usePageFilters();
	const expand = useExpand();
	const showDrill = drill && drill.fields.length > 1;

	// Offered only where there is a page able to honour it and a visual to
	// name. The editor canvas and the version comparison draw frames too, and
	// neither has anywhere to expand into.
	const canExpand = Boolean(expand && visualId);
	const isExpanded = canExpand && expand?.expandedId === visualId;

	return (
		<div className={styles.visual}>
			{(title ||
				meta ||
				showDrill ||
				onZoomOut ||
				actions ||
				canExpand) && (
				<div className={styles.header}>
					{title && <span className={styles.title}>{title}</span>}

					{showDrill && (
						// A breadcrumb rather than a back button: a reader
						// several levels down can see where they are and jump
						// straight back, instead of clicking up one at a time.
						<nav className={styles.drill} aria-label="Drill path">
							<button
								type="button"
								className={styles.crumb}
								onClick={() => drillUp(drill.visualId, 0)}
								disabled={drill.depth === 0}
							>
								{drill.fields[0]}
							</button>
							{drill.path.map((step, i) => (
								<span
									key={`${step.field}-${step.value}`}
									className={styles.crumbGroup}
								>
									<span
										className={styles.crumbSep}
										aria-hidden="true"
									>
										›
									</span>
									<button
										type="button"
										className={styles.crumb}
										onClick={() =>
											drillUp(drill.visualId, i + 1)
										}
										disabled={i === drill.path.length - 1}
									>
										{step.value}
									</button>
								</span>
							))}
							{drill.depth < drill.fields.length - 1 && (
								<span className={styles.crumbHint}>
									click to drill into{" "}
									{drill.fields[drill.depth + 1]}
								</span>
							)}
						</nav>
					)}
					{onZoomOut && (
						<button
							type="button"
							className={styles.zoomedChip}
							onClick={onZoomOut}
							title="Show the full range again"
						>
							<svg
								width="11"
								height="11"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.5"
								strokeLinecap="round"
								aria-hidden="true"
							>
								<circle cx="11" cy="11" r="7" />
								<path d="M8 11h6M20 20l-3.5-3.5" />
							</svg>
							Zoomed to selection
						</button>
					)}

					{/* Pushed to the right of whatever the header is
					    already carrying, so the actions sit in the same place
					    on every visual whether or not it has a breadcrumb. */}
					<span className={styles.headerSpacer} aria-hidden="true" />

					{actions}

					{canExpand && (
						<button
							type="button"
							className={styles.frameAction}
							onClick={() =>
								expand?.setExpandedId(
									isExpanded ? null : (visualId ?? null),
								)
							}
							title={
								isExpanded
									? "Back to the page"
									: "Open this on its own, full size"
							}
							aria-label={
								isExpanded
									? "Back to the page"
									: "Open this full size"
							}
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
								{isExpanded ? (
									<>
										<path d="M9 3v6H3M21 15h-6v6" />
										<path d="M15 9l6-6M3 21l6-6" />
									</>
								) : (
									<>
										<path d="M15 3h6v6M9 21H3v-6" />
										<path d="M21 3l-7 7M3 21l7-7" />
									</>
								)}
							</svg>
						</button>
					)}

					{meta && (
						<span className={styles.badge}>
							<span
								className={`${styles.dot} ${
									meta.stale ? styles.dotWarm : ""
								}`}
								aria-hidden="true"
							/>
							{meta.stale ? "Refreshing" : freshnessLabel(meta)}
						</span>
					)}
				</div>
			)}
			{notice && (
				<div className={styles.driftNotice} role="status">
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
					>
						<circle cx="12" cy="12" r="10" />
						<path d="M12 8v5M12 16h.01" />
					</svg>
					{notice}
				</div>
			)}
			<div className={`${styles.body} ${flush ? styles.bodyFlush : ""}`}>
				{children}
			</div>
		</div>
	);
}

export function VisualLoading({ rows = 4 }: { rows?: number }) {
	return (
		<div aria-busy="true" aria-label="Loading">
			{Array.from({ length: rows }, (_, i) => (
				<Skeleton
					key={i}
					height={12}
					width={`${100 - i * 12}%`}
					style={{ marginBottom: "var(--space-2)" }}
				/>
			))}
		</div>
	);
}

export function VisualError({ error }: { error: Error & { status?: number } }) {
	// A 403 is an access decision, not a fault. Saying so stops a user
	// reporting a bug when the platform is working as configured.
	const isAccess = error.status === 403;
	return (
		<div className={`${styles.state} ${isAccess ? "" : styles.stateError}`}>
			<svg
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			>
				{isAccess ? (
					<>
						<rect x="3" y="11" width="18" height="11" rx="2" />
						<path d="M7 11V7a5 5 0 0 1 10 0v4" />
					</>
				) : (
					<>
						<circle cx="12" cy="12" r="10" />
						<path d="M12 8v4M12 16h.01" />
					</>
				)}
			</svg>
			<span>{error.message}</span>
		</div>
	);
}

export function VisualEmpty({ message }: { message?: string }) {
	return (
		<div className={styles.state}>
			<svg
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			>
				<path d="M3 3v18h18" />
				<path d="M7 14l3-3 3 3 4-5" />
			</svg>
			<span>{message ?? "No data for the current filters"}</span>
		</div>
	);
}

export function VisualNotice({ children }: { children: ReactNode }) {
	return <div className={styles.notice}>{children}</div>;
}
