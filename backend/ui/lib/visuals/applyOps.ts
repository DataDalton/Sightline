// Applying another session's edits to a local canvas.
//
// This is what makes co-editing work: every session holds the same list of
// visuals, and every session applies the same ops in the same sequence order,
// so they converge on the same result without anyone coordinating.
//
// The conflict model is last-writer-wins per field, not a CRDT. That is a
// deliberate choice for this shape of editing. A CRDT earns its complexity
// when two people type into the same paragraph and both keystrokes must
// survive. Here the operations are coarse and mostly disjoint: two editors
// usually work on different visuals, and when they do touch the same one, the
// later of "move it here" and "move it there" is the answer anyone would
// expect. Merging two positions into a third nobody chose would be worse.
//
// What last-writer-wins cannot do is preserve a change that was overwritten,
// so the version history keeps every published state and the op log records
// who did what.

export interface VisualLayout {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface AppliedVisual {
	visualId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: Record<string, unknown>;
	layout: VisualLayout;
}

export type RemoteOperation =
	| {
			type: "addVisual";
			visualId?: string;
			pageId: string;
			visualType: string;
			title?: string | null;
			sourceKey?: string | null;
			config?: Record<string, unknown>;
			layout?: VisualLayout;
	  }
	| {
			type: "updateVisual";
			visualId: string;
			title?: string | null;
			visualType?: string;
			sourceKey?: string | null;
			config?: Record<string, unknown>;
			layout?: VisualLayout;
	  }
	| { type: "removeVisual"; visualId: string }
	| { type: "reorderVisuals"; pageId: string; visualIds: string[] }
	| { type: "updateReport"; title?: string; description?: string | null }
	| {
			type: "updatePage";
			pageId: string;
			title?: string;
			config?: Record<string, unknown>;
	  };

export interface ApplyOptions {
	// Visuals the local editor is actively manipulating. A remote change to
	// one of these is skipped rather than applied, because yanking a visual
	// out from under someone mid-drag is worse than being briefly out of date.
	// The next op after the gesture ends brings them back in line.
	protectedIds?: Set<string>;
}

export interface ApplyResult {
	visuals: AppliedVisual[];
	// Ids that were skipped because they were being edited locally, so the UI
	// can tell the author their change and someone else's have diverged.
	deferred: string[];
}

// Layout travels inside config from the editor for convenience, so it is split
// out here the same way the server does.
function splitLayout(
	config: Record<string, unknown> | undefined,
	explicit: VisualLayout | undefined,
): { config: Record<string, unknown>; layout: VisualLayout | null } {
	if (!config) return { config: {}, layout: explicit ?? null };
	const { layout, ...rest } = config as Record<string, unknown> & {
		layout?: VisualLayout;
	};
	return { config: rest, layout: explicit ?? layout ?? null };
}

export function applyOperation(
	visuals: AppliedVisual[],
	operation: RemoteOperation,
	options: ApplyOptions = {},
): ApplyResult {
	const protectedIds = options.protectedIds ?? new Set<string>();
	const deferred: string[] = [];

	switch (operation.type) {
		case "addVisual": {
			const id = operation.visualId;
			// An insert with no id cannot be reproduced, so it is ignored
			// rather than guessed at. The next full reload picks it up.
			if (!id) return { visuals, deferred };
			// Applying the same op twice must not duplicate, since a session
			// can receive an op it already applied after a reconnect.
			if (visuals.some((v) => v.visualId === id)) {
				return { visuals, deferred };
			}

			const { config, layout } = splitLayout(operation.config, operation.layout);
			return {
				visuals: [
					...visuals,
					{
						visualId: id,
						visualType: operation.visualType,
						title: operation.title ?? null,
						sourceKey: operation.sourceKey ?? null,
						config,
						layout: layout ?? { x: 0, y: 0, w: 6, h: 4 },
					},
				],
				deferred,
			};
		}

		case "updateVisual": {
			if (protectedIds.has(operation.visualId)) {
				return { visuals, deferred: [operation.visualId] };
			}

			const { config, layout } = splitLayout(operation.config, operation.layout);
			return {
				visuals: visuals.map((visual) => {
					if (visual.visualId !== operation.visualId) return visual;
					// Only the fields the op carries change, matching the
					// server, so a session that edited one property does not
					// clobber another it never touched.
					return {
						...visual,
						title: operation.title ?? visual.title,
						visualType: operation.visualType ?? visual.visualType,
						sourceKey:
							operation.sourceKey !== undefined
								? operation.sourceKey
								: visual.sourceKey,
						config: operation.config ? config : visual.config,
						layout: layout ?? visual.layout,
					};
				}),
				deferred,
			};
		}

		case "removeVisual": {
			// A removal is applied even to a protected visual: there is
			// nothing left to protect, and leaving a ghost that no longer
			// exists on the server would fail on the next save.
			return {
				visuals: visuals.filter((v) => v.visualId !== operation.visualId),
				deferred,
			};
		}

		case "reorderVisuals": {
			const order = new Map(
				operation.visualIds.map((id, index) => [id, index]),
			);
			return {
				visuals: [...visuals].sort(
					(a, b) =>
						(order.get(a.visualId) ?? Number.MAX_SAFE_INTEGER) -
						(order.get(b.visualId) ?? Number.MAX_SAFE_INTEGER),
				),
				deferred,
			};
		}

		default:
			// Report and page level changes do not affect the visual list. The
			// editing session that made one already holds it, and any other
			// session picks it up on its next load rather than mid-arrangement.
			return { visuals, deferred };
	}
}

export interface RemoteOp {
	seq: number;
	actor: string;
	originId: string | null;
	op: { version: number; operations: RemoteOperation[] };
}

export interface SyncResult {
	visuals: AppliedVisual[];
	// Highest version applied, which becomes the base for the next save. This
	// is the rebase: a session that has applied everything up to version N is
	// no longer stale at N, so its save is accepted.
	version: number;
	seq: number;
	deferred: string[];
	// Actors whose changes landed, for a short notice in the UI.
	actors: string[];
}

// Applies a batch of remote ops in sequence order.
//
// Ops from this session are skipped: they were applied optimistically when the
// author made them, and applying them again would be a no-op at best and would
// undo a subsequent local edit at worst.
export function applyRemoteOps(
	visuals: AppliedVisual[],
	ops: RemoteOp[],
	ownOriginId: string,
	currentVersion: number,
	options: ApplyOptions = {},
): SyncResult {
	let next = visuals;
	let version = currentVersion;
	let seq = 0;
	const deferred = new Set<string>();
	const actors = new Set<string>();

	// Sequence order is what makes every session converge, so it is enforced
	// here rather than trusted from the transport.
	const ordered = [...ops].sort((a, b) => a.seq - b.seq);

	for (const entry of ordered) {
		seq = Math.max(seq, entry.seq);

		if (entry.originId === ownOriginId) {
			// Still advance the version: this session's own change is on the
			// server, so its next save must be based on the version that
			// change produced.
			version = Math.max(version, entry.op.version ?? version);
			continue;
		}

		for (const operation of entry.op.operations ?? []) {
			const result = applyOperation(next, operation, options);
			next = result.visuals;
			for (const id of result.deferred) deferred.add(id);
		}

		version = Math.max(version, entry.op.version ?? version);
		actors.add(entry.actor);
	}

	return {
		visuals: next,
		version,
		seq,
		deferred: Array.from(deferred),
		actors: Array.from(actors),
	};
}
