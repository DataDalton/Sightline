import { createHash } from "node:crypto";
import { maxSplits, type WatchItem } from "./watch";

// Who a stored card may be handed to, and the key it is stored under.
//
// A card is built from the same answers a report reads, so it may be shared
// exactly as far as those answers are:
//
//   - a dataset no catalogue filter or mask applies to answers everyone the
//     same, so its card is held once for everybody who can read the dataset
//   - a filtered one answers everyone in a policy class the same, so its card
//     is held per class
//   - a filtered one whose filters have not been read yet is not known to
//     answer anyone else the same, so its card is held for the one reader
//     and their current class
//
// The reader's grant on the dataset is checked before any card is handed
// over, whichever of these it is.

export function cardScope(
	protection: { shareable: boolean; filtered: boolean },
	policyId: string,
	email: string,
): string {
	if (!protection.shareable)
		return `person:${email.toLowerCase()}:${policyId}`;
	return protection.filtered ? policyId : "unfiltered";
}

// The figure, without the report it was found on. Two reports showing the
// same measure over the same date field read the same card.
export function cardDigest(item: WatchItem): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				item.sourceKey,
				item.measure,
				item.timeField,
				item.splitBy.slice(0, maxSplits),
			]),
		)
		.digest("hex")
		.slice(0, 32);
}

// The scope is a literal prefix rather than part of the hashed input, as in
// the result cache, so no digest collision can cross from one scope to
// another.
export function cardKey(scope: string, item: WatchItem): string {
	return `${scope}:${cardDigest(item)}`;
}
