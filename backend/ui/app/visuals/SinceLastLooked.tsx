"use client";

import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	type ReactNode,
} from "react";
import useSWR from "swr";
import { lastSeenKey } from "../../lib/query/requestKey";

// Under a headline figure, how it has moved since this person last looked. Read in one small
// batch when the page opens and saved as they leave. See app/api/last-seen.

interface Since {
	before: Record<string, number>;
	seenOn: string | null;
	report: (key: string, value: number) => void;
}

const SinceContext = createContext<Since | null>(null);

// Long enough that opening a page by mistake does not reset what it is compared with.
const lookedLongEnoughMs = 10_000;

export function SinceProvider({
	pageId,
	children,
}: {
	pageId: string | null;
	children: ReactNode;
}) {
	const { data } = useSWR<{
		figures: Record<string, number>;
		seenOn: string | null;
	}>(pageId ? lastSeenKey(pageId) : null, {
		revalidateOnFocus: false,
		revalidateIfStale: false,
	});
	const shown = useRef<Record<string, number>>({});
	const openedAt = useRef(Date.now());

	useEffect(() => {
		if (!pageId) return;
		shown.current = {};
		openedAt.current = Date.now();
		const save = () => {
			if (
				Object.keys(shown.current).length === 0 ||
				Date.now() - openedAt.current < lookedLongEnoughMs
			) {
				return;
			}
			const body = JSON.stringify({ pageId, figures: shown.current });
			navigator.sendBeacon?.(
				"/api/last-seen",
				new Blob([body], { type: "application/json" }),
			);
		};
		const onHide = () => {
			if (document.visibilityState === "hidden") save();
		};
		document.addEventListener("visibilitychange", onHide);
		return () => {
			document.removeEventListener("visibilitychange", onHide);
			save();
		};
	}, [pageId]);

	const value = useMemo<Since>(
		() => ({
			before: data?.figures ?? {},
			seenOn: data?.seenOn ?? null,
			report: (key, figure) => {
				shown.current[key] = figure;
			},
		}),
		[data],
	);
	return (
		<SinceContext.Provider value={value}>{children}</SinceContext.Provider>
	);
}

// Words for the change, or nothing with nothing to compare or no real change. A figure is
// keyed by its filters too, so a different filter is not read as a change.
export function useSinceLastLooked(
	key: string,
	figure: number | null,
): string | null {
	const since = useContext(SinceContext);
	useEffect(() => {
		if (figure !== null && Number.isFinite(figure))
			since?.report(key, figure);
	}, [since, key, figure]);
	const before = since?.before[key];
	if (before === undefined || figure === null || !since?.seenOn) return null;
	if (before === 0) return null;
	const change = ((figure - before) / Math.abs(before)) * 100;
	if (Math.abs(change) < 0.05) return null;
	const day = new Date(since.seenOn).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
	return `${change > 0 ? "+" : ""}${change.toFixed(1)}% since you last looked, ${day}`;
}
