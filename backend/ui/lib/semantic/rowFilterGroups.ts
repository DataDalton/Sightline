// Finding the groups that decide what rows somebody sees.
//
// The platform caches answers and shares an entry between two people only when
// they provably see the same rows. "Provably" means the policy class is built
// from every group that changes row visibility, which includes the groups the
// row filters branch on and not only the ones the platform's own access rules
// name.
//
// A group missing from that set is not a coarser cache. Two readers restricted
// to different divisions resolve to the same class, and the second is served
// the first's rows without a query running. On-behalf-of protects a query; it
// cannot protect a cache hit, because a cache hit is the absence of a query.
//
// So the groups come from the catalogue rather than from configuration. A
// filter names the groups it branches on, and those names are exactly the ones
// the class has to tell apart, without anybody keeping a list in step with a
// filter somebody else edits.

export interface FilterGroups {
	// Named in is_account_group_member(), which resolves against the account.
	accountGroups: string[];
	// Named in is_member(), which resolves against the workspace. The two are
	// different directories and can disagree for the same person, so which
	// function a filter used has to be carried through to the probe.
	workspaceGroups: string[];
	// True when what the body decides depends on something no group list can
	// capture: the reader's own name, a membership test on a name worked out
	// at query time, or a call to another routine that is not followed. Two
	// readers in the same groups can see different rows under such a body, so
	// no policy class can stand for them and nothing from the source may be
	// shared.
	perReader?: boolean;
}

const empty = (): FilterGroups => ({ accountGroups: [], workspaceGroups: [] });

