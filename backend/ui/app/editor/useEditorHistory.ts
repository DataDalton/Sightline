"use client";

import { useCallback, useRef, useState } from "react";

// Undo and redo for the canvas.
//
// Snapshots rather than inverse operations. An inverse-operation history has to
// know how to undo every kind of edit, and every new edit is a new chance to
// get one of them wrong; a snapshot is correct for edits nobody has written
// yet. A page is a few dozen small objects, so the copies are cheap.
//
// A snapshot is taken before an edit rather than after it, so the first undo
// goes back to the state the author could see when they decided to act.
//
// The stack is cleared on save. Everything in it describes unsaved work, and
// the operations an undo produces are only valid against the version the
// editor loaded: once a save has moved that version, putting back a visual the
// server has since deleted would insert a row rather than restore one. Undo
// covering unsaved work is a promise that can be kept.

// How many steps back an author can go. Deep enough to cover a session of
// arranging, bounded so a long one does not hold every intermediate state of
// the page in memory.
const limit = 60;

// How long a run of edits to the same thing keeps counting as one step. Long
// enough to cover typing, short enough that coming back to a field after a
// pause is a step of its own.
const coalesceWindow = 600;

export interface HistoryState<T> {
	record: (present: T, coalesceKey?: string) => void;
	undo: (present: T) => T | null;
	redo: (present: T) => T | null;
	clear: () => void;
	canUndo: boolean;
	canRedo: boolean;
}

export function useEditorHistory<T>(): HistoryState<T> {
	const past = useRef<T[]>([]);
	const future = useRef<T[]>([]);
	// What the last snapshot was taken for, and when, so a run of edits to one
	// field collapses into the single step back that it is.
	const lastKey = useRef<string | undefined>(undefined);
	const lastAt = useRef(0);
	// Mirrors the two stacks for the toolbar, which has to re-render when they
	// change. The refs are what the callbacks read, so a record during a
	// gesture does not depend on a render having happened.
	const [depth, setDepth] = useState({ past: 0, future: 0 });

	const sync = useCallback(() => {
		setDepth({ past: past.current.length, future: future.current.length });
	}, []);

	const record = useCallback(
		(present: T, coalesceKey?: string) => {
			// A run of edits to the same thing is one step back, not thirty.
			//
			// Typing a title calls the same mutator per keystroke, and a
			// snapshot each time would fill the stack with single characters
			// and push out the arranging an author actually wants to undo.
			// Since a snapshot is taken before the edit, keeping only the
			// first of a run means undo returns to before the run started,
			// which is what "undo the rename" means.
			const now = Date.now();
			if (
				coalesceKey !== undefined &&
				coalesceKey === lastKey.current &&
				now - lastAt.current < coalesceWindow &&
				past.current.length > 0
			) {
				lastAt.current = now;
				return;
			}
			lastKey.current = coalesceKey;
			lastAt.current = now;

			past.current = [...past.current.slice(-(limit - 1)), present];
			// A new edit after an undo is a new branch, and the states that
			// were ahead can no longer be reached from it.
			future.current = [];
			sync();
		},
		[sync],
	);

	const undo = useCallback(
		(present: T): T | null => {
			const previous = past.current[past.current.length - 1];
			if (previous === undefined) return null;
			past.current = past.current.slice(0, -1);
			future.current = [...future.current, present];
			sync();
			return previous;
		},
		[sync],
	);

	const redo = useCallback(
		(present: T): T | null => {
			const next = future.current[future.current.length - 1];
			if (next === undefined) return null;
			future.current = future.current.slice(0, -1);
			past.current = [...past.current, present];
			sync();
			return next;
		},
		[sync],
	);

	const clear = useCallback(() => {
		past.current = [];
		future.current = [];
		lastKey.current = undefined;
		sync();
	}, [sync]);

	return {
		record,
		undo,
		redo,
		clear,
		canUndo: depth.past > 0,
		canRedo: depth.future > 0,
	};
}

// Whether a keystroke belongs to whatever the author is typing into.
//
// The panel is full of text fields and a selected text panel is a live editable
// region, so the editor's own shortcuts have to stay out of the way: copying a
// word out of a title must not copy the visual, and undoing a typo must not
// undo the last thing that was dragged.
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
