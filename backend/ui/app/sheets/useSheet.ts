"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
	queryFingerprint,
	type SheetDefinition,
} from "../../lib/sheets/definition";
import type { PivotData, TableData } from "../../lib/sheets/data";
import type { Note, Present, Sheet } from "../../lib/sheets/store";

// One open sheet: what it asks, the rows it shows, the changes being saved,
// and who else has it open.
//
// A change shows at once and is saved a moment after editing pauses, so typing
// a formula or dragging a column does not send a request per keystroke. Steady
// editing with no pause still saves at least every few seconds, so a long run
// of changes is not held only in the page. A save names the
// version it started from. When somebody else saved in between, the server
// refuses it, the sheet reloads with their change, and this person is told,
// rather than one of the two changes vanishing without anybody knowing.

const saveDelayMs = 1000;
// The longest a change waits while editing carries on without a pause.
const saveMaxWaitMs = 5000;
// A save the server could not take for a passing reason is sent again after
// this, doubling each time up to the ceiling.
const retryFirstMs = 2000;
const retryCeilingMs = 30000;
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

interface NotesRead {
	notesVersion: number;
	notes: Note[];
	// Which set of rows held by the page these notes were read for.
	tableId: number;
}

// The notes on the rows a table holds, as they stand now.
async function readNotes(
	url: string,
	table: TableData,
	tableId: number,
): Promise<NotesRead> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ keys: [...new Set(table.keys)] }),
	});
	const body = await response.json().catch(() => null);
	if (!response.ok) throw new Error(body?.error ?? "Could not load notes");
	return { notesVersion: body.notesVersion, notes: body.notes, tableId };
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
	// The newest version this page knows of. A note written here raises it
	// before the sheet is read again, so a render with the older copy keeps
	// the higher number rather than sending a save that conflicts with this
	// person's own note.
	const versionRef = useRef<{ id: string; version: number }>({
		id,
		version: 0,
	});
	if (versionRef.current.id !== id) versionRef.current = { id, version: 0 };
	if (sheet && sheet.id === id && sheet.version > versionRef.current.version)
		versionRef.current.version = sheet.version;
	// The layout this page's edits are made on top of, which a save names as
	// its base. Notes leave it alone, so only another layout save conflicts.
	const layoutRef = useRef<{ id: string; version: number }>({
		id,
		version: 0,
	});
	if (layoutRef.current.id !== id) layoutRef.current = { id, version: 0 };
	if (
		sheet &&
		sheet.id === id &&
		sheet.layoutVersion > layoutRef.current.version
	)
		layoutRef.current.version = sheet.layoutVersion;

	const editable =
		sheet?.permission === "owner" || sheet?.permission === "edit";
	const definition = draft ?? sheet?.definition ?? null;

	// Read again only when what the rows are read from changes. A width, a
	// title, a formula or a note saved by anybody leaves them as they are.
	const dataKey = sheet
		? `/api/sheets/${id}/data?q=${queryFingerprint(sheet.definition)}`
		: null;
	const {
		data: dataResponse,
		error: dataError,
		isLoading: dataLoading,
		mutate: mutateData,
	} = useSWR<{ data: TableData | PivotData; notesVersion: number }>(dataKey, {
		revalidateOnFocus: false,
		keepPreviousData: true,
	});

	// Notes written since the rows were read, by anybody, are read on their
	// own for the rows this page already holds.
	const table =
		dataResponse?.data.mode === "table" ? dataResponse.data : null;
	const loadedNotes = dataResponse?.notesVersion ?? 0;
	const notesVersion = sheet?.notesVersion ?? 0;
	// Each set of rows held is told apart by a number, so notes read for one
	// set are never laid over another.
	const tableIds = useRef(new WeakMap<TableData, number>());
	const nextTableId = useRef(0);
	let tableId = 0;
	if (table) {
		tableId = tableIds.current.get(table) ?? ++nextTableId.current;
		tableIds.current.set(table, tableId);
	}
	const { data: notesResponse } = useSWR<NotesRead>(
		table && notesVersion > loadedNotes
			? [`/api/sheets/${id}/notes`, notesVersion, tableId]
			: null,
		([url]: [string]) => readNotes(url, table!, tableId),
		{ revalidateOnFocus: false, keepPreviousData: true },
	);
	const data = useMemo(() => {
		if (!dataResponse) return undefined;
		if (
			!table ||
			!notesResponse ||
			notesResponse.tableId !== tableId ||
			notesResponse.notesVersion <= loadedNotes
		)
			return dataResponse.data;
		return { ...table, notes: notesResponse.notes };
	}, [dataResponse, table, tableId, notesResponse, loadedNotes]);

	// Whether a save is on its way. A second save sent alongside it would name
	// the same base version and be refused as a conflict with this person's own
	// change, so saves go one at a time.
	const inFlight = useRef(false);
	// When the change now waiting was first scheduled, for the longest wait.
	const waitingSince = useRef<number | null>(null);
	// The wait before the next attempt at a save that could not land, zero
	// when the last one did.
	const retryDelay = useRef(0);
	const flushRef = useRef<(keepalive?: boolean) => Promise<void>>(
		async () => {},
	);

	// Sends what is pending again after a failure that may pass, keeping the
	// change rather than dropping it.
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
						baseVersion: layoutRef.current.version,
					}),
					keepalive,
				});
				const body = await response.json().catch(() => null);
				// A busy or failing server, or a request that timed out, says
				// nothing about the change itself. It is kept and sent again.
				const passing =
					response.status === 408 ||
					response.status === 429 ||
					response.status >= 500;
				if (!response.ok && passing) {
					pending.current = { ...change, ...(pending.current ?? {}) };
					setNotice("The change has not saved yet. Trying again.");
					if (!keepalive) retryLater();
					return;
				}
				if (!response.ok) {
					// Anything made on top of the refused draft goes with it,
					// so it cannot overwrite somebody else's change later. The
					// sheet is read again so the page shows what is saved.
					pending.current = null;
					if (timer.current) {
						clearTimeout(timer.current);
						timer.current = null;
					}
					setDraft(null);
					setNotice(
						body?.error ??
							(response.status === 409
								? "Somebody else changed this sheet. It has been reloaded."
								: "The change could not be saved."),
					);
					await mutateSheet();
					return;
				}
				versionRef.current.version = body.sheet.version;
				layoutRef.current.version = body.sheet.layoutVersion;
				await mutateSheet({ sheet: body.sheet }, false);
				saved = true;
				if (retryDelay.current) {
					retryDelay.current = 0;
					setNotice(null);
				}
				// Kept only if something else was changed while this saved.
				if (!pending.current) setDraft(null);
			} catch {
				// The request never landed. The change goes back under anything
				// newer, so the next save sends both.
				pending.current = { ...change, ...(pending.current ?? {}) };
				setNotice(
					"The change has not saved yet. Check the connection. Trying again.",
				);
				if (!keepalive) retryLater();
			} finally {
				inFlight.current = false;
				setSaving(false);
			}
			// Changes made while this saved go now, on the version it returned,
			// unless a scheduled save is about to send them anyway.
			if (saved && pending.current && !timer.current) void flush();
		},
		[sheetKey, mutateSheet, retryLater],
	);
	useEffect(() => {
		flushRef.current = flush;
	}, [flush]);

	const schedule = useCallback(() => {
		const now = Date.now();
		waitingSince.current ??= now;
		// Past the longest wait, the save already scheduled is left to go
		// rather than pushed back again.
		if (timer.current && now - waitingSince.current >= saveMaxWaitMs)
			return;
		// A save waiting to be retried keeps its own timing.
		if (retryDelay.current && timer.current) return;
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(
			() => {
				timer.current = null;
				waitingSince.current = null;
				void flush();
			},
			Math.min(saveDelayMs, saveMaxWaitMs - (now - waitingSince.current)),
		);
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
			// Cleared as well as cancelled, so a save still in flight sends
			// what is pending once it lands.
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
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
					body.version > versionRef.current.version &&
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
			versionRef.current.version = Math.max(
				versionRef.current.version,
				body.version,
			);
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
		data,
		dataError,
		dataLoading,
		reload: () => void mutateData(),
		present,
		sessionId,
		setCell,
		writeNote,
	};
}
