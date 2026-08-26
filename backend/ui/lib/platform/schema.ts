import { sql } from "../data/lakebase";

// Transactional schema, in Lakebase Postgres.
//
// Everything the app writes at request latency lives here: the semantic layer,
// reports and their visuals, per-user saved views, access policy, presence and
// the collaboration op log. Delta is an analytical store with file-per-commit
// writes and no point updates, so none of this belongs there. Usage telemetry
// does, and is defined separately in telemetry.ts.
//
// Nothing here is a file in source control. Reports take concurrent edits from
// many people and saved views are per-user, neither of which a repo can model.
// The planning documents are imported once as seed content and then owned by
// the database.

const statements: string[] = [
	// --- Semantic layer ----------------------------------------------------

	// One row per queryable source view.
	`CREATE TABLE IF NOT EXISTS data_sources (
		source_key        TEXT PRIMARY KEY,
		title             TEXT NOT NULL,
		description       TEXT,
		catalog_name      TEXT NOT NULL,
		schema_name       TEXT NOT NULL,
		object_name       TEXT NOT NULL,
		-- 'metric_view' owns its aggregation and is read with MEASURE(), so
		-- the app never restates a measure expression. 'table' has no semantic
		-- layer, so each field carries its own expression.
		kind              TEXT NOT NULL DEFAULT 'table'
			CHECK (kind IN ('metric_view', 'table')),
		-- 'direct' queries the warehouse per request under the caller token.
		-- 'cached' may serve from the result cache under a policy class.
		access_mode       TEXT NOT NULL DEFAULT 'direct',
		-- True when Unity Catalog applies a row filter or column mask. Drives
		-- the cache key, so it is enforced rather than informational: a
		-- filtered source is never cached without its policy class.
		has_row_filter    BOOLEAN NOT NULL DEFAULT FALSE,
		cache_ttl_seconds INTEGER NOT NULL DEFAULT 300,
		default_time_field TEXT,
		is_active         BOOLEAN NOT NULL DEFAULT TRUE,
		created_by        TEXT,
		created_on        TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_by       TEXT,
		modified_on       TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	// Dimensions and measures as SQL fragments against their source. The query
	// builder composes these; a client only ever sends field keys, never SQL.
	`CREATE TABLE IF NOT EXISTS source_fields (
		field_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		source_key   TEXT NOT NULL REFERENCES data_sources(source_key) ON DELETE CASCADE,
		-- The key a report and a query refer to. For a metric view this is the
		-- curated name the view publishes; for a plain table it is the raw
		-- column name, because that is what a report authored against the
		-- table refers to.
		field_name   TEXT NOT NULL,
		-- Human-readable label, where the key is not already one. Presentation
		-- only: nothing resolves a field by this.
		display_name TEXT,
		field_kind   TEXT NOT NULL CHECK (field_kind IN ('dimension', 'measure')),
		-- Admin-authored expression, never client-supplied. Null for a metric
		-- view field: the view resolves it, and restating it here would let
		-- the app drift from the view definition.
		sql_expr     TEXT,
		data_type    TEXT,
		description  TEXT,
		format_hint  TEXT,
		-- Unity Catalog column tags, refreshed from information_schema. Shown
		-- in tooltips so a reader sees how the source itself classifies a
		-- field rather than only what the app was told.
		tags         JSONB NOT NULL DEFAULT '{}'::jsonb,
		folder       TEXT,
		sort_order   INTEGER NOT NULL DEFAULT 0,
		is_default   BOOLEAN NOT NULL DEFAULT FALSE,
		is_active    BOOLEAN NOT NULL DEFAULT TRUE,
		created_by   TEXT,
		created_on   TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_by  TEXT,
		modified_on  TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (source_key, field_name)
	)`,

	// --- Navigation and reports --------------------------------------------

	`CREATE TABLE IF NOT EXISTS categories (
		category_id TEXT PRIMARY KEY,
		name        TEXT NOT NULL,
		description TEXT,
		icon        TEXT,
		sort_order  INTEGER NOT NULL DEFAULT 0,
		is_active   BOOLEAN NOT NULL DEFAULT TRUE
	)`,

	`CREATE TABLE IF NOT EXISTS reports (
		report_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		category_id TEXT REFERENCES categories(category_id),
		slug        TEXT NOT NULL UNIQUE,
		title       TEXT NOT NULL,
		description TEXT,
		source_key  TEXT REFERENCES data_sources(source_key),
		owner_email TEXT NOT NULL,
		visibility  TEXT NOT NULL DEFAULT 'private'
			CHECK (visibility IN ('private', 'shared', 'published')),
		-- Bumped on every save. A save carrying a stale version is rejected,
		-- so two editors cannot silently overwrite each other.
		version     BIGINT NOT NULL DEFAULT 1,
		is_active   BOOLEAN NOT NULL DEFAULT TRUE,
		created_by  TEXT,
		created_on  TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_by TEXT,
		modified_on TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE TABLE IF NOT EXISTS report_pages (
		page_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		report_id  UUID NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
		slug       TEXT NOT NULL,
		title      TEXT NOT NULL,
		template   TEXT,
		source_key TEXT REFERENCES data_sources(source_key),
		-- Page-level settings that are not a visual. Holds the freshness
		-- stamp's field today; a JSONB column so the next one needs no
		-- migration.
		config     JSONB NOT NULL DEFAULT '{}'::jsonb,
		sort_order INTEGER NOT NULL DEFAULT 0,
		is_active  BOOLEAN NOT NULL DEFAULT TRUE,
		UNIQUE (report_id, slug)
	)`,

	// Encoding and display options live in config so a new visual type needs
	// no migration.
	`CREATE TABLE IF NOT EXISTS report_visuals (
		visual_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		page_id     UUID NOT NULL REFERENCES report_pages(page_id) ON DELETE CASCADE,
		visual_type TEXT NOT NULL,
		title       TEXT,
		source_key  TEXT REFERENCES data_sources(source_key),
		-- { dimensions, measures, filters, sort, options }
		config      JSONB NOT NULL DEFAULT '{}'::jsonb,
		layout_x    INTEGER NOT NULL DEFAULT 0,
		layout_y    INTEGER NOT NULL DEFAULT 0,
		layout_w    INTEGER NOT NULL DEFAULT 6,
		layout_h    INTEGER NOT NULL DEFAULT 4,
		sort_order  INTEGER NOT NULL DEFAULT 0,
		is_active   BOOLEAN NOT NULL DEFAULT TRUE
	)`,

	// Full snapshot per save, so any version restores and an edit history
	// reconstructs. Append-only.
	`CREATE TABLE IF NOT EXISTS report_versions (
		version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		report_id  UUID NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
		version    BIGINT NOT NULL,
		label      TEXT,
		snapshot   JSONB NOT NULL,
		created_by TEXT,
		created_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (report_id, version)
	)`,

	// --- Collaboration -----------------------------------------------------

	// Append-only edit log. This is the delivery guarantee for live editing.
	//
	// Lakebase scales to zero and closes idle connections, which destroys
	// LISTEN registrations, so a NOTIFY can be missed. The monotonic seq makes
	// that harmless: a replica resyncs by reading everything after its last
	// seen value, and a dropped notification costs latency rather than
	// correctness.
	`CREATE TABLE IF NOT EXISTS report_ops (
		seq        BIGSERIAL PRIMARY KEY,
		report_id  UUID NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
		actor      TEXT NOT NULL,
		-- Client-generated, so an editor can recognise and skip its own ops.
		origin_id  TEXT,
		op         JSONB NOT NULL,
		created_on TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS report_ops_report_seq_idx
		ON report_ops (report_id, seq)`,

	// Who is currently in a report. Rows carry an expiry rather than relying
	// on a disconnect signal, because a replica can die without sending one.
	`CREATE TABLE IF NOT EXISTS presence (
		presence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		report_id   UUID NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
		user_email  TEXT NOT NULL,
		session_id  TEXT NOT NULL,
		-- Cursor position, selected visual, editing state.
		state       JSONB NOT NULL DEFAULT '{}'::jsonb,
		heartbeat_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		expires_on  TIMESTAMPTZ NOT NULL,
		UNIQUE (report_id, session_id)
	)`,

	`CREATE INDEX IF NOT EXISTS presence_expiry_idx ON presence (expires_on)`,

	// --- Personalization ---------------------------------------------------

	// A user's own take on a page: filters, columns, sort, layout. Never
	// mutates the underlying report.
	`CREATE TABLE IF NOT EXISTS saved_views (
		view_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		owner_email TEXT NOT NULL,
		report_id   UUID REFERENCES reports(report_id) ON DELETE CASCADE,
		page_id     UUID REFERENCES report_pages(page_id) ON DELETE CASCADE,
		name        TEXT NOT NULL,
		config      JSONB NOT NULL DEFAULT '{}'::jsonb,
		is_default  BOOLEAN NOT NULL DEFAULT FALSE,
		is_shared   BOOLEAN NOT NULL DEFAULT FALSE,
		shared_with TEXT[],
		created_on  TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_on TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS saved_views_owner_idx
		ON saved_views (owner_email, page_id)`,

	// --- Access control ----------------------------------------------------

	// Governs what a user can open. Which rows they see stays with Unity
	// Catalog; this layer never filters data.
	`CREATE TABLE IF NOT EXISTS access_policies (
		policy_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		subject_type  TEXT NOT NULL CHECK (subject_type IN ('group', 'user')),
		subject_id    TEXT NOT NULL,
		resource_type TEXT NOT NULL CHECK (resource_type IN ('category', 'report', 'page')),
		resource_id   TEXT NOT NULL,
		permission    TEXT NOT NULL CHECK (permission IN ('view', 'edit', 'admin')),
		granted_by    TEXT,
		granted_on    TIMESTAMPTZ NOT NULL DEFAULT now(),
		is_active     BOOLEAN NOT NULL DEFAULT TRUE
	)`,

	`CREATE INDEX IF NOT EXISTS access_policies_lookup_idx
		ON access_policies (resource_type, resource_id, is_active)`,

	// --- Shared result cache -----------------------------------------------

	// Second cache tier, shared across replicas and surviving restarts. The
	// first tier is per-replica memory; this one stops a cold replica going
	// straight to the warehouse. Keyed by policy class, so two users share an
	// entry only when Unity Catalog would return them the same rows.
	`CREATE TABLE IF NOT EXISTS result_cache (
		cache_key    TEXT PRIMARY KEY,
		policy_class TEXT NOT NULL,
		source_key   TEXT,
		payload      JSONB NOT NULL,
		row_count    INTEGER,
		created_on   TIMESTAMPTZ NOT NULL DEFAULT now(),
		expires_on   TIMESTAMPTZ NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS result_cache_expiry_idx ON result_cache (expires_on)`,

	// Which sources a reader can read, as Unity Catalog answered it.
	//
	// Held here rather than only in memory because resolving it costs a
	// warehouse round trip, which is three orders of magnitude slower than
	// reading it back. In memory alone every replica pays that separately and
	// pays it again after a restart, which is most of what a reader waits for
	// on a cold first page.
	//
	// Recomputed only while that reader is making a request, since it is their
	// token the question has to be asked with.
	`CREATE TABLE IF NOT EXISTS reader_access (
		user_email  TEXT PRIMARY KEY,
		source_keys JSONB NOT NULL,
		computed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		expires_on  TIMESTAMPTZ NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS reader_access_expiry_idx
		ON reader_access (expires_on)`,

	// Which tracked groups a reader belongs to, as the account directory
	// answered it.
	//
	// Costs a warehouse round trip to ask and a Postgres one to read back, and
	// every replica was asking separately. Held against the exact set of groups
	// it was asked about, so changing that set makes every stored answer a miss
	// rather than a wrong answer.
	`CREATE TABLE IF NOT EXISTS reader_policy (
		user_email  TEXT NOT NULL,
		group_set   TEXT NOT NULL,
		grants      JSONB NOT NULL,
		computed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		expires_on  TIMESTAMPTZ NOT NULL,
		PRIMARY KEY (user_email, group_set)
	)`,

	`CREATE INDEX IF NOT EXISTS reader_policy_expiry_idx
		ON reader_policy (expires_on)`,

	// --- Operations --------------------------------------------------------

	`CREATE TABLE IF NOT EXISTS platform_settings (
		setting_key   TEXT PRIMARY KEY,
		setting_value TEXT,
		description   TEXT,
		modified_by   TEXT,
		modified_on   TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE TABLE IF NOT EXISTS activity_log (
		log_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		record_type TEXT NOT NULL,
		record_id  TEXT NOT NULL,
		action     TEXT NOT NULL,
		field_name TEXT,
		old_value  TEXT,
		new_value  TEXT,
		changed_by TEXT NOT NULL,
		changed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		notes      TEXT
	)`,

	`CREATE INDEX IF NOT EXISTS activity_log_record_idx
		ON activity_log (record_type, record_id, changed_on DESC)`,

	// Who viewed what, when, and what it cost.
	//
	// Written here rather than straight to Delta: every page view and every
	// query appends a row, and Delta commits a file per write, which is the
	// wrong shape for that rate. Databricks can mirror this table into Delta
	// with a synced table when the history is wanted for long-term analysis.
	`CREATE TABLE IF NOT EXISTS usage_events (
		event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		occurred_on   TIMESTAMPTZ NOT NULL DEFAULT now(),
		user_email    TEXT NOT NULL,
		policy_class  TEXT,
		event_type    TEXT NOT NULL
			CHECK (event_type IN ('page_view','query','export','edit','error')),
		category_id   TEXT,
		report_id     UUID,
		page_id       UUID,
		visual_id     UUID,
		source_key    TEXT,
		-- Time the user waited, end to end.
		duration_ms   INTEGER,
		-- Warehouse time, null on a cache hit.
		query_ms      INTEGER,
		row_count      BIGINT,
		cache_hit     BOOLEAN,
		error_message TEXT,
		session_id    TEXT,
		client_info   TEXT
	)`,

	`CREATE INDEX IF NOT EXISTS usage_events_time_idx
		ON usage_events (occurred_on DESC)`,
	`CREATE INDEX IF NOT EXISTS usage_events_report_idx
		ON usage_events (report_id, occurred_on DESC)`,
	`CREATE INDEX IF NOT EXISTS usage_events_user_idx
		ON usage_events (user_email, occurred_on DESC)`,
];

// Columns added after the initial schema shipped. CREATE TABLE IF NOT EXISTS
// does nothing to a table that already exists, so new columns need their own
// idempotent statement.
const migrations: string[] = [
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'table'`,
	`ALTER TABLE source_fields ALTER COLUMN sql_expr DROP NOT NULL`,
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '{}'::jsonb`,
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS display_name TEXT`,
	`ALTER TABLE report_pages ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb`,
];

// Creates anything missing. Safe to run on every startup.
// Hands every table in the schema to whoever owns the schema.
//
// A table belongs to whoever ran the CREATE, so the platform tables end up owned
// by the identity that happened to start first: a service principal on one
// deployment, a person who ran a migration by hand on another. Ownership is what
// ALTER TABLE checks, so the next identity to start cannot apply a migration to
// a table the previous one made, and the failure arrives as a permission error
// on a column that already exists.
//
// Naming the schema owner rather than a configured role means there is one fact
// to set, and it is set by whoever created the schema. Silent when the current
// identity is not a member of that role, because then there is nothing it may
// do and nothing it needs to.
async function adoptSchemaOwner(): Promise<void> {
	try {
		await sql(
			`DO $$
			 DECLARE
			   owner text;
			   target record;
			 BEGIN
			   SELECT pg_get_userbyid(nspowner) INTO owner
			   FROM pg_namespace WHERE nspname = current_schema();
			   IF owner IS NULL OR NOT pg_has_role(current_user, owner, 'MEMBER')
			   THEN
			     RETURN;
			   END IF;
			   FOR target IN
			     SELECT tablename FROM pg_tables
			     WHERE schemaname = current_schema() AND tableowner <> owner
			   LOOP
			     EXECUTE format('ALTER TABLE %I.%I OWNER TO %I',
			                    current_schema(), target.tablename, owner);
			   END LOOP;
			 END $$`,
		);
	} catch (error) {
		// Worth knowing about and not worth refusing to start over: the tables
		// this identity created are still usable by it.
		console.warn("Could not align table ownership with the schema:", error);
	}
}

export async function initPlatformSchema(): Promise<void> {
	for (const statement of statements) {
		await sql(statement);
	}

	// Between the two, because a migration is an ALTER TABLE and that is the
	// statement ownership gates. A table this identity created a moment ago is
	// already its own, so this is for the ones an earlier identity created.
	await adoptSchemaOwner();

	for (const statement of migrations) {
		await sql(statement);
	}
}

// Removes expired presence and cache rows. Cheap, and called on a timer
// rather than on the request path.
export async function sweepExpired(): Promise<void> {
	await sql(`DELETE FROM presence WHERE expires_on < now()`);
	await sql(`DELETE FROM result_cache WHERE expires_on < now()`);
	await sql(`DELETE FROM reader_access WHERE expires_on < now()`);
	await sql(`DELETE FROM reader_policy WHERE expires_on < now()`);
}
