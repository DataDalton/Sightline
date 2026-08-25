// Shared row and parameter shapes for both query paths: metadata.ts under the
// service principal, and userSession.ts under the caller own token.

export type Row = Record<string, unknown>;

// Values bound to :name markers in the SQL string. Identifiers (table and
// column names) cannot be bound, so callers keep those allow-listed.
export type QueryParams = Record<string, unknown>;
