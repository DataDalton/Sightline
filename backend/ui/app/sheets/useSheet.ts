"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { SheetDefinition } from "../../lib/sheets/definition";
import type { PivotData, TableData } from "../../lib/sheets/data";
import type { Present, Sheet } from "../../lib/sheets/store";

// One open sheet: what it asks, the rows it shows, the changes being saved,
// and who else has it open.
//
// A change shows at once and is saved a moment later, so typing a formula or
// dragging a column does not send a request per keystroke. A save names the
// version it started from. When somebody else saved in between, the server
// refuses it, the sheet reloads with their change, and this person is told,
// rather than one of the two changes vanishing without anybody knowing.

const saveDelayMs = 700;
const pollMs = 4000;

export interface SheetState {
	sheet: Sheet | undefined;
	error: unknown;
	// What is shown: the saved definition with any unsaved change on top.
	definition: SheetDefinition | null;
	editable: boolean;
	change: (fn: (def: SheetDefinition) => SheetDefinition) => void;
	rename: (title: string) => void;
	saving: boolean;
	notice: string | null;
	clearNotice: () => void;

	data: TableData | PivotData | undefined;
	dataError: unknown;
	dataLoading: boolean;
	reload: () => void;

	present: Present[];
	sessionId: string;
	setCell: (cell: { row: string; column: string } | null) => void;
	writeNote: (
		rowKey: string,
		noteId: string,
		value: string,
	) => Promise<string | null>;
}

