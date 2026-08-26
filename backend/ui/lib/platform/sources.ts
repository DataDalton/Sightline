import type { Identity } from "../auth/identity";
import { readableSources, catalogAccessEnabled } from "../auth/sourceAccess";
import { isDatabricksApp } from "../runtime";
import { listSources } from "../semantic/registry";
import type { SemanticField } from "../semantic/types";

// The sources a caller may build on.
//
// Reachability comes from the catalogue: a SELECT grant on the data is the
// statement that somebody may read it. A source registered for one report is
// therefore available to anyone who could already have read it, which is the
// same set of people and the same rows.

// Which sources to filter by, or null for no filtering at all.
//
// The same three cases executeQuery runs under, in the same order, because
// offering a source is a promise that querying it will work. A rule of its own
// here would either offer sources that answer with an error or hide ones the
// reader can read.
//
//   a forwarded token   ask the catalogue under it
//   local development   no filtering: the query runs as the developer's own
//                       credentials, and those decide at query time
//   deployed, no token  nothing, because no query could run either
async function reachableSet(identity: Identity): Promise<Set<string> | null> {
	if (identity.userToken) {
		return catalogAccessEnabled() ? await readableSources(identity) : null;
	}
	if (!isDatabricksApp) return null;
	return new Set();
}

function fieldOf(f: SemanticField) {
	return {
		name: f.name,
		displayName: f.displayName,
		dataType: f.dataType,
		formatHint: f.formatHint,
		description: f.description,
		tags: f.tags,
	};
}

// Sources this caller may query, with the field metadata a picker needs.
export async function readableSourceList(identity: Identity) {
	const all = listSources();
	const reachable = await reachableSet(identity);

	return all
		.filter((s) => !reachable || reachable.has(s.sourceKey))
		.map((s) => ({
			sourceKey: s.sourceKey,
			title: s.title,
			description: s.description,
			kind: s.kind,
			defaultTimeField: s.defaultTimeField,
			dimensions: s.dimensions.map(fieldOf),
			measures: s.measures.map(fieldOf),
		}));
}
