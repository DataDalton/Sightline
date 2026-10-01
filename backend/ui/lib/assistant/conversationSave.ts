// Works out what of a conversation has to go to the server, so a save sends the
// messages that are new or changed since the last one rather than the whole
// conversation again.
//
// Kept free of browser and database imports so it can be tested. The browser
// keeps one tracker per open conversation and the server stores whatever each
// save carries, one row per message.

// The most one message may hold, in characters of its JSON. Only a guard against
// a single runaway message, never a bound on how long a conversation may grow.
export const maxMessageLength = 2_000_000;

// How much one save request carries before the rest goes in the next request.
// A message larger than this still goes, alone.
export const saveBatchLength = 1_000_000;

// The longest message id the server accepts. The browser makes short ones.
export const maxMessageIdLength = 100;

interface Identified {
	id: string;
}

// What the server was last known to hold for one message. The object itself is
// kept so an unchanged message is recognised without reading it, since messages
// are replaced rather than edited in place. A null fingerprint with a null
// object means the message may or may not be on the server, so it is sent again.
interface Saved {
	ref: object | null;
	fingerprint: string | null;
}

export interface SaveTracker {
	// The title last sent, or null when it is not known to be on the server.
	title: string | null;
	saved: Map<string, Saved>;
}

export interface SaveBatch<T extends Identified> {
	title?: string;
	messages: T[];
	// Ids saved before and no longer in the conversation, such as an answer
	// that was asked again.
	removed: string[];
	// The fingerprint of each message in the batch, recorded once it lands.
	fingerprints: string[];
}

// FNV-1a over the message's JSON, as hex. Cheap, and only computed for a
// message whose object is not the one last saved.
export function fingerprint(value: unknown): string {
	const text = JSON.stringify(value) ?? "";
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${text.length.toString(36)}.${(hash >>> 0).toString(16)}`;
}

export function newTracker(): SaveTracker {
	return { title: null, saved: new Map() };
}

// A tracker for a conversation just read from the server, where every message
// and the title are already stored.
export function trackStored<T extends Identified>(
	title: string,
	messages: T[],
): SaveTracker {
	const tracker: SaveTracker = { title, saved: new Map() };
	for (const m of messages) {
		tracker.saved.set(m.id, { ref: m, fingerprint: null });
	}
	return tracker;
}

// A tracker for a conversation read back from the browser, where whether each
// message reached the server is not known. Each is sent again on the next save,
// and each is still tracked so one that is later replaced is removed.
export function trackUnknown<T extends Identified>(messages: T[]): SaveTracker {
	const tracker: SaveTracker = { title: null, saved: new Map() };
	for (const m of messages) {
		tracker.saved.set(m.id, { ref: null, fingerprint: null });
	}
	return tracker;
}

function storedFingerprint(entry: Saved): string | null {
	if (entry.fingerprint !== null) return entry.fingerprint;
	return entry.ref ? fingerprint(entry.ref) : null;
}

// The requests that bring the server up to date, in order, or an empty list
// when it already is. The title and the removals go with the first. A message
// too large to keep is left out, and is listed in skipped.
export function planSave<T extends Identified>(
	tracker: SaveTracker,
	title: string,
	messages: T[],
): { batches: SaveBatch<T>[]; skipped: string[] } {
	const changed: { message: T; fingerprint: string; length: number }[] = [];
	const skipped: string[] = [];
	const present = new Set<string>();

	for (const m of messages) {
		present.add(m.id);
		const entry = tracker.saved.get(m.id);
		if (entry && entry.ref === m) continue;
		const print = fingerprint(m);
		if (entry && storedFingerprint(entry) === print) continue;
		const length = JSON.stringify(m).length;
		if (length > maxMessageLength) {
			skipped.push(m.id);
			continue;
		}
		changed.push({ message: m, fingerprint: print, length });
	}

	const removed = [...tracker.saved.keys()].filter((id) => !present.has(id));
	const titleChanged = tracker.title !== title;
	if (changed.length === 0 && removed.length === 0 && !titleChanged) {
		return { batches: [], skipped };
	}

	const batches: SaveBatch<T>[] = [];
	let current: SaveBatch<T> = {
		...(titleChanged ? { title } : {}),
		messages: [],
		removed,
		fingerprints: [],
	};
	let used = 0;
	for (const c of changed) {
		if (current.messages.length > 0 && used + c.length > saveBatchLength) {
			batches.push(current);
			current = { messages: [], removed: [], fingerprints: [] };
			used = 0;
		}
		current.messages.push(c.message);
		current.fingerprints.push(c.fingerprint);
		used += c.length;
	}
	batches.push(current);
	return { batches, skipped };
}

// Records a batch the server accepted.
export function commitBatch<T extends Identified>(
	tracker: SaveTracker,
	batch: SaveBatch<T>,
): void {
	if (batch.title !== undefined) tracker.title = batch.title;
	for (const id of batch.removed) tracker.saved.delete(id);
	batch.messages.forEach((m, i) => {
		tracker.saved.set(m.id, { ref: m, fingerprint: batch.fingerprints[i] });
	});
}
