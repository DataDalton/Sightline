// What the assistant should do about a change, worked out from what was said
// about it.
//
// A change arrives two ways. An update names what it is about: a field renamed
// with its old name, a field removed or added, a dataset or page added. The
// daily field sync finds what it can see for itself: fields that arrived,
// fields that went, likely renames with a confidence, and definitions that
// changed. Both become the same actions here, each with a key, so a change told
// both ways is acted on once.
//
// Nothing here checks the catalogue. The runner confirms each action against
// the source's fields before it acts, so an update that names a rename the
// source does not show yet waits rather than breaking reports.
//
// Kept free of database and network imports so it can be tested on its own.

export type UpkeepAction =
	| { kind: "rename"; sourceKey: string; field: string; to: string }
	| { kind: "remove"; sourceKey: string; field: string }
	| { kind: "newField"; sourceKey: string; field: string }
	| { kind: "definition"; sourceKey: string; field: string }
	| { kind: "newSource"; sourceKey: string }
	| { kind: "pageAdded"; pageId: string };

export interface AboutLike {
	kind: string;
	id: string;
	sourceKey?: string;
	change?: string;
	from?: string;
}

export interface SyncFindings {
	sourceKey: string;
	added: string[];
	renames: { from: string; to: string; confidence: number }[];
	redefined: { name: string }[];
}

// How sure the sync must be of a rename it found on its own before the
// assistant follows it without anybody saying so. An identical definition with
// the same type and position reaches it, a similar name alone does not.
export const autoRenameConfidence = 0.8;

export function actionKey(action: UpkeepAction): string {
	switch (action.kind) {
		case "rename":
			return `rename:${action.sourceKey}:${action.field}:${action.to}`;
		case "remove":
		case "newField":
		case "definition":
			return `${action.kind}:${action.sourceKey}:${action.field}`;
		case "newSource":
			return `newSource:${action.sourceKey}`;
		case "pageAdded":
			return `pageAdded:${action.pageId}`;
	}
}

function unique(actions: UpkeepAction[]): UpkeepAction[] {
	const seen = new Set<string>();
	return actions.filter((action) => {
		const key = actionKey(action);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// The actions an update's subject calls for.
export function planFromAbout(about: AboutLike[]): UpkeepAction[] {
	const actions: UpkeepAction[] = [];
	for (const item of about) {
		if (item.kind === "field" && item.sourceKey) {
			const sourceKey = item.sourceKey;
			if (
				item.change === "renamed" &&
				item.from &&
				item.from !== item.id
			) {
				actions.push({
					kind: "rename",
					sourceKey,
					field: item.from,
					to: item.id,
				});
			} else if (item.change === "removed") {
				actions.push({ kind: "remove", sourceKey, field: item.id });
			} else if (item.change === "added") {
				actions.push({ kind: "newField", sourceKey, field: item.id });
			} else if (item.change === "changed") {
				actions.push({ kind: "definition", sourceKey, field: item.id });
			}
		} else if (
			(item.kind === "source" || item.kind === "table") &&
			item.change === "added"
		) {
			actions.push({ kind: "newSource", sourceKey: item.id });
		} else if (item.kind === "page" && item.change === "added") {
			actions.push({ kind: "pageAdded", pageId: item.id });
		}
	}
	return unique(actions);
}

// The actions a sync's findings call for. A field that went missing is not
// removed here: the runner waits a day for it to come back or turn out to be a
// rename first.
export function planFromSync(found: SyncFindings): UpkeepAction[] {
	const { sourceKey } = found;
	const renamedTo = new Set<string>();
	const actions: UpkeepAction[] = [];
	for (const rename of found.renames) {
		if (rename.confidence < autoRenameConfidence) continue;
		renamedTo.add(rename.to);
		actions.push({
			kind: "rename",
			sourceKey,
			field: rename.from,
			to: rename.to,
		});
	}
	for (const field of found.added) {
		// The new name of a rename is not a new field.
		if (renamedTo.has(field)) continue;
		actions.push({ kind: "newField", sourceKey, field });
	}
	for (const { name } of found.redefined) {
		actions.push({ kind: "definition", sourceKey, field: name });
	}
	return unique(actions);
}

// What each kind of action is called in a note or a version label.
export function describeAction(action: UpkeepAction): string {
	switch (action.kind) {
		case "rename":
			return `${action.field} renamed to ${action.to}`;
		case "remove":
			return `${action.field} removed`;
		case "newField":
			return `${action.field} added`;
		case "definition":
			return `${action.field} redefined`;
		case "newSource":
			return "New source";
		case "pageAdded":
			return "New page";
	}
}
