"use client";

import {
	createContext,
	useContext,
	useEffect,
	useId,
	useMemo,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from "react";
import { nearMargin, scrollRootFor } from "../../lib/visuals/lazyLoad";
import { pendingQueries } from "../hooks/queryBatch";
import styles from "./Visual.module.css";

// Loading a visual only once it is about to be seen.
//
// A long report used to ask for every visual's rows and start every chart the
// moment it opened, including the ones a reader never scrolls to. Each frame
// now watches how close it is to the screen, and what it holds is mounted, so
// its query runs and its chart is created, once it is within a screen of being
// visible. After that it stays loaded.
//
// The same watch tells a live visual when it is out of sight, so it stops
// asking for fresh rows nobody is looking at.

export interface VisualVisibility {
	// Has come within a screen of being visible at least once.
	near: boolean;
	// Is within a screen of being visible now.
	onScreen: boolean;
}

const always: VisualVisibility = { near: true, onScreen: true };

// Anything outside a watched frame, such as a filter widget or an editor
// preview, counts as visible and loads straight away.
const VisibilityContext = createContext<VisualVisibility>(always);

export function useVisualVisibility(): VisualVisibility {
	return useContext(VisibilityContext);
}

// --- Loading everything at once ------------------------------------------------

// Set while the whole page has to be drawn, such as for printing. Every frame
// that loads because of it keeps its own record of having loaded, so this is
// let go of once the page has printed and a later page loads lazily again.
let forced = false;
const forcedListeners = new Set<() => void>();
// Frames mounted and still waiting to load.
const deferred = new Set<string>();

function subscribeForced(listener: () => void) {
	forcedListeners.add(listener);
	return () => {
		forcedListeners.delete(listener);
	};
}

function setForced(next: boolean): void {
	if (forced === next) return;
	forced = next;
	for (const listener of forcedListeners) listener();
}

export function loadAllVisuals(): void {
	setForced(true);
}

// How long printing waits for the page before printing what it has, and how
// long a chart takes to finish drawing its entrance once its rows are in.
const printWaitMs = 20000;
const drawSettleMs = 1200;
const pollMs = 100;

const pause = (ms: number) =>
	new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// Loads every visual on the page, waits for their answers and their charts,
// then opens the print dialog.
//
// Queries are counted rather than awaited, because a visual starts its own
// once it mounts and a chart can ask a follow-up question once its first
// answer arrives. The count has to stay at zero across two looks before the
// page counts as loaded.
async function printWhenLoaded(): Promise<void> {
	loadAllVisuals();
	const deadline = Date.now() + printWaitMs;
	let quiet = 0;
	while (quiet < 2 && Date.now() < deadline) {
		await pause(pollMs);
		quiet = pendingQueries() === 0 ? quiet + 1 : 0;
	}
	await pause(drawSettleMs);
	window.print();
}

let printHooked = false;

// The print shortcut is taken over only while something on the page has not
// loaded, so it prints the whole report rather than the part already scrolled
// past. Printing from the browser's menu cannot be delayed, so it loads what
// it can in the moment before the page is laid out for paper.
function hookPrinting(): void {
	if (printHooked || typeof window === "undefined") return;
	printHooked = true;
	window.addEventListener("beforeprint", loadAllVisuals);
	window.addEventListener("afterprint", () => setForced(false));
	window.addEventListener(
		"keydown",
		(event) => {
			if (
				event.key?.toLowerCase() !== "p" ||
				!(event.ctrlKey || event.metaKey) ||
				event.altKey ||
				event.shiftKey ||
				deferred.size === 0
			) {
				return;
			}
			event.preventDefault();
			void printWhenLoaded();
		},
		true,
	);
}

// --- Watching one frame --------------------------------------------------------

// How close the element is to being seen, measured against whatever it
// scrolls inside.
export function useNearScreen(
	element: HTMLElement | null,
	enabled = true,
): VisualVisibility {
	const id = useId();
	const everything = useSyncExternalStore(
		subscribeForced,
		() => forced,
		() => false,
	);
	const [near, setNear] = useState(false);
	const [onScreen, setOnScreen] = useState(false);

	useEffect(() => {
		hookPrinting();
	}, []);

	useEffect(() => {
		if (!enabled || !element) return;
		if (typeof IntersectionObserver === "undefined") {
			setNear(true);
			setOnScreen(true);
			return;
		}
		const rootOf = () =>
			scrollRootFor(
				element,
				(node) => getComputedStyle(node),
				(node) =>
					node === document.body || node === document.documentElement,
			);

		// The root is looked for again whenever the frame reads as out of
		// range. A page whose layout is still being measured has nothing to
		// scroll yet when the frame first mounts, and the scroller it settles
		// into is the one that has to be watched.
		let observer: IntersectionObserver | null = null;
		const watch = (root: HTMLElement | null) => {
			observer?.disconnect();
			observer = new IntersectionObserver(
				(entries) => {
					const latest = entries[entries.length - 1];
					if (!latest) return;
					setOnScreen(latest.isIntersecting);
					if (latest.isIntersecting) {
						setNear(true);
						return;
					}
					const settled = rootOf();
					if (settled !== root) watch(settled);
				},
				{ root, rootMargin: nearMargin },
			);
			observer.observe(element);
		};
		watch(rootOf());
		return () => observer?.disconnect();
	}, [element, enabled]);

	// Loading everything counts as having come near, so the frame stays
	// loaded once that is let go of.
	useEffect(() => {
		if (everything) setNear(true);
	}, [everything]);

	const loaded = !enabled || everything || near;

	// Recorded while waiting so the print shortcut knows there is something
	// left to load.
	useEffect(() => {
		if (loaded) return;
		deferred.add(id);
		return () => {
			deferred.delete(id);
		};
	}, [loaded, id]);

	// One object per change, since it is handed down as a context value and
	// every query under it reads it.
	const visible = onScreen || everything;
	return useMemo(
		() => (enabled ? { near: loaded, onScreen: visible } : always),
		[enabled, loaded, visible],
	);
}

export function VisibilityProvider({
	value,
	children,
}: {
	value: VisualVisibility;
	children: ReactNode;
}) {
	return (
		<VisibilityContext.Provider value={value}>
			{children}
		</VisibilityContext.Provider>
	);
}

// A visual that has no frame of its own, such as a row of figures, loaded the
// same way a framed one is. The placeholder stands in until it is near.
export function LazyBoundary({
	placeholder,
	children,
}: {
	placeholder: ReactNode;
	children: ReactNode;
}) {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const visibility = useNearScreen(element);
	return (
		<div ref={setElement} className={styles.lazyBoundary}>
			<VisibilityProvider value={visibility}>
				{visibility.near ? children : placeholder}
			</VisibilityProvider>
		</div>
	);
}