function newSessionId(): string {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useSheet(id: string): SheetState {
	const sheetKey = `/api/sheets/${id}`;
	const {
		data: sheetResponse,
		error,
		mutate: mutateSheet,
	} = useSWR<{ sheet: Sheet }>(sheetKey, {
		revalidateOnFocus: false,
	});
	const sheet = sheetResponse?.sheet;

	const [draft, setDraft] = useState<SheetDefinition | null>(null);
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const pending = useRef<{
		definition?: SheetDefinition;
		title?: string;
	} | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const versionRef = useRef<number>(0);
	versionRef.current = sheet?.version ?? versionRef.current;

	const editable =
		sheet?.permission === "owner" || sheet?.permission === "edit";
	const definition = draft ?? sheet?.definition ?? null;

	const dataKey = sheet ? `/api/sheets/${id}/data?v=${sheet.version}` : null;
	const {
		data: dataResponse,
		error: dataError,
		isLoading: dataLoading,
		mutate: mutateData,
	} = useSWR<{ data: TableData | PivotData }>(dataKey, {
		revalidateOnFocus: false,
		keepPreviousData: true,
	});

	// Whether a save is on its way. A second save sent alongside it would name
	// the same base version and be refused as a conflict with this person's own
	// change, so saves go one at a time.
	const inFlight = useRef(false);

	// keepalive lets the request outlive the page when it is sent on unload.
	const flush = useCallback(
		async (keepalive = false) => {
			// The save in flight sends whatever arrived meanwhile once it lands.
			if (inFlight.current) return;
			const change = pending.current;
			pending.current = null;
			if (!change) return;
			inFlight.current = true;
			setSaving(true);
			let saved = false;
			try {
				const response = await fetch(sheetKey, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						...change,
						baseVersion: versionRef.current,
					}),
					keepalive,
				});
				const body = await response.json().catch(() => null);
				if (response.status === 409) {
					// Anything made on top of the discarded draft goes with it,
					// so it cannot overwrite the other person's change later.
					pending.current = null;
					if (timer.current) {
						clearTimeout(timer.current);
						timer.current = null;
					}
					setDraft(null);
					setNotice(
						body?.error ??
							"Somebody else changed this sheet. It has been reloaded.",
					);
					await mutateSheet();
					return;
				}
				if (!response.ok) {
					setNotice(body?.error ?? "The change could not be saved.");
					return;
				}
				versionRef.current = body.sheet.version;
				await mutateSheet({ sheet: body.sheet }, false);
				saved = true;
				// Kept only if something else was changed while this saved.
				if (!pending.current) setDraft(null);
			} catch {
				// The request never landed. The change goes back under anything
				// newer, so the next save sends both.
				pending.current = { ...change, ...(pending.current ?? {}) };
				setNotice(
					"The change could not be saved. Check the connection and edit again to retry.",
				);
			} finally {
				inFlight.current = false;
				setSaving(false);
			}
			// Changes made while this saved go now, on the version it returned,
			// unless a scheduled save is about to send them anyway.
			if (saved && pending.current && !timer.current) void flush();
		},
		[sheetKey, mutateSheet],
	);

	const schedule = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			timer.current = null;
			void flush();
		}, saveDelayMs);
	}, [flush]);

	const change = useCallback(
		(fn: (def: SheetDefinition) => SheetDefinition) => {
			if (!editable) return;
			setDraft((current) => {
				const base = current ?? sheet?.definition;
				if (!base) return current;
				const next = fn(base);
				pending.current = { ...pending.current, definition: next };
				return next;
			});
			schedule();
		},
		[editable, sheet?.definition, schedule],
	);

	const rename = useCallback(
		(title: string) => {
			if (!editable) return;
			pending.current = { ...pending.current, title };
			schedule();
		},
		[editable, schedule],
	);

	// A change still waiting when the page closes is sent on the way out.
	useEffect(() => {
		const onHide = () => {
			if (pending.current) void flush(true);
		};
		window.addEventListener("pagehide", onHide);
		return () => {
			window.removeEventListener("pagehide", onHide);
			if (timer.current) clearTimeout(timer.current);
			if (pending.current) void flush();
		};
	}, [flush]);

	// --- Who else is here ------------------------------------------------------

	const [sessionId] = useState(newSessionId);
	const [present, setPresent] = useState<Present[]>([]);
	const cellRef = useRef<{ row: string; column: string } | null>(null);
	const setCell = useCallback(
		(cell: { row: string; column: string } | null) => {
			cellRef.current = cell;
		},
		[],
	);

	useEffect(() => {
		if (!sheet) return;
		let stopped = false;
		const beat = async () => {
			if (document.visibilityState !== "visible") return;
			try {
				const response = await fetch(`/api/sheets/${id}/live`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId, cell: cellRef.current }),
				});
				if (!response.ok || stopped) return;
				const body = (await response.json()) as {
					version: number;
					present: Present[];
				};
				setPresent(body.present);
				// Somebody else saved. Taken when nothing of this person's is
				// waiting to go, so their own change is never overwritten here.
				if (
					body.version > versionRef.current &&
					!pending.current &&
					!timer.current
				) {
					void mutateSheet();
				}
			} catch {
				// Offline for a moment. The next beat tries again.
			}
		};
		void beat();
		const interval = setInterval(beat, pollMs);
		const leave = () =>
			void fetch(`/api/sheets/${id}/live`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId }),
				keepalive: true,
			}).catch(() => {});
		// A reload or a closed tab never unmounts anything, so the cleanup
		// below does not run for either, and the old session would stay
		// listed beside the new one until its lease ran out.
		window.addEventListener("pagehide", leave);
		return () => {
			stopped = true;
			clearInterval(interval);
			window.removeEventListener("pagehide", leave);
			leave();
		};
		// Started once per sheet. The version is read through a ref.
	}, [id, Boolean(sheet), sessionId, mutateSheet]);

	const writeNote = useCallback(
		async (rowKey: string, noteId: string, value: string) => {
			const response = await fetch(`/api/sheets/${id}/notes`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rowKey, noteId, value }),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok)
				return body?.error ?? "The note could not be saved.";
			versionRef.current = body.version;
			void mutateSheet();
			return null;
		},
		[id, mutateSheet],
	);

	return {
		sheet,
		error,
		definition,
		editable,
		change,
		rename,
		saving,
		notice,
		clearNotice: () => setNotice(null),
		data: dataResponse?.data,
		dataError,
		dataLoading,
		reload: () => void mutateData(),
		present,
		sessionId,
		setCell,
		writeNote,
	};
}
