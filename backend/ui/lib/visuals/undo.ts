// What putting the canvas back to an earlier state means for the save.
//
// The editor batches edits as an operation list rather than writing each one,
// so undo cannot just restore the visuals on screen: the pending operations
// have to end up describing the state that is now showing, or the next save
// writes the change that was just undone.
//
// Which operation each visual needs depends on whether it exists on the server
// yet, which is what the unsaved flag records. Undoing the creation of a visual
// is not a delete, it is the cancellation of an insert that never happened; and
// putting back one that the server still holds is not an insert, it is the
// cancellation of a delete. Getting those two backwards writes a duplicate row
// or leaves a deletion that cannot be undone.

export interface UndoableVisual {
	visualId: string;
	// Created in this session and not yet written. The server has never seen
	// it, so there is nothing there to update or to put back.
	isNew?: boolean;
}

export type RestoreOp =
	| { kind: "add"; visualId: string }
	| { kind: "update"; visualId: string }
	| { kind: "remove"; visualId: string }
	// The pending operation for this visual is dropped, leaving the server's
	// copy exactly as it is.
	| { kind: "cancel"; visualId: string };

export function opsForRestore(
	current: UndoableVisual[],
	target: UndoableVisual[],
): RestoreOp[] {
	const now = new Map(current.map((v) => [v.visualId, v]));
	const then = new Map(target.map((v) => [v.visualId, v]));
	const ops: RestoreOp[] = [];

	// On screen now, gone in the state being restored.
	for (const visual of current) {
		if (then.has(visual.visualId)) continue;
		ops.push(
			visual.isNew
				? // Created and then undone. The insert is dropped rather than
					// a delete being sent for a row that was never written.
					{ kind: "cancel", visualId: visual.visualId }
				: { kind: "remove", visualId: visual.visualId },
		);
	}

	// In the state being restored, not on screen now.
	for (const visual of target) {
		if (now.has(visual.visualId)) continue;
		ops.push(
			visual.isNew
				? // It only ever existed here, so it has to be inserted again.
					{ kind: "add", visualId: visual.visualId }
				: // The server still holds it: the pending delete is dropped.
					{ kind: "cancel", visualId: visual.visualId },
		);
	}

	// In both. An update carries the whole definition, so sending one for a
	// visual that happens to be unchanged writes the same values it already
	// holds and costs nothing to be wrong about.
	for (const visual of target) {
		if (now.has(visual.visualId)) {
			ops.push({ kind: "update", visualId: visual.visualId });
		}
	}

	return ops;
}
