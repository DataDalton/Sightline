"use client";

import { refreshBoardList } from "./boardList";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { BoardDefinition } from "../../lib/boards/definition";
import type { Board } from "../../lib/boards/store";

// One board as the page holds it: the stored copy, the draft being arranged,
// and the save that follows each change.
//
// Changes are drawn at once and saved shortly after the last of a burst, so
// dragging a note across the board is one save rather than one per frame.
// Saves go one at a time against the version this page last saw, and one
// refused because somebody else saved first drops the draft and reloads. One
// that failed for a passing reason, such as a lost connection or a busy
// server, keeps the change and is sent again after a growing wait.
// While nothing is waiting to save, the page checks now and then for a newer
// version, so a board two people have open stays the same for both.

const saveDelay = 600;
const retryFirstMs = 2000;
const retryCeilingMs = 30000;
const checkEvery = 10_000;

export interface BoardState {
	board: Board | undefined;
	error: unknown;
	definition: BoardDefinition | null;
	title: string;
	editable: boolean;
	saving: boolean;
	notice: string | null;
	clearNotice: () => void;
	change: (next: BoardDefinition) => void;
	rename: (title: string) => void;
}

export function useBoard(id: string): BoardState {
	const key = `/api/boards/${id}/`;
	const { data, error, mutate } = useSWR<{ board: Board }>(key, {
		revalidateOnFocus: false,
	});
	const board = data?.board;

	const [draft, setDraft] = useState<BoardDefinition | null>(null);
	const [title, setTitle] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const version = useRef(0);
	if (board && board.version > version.current)
		version.current = board.version;
	const pending = useRef<{
		definition?: BoardDefinition;
		title?: string;
	} | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const inFlight = useRef(false);
	// The wait before the next attempt at a save that could not land, zero
	// when the last one did.
	const retryDelay = useRef(0);
	const flushRef = useRef<() => Promise<void>>(async () => {});

	const retryLater = useCallback(() => {
		retryDelay.current = retryDelay.current
			? Math.min(retryDelay.current * 2, retryCeilingMs)
			: retryFirstMs;
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			timer.current = null;
			void flushRef.current();
		}, retryDelay.current);
	}, []);

	const flush = useCallback(async () => {
		if (inFlight.current) return;
		const change = pending.current;
		pending.current = null;
		if (!change) return;
		inFlight.current = true;
		setSaving(true);
		try {
			const response = await fetch(key, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...change,
					baseVersion: version.current,
				}),
			});
			const body = await response.json().catch(() => null);
			const passing =
				response.status === 408 ||
				response.status === 429 ||
				response.status >= 500;
			if (!response.ok && passing) {
				pending.current = { ...change, ...(pending.current ?? {}) };
				setNotice("The change has not saved yet. Trying again.");
				retryLater();
				return;
			}
			if (!response.ok) {
				pending.current = null;
				setDraft(null);
				setTitle(null);
				setNotice(
					body?.error ??
						(response.status === 409
							? "Somebody else changed this board. It has been reloaded."
							: "The change could not be saved."),
				);
				await mutate();
				return;
			}
			version.current = body.board.version;
			await mutate({ board: body.board }, false);
			refreshBoardList();
			if (retryDelay.current) {
				retryDelay.current = 0;
				setNotice(null);
			}
			if (!pending.current) {
				setDraft(null);
				setTitle(null);
			}
		} catch {
			// Never landed. Put back under anything newer so the next save
			// carries both.
			pending.current = { ...change, ...(pending.current ?? {}) };
			setNotice(
				"The change has not saved yet. Check the connection. Trying again.",
			);
			retryLater();
		} finally {
			inFlight.current = false;
			setSaving(false);
			if (pending.current && !timer.current) void flush();
		}
	}, [key, mutate, retryLater]);
	useEffect(() => {
		flushRef.current = flush;
	}, [flush]);

	const schedule = useCallback(
		(change: { definition?: BoardDefinition; title?: string }) => {
			pending.current = { ...(pending.current ?? {}), ...change };
			// A save waiting to be retried keeps its own timing and carries
			// this change with it.
			if (retryDelay.current && timer.current) return;
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				timer.current = null;
				void flush();
			}, saveDelay);
		},
		[flush],
	);

	// A change still waiting when the page closes is sent on the way out.
	useEffect(() => {
		const leave = () => {
			if (!pending.current) return;
			void fetch(key, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...pending.current,
					baseVersion: version.current,
				}),
				keepalive: true,
			})
				.then(refreshBoardList)
				.catch(() => {});
		};
		window.addEventListener("pagehide", leave);
		return () => {
			window.removeEventListener("pagehide", leave);
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
			leave();
			pending.current = null;
		};
	}, [key]);

	// Somebody else's change, taken only when nothing of this person's is
	// waiting, so their own work is never replaced here.
	useEffect(() => {
		const tick = setInterval(() => {
			if (
				document.hidden ||
				pending.current ||
				timer.current ||
				inFlight.current
			)
				return;
			void (async () => {
				try {
					// Answered with no body while the board is unchanged.
					const response = await fetch(
						`${key}?since=${version.current}`,
					);
					if (!response.ok || response.status === 204) return;
					const body = (await response.json()) as { board: Board };
					if (
						body.board.version > version.current &&
						!pending.current &&
						!timer.current
					) {
						await mutate(body, false);
					}
				} catch {
					// Offline for a moment. The next check tries again.
				}
			})();
		}, checkEvery);
		return () => clearInterval(tick);
	}, [key, mutate]);

	const editable =
		board?.permission === "owner" || board?.permission === "edit";

	return {
		board,
		error,
		definition: draft ?? board?.definition ?? null,
		title: title ?? board?.title ?? "",
		editable,
		saving,
		notice,
		clearNotice: () => setNotice(null),
		change: (next) => {
			if (!editable) return;
			setDraft(next);
			schedule({ definition: next });
		},
		rename: (next) => {
			if (!editable) return;
			setTitle(next);
			schedule({ title: next });
		},
	};
}
