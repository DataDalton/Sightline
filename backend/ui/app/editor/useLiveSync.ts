"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	applyRemoteOps,
	type AppliedVisual,
	type RemoteOp,
} from "../../lib/visuals/applyOps";

// Live co-editing.
//
// Each session polls for ops it has not seen, applies them in sequence order,
// and advances the version it is based on. That last part is what turns
// optimistic concurrency from a blocker into a rebase: a session that has
// applied everything up to version N is no longer stale at N, so its next save
// is accepted rather than rejected.
//
// Polling rather than a socket, for the same reason the change feed polls: the
// app runs on several replicas with no shared pub/sub, so a socket would only
// carry the changes that happened to land on its own replica. The op sequence
// in Lakebase is shared by all of them.
//
// The interval tightens while someone else is present and relaxes when the
// author is alone, so a solo editor is not making a request every second for
// changes that cannot exist.

export interface PresentUser {
	userEmail: string;
	sessionId: string;
	state: {
		pageId?: string | null;
		visualId?: string | null;
		editing?: boolean;
	};
	isSelf: boolean;
}

interface LiveSyncOptions {
	slug: string;
	pageId: string;
	sessionId: string;
	enabled: boolean;
	// Ids the author is currently manipulating, so a remote change to one is
	// deferred rather than applied mid-gesture.
	protectedIds: () => Set<string>;
	// What this session is looking at, broadcast so others can see it.
	localState: () => { visualId?: string | null };
	onRemoteChange: (
		visuals: AppliedVisual[],
		version: number,
		actors: string[],
	) => void;
	// A restore cannot be replayed as a list of operations: it replaces the
	// page wholesale. Rather than applying a partial version of it and letting
	// this session drift, the session is told to load the report again.
	onReload: (actor: string) => void;
	getVisuals: () => AppliedVisual[];
	getVersion: () => number;
}

const activeIntervalMs = 2000;
const soloIntervalMs = 8000;

export function useLiveSync({
	slug,
	pageId,
	sessionId,
	enabled,
	protectedIds,
	localState,
	onRemoteChange,
	onReload,
	getVisuals,
	getVersion,
}: LiveSyncOptions) {
	const [present, setPresent] = useState<PresentUser[]>([]);
	const [deferred, setDeferred] = useState<string[]>([]);
	const [connected, setConnected] = useState(true);
	const seqRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Callbacks are held in refs so changing them does not restart the poll
	// loop, which would reset the interval on every render.
	const handlers = useRef({
		protectedIds,
		localState,
		onRemoteChange,
		onReload,
		getVisuals,
		getVersion,
	});
	handlers.current = {
		protectedIds,
		localState,
		onRemoteChange,
		onReload,
		getVisuals,
		getVersion,
	};

	const poll = useCallback(async () => {
		try {
			const response = await fetch(
				`/api/report/${encodeURIComponent(slug)}/live`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sessionId,
						afterSeq: seqRef.current,
						state: {
							pageId,
							editing: true,
							...handlers.current.localState(),
						},
					}),
				},
			);

			if (!response.ok) {
				setConnected(false);
				return;
			}
			setConnected(true);

			const data = (await response.json()) as {
				present?: PresentUser[];
				ops?: RemoteOp[];
				seq?: number;
			};

			setPresent(data.present ?? []);

			const ops = data.ops ?? [];
			if (ops.length === 0) {
				seqRef.current = Math.max(seqRef.current, data.seq ?? 0);
				return;
			}

			// A restore among the ops ends the replay: whatever came before it
			// in the same batch is superseded by the snapshot it wrote.
			const restore = ops.find((op) =>
				op.op?.operations?.some(
					(operation) =>
						(operation as { type?: string }).type === "restore",
				),
			);
			if (restore) {
				seqRef.current = Math.max(
					seqRef.current,
					restore.seq,
					data.seq ?? 0,
				);
				handlers.current.onReload(restore.actor);
				return;
			}

			const result = applyRemoteOps(
				handlers.current.getVisuals(),
				ops,
				sessionId,
				handlers.current.getVersion(),
				{ protectedIds: handlers.current.protectedIds() },
			);

			seqRef.current = Math.max(
				seqRef.current,
				result.seq,
				data.seq ?? 0,
			);
			setDeferred(result.deferred);

			// Reported even when only this session's own ops came back, because
			// the version still moved and the editor has to know.
			handlers.current.onRemoteChange(
				result.visuals,
				result.version,
				result.actors,
			);
		} catch {
			setConnected(false);
		}
	}, [slug, pageId, sessionId]);

	// Read through refs by the loop below, so a change of page or of who is
	// present adjusts the next poll without tearing the loop down. Tearing it
	// down sends a leave, and other editors would see this one drop out and
	// come back.
	const pollRef = useRef(poll);
	pollRef.current = poll;
	const presentRef = useRef(present);
	presentRef.current = present;

	useEffect(() => {
		if (!enabled) return;

		let cancelled = false;

		const schedule = () => {
			if (cancelled) return;
			// Someone else in the report means changes can arrive, so the poll
			// tightens. Alone, nothing can change underneath and a slower
			// interval costs nothing.
			const others = presentRef.current.filter((p) => !p.isSelf).length;
			const interval = others > 0 ? activeIntervalMs : soloIntervalMs;
			timerRef.current = setTimeout(async () => {
				// A hidden tab skips the poll and keeps the schedule, so it
				// catches up on the first tick after it is shown again.
				if (document.visibilityState === "visible") {
					await pollRef.current();
				}
				schedule();
			}, interval);
		};

		void pollRef.current().then(schedule);

		// Leaving deliberately removes the presence row rather than waiting
		// out the lease, so other editors see the departure promptly.
		// keepalive lets it survive the page unloading.
		const leave = () =>
			void fetch(`/api/report/${encodeURIComponent(slug)}/live`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId, leaving: true }),
				keepalive: true,
			}).catch(() => {});

		// A reload or a closed tab never unmounts anything, so the cleanup
		// below does not run for either. Without this the old session stayed
		// listed until its lease ran out, beside the new one the reload
		// started, and one person showed as several. A page restored from the
		// back-forward cache heartbeats again on its next poll.
		window.addEventListener("pagehide", leave);

		return () => {
			cancelled = true;
			if (timerRef.current) clearTimeout(timerRef.current);
			window.removeEventListener("pagehide", leave);
			leave();
		};
	}, [enabled, slug, sessionId]);

	// Moving to another page announces it straight away rather than on the
	// next tick. The loop above has already polled for the first page.
	const announcedPageRef = useRef(pageId);
	useEffect(() => {
		if (!enabled || announcedPageRef.current === pageId) return;
		announcedPageRef.current = pageId;
		void poll();
	}, [enabled, pageId, poll]);

	// A save has just landed, so the next poll should not replay this
	// session's own ops as if they were remote.
	const acknowledge = useCallback((seq: number) => {
		seqRef.current = Math.max(seqRef.current, seq);
	}, []);

	return {
		present,
		others: present.filter((p) => !p.isSelf),
		deferred,
		connected,
		acknowledge,
		refresh: poll,
	};
}