// Functions that answer with who is asking.
const identityCall = /\b(?:current_user|session_user|user)\s*\(/i;

// A membership test whose argument is not a quoted name.
const computedMembership =
	/\b(?:is_account_group_member|is_member)\s*\(\s*(?!['"])/i;

// A call to a routine named by schema, which may test membership itself. The
// body it runs is not read, so what it decides is unknown.
const qualifiedCall = /\b[A-Za-z_`][\w`]*\s*\.\s*[A-Za-z_`][\w`]*\s*\(/;

// Words that are followed by a bracket in a filter body without being a call,
// and the built in functions a filter body commonly uses. Any other name
// followed by a bracket is a routine in the current schema, whose body is not
// read, so it decides per reader as far as this can tell.
const knownCalls = new Set([
	// Keywords that take a bracketed list or subquery.
	"return",
	"select",
	"in",
	"exists",
	"and",
	"or",
	"not",
	"when",
	"then",
	"else",
	"case",
	"values",
	"over",
	"filter",
	"any",
	"all",
	"some",
	"like",
	"ilike",
	"rlike",
	"between",
	"is",
	"as",
	"on",
	"from",
	"where",
	"struct",
	"array",
	"map",
	"named_struct",
	// Membership and identity, handled by the patterns above.
	"is_member",
	"is_account_group_member",
	"current_user",
	"session_user",
	"user",
	// Built in functions that answer the same for every reader.
	"if",
	"iff",
	"coalesce",
	"nvl",
	"nvl2",
	"ifnull",
	"nullif",
	"isnull",
	"isnotnull",
	"cast",
	"try_cast",
	"lower",
	"upper",
	"lcase",
	"ucase",
	"trim",
	"ltrim",
	"rtrim",
	"concat",
	"concat_ws",
	"substring",
	"substr",
	"left",
	"right",
	"length",
	"split",
	"split_part",
	"replace",
	"regexp_like",
	"regexp_extract",
	"startswith",
	"endswith",
	"contains",
	"instr",
	"array_contains",
	"arrays_overlap",
	"size",
	"element_at",
	"current_date",
	"current_timestamp",
	"now",
	"date_add",
	"date_sub",
	"datediff",
	"year",
	"month",
	"day",
	"to_date",
	"abs",
	"round",
	"greatest",
	"least",
	"hash",
	"sha2",
	"md5",
	"mask",
]);

// Names followed by a bracket, outside quoted text, that are not in the list
// above. A quoted string can hold a bracket and is not a call.
function unknownCall(definition: string): boolean {
	const bare = definition.replace(
		/'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"/g,
		"''",
	);
	const call = /(?<![.\w`])`?([A-Za-z_]\w*)`?\s*\(/g;
	let match: RegExpExecArray | null;
	while ((match = call.exec(bare)) !== null) {
		if (!knownCalls.has(match[1].toLowerCase())) return true;
	}
	return false;
}

// Group names out of a row filter or column mask body.
//
// Text matching rather than parsing: the body is arbitrary SQL and the only
// part that matters is which names are passed to the membership functions.
//
// A name this misses is not a coarser cache. Two readers the missed group
// tells apart resolve to the same class and are served one another's rows, so
// anything this cannot read as a fixed list of names marks the body as
// deciding per reader instead of passing as a body that names nobody.
export function extractFilterGroups(definition: string): FilterGroups {
	if (typeof definition !== "string" || definition === "") return empty();

	const account = new Set<string>();
	const workspace = new Set<string>();

	// A quote inside a name is written twice in SQL, or escaped with a
	// backslash, and both spellings are read as part of the name.
	const pattern =
		/\b(is_account_group_member|is_member)\s*\(\s*(['"])((?:\\.|\2\2|(?!\2).)*)\2/gi;

	let match: RegExpExecArray | null;
	while ((match = pattern.exec(definition)) !== null) {
		const fn = match[1].toLowerCase();
		const quote = match[2];
		const name = match[3]
			.split(quote + quote)
			.join(quote)
			.replace(/\\(['"])/g, "$1")
			.trim();
		if (!name) continue;
		if (fn === "is_member") workspace.add(name);
		else account.add(name);
	}

	const perReader =
		identityCall.test(definition) ||
		computedMembership.test(definition) ||
		qualifiedCall.test(definition) ||
		unknownCall(definition);

	return {
		accountGroups: [...account].sort(),
		workspaceGroups: [...workspace].sort(),
		...(perReader ? { perReader: true } : {}),
	};
}

export function mergeFilterGroups(parts: FilterGroups[]): FilterGroups {
	const account = new Set<string>();
	const workspace = new Set<string>();
	for (const part of parts) {
		for (const g of part.accountGroups) account.add(g);
		for (const g of part.workspaceGroups) workspace.add(g);
	}
	const perReader = parts.some((part) => part.perReader === true);
	return {
		accountGroups: [...account].sort(),
		workspaceGroups: [...workspace].sort(),
		...(perReader ? { perReader: true } : {}),
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
	const pattern = /^\s*(?:-\s+)?source:\s*(['"]?)([A-Za-z0-9_.`-]+)\1\s*$/gm;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(body)) !== null) {
		const name = match[2].replace(/`/g, "").trim();
		// Only a fully qualified name is useful: a bare word is a join alias
		// rather than a table.
		if (name.split(".").length >= 2) tables.add(name);
	}

	return [...tables].sort();
}

// Whether every source a metric view names was read as a full table name.
//
// A source can also be a query, a folded or multi-line value, or a name with
// fewer than three parts, and none of those tell parseMetricViewTables which
// table is behind it. A filter on that table would then go unseen, and "no
// filter found" would read as "no filter there". So a view whose sources were
// not all read is reported as incomplete, and callers treat it as unknown.
export function metricViewSourcesComplete(createStatement: string): boolean {
	const start = createStatement.indexOf("$$");
	const end = createStatement.lastIndexOf("$$");
	const body =
		start >= 0 && end > start
			? createStatement.slice(start + 2, end)
			: createStatement;

	const key = /^\s*(?:-\s+)?source:(.*)$/gm;
	const fullName = /^\s*(['"]?)([A-Za-z0-9_.`-]+)\1\s*$/;
	let match: RegExpExecArray | null;
	while ((match = key.exec(body)) !== null) {
		const value = fullName.exec(match[1]);
		if (!value) return false;
		const parts = value[2].replace(/`/g, "").split(".");
		if (parts.length !== 3 || parts.some((part) => part === "")) {
			return false;
		}
	}
	return true;
}
