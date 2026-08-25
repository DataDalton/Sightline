// Finding the groups that decide what rows somebody sees.
//
// The platform caches answers and shares an entry between two people only when
// they provably see the same rows. "Provably" means the policy class has to be
// built from every group that changes row visibility, and until now that list
// came from the platform's own access rules, which know nothing about the row
// filters Unity Catalog applies underneath.
//
// The consequence was quiet and serious: two readers restricted to different
// divisions resolved to the same class, so the second could be served the
// first's cached rows without a query ever running. On-behalf-of protects a
// query; it cannot protect a cache hit, because a cache hit is the absence of
// a query.
//
// So the groups are discovered from the catalogue rather than configured. A
// filter names the groups it branches on, and those names are exactly the ones
// the class has to distinguish. Nobody has to remember to keep a list in step
// with a filter somebody else edits.

export interface FilterGroups {
	// Named in is_account_group_member(), which resolves against the account.
	accountGroups: string[];
	// Named in is_member(), which resolves against the workspace. The two are
	// different directories and can disagree for the same person, so which
	// function a filter used has to be carried through to the probe.
	workspaceGroups: string[];
}

const empty = (): FilterGroups => ({ accountGroups: [], workspaceGroups: [] });

// Group names out of a row filter or column mask body.
//
// Text matching rather than parsing: the body is arbitrary SQL and the only
// part that matters is which names are passed to the membership functions. A
// name this misses costs cache efficiency, because the class is coarser than
// it needs to be. A name it invents costs nothing either. Neither direction
// makes the class unsafe, which is why a regular expression is enough here and
// would not be if the same text decided access.
export function extractFilterGroups(definition: string): FilterGroups {
	if (typeof definition !== "string" || definition === "") return empty();

	const account = new Set<string>();
	const workspace = new Set<string>();

	const pattern =
		/\b(is_account_group_member|is_member)\s*\(\s*(['"])((?:\\.|(?!\2).)*)\2/gi;

	let match: RegExpExecArray | null;
	while ((match = pattern.exec(definition)) !== null) {
		const fn = match[1].toLowerCase();
		const name = match[3].replace(/\\(['"])/g, "$1").trim();
		if (!name) continue;
		if (fn === "is_member") workspace.add(name);
		else account.add(name);
	}

	return {
		accountGroups: [...account].sort(),
		workspaceGroups: [...workspace].sort(),
	};
}

export function mergeFilterGroups(parts: FilterGroups[]): FilterGroups {
	const account = new Set<string>();
	const workspace = new Set<string>();
	for (const part of parts) {
		for (const g of part.accountGroups) account.add(g);
		for (const g of part.workspaceGroups) workspace.add(g);
	}
	return {
		accountGroups: [...account].sort(),
		workspaceGroups: [...workspace].sort(),
	};
}

// The tables a metric view reads from.
//
// A row filter sits on a base table, not on the view over it, so discovering
// what filters a source is subject to means knowing what it is built on. The
// view definition states its source and its joins, which is where this comes
// from.
export function parseMetricViewTables(createStatement: string): string[] {
	const start = createStatement.indexOf("$$");
	const end = createStatement.lastIndexOf("$$");
	const body =
		start >= 0 && end > start
			? createStatement.slice(start + 2, end)
			: createStatement;

	const tables = new Set<string>();

	// "source: catalog.schema.table" at the top level, and the same key inside
	// each join. Both spellings are the same thing: something this view reads.
	const pattern = /^\s*(?:-\s+)?source:\s*(['"]?)([A-Za-z0-9_.`]+)\1\s*$/gm;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(body)) !== null) {
		const name = match[2].replace(/`/g, "").trim();
		// Only a fully qualified name is useful: a bare word is a join alias
		// rather than a table.
		if (name.split(".").length >= 2) tables.add(name);
	}

	return [...tables].sort();
}
