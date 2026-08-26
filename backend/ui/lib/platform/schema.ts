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

	// A question somebody asked outside any report.
	//
	// Held apart from saved_views because a view is an arrangement of a report
	// that already exists, and this is the whole thing: which source, which
	// fields, which filters, drawn how. It has no report to hang off, and
	// nulling out the two columns that make a view a view would leave a table
	// where half the rows mean something different from the other half.
	//
	// The config is a visual definition, the same shape a report visual stores,
	// so the renderer draws one without knowing where it came from.
	`CREATE TABLE IF NOT EXISTS explorations (
		exploration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		owner_email    TEXT NOT NULL,
		name           TEXT NOT NULL,
		source_key     TEXT NOT NULL,
		config         JSONB NOT NULL DEFAULT '{}'::jsonb,
		is_shared      BOOLEAN NOT NULL DEFAULT FALSE,
		created_on     TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_on    TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS explorations_owner_idx
		ON explorations (owner_email, modified_on DESC)`,

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

	// A named bundle of one resource permission and the platform actions its
	// holder may take. The built-in three are re-asserted on every start from
	// lib/platform/accessRules; anything else is an administrator's own.
	`CREATE TABLE IF NOT EXISTS roles (
		role_id     TEXT PRIMARY KEY,
		name        TEXT NOT NULL,
		description TEXT,
		-- What the holder may do to resources inside the assignment's scope.
		permission  TEXT NOT NULL DEFAULT 'view'
			CHECK (permission IN ('view', 'edit', 'admin')),
		-- Built-in roles are owned by the code and cannot be deleted.
		is_builtin  BOOLEAN NOT NULL DEFAULT FALSE,
		is_active   BOOLEAN NOT NULL DEFAULT TRUE,
		created_by  TEXT,
		created_on  TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE TABLE IF NOT EXISTS role_capabilities (
		role_id    TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
		capability TEXT NOT NULL,
		PRIMARY KEY (role_id, capability)
	)`,

	// Binds a role to a group or a named individual, within a scope.
	//
	// Scope is what makes "edit, but only in this subject area" expressible
	// without inventing a permission level for it. A global assignment stands
	// in wherever nothing else names the resource; a scoped one reaches that
	// resource and, for a category, the reports inside it.
	`CREATE TABLE IF NOT EXISTS role_assignments (
		assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		role_id       TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
		subject_type  TEXT NOT NULL CHECK (subject_type IN ('group', 'user')),
		subject_id    TEXT NOT NULL,
		scope_type    TEXT NOT NULL DEFAULT 'global'
			CHECK (scope_type IN ('global', 'category', 'report')),
		scope_id      TEXT,
		granted_by    TEXT,
		granted_on    TIMESTAMPTZ NOT NULL DEFAULT now(),
		is_active     BOOLEAN NOT NULL DEFAULT TRUE,
		-- A global assignment names no scope and a scoped one must. Enforced
		-- here because a scoped row with a null scope would otherwise read as
		-- global, which widens a grant on malformed input.
		CHECK ((scope_type = 'global') = (scope_id IS NULL))
	)`,

	`CREATE INDEX IF NOT EXISTS role_assignments_subject_idx
		ON role_assignments (subject_type, subject_id, is_active)`,

	`CREATE INDEX IF NOT EXISTS role_assignments_scope_idx
		ON role_assignments (scope_type, scope_id, is_active)`,

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

	// What the catalogue sync is doing, and what the last one did.
	//
	// The work runs on the server and takes tens of seconds. Holding its state
	// only in the request that started it means an administrator who navigates
	// away, or arrives while somebody else is syncing, has no way to see
	// whether anything is happening. Written here so any page load can ask.
	`CREATE TABLE IF NOT EXISTS sync_runs (
		run_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		started_by  TEXT NOT NULL,
		started_on  TIMESTAMPTZ NOT NULL DEFAULT now(),
		finished_on TIMESTAMPTZ,
		total       INTEGER NOT NULL DEFAULT 0,
		completed   INTEGER NOT NULL DEFAULT 0,
		current     TEXT,
		error       TEXT
	)`,

	`CREATE INDEX IF NOT EXISTS sync_runs_started_idx
		ON sync_runs (started_on DESC)`,

	// An export in progress, and the file it produced.
	//
	// Export used to run inside the request that asked for it: the whole result
	// was fetched, turned into one CSV string, and written to the response. A
	// large one held the rows, the encoded lines and the joined document in
	// memory at once, and the reader watched a spinner with no way to know
	// whether it was working, no way to leave the page, and nothing to show for
	// it if the container recycled.
	//
	// So the request records what was asked for and returns. The work runs
	// behind it and writes here, which is also what lets the answer be
	// collected from a replica that did not do the work.
	`CREATE TABLE IF NOT EXISTS export_jobs (
		job_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		requested_by TEXT NOT NULL,
		policy_class TEXT NOT NULL,
		source_key   TEXT NOT NULL,
		report_id    TEXT,
		page_id      TEXT,
		visual_id    TEXT,
		spec         JSONB NOT NULL,
		filename     TEXT NOT NULL,
		status       TEXT NOT NULL DEFAULT 'queued',
		row_count    INTEGER NOT NULL DEFAULT 0,
		byte_count   BIGINT NOT NULL DEFAULT 0,
		truncated    BOOLEAN NOT NULL DEFAULT FALSE,
		error        TEXT,
		requested_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		started_on   TIMESTAMPTZ,
		-- Touched as each batch lands. A job is judged dead by how long it has
		-- been silent, not by how long it has been running: a large export on a
		-- busy warehouse is slow and alive, and the two are only distinguishable
		-- by whether it is still making progress.
		progress_on  TIMESTAMPTZ,
		finished_on  TIMESTAMPTZ,
		expires_on   TIMESTAMPTZ NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS export_jobs_owner_idx
		ON export_jobs (requested_by, requested_on DESC)`,

	`CREATE INDEX IF NOT EXISTS export_jobs_expiry_idx
		ON export_jobs (expires_on)`,

	// The file itself, in pieces.
	//
	// One row per batch, written as the warehouse hands them over and read back
	// in order. Holding the document in a single column would mean building it
	// whole on the way in and again on the way out, which is the memory this
	// exists to bound.
	`CREATE TABLE IF NOT EXISTS export_chunks (
		job_id UUID NOT NULL REFERENCES export_jobs (job_id) ON DELETE CASCADE,
		seq    INTEGER NOT NULL,
		body   TEXT NOT NULL,
		PRIMARY KEY (job_id, seq)
	)`,

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

	// The tables a metric view reads, recorded when the view is synced.
	//
	// Deriving them means opening the view definition, which Unity Catalog gates
	// behind SELECT on the view rather than behind BROWSE, and which returns the
	// whole semantic layer: tens to hundreds of kilobytes of YAML per view. The
	// row filter walk needs only the handful of table names inside it, and the
	// answer changes when somebody edits the view rather than on a timer.
	//
	// So it is derived once, by a sync, under the identity of whoever asked for
	// it. The walk then reads this column instead of re-parsing megabytes every
	// hour, and the application never needs SELECT on anything.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS base_tables JSONB`,

	`ALTER TABLE source_fields ALTER COLUMN sql_expr DROP NOT NULL`,
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '{}'::jsonb`,
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS display_name TEXT`,
	`ALTER TABLE report_pages ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb`,

	// Marks a report somebody built for themselves rather than for the
	// catalogue. Personal reports are exempt from every implicit grant: a
	// global editor role does not reach one and neither does catalogue
	// reachability, so the only ways in are owning it and being named on it.
	//
	// A column of its own rather than a reading of visibility, which defaults
	// to 'private' on every row already in the table. Treating those as
	// personal would hide the entire curated catalogue the moment this shipped.
	// Defaulting to FALSE means the rule is inert for everything that came
	// before it, and true only for what the personal path creates.
	`ALTER TABLE reports ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT FALSE`,

	`CREATE INDEX IF NOT EXISTS reports_owner_idx
		ON reports (owner_email, is_personal) WHERE is_personal = TRUE`,

	// Records which personal page an exploration became.
	//
	// Saved questions used to live in a table only the explore screen could
	// read, so nobody could find what they had kept and nothing could be built
	// on one. They are personal pages now. The rows are converted rather than
	// moved: the table stays exactly as it was, so a conversion that got
	// something wrong can be looked at rather than reconstructed.
	`ALTER TABLE explorations ADD COLUMN IF NOT EXISTS migrated_to UUID`,
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

	// The chunks go with the job, by the foreign key.
	await sql(`DELETE FROM export_jobs WHERE expires_on < now()`);

	// A job whose replica went away mid-run is otherwise "running" for ever,
	// and the page waiting on it never stops waiting.
	//
	// Silence is the signal, not elapsed time. A job that has written a batch
	// recently is working however long it has been going, and one that has
	// written nothing for ten minutes is not coming back.
	await sql(
		`UPDATE export_jobs
		 SET status = 'failed',
		     error = 'The export stopped before it finished.',
		     finished_on = now()
		 WHERE status IN ('queued', 'running')
		   AND coalesce(progress_on, started_on, requested_on)
		       < now() - interval '10 minutes'`,
	);
}
