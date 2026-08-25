// A hostname with any scheme, port or path removed.
//
// The Databricks console presents a workspace and a database instance as URLs,
// and both are commonly stored that way. A Postgres driver resolves whatever
// string it is handed as a hostname, and the SQL driver expects the same, so a
// value carrying https:// or a trailing slash turns into a DNS lookup for a
// name that cannot exist. The resulting error names a network fault, which
// sends whoever reads it looking in the wrong place.
//
// The port is dropped rather than honoured, because it travels in PGPORT and a
// host string is not where the connection reads it from.
export function bareHostname(value: string): string {
	return value
		.trim()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/[/?#].*$/, "")
		.replace(/:\d+$/, "");
}
