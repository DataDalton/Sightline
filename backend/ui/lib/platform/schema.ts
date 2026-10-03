import { createHash } from "node:crypto";
import { sql, withAdvisoryLock } from "../data/lakebase";

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
		-- Zero means inherit the platform setting rather than do not cache.
		-- The migration below says the same thing to a table that already
		-- exists, and the two agree so a fresh install never starts out pinned.
		cache_ttl_seconds INTEGER NOT NULL DEFAULT 0,
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
	// A page's views are listed by page, and owners are matched without case.
	`CREATE INDEX IF NOT EXISTS saved_views_page_idx
		ON saved_views (page_id)`,
	`CREATE INDEX IF NOT EXISTS saved_views_owner_lower_idx
		ON saved_views (lower(owner_email))`,

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
	// Grants are matched to a caller by subject, without case.
	`CREATE INDEX IF NOT EXISTS access_policies_subject_lower_idx
		ON access_policies (subject_type, lower(subject_id)) WHERE is_active`,

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
	// Subjects are matched without case when a caller's roles are resolved.
	`CREATE INDEX IF NOT EXISTS role_assignments_subject_lower_idx
		ON role_assignments (subject_type, lower(subject_id)) WHERE is_active`,

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
	// The administration log is read newest first across every record type.
	`CREATE INDEX IF NOT EXISTS activity_log_changed_idx
		ON activity_log (changed_on DESC)`,

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
	`CREATE INDEX IF NOT EXISTS usage_events_user_idx
		ON usage_events (user_email, occurred_on DESC)`,

	// Reports somebody chose to keep to hand.
	//
	// Separate from usage_events, which answers what a reader opened. That is
	// evidence of habit and this is a statement of intent, and they disagree
	// often enough to matter: the report opened most is frequently the one
	// nobody chose, reached through a link somebody sends every week.
	//
	// No foreign key to reports, so removing a report does not have to know
	// this table exists. A favourite pointing at something gone is filtered by
	// the join that reads it.
	// Usage, pre-aggregated by day.
	//
	// The raw events are kept for ever: they are the audit record, and an
	// aggregate cannot answer a question nobody thought to aggregate for. What
	// they cannot do is answer the administration screens, which count and rank
	// over a window and would end up scanning tens of millions of rows to draw
	// a summary.
	//
	// So the reads move and the writes do not. One row per day per reader per
	// report per source, which collapses a day of events by three or four
	// orders of magnitude while still supporting every question those screens
	// ask: totals by summing, distinct readers by counting rows rather than
	// summing counts, and averages from a sum and a count held side by side.
	`CREATE TABLE IF NOT EXISTS usage_daily (
		day          DATE NOT NULL,
		event_type   TEXT NOT NULL,
		user_email   TEXT NOT NULL,
		report_id    UUID,
		source_key   TEXT,
		events       BIGINT NOT NULL DEFAULT 0,
		cache_hits   BIGINT NOT NULL DEFAULT 0,
		cacheable    BIGINT NOT NULL DEFAULT 0,
		duration_sum BIGINT NOT NULL DEFAULT 0,
		duration_n   BIGINT NOT NULL DEFAULT 0,
		query_ms_sum BIGINT NOT NULL DEFAULT 0,
		query_ms_n   BIGINT NOT NULL DEFAULT 0,
		query_ms_max BIGINT NOT NULL DEFAULT 0,
		rows_sum     BIGINT NOT NULL DEFAULT 0,
		-- Kept so "first seen" and "last seen" stay times rather than dates.
		first_event  TIMESTAMPTZ,
		last_event   TIMESTAMPTZ,
		-- No primary key, because the natural one is not a list of columns:
		-- report and source are absent on most events and a key cannot be
		-- written over an expression. The unique index below says the same
		-- thing in the form Postgres accepts.
		created_on   TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	// One row per day per reader per report per source, with absent report and
	// source folded to a fixed value so two rows that mean the same thing
	// cannot both exist. Also the index the reads use, so it earns its keep
	// twice.
	`CREATE UNIQUE INDEX IF NOT EXISTS usage_daily_key_idx ON usage_daily (
		day, event_type, user_email,
		coalesce(report_id, '00000000-0000-0000-0000-000000000000'::uuid),
		coalesce(source_key, '')
	)`,

	`CREATE INDEX IF NOT EXISTS usage_daily_day_idx ON usage_daily (day DESC)`,
	`CREATE INDEX IF NOT EXISTS usage_daily_report_idx
		ON usage_daily (report_id, day DESC)`,

	// Latency needs its own shape, because a percentile is the one figure that
	// cannot be recovered from sums and counts. Computed per day, where it is
	// exact, and combined across a window as a weighted reading, which the
	// screen labels as covering the window rather than any single day.
	`CREATE TABLE IF NOT EXISTS usage_daily_latency (
		day        DATE NOT NULL,
		source_key TEXT NOT NULL DEFAULT '',
		samples    BIGINT NOT NULL DEFAULT 0,
		p50_ms     DOUBLE PRECISION,
		p95_ms     DOUBLE PRECISION,
		max_ms     BIGINT,
		PRIMARY KEY (day, source_key)
	)`,

	// How far the rollup has been built, so a run knows what to redo rather
	// than rebuilding history every time.
	`CREATE TABLE IF NOT EXISTS usage_rollup_state (
		id          BOOLEAN PRIMARY KEY DEFAULT TRUE,
		built_to    DATE,
		ran_on      TIMESTAMPTZ,
		CONSTRAINT usage_rollup_state_single CHECK (id)
	)`,

	`CREATE TABLE IF NOT EXISTS favourites (
		user_email TEXT NOT NULL,
		report_id  UUID NOT NULL,
		created_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (user_email, report_id)
	)`,

	`CREATE INDEX IF NOT EXISTS favourites_user_idx
		ON favourites (user_email, created_on DESC)`,
	// Every read matches the reader without case.
	`CREATE INDEX IF NOT EXISTS favourites_user_lower_idx
		ON favourites (lower(user_email), created_on DESC)`,

	// Boards, each a canvas somebody arranges from visuals copied out of reports,
	// notes and text. The definition holds every item and arrow. Version goes
	// up on every change and is what an open copy polls. See lib/boards.
	`CREATE TABLE IF NOT EXISTS boards (
		board_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		owner_email TEXT NOT NULL,
		title       TEXT NOT NULL,
		definition  JSONB NOT NULL,
		version     BIGINT NOT NULL DEFAULT 1,
		created_on  TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_by TEXT NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS boards_owner_idx
		ON boards (owner_email, modified_on DESC)`,

	// People a board is shared with, to look at or to change.
	`CREATE TABLE IF NOT EXISTS board_shares (
		board_id   UUID NOT NULL REFERENCES boards (board_id) ON DELETE CASCADE,
		email      TEXT NOT NULL,
		permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
		granted_by TEXT NOT NULL,
		granted_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (board_id, email)
	)`,

	`CREATE INDEX IF NOT EXISTS board_shares_email_idx
		ON board_shares (email)`,

	// A figure somebody pinned to their home page briefing, or hid from it.
	// Keyed by the report and measure it came from, so it follows the figure
	// rather than wherever it happens to sit in the list. See lib/briefing.
	`CREATE TABLE IF NOT EXISTS briefing_choices (
		user_email TEXT NOT NULL,
		report_id  UUID NOT NULL REFERENCES reports (report_id) ON DELETE CASCADE,
		measure    TEXT NOT NULL,
		choice     TEXT NOT NULL CHECK (choice IN ('pin', 'hide')),
		-- Where a pin sits among the reader's pins. Null for a hide.
		position   INTEGER,
		chosen_on  TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (user_email, report_id, measure)
	)`,

	// --- Commentary --------------------------------------------------------

	// A note somebody pinned to a visual.
	//
	// "The dip in March was the system migration" is the context that makes a
	// figure readable, and it lived in email, so the same question came back
	// every quarter and whoever answered it last was not the one being asked.
	//
	// Attached to the visual rather than to the report, because that is the
	// grain the question is asked at, and carrying an optional date so a note
	// about one point can say which point.
	//
	// No foreign key to report_visuals. A visual is replaced rather than
	// updated when a version is restored, and a cascade would delete the
	// commentary along with it. An orphan note is swept rather than lost.
	`CREATE TABLE IF NOT EXISTS visual_notes (
		note_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		report_id   UUID NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
		page_id     UUID NOT NULL,
		visual_id   UUID NOT NULL,
		author_email TEXT NOT NULL,
		body        TEXT NOT NULL,
		anchored_on DATE,
		created_on  TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_on  TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	// Read a page at a time, which is how the reader loads them: every note on
	// every visual of the page they just opened, in one query.
	`CREATE INDEX IF NOT EXISTS visual_notes_page_idx
		ON visual_notes (page_id, visual_id, created_on)`,

	// Conversations with the data assistant, one row each, private to the
	// person who had them.
	//
	// Each message is kept in assistant_messages, including the steps each
	// answer took and the first rows they returned, because reopening a
	// conversation is reopening what was seen, not a replay. The queries would
	// run again against today's data and could say something else. The
	// messages column holds transcripts from before those rows existed, until
	// each is moved.
	`CREATE TABLE IF NOT EXISTS assistant_conversations (
		conversation_id UUID PRIMARY KEY,
		owner_email     TEXT NOT NULL,
		title           TEXT NOT NULL,
		messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
		created_on      TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_on     TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS assistant_conversations_owner_idx
		ON assistant_conversations (owner_email, modified_on DESC)`,

	// Explorations somebody saved to come back to: the dataset, the columns and
	// the conditions, by name. Private to whoever saved them. A saved view is a
	// question rather than an answer, so opening one runs it again against the
	// data as it is now.
	`CREATE TABLE IF NOT EXISTS explore_views (
		view_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		owner_email TEXT NOT NULL,
		name        TEXT NOT NULL,
		state       JSONB NOT NULL,
		created_on  TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_on TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS explore_views_owner_idx
		ON explore_views (owner_email, modified_on DESC)`,

	// How one person wants the assistant to work with them, carried into every
	// conversation. Instructions are what they wrote themselves; memories are
	// the things they asked it to remember along the way. The email is stored
	// lowercased, since that is how every lookup spells it.
	`CREATE TABLE IF NOT EXISTS assistant_profiles (
		owner_email  TEXT PRIMARY KEY,
		instructions TEXT NOT NULL DEFAULT '',
		memories     JSONB NOT NULL DEFAULT '[]'::jsonb,
		modified_on  TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	// Somebody's inbox. One row per thing they were told, whether or not it
	// also reached a device, so the inbox is the whole record and a push is
	// only a way of noticing it sooner.
	`CREATE TABLE IF NOT EXISTS notifications (
		notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		owner_email     TEXT NOT NULL,
		kind            TEXT NOT NULL,
		title           TEXT NOT NULL,
		body            TEXT NOT NULL DEFAULT '',
		link            TEXT,
		data            JSONB NOT NULL DEFAULT '{}'::jsonb,
		created_on      TIMESTAMPTZ NOT NULL DEFAULT now(),
		read_on         TIMESTAMPTZ
	)`,

	`CREATE INDEX IF NOT EXISTS notifications_owner_idx
		ON notifications (owner_email, created_on DESC)`,

	`CREATE INDEX IF NOT EXISTS notifications_unread_idx
		ON notifications (owner_email) WHERE read_on IS NULL`,

	// The browsers and phones somebody allowed to receive pushes. Keyed by the
	// endpoint the push service issued, which is unique to one browser
	// profile on one device.
	`CREATE TABLE IF NOT EXISTS push_subscriptions (
		endpoint     TEXT PRIMARY KEY,
		owner_email  TEXT NOT NULL,
		p256dh       TEXT NOT NULL,
		auth         TEXT NOT NULL,
		device       TEXT NOT NULL DEFAULT '',
		created_on   TIMESTAMPTZ NOT NULL DEFAULT now(),
		last_sent_on TIMESTAMPTZ,
		failures     INTEGER NOT NULL DEFAULT 0
	)`,

	`CREATE INDEX IF NOT EXISTS push_subscriptions_owner_idx
		ON push_subscriptions (owner_email)`,

	// The key pair this deployment signs pushes with. One row. Generated the
	// first time an administrator turns pushes on, and kept, because every
	// subscription was made against its public half and a new pair orphans
	// all of them.
	`CREATE TABLE IF NOT EXISTS push_keys (
		key_id      INTEGER PRIMARY KEY CHECK (key_id = 1),
		public_key  TEXT NOT NULL,
		private_key TEXT NOT NULL,
		subject     TEXT NOT NULL,
		created_on  TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	// Which kinds of notification somebody wants on their devices as well as
	// in the inbox. Absent means the defaults.
	`CREATE TABLE IF NOT EXISTS notification_prefs (
		owner_email TEXT PRIMARY KEY,
		push        JSONB NOT NULL DEFAULT '{}'::jsonb,
		modified_on TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	// Alerts. The definition is what the owner wrote, and state is what the last
	// check saw for each group, which is what the next check compares with.
	`CREATE TABLE IF NOT EXISTS alert_rules (
		rule_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		owner_email     TEXT NOT NULL,
		name            TEXT NOT NULL,
		source_key      TEXT NOT NULL,
		definition      JSONB NOT NULL,
		enabled         BOOLEAN NOT NULL DEFAULT TRUE,
		state           JSONB NOT NULL DEFAULT '{}'::jsonb,
		last_checked_on TIMESTAMPTZ,
		last_status     TEXT NOT NULL DEFAULT 'waiting',
		last_error      TEXT,
		next_check_on   TIMESTAMPTZ NOT NULL DEFAULT now(),
		-- When the owner was last seen able to read the dataset, which is
		-- what lets a check run while they are away.
		access_confirmed_on TIMESTAMPTZ,
		created_on      TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_on     TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS alert_rules_owner_idx
		ON alert_rules (owner_email, created_on DESC)`,

	`CREATE INDEX IF NOT EXISTS alert_rules_due_idx
		ON alert_rules (next_check_on) WHERE enabled`,

	// Every time an alert fired or came back, so the alert can show its own
	// history without reading through the inbox.
	`CREATE TABLE IF NOT EXISTS alert_events (
		event_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		rule_id    UUID NOT NULL REFERENCES alert_rules (rule_id) ON DELETE CASCADE,
		fired_on   TIMESTAMPTZ NOT NULL DEFAULT now(),
		title      TEXT NOT NULL,
		body       TEXT NOT NULL DEFAULT '',
		firings    INTEGER NOT NULL DEFAULT 1
	)`,

	`CREATE INDEX IF NOT EXISTS alert_events_rule_idx
		ON alert_events (rule_id, fired_on DESC)`,

	// Sheets: a question asked of one dataset with the reader's own columns on
	// top. The data is never stored here, only what the sheet asks for and the
	// notes people wrote beside it. Version goes up on every change, which is
	// what an open copy polls to know it should reload.
	`CREATE TABLE IF NOT EXISTS sheets (
		sheet_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		owner_email TEXT NOT NULL,
		title       TEXT NOT NULL,
		definition  JSONB NOT NULL,
		version     BIGINT NOT NULL DEFAULT 1,
		created_on  TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_by TEXT NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS sheets_owner_idx
		ON sheets (owner_email, modified_on DESC)`,

	// Who else a sheet is shared with, one person at a time, and whether they
	// may change it or only look.
	`CREATE TABLE IF NOT EXISTS sheet_shares (
		sheet_id   UUID NOT NULL REFERENCES sheets (sheet_id) ON DELETE CASCADE,
		email      TEXT NOT NULL,
		permission TEXT NOT NULL,
		granted_by TEXT NOT NULL,
		granted_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (sheet_id, email)
	)`,

	`CREATE INDEX IF NOT EXISTS sheet_shares_email_idx
		ON sheet_shares (email)`,

	// A note in a note column, keyed by the row it sits on. See rowKey in
	// lib/sheets/definition.
	`CREATE TABLE IF NOT EXISTS sheet_cells (
		sheet_id    UUID NOT NULL REFERENCES sheets (sheet_id) ON DELETE CASCADE,
		row_key     TEXT NOT NULL,
		note_id     TEXT NOT NULL,
		value       TEXT NOT NULL,
		modified_by TEXT NOT NULL,
		modified_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (sheet_id, row_key, note_id)
	)`,

	// Who has a sheet open, as a lease each open copy renews while it polls.
	`CREATE TABLE IF NOT EXISTS sheet_presence (
		sheet_id   UUID NOT NULL REFERENCES sheets (sheet_id) ON DELETE CASCADE,
		session_id TEXT NOT NULL,
		user_email TEXT NOT NULL,
		state      JSONB NOT NULL DEFAULT '{}'::jsonb,
		expires_on TIMESTAMPTZ NOT NULL,
		PRIMARY KEY (sheet_id, session_id)
	)`,

	// --- Conversations ------------------------------------------------------

	// A question somebody asked the people who maintain a category, and the
	// replies to it. See lib/messages/store.
	`CREATE TABLE IF NOT EXISTS threads (
		thread_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		subject         TEXT NOT NULL,
		-- What it is about. The category decides who it was sent to. The
		-- report, when there is one, is where it was asked from.
		category_id     TEXT NOT NULL,
		report_slug     TEXT,
		created_by      TEXT NOT NULL,
		created_on      TIMESTAMPTZ NOT NULL DEFAULT now(),
		last_message_on TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS threads_creator_idx
		ON threads (created_by, created_on DESC)`,

	// Who a conversation is between. A person by address, or a group by name,
	// whose members are whoever belongs to it when they look.
	`CREATE TABLE IF NOT EXISTS thread_members (
		thread_id   UUID NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
		member_type TEXT NOT NULL CHECK (member_type IN ('user', 'group')),
		member_id   TEXT NOT NULL,
		PRIMARY KEY (thread_id, member_type, member_id)
	)`,

	`CREATE INDEX IF NOT EXISTS thread_members_member_idx
		ON thread_members (member_type, member_id)`,

	`CREATE TABLE IF NOT EXISTS thread_messages (
		message_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		thread_id    UUID NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
		author_email TEXT NOT NULL,
		body         TEXT NOT NULL,
		created_on   TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS thread_messages_thread_idx
		ON thread_messages (thread_id, created_on)`,

	// When each person last read each conversation, per person rather than per
	// member, since one group is several readers.
	`CREATE TABLE IF NOT EXISTS thread_reads (
		thread_id  UUID NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
		user_email TEXT NOT NULL,
		read_on    TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (thread_id, user_email)
	)`,

	// The groups each person was last found in, kept for as long as they have
	// used the application at all rather than for the probe lifetime, so a
	// message to a group reaches every member who has ever signed in. Written
	// every time their membership is probed. See lib/auth/policy.
	`CREATE TABLE IF NOT EXISTS member_groups (
		user_email TEXT PRIMARY KEY,
		grants     JSONB NOT NULL,
		checked_on TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS member_groups_grants_idx
		ON member_groups USING gin (grants)`,

	// A page somebody asked to be sent on a schedule, with its headline
	// figures worked out under their access. See lib/deliveries.
	`CREATE TABLE IF NOT EXISTS deliveries (
		delivery_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		owner_email         TEXT NOT NULL,
		report_id           UUID NOT NULL REFERENCES reports (report_id) ON DELETE CASCADE,
		page_id             UUID NOT NULL REFERENCES report_pages (page_id) ON DELETE CASCADE,
		-- The dataset its figures come from, which decides whether it can be
		-- worked out while the owner is away. See runsUnattended.
		source_key          TEXT,
		schedule            JSONB NOT NULL,
		enabled             BOOLEAN NOT NULL DEFAULT TRUE,
		-- The figures last sent, so the next can say what changed.
		state               JSONB NOT NULL DEFAULT '{}'::jsonb,
		next_run_on         TIMESTAMPTZ NOT NULL,
		last_run_on         TIMESTAMPTZ,
		last_status         TEXT NOT NULL DEFAULT 'waiting',
		last_error          TEXT,
		access_confirmed_on TIMESTAMPTZ,
		created_on          TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (owner_email, page_id)
	)`,

	`CREATE INDEX IF NOT EXISTS deliveries_due_idx
		ON deliveries (next_run_on) WHERE enabled`,

	// The last version seen of each table a source reads, from its Delta
	// history, so a new version that changed data can be noticed. See
	// lib/freshness/checker.
	`CREATE TABLE IF NOT EXISTS source_checks (
		table_name    TEXT PRIMARY KEY,
		version       BIGINT,
		-- When that version was made, which tells a recreated table that
		-- reached the same version apart from the one seen before.
		version_at    TIMESTAMPTZ,
		checked_on    TIMESTAMPTZ,
		changed_on    TIMESTAMPTZ,
		next_check_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		-- Set when a reader met an answer whose table is overdue a look, so the
		-- next pass looks even with the warehouse stopped.
		wanted_on     TIMESTAMPTZ,
		last_error    TEXT
	)`,

	// What one person could see of a row-filtered dataset when they were last
	// here: every combination of the columns its filter decides on, read under
	// their own token. Lets their alerts on it be checked while they are away.
	// See lib/alerts/access.
	`CREATE TABLE IF NOT EXISTS alert_access (
		owner_email TEXT NOT NULL,
		source_key  TEXT NOT NULL,
		fields      JSONB NOT NULL,
		tuples      JSONB NOT NULL,
		too_many    BOOLEAN NOT NULL DEFAULT FALSE,
		captured_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (owner_email, source_key)
	)`,

	// Alerts an editor put on a report page, which readers subscribe to. The
	// definition has the same shape as a personal alert's, schedule included,
	// and only people who may edit the report change it. See lib/alerts/pageStore.
	//
	// Due times live here rather than per scope, because the scopes an alert
	// is judged in are worked out from its subscribers each time it runs.
	`CREATE TABLE IF NOT EXISTS page_alerts (
		alert_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		report_id       UUID NOT NULL REFERENCES reports (report_id) ON DELETE CASCADE,
		page_id         UUID NOT NULL REFERENCES report_pages (page_id) ON DELETE CASCADE,
		name            TEXT NOT NULL,
		source_key      TEXT NOT NULL,
		definition      JSONB NOT NULL,
		is_active       BOOLEAN NOT NULL DEFAULT TRUE,
		next_check_on   TIMESTAMPTZ NOT NULL DEFAULT now(),
		last_checked_on TIMESTAMPTZ,
		created_by      TEXT NOT NULL,
		created_on      TIMESTAMPTZ NOT NULL DEFAULT now(),
		modified_by     TEXT NOT NULL,
		modified_on     TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS page_alerts_page_idx
		ON page_alerts (page_id) WHERE is_active`,

	`CREATE INDEX IF NOT EXISTS page_alerts_due_idx
		ON page_alerts (next_check_on) WHERE is_active`,

	`CREATE INDEX IF NOT EXISTS page_alerts_source_idx
		ON page_alerts (source_key) WHERE is_active`,

	// Who follows a page alert. A mute that lasts until lifted is stored as
	// infinity. access_confirmed_on is when the subscriber was last seen able
	// to read the alert's dataset, which is what lets a reading be taken for
	// them while they are away, as for a personal alert.
	`CREATE TABLE IF NOT EXISTS page_alert_subscriptions (
		alert_id            UUID NOT NULL REFERENCES page_alerts (alert_id) ON DELETE CASCADE,
		email               TEXT NOT NULL,
		muted_until         TIMESTAMPTZ,
		access_confirmed_on TIMESTAMPTZ,
		created_on          TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (alert_id, email)
	)`,

	`CREATE INDEX IF NOT EXISTS page_alert_subscriptions_email_idx
		ON page_alert_subscriptions (email)`,

	// What a page alert last saw in one access scope. "app" for a dataset that
	// shows everybody the same rows, or the app narrowed to one recorded
	// restriction. See scopeKeyFor in lib/alerts/pageRules.
	`CREATE TABLE IF NOT EXISTS page_alert_state (
		alert_id        UUID NOT NULL REFERENCES page_alerts (alert_id) ON DELETE CASCADE,
		scope_key       TEXT NOT NULL,
		state           JSONB NOT NULL DEFAULT '{}'::jsonb,
		last_checked_on TIMESTAMPTZ,
		next_check_on   TIMESTAMPTZ,
		last_status     TEXT NOT NULL DEFAULT 'waiting',
		last_error      TEXT,
		PRIMARY KEY (alert_id, scope_key)
	)`,

	// Every time a page alert fired in a scope, and how many people were told.
	`CREATE TABLE IF NOT EXISTS page_alert_events (
		event_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		alert_id   UUID NOT NULL REFERENCES page_alerts (alert_id) ON DELETE CASCADE,
		scope_key  TEXT NOT NULL,
		fired_on   TIMESTAMPTZ NOT NULL DEFAULT now(),
		title      TEXT NOT NULL,
		body       TEXT NOT NULL DEFAULT '',
		firings    INTEGER NOT NULL DEFAULT 1,
		recipients INTEGER NOT NULL DEFAULT 0
	)`,

	`CREATE INDEX IF NOT EXISTS page_alert_events_alert_idx
		ON page_alert_events (alert_id, fired_on DESC)`,
];

// Columns added after the initial schema shipped. CREATE TABLE IF NOT EXISTS
// does nothing to a table that already exists, so new columns need their own
// idempotent statement.
const migrations: string[] = [
	// When a session said it was leaving. The row is kept until its lease
	// runs out so a heartbeat still in flight cannot list it again. See leave
	// in lib/platform/presence and leaveSheet in lib/sheets/store.
	`ALTER TABLE presence ADD COLUMN IF NOT EXISTS left_on TIMESTAMPTZ`,
	`ALTER TABLE sheet_presence ADD COLUMN IF NOT EXISTS left_on TIMESTAMPTZ`,
	// Goes up only on a change to the layout, which is what a layout save is
	// checked against. Version also goes up on every note, so a note written
	// by one person does not refuse another person's layout change.
	`ALTER TABLE sheets ADD COLUMN IF NOT EXISTS layout_version BIGINT NOT NULL DEFAULT 1`,
	`ALTER TABLE briefing_choices ADD COLUMN IF NOT EXISTS position INTEGER`,

	// The category a role belongs to, for the editor role every category has.
	// See syncCategoryRoles in lib/platform/roles.
	`ALTER TABLE roles ADD COLUMN IF NOT EXISTS category_id TEXT`,

	// Which fields of a row-filtered dataset hold the columns its filters
	// decide on, and whether any column of it is masked. Written by the filter
	// walk. Null fields means the filters could not be mapped to fields, and
	// its alerts keep to checks while their owner is signed in.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS access_fields JSONB`,
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS has_column_mask BOOLEAN NOT NULL DEFAULT FALSE`,

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
	// Lists written before a view reading from a query or a short name was
	// recognised can hold only part of what the view reads. They are cleared
	// once, marked by the column added alongside, and read again from each
	// view's definition the next time a check needs them.
	`DO $$ BEGIN
	   IF NOT EXISTS (
	     SELECT 1 FROM pg_attribute
	     WHERE attrelid = 'data_sources'::regclass
	       AND attname = 'base_tables_rechecked' AND NOT attisdropped
	   ) THEN
	     ALTER TABLE data_sources ADD COLUMN base_tables_rechecked BOOLEAN;
	     UPDATE data_sources SET base_tables = NULL;
	   END IF;
	 END $$`,

	`ALTER TABLE source_fields ALTER COLUMN sql_expr DROP NOT NULL`,
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '{}'::jsonb`,
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS display_name TEXT`,
	`ALTER TABLE report_pages ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb`,
	// Locks an administrator has put on a page. Two, because a page that has
	// been signed off usually needs to survive deletion while still being
	// correctable, and a page that is quoted elsewhere needs the opposite.
	`ALTER TABLE report_pages ADD COLUMN IF NOT EXISTS protect_delete BOOLEAN NOT NULL DEFAULT FALSE`,
	`ALTER TABLE report_pages ADD COLUMN IF NOT EXISTS protect_edit BOOLEAN NOT NULL DEFAULT FALSE`,

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
	// Locks that apply to every page of a report at once. A page carries its own
	// pair as well; the two are combined rather than one overriding the other, so
	// locking the report cannot quietly unlock a page somebody locked on purpose.
	`ALTER TABLE reports ADD COLUMN IF NOT EXISTS protect_delete BOOLEAN NOT NULL DEFAULT FALSE`,
	`ALTER TABLE reports ADD COLUMN IF NOT EXISTS protect_edit BOOLEAN NOT NULL DEFAULT FALSE`,
	// Whether pages may be added. Report level only: a page cannot stop a page
	// that does not exist yet from being created.
	`ALTER TABLE reports ADD COLUMN IF NOT EXISTS protect_add_page BOOLEAN NOT NULL DEFAULT FALSE`,

	// Somebody's own pages and the reports they authored, matched without
	// regard to case, newest first. Those lookups compare lowercased
	// addresses, so an index on the raw address goes unused and is dropped.
	`CREATE INDEX IF NOT EXISTS reports_owner_lower_idx
		ON reports (lower(owner_email), modified_on DESC) WHERE is_active`,
	`DROP INDEX IF EXISTS reports_owner_idx`,

	// Records which personal page an exploration became.
	//
	// Saved questions used to live in a table only the explore screen could
	// read, so nobody could find what they had kept and nothing could be built
	// on one. They are personal pages now. The rows are converted rather than
	// moved: the table stays exactly as it was, so a conversion that got
	// something wrong can be looked at rather than reconstructed.
	`ALTER TABLE explorations ADD COLUMN IF NOT EXISTS migrated_to UUID`,

	// Where a report sits inside its category.
	//
	// Categories have carried an order since the beginning and reports never
	// did, so a category listed alphabetically and the report a team opens
	// every morning sat wherever its title fell. Defaulting to zero leaves
	// every existing report tied, and a tie falls back to title, which is the
	// order they were in before this column existed.
	`ALTER TABLE reports ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,

	// Zero means "use the platform default" rather than "do not cache".
	//
	// The column defaulted to 300, and the resolver preferred any positive
	// source value over the platform setting, so every source pinned itself to
	// five minutes and the Result cache setting had no effect on anything. New
	// sources now inherit. Existing rows keep whatever they hold, because a
	// value somebody set deliberately and the old default are indistinguishable
	// from here: they are changed per source under Platform, Sources, Edit.
	`ALTER TABLE data_sources ALTER COLUMN cache_ttl_seconds SET DEFAULT 0`,

	// When a sync last reported progress.
	//
	// Whether a run is still going cannot be read from its start time: a walk
	// of a large catalogue legitimately takes a while, and a walk whose replica
	// died stopped instantly. Silence is the signal, which is the same reading
	// the export jobs use, and it needs a timestamp that moves.
	`ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS progress_on TIMESTAMPTZ`,

	// A source whose data arrives continuously rather than on a schedule.
	// Answers from it are reused for seconds rather than an hour, never served
	// past that, and open pages ask again on the same interval. See
	// liveTtlSeconds in lib/settings.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS is_live BOOLEAN NOT NULL DEFAULT FALSE`,

	// Which page of a report somebody opened, and what they did with a visual
	// on it, so the people who maintain a report can see what is read. See
	// lib/platform/reportUsage.
	`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS action TEXT`,

	// Whether a source's tables are watched for changes or it is refreshed on
	// a timer, why, and when its data last changed. Every replica reads these
	// to decide whether a cached answer still stands. See lib/freshness.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS freshness_mode TEXT NOT NULL DEFAULT 'timer'`,
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS freshness_note TEXT`,
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS checked_on TIMESTAMPTZ`,
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS data_changed_on TIMESTAMPTZ`,

	// When each watched table's data changed, timed by its commit, so when a
	// table usually loads can be learned and a late load noticed. See
	// lib/freshness/arrivals.
	`CREATE TABLE IF NOT EXISTS table_arrivals (
		table_name TEXT NOT NULL,
		arrived_on TIMESTAMPTZ NOT NULL,
		PRIMARY KEY (table_name, arrived_on)
	)`,
	// When the longer history behind a table was last read to learn from.
	`ALTER TABLE source_checks ADD COLUMN IF NOT EXISTS learned_on TIMESTAMPTZ`,
	// How a source's lateness is judged, learned or set by hand, and where it
	// stands: whether it is late, when its next load was expected, when its
	// last load landed and the pattern that was learned.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS lateness JSONB NOT NULL DEFAULT '{"mode":"auto"}'`,
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS late_state TEXT`,
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS expected_by TIMESTAMPTZ`,
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS last_arrival TIMESTAMPTZ`,
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS arrival_pattern JSONB`,
	// Readers who asked to be told when a source's data is late, beside the
	// people who look after it, who are told regardless.
	`CREATE TABLE IF NOT EXISTS late_subscriptions (
		email      TEXT NOT NULL,
		source_key TEXT NOT NULL,
		created_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (email, source_key)
	)`,
	`CREATE INDEX IF NOT EXISTS late_subscriptions_source_idx
		ON late_subscriptions (source_key)`,

	// Indexes for the lookups that run on a timer or on every page open.
	// A reader's recent pages, matched without regard to case.
	`CREATE INDEX IF NOT EXISTS usage_events_user_lower_idx
		ON usage_events (lower(user_email), occurred_on DESC)`,
	// Dropping a source's cached answers when its data changes.
	`CREATE INDEX IF NOT EXISTS result_cache_source_idx
		ON result_cache (source_key)`,
	// A page's visuals, read with every report.
	`CREATE INDEX IF NOT EXISTS report_visuals_page_idx
		ON report_visuals (page_id) WHERE is_active`,
	`CREATE INDEX IF NOT EXISTS report_visuals_source_idx
		ON report_visuals (source_key) WHERE is_active`,
	`CREATE INDEX IF NOT EXISTS report_pages_source_idx
		ON report_pages (source_key) WHERE is_active`,
	// The sweep deletes by age.
	`CREATE INDEX IF NOT EXISTS notifications_created_idx
		ON notifications (created_on)`,
	`CREATE INDEX IF NOT EXISTS table_arrivals_time_idx
		ON table_arrivals (arrived_on)`,
	`CREATE INDEX IF NOT EXISTS alert_events_fired_idx
		ON alert_events (fired_on)`,
	// Rebuilt only when the constraint does not already allow the newest event
	// type. Adding a check takes an exclusive lock and scans the whole table,
	// which is never pruned, and this runs on every start of every replica.
	`DO $$ BEGIN
	   IF NOT EXISTS (
	     SELECT 1 FROM pg_constraint
	     WHERE conname = 'usage_events_event_type_check'
	       AND conrelid = 'usage_events'::regclass
	       AND pg_get_constraintdef(oid) LIKE '%visual_action%'
	   ) THEN
	     ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_event_type_check;
	     ALTER TABLE usage_events ADD CONSTRAINT usage_events_event_type_check
	       CHECK (event_type IN ('page_view', 'query', 'export', 'edit', 'error',
	                             'page_open', 'visual_action'));
	   END IF;
	 END $$`,
	`CREATE INDEX IF NOT EXISTS usage_events_page_idx
		ON usage_events (report_id, event_type, occurred_on DESC)`,

	// Where a field stands against its source. A field the source stopped
	// publishing is marked missing rather than deleted, so its labels survive
	// and every item that names it can be found and repaired. The fingerprint is
	// what the last sync saw of it, which is what a rename is recognised by once
	// the name itself is gone. See lib/semantic/fieldSync and renames.
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
	// Added once rather than dropped and added on every start, for the same
	// reason as the usage check above.
	`DO $$ BEGIN
	   IF NOT EXISTS (
	     SELECT 1 FROM pg_constraint
	     WHERE conname = 'source_fields_status_check'
	       AND conrelid = 'source_fields'::regclass
	   ) THEN
	     ALTER TABLE source_fields ADD CONSTRAINT source_fields_status_check
	       CHECK (status IN ('active', 'missing'));
	   END IF;
	 END $$`,
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS missing_since TIMESTAMPTZ`,
	// Set when an administrator confirmed the field was renamed and remapped
	// everything that named it. See lib/semantic/remap.
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS renamed_to TEXT`,
	// A likely new name offered by the sync, never applied without somebody
	// confirming it.
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS rename_candidate TEXT`,
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS rename_confidence REAL`,
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS fingerprint JSONB`,
	// When the people whose items name a missing field were told, so a later
	// sync does not tell them again.
	`ALTER TABLE source_fields ADD COLUMN IF NOT EXISTS announced_on TIMESTAMPTZ`,
	`CREATE INDEX IF NOT EXISTS source_fields_missing_idx
		ON source_fields (source_key) WHERE status = 'missing'`,

	// When a source's fields were last read from the catalogue, so the daily
	// pass knows which are due.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS fields_synced_on TIMESTAMPTZ`,

	// Protection an administrator asked for by hand, which detection never
	// turns off. Added without a default and filled from the flag as it stood,
	// because every flag set before detection existed was set by hand. The
	// default follows, so only rows present at that moment inherit.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS row_filter_forced BOOLEAN`,
	`UPDATE data_sources SET row_filter_forced = has_row_filter
	 WHERE row_filter_forced IS NULL`,
	`ALTER TABLE data_sources ALTER COLUMN row_filter_forced SET DEFAULT FALSE`,
	// When the catalogue was last asked whether the source carries a row
	// filter or a column mask, and why the last attempt failed if it did.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS protection_checked_on TIMESTAMPTZ`,
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS protection_error TEXT`,

	// Starts member_groups from the stored policies still held, so people who
	// signed in before it existed count as members straight away. A row
	// already there is newer, so it is left alone.
	`INSERT INTO member_groups (user_email, grants, checked_on)
	 SELECT DISTINCT ON (user_email) user_email, grants, computed_on
	 FROM reader_policy
	 ORDER BY user_email, computed_on DESC
	 ON CONFLICT (user_email) DO NOTHING`,

	// Home page cards kept between visits, one per figure, scope and day.
	// The scope says who a card may be handed to, as policy_class does for
	// result_cache. See lib/briefing/store.
	`CREATE TABLE IF NOT EXISTS briefing_cards (
		card_key    TEXT NOT NULL,
		day         DATE NOT NULL,
		scope       TEXT NOT NULL,
		source_key  TEXT NOT NULL,
		card        JSONB,
		computed_on TIMESTAMPTZ NOT NULL,
		expires_on  TIMESTAMPTZ NOT NULL,
		PRIMARY KEY (card_key, day)
	)`,
	`CREATE INDEX IF NOT EXISTS briefing_cards_source_idx
		ON briefing_cards (source_key)`,
	`CREATE INDEX IF NOT EXISTS briefing_cards_day_idx ON briefing_cards (day)`,

	// How many questions each conversation holds, so the history lists them
	// without unpacking every transcript. Set by saveConversation. Rows saved
	// before the column existed are counted once, and a row already counted
	// is not matched again. See lib/assistant/store.
	`ALTER TABLE assistant_conversations ADD COLUMN IF NOT EXISTS questions INTEGER`,
	`UPDATE assistant_conversations
	 SET questions = (SELECT count(*) FROM jsonb_array_elements(
	                    CASE WHEN jsonb_typeof(messages) = 'array'
	                         THEN messages ELSE '[]'::jsonb END) m
	                  WHERE m->>'role' = 'user')
	 WHERE questions IS NULL`,

	// Page views by policy class, newest first, carrying the report and the
	// reader, so the ranking of what people with the same access open reads
	// the index alone. See popularWithPeers in lib/briefing/plan.
	//
	// Built concurrently, as is the next, because usage_events is written on
	// every page view and a plain build holds those writes for as long as it
	// takes. Each statement runs outside a transaction, which this needs.
	`CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_events_peer_views_idx
		ON usage_events (policy_class, occurred_on DESC)
		INCLUDE (report_id, user_email) WHERE event_type = 'page_view'`,
	// One reader's page views, newest first, without the queries, exports
	// and other events the per reader index also holds. Read for recents and
	// for what a reader opens most.
	`CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_events_user_views_idx
		ON usage_events (lower(user_email), occurred_on DESC)
		INCLUDE (report_id) WHERE event_type = 'page_view'`,
	// Every lookup by report also names the event type, which
	// usage_events_page_idx leads with after the report.
	`DROP INDEX IF EXISTS usage_events_report_idx`,
	// Each version's change summary, written with the version so the history
	// list reads it rather than comparing snapshots. Older rows are filled in
	// when first listed. See lib/platform/history.
	`ALTER TABLE report_versions ADD COLUMN IF NOT EXISTS changes JSONB`,

	// Background work one replica does for all of them, claimed by name. See
	// lib/freshness/claim.
	`CREATE TABLE IF NOT EXISTS background_claims (
		name       TEXT PRIMARY KEY,
		claimed_on TIMESTAMPTZ NOT NULL
	)`,
	// When the freshness checker read a metric view's definition and found
	// it names something other than tables, so it is not read again until
	// the catalogue sync records a list. See lib/freshness/checker.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS base_tables_checked_on TIMESTAMPTZ`,
	// When the daily field sync of a source last failed, so no replica
	// retries it before the wait is over. See lib/semantic/fieldWatch.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS fields_sync_failed_on TIMESTAMPTZ`,
	// When anything the freshness marks read about a source last changed,
	// stamped by a trigger whoever writes it, so each replica reads only the
	// sources that moved. See lib/freshness/marks.
	`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS marks_changed_on TIMESTAMPTZ NOT NULL DEFAULT now()`,
	`DO $$ BEGIN
	   IF NOT EXISTS (
	     SELECT 1 FROM pg_proc p
	     JOIN pg_namespace n ON n.oid = p.pronamespace
	     WHERE p.proname = 'data_sources_marks_stamp'
	       AND n.nspname = current_schema()
	   ) THEN
	     EXECUTE $f$
	       CREATE FUNCTION data_sources_marks_stamp() RETURNS trigger
	       LANGUAGE plpgsql AS $b$
	       BEGIN
	         IF TG_OP = 'INSERT' OR
	            (NEW.is_active, NEW.freshness_mode, NEW.data_changed_on,
	             NEW.has_row_filter, NEW.kind, NEW.base_tables,
	             NEW.catalog_name, NEW.schema_name, NEW.object_name)
	            IS DISTINCT FROM
	            (OLD.is_active, OLD.freshness_mode, OLD.data_changed_on,
	             OLD.has_row_filter, OLD.kind, OLD.base_tables,
	             OLD.catalog_name, OLD.schema_name, OLD.object_name)
	         THEN
	           NEW.marks_changed_on := clock_timestamp();
	         END IF;
	         RETURN NEW;
	       END
	       $b$
	     $f$;
	   END IF;
	   IF NOT EXISTS (
	     SELECT 1 FROM pg_trigger
	     WHERE tgname = 'data_sources_marks_stamp'
	       AND tgrelid = 'data_sources'::regclass
	   ) THEN
	     CREATE TRIGGER data_sources_marks_stamp
	       BEFORE INSERT OR UPDATE ON data_sources
	       FOR EACH ROW EXECUTE FUNCTION data_sources_marks_stamp();
	   END IF;
	 END $$`,
	// What each watched table's loads say about when it usually loads,
	// with the newest load it was learned from, so it is learned again only
	// once a newer one lands. See lib/freshness/lateness.
	`CREATE TABLE IF NOT EXISTS table_patterns (
		table_name     TEXT PRIMARY KEY,
		pattern        JSONB NOT NULL,
		newest_arrival TIMESTAMPTZ,
		learned_on     TIMESTAMPTZ NOT NULL
	)`,
	// The last row filter walk, for every replica to take rather than walk
	// again. One row. See lib/semantic/filterDiscovery.
	`CREATE TABLE IF NOT EXISTS filter_walks (
		walk_id    SMALLINT PRIMARY KEY,
		started_on TIMESTAMPTZ NOT NULL,
		walked_on  TIMESTAMPTZ NOT NULL,
		result     JSONB NOT NULL,
		covered    JSONB NOT NULL
	)`,

	// Each assistant conversation's messages, one row each, so a save writes
	// only the messages that are new or changed. Keyed by the id the browser
	// gives a message, so a resent message replaces itself rather than
	// appearing twice, and read in position order. See lib/assistant/store.
	`CREATE TABLE IF NOT EXISTS assistant_messages (
		conversation_id UUID NOT NULL
			REFERENCES assistant_conversations (conversation_id)
			ON DELETE CASCADE,
		message_id      TEXT NOT NULL,
		position        BIGINT NOT NULL,
		role            TEXT NOT NULL,
		message         JSONB NOT NULL,
		created_on      TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (conversation_id, message_id)
	)`,
	`CREATE INDEX IF NOT EXISTS assistant_messages_order_idx
		ON assistant_messages (conversation_id, position)`,
	// Whether a conversation's transcript column has been moved into rows.
	// The column itself is left in place and no longer read once moved.
	`ALTER TABLE assistant_conversations ADD COLUMN IF NOT EXISTS messages_moved BOOLEAN NOT NULL DEFAULT false`,
	// Moves every transcript not yet moved, flagging each in the same
	// statement so it is moved once however often this runs.
	`WITH moved AS (
	     UPDATE assistant_conversations SET messages_moved = true
	     WHERE NOT messages_moved
	     RETURNING conversation_id, messages)
	 INSERT INTO assistant_messages
	     (conversation_id, message_id, position, role, message)
	 SELECT moved.conversation_id,
	        coalesce(m.elem->>'id', 'moved-' || m.ord),
	        m.ord,
	        coalesce(m.elem->>'role', ''),
	        m.elem
	 FROM moved,
	      jsonb_array_elements(
	          CASE WHEN jsonb_typeof(moved.messages) = 'array'
	               THEN moved.messages ELSE '[]'::jsonb END)
	          WITH ORDINALITY AS m(elem, ord)
	 WHERE jsonb_typeof(m.elem) = 'object'
	 ON CONFLICT (conversation_id, message_id) DO NOTHING`,

	// Retention of personal items. keep is the owner's mark exempting an item,
	// removed_on puts it in the bin, and last_opened_on is written on open at
	// most about once a day. A personal page reads its opens from usage
	// events, and restored_on counts as use after it leaves the bin. An access
	// grant switched off because its page went to the bin is marked, so a
	// restore switches back exactly those. See lib/retention.
	`ALTER TABLE reports ADD COLUMN IF NOT EXISTS keep BOOLEAN NOT NULL DEFAULT FALSE`,
	`ALTER TABLE reports ADD COLUMN IF NOT EXISTS removed_on TIMESTAMPTZ`,
	`ALTER TABLE reports ADD COLUMN IF NOT EXISTS restored_on TIMESTAMPTZ`,
	`ALTER TABLE sheets ADD COLUMN IF NOT EXISTS keep BOOLEAN NOT NULL DEFAULT FALSE`,
	`ALTER TABLE sheets ADD COLUMN IF NOT EXISTS removed_on TIMESTAMPTZ`,
	`ALTER TABLE sheets ADD COLUMN IF NOT EXISTS last_opened_on TIMESTAMPTZ`,
	`ALTER TABLE boards ADD COLUMN IF NOT EXISTS keep BOOLEAN NOT NULL DEFAULT FALSE`,
	`ALTER TABLE boards ADD COLUMN IF NOT EXISTS removed_on TIMESTAMPTZ`,
	`ALTER TABLE boards ADD COLUMN IF NOT EXISTS last_opened_on TIMESTAMPTZ`,
	`ALTER TABLE explore_views ADD COLUMN IF NOT EXISTS keep BOOLEAN NOT NULL DEFAULT FALSE`,
	`ALTER TABLE explore_views ADD COLUMN IF NOT EXISTS removed_on TIMESTAMPTZ`,
	`ALTER TABLE explore_views ADD COLUMN IF NOT EXISTS last_opened_on TIMESTAMPTZ`,
	`ALTER TABLE access_policies ADD COLUMN IF NOT EXISTS retention_held BOOLEAN NOT NULL DEFAULT FALSE`,
	`CREATE INDEX IF NOT EXISTS reports_removed_idx
		ON reports (lower(owner_email), removed_on) WHERE removed_on IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS sheets_removed_idx
		ON sheets (owner_email, removed_on) WHERE removed_on IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS boards_removed_idx
		ON boards (owner_email, removed_on) WHERE removed_on IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS explore_views_removed_idx
		ON explore_views (owner_email, removed_on) WHERE removed_on IS NOT NULL`,
	// Each warning sent, by the due date it announced, so the same date is
	// never announced twice and removal can wait out the warning period.
	`CREATE TABLE IF NOT EXISTS retention_warnings (
		kind      TEXT NOT NULL,
		item_id   TEXT NOT NULL,
		due_on    DATE NOT NULL,
		warned_on TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (kind, item_id, due_on)
	)`,

	// What each home page figure read as for each recent period, every time
	// its card was worked out, with how long after the period ended, so how
	// complete a young period usually is can be learned. Kept under the
	// card's own scope. figure names the measure and date field alone, for
	// an unusual alert on the same figure. See lib/briefing/observations.
	`CREATE TABLE IF NOT EXISTS figure_observations (
		scope       TEXT NOT NULL,
		card_digest TEXT NOT NULL,
		figure      TEXT NOT NULL,
		source_key  TEXT NOT NULL,
		period      DATE NOT NULL,
		observed_on TIMESTAMPTZ NOT NULL,
		value       DOUBLE PRECISION NOT NULL,
		age_hours   DOUBLE PRECISION NOT NULL,
		PRIMARY KEY (scope, card_digest, period, observed_on)
	)`,
	`CREATE INDEX IF NOT EXISTS figure_observations_figure_idx
		ON figure_observations (scope, figure, period)`,
	`CREATE INDEX IF NOT EXISTS figure_observations_time_idx
		ON figure_observations (observed_on)`,

	// When each home page card was last judged, as opposed to when the
	// answers it was built from were computed, so a card is judged again
	// only once time has moved past something it was judged before.
	`ALTER TABLE briefing_cards ADD COLUMN IF NOT EXISTS judged_on TIMESTAMPTZ`,
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

// The first line of a statement, for a log message that says which one failed
// without printing the whole definition.
function firstLine(statement: string): string {
	const trimmed = statement.trim();
	const breakAt = trimmed.indexOf("\n");
	return (breakAt === -1 ? trimmed : trimmed.slice(0, breakAt)).slice(0, 100);
}

// Runs every statement, and does not let one failure stop the others.
//
// These ran in a single unbroken loop, so the first statement to throw took
// every statement after it with it. That turns one bad definition into a
// database missing half its columns, and since the access tables and the
// is_personal column are in that half, into everybody being locked out by
// something unrelated.
//
// Each of these is independently useful and independently safe to retry: they
// are all IF NOT EXISTS or ADD COLUMN IF NOT EXISTS, and the next start runs
// them again. Logging and carrying on leaves the schema as complete as it can
// be rather than as complete as it got to.
async function applyAll(kind: string, all: string[]): Promise<void> {
	const failures: string[] = [];
	lastFailures = lastFailures.filter((f) => f.kind !== kind);

	for (const statement of all) {
		try {
			await sql(statement);
		} catch (error) {
			failures.push(firstLine(statement));
			console.error(
				`Schema ${kind} failed: ${firstLine(statement)}`,
				error,
			);
		}
	}

	if (failures.length > 0) {
		lastFailures.push(
			...failures.map((statement) => ({ kind, statement })),
		);
		console.error(
			`${failures.length} of ${all.length} schema ${kind} statements ` +
				`did not apply. The app is running against an incomplete ` +
				`schema and some features will not work: ${failures.join("; ")}`,
		);
	}
}

// What did not apply on the last pass, so an administrator can read the reason
// rather than only the symptom.
//
// A partial schema is the failure that reads as everything being broken with
// nothing to explain it: reports do not load, navigation is empty, and the only
// record was a console line on whichever replica lost the race. Kept in memory
// per replica, which is the same scope as everything else the diagnostics
// endpoint reports.
let lastFailures: { kind: string; statement: string }[] = [];
let lastAppliedAt = 0;

export function schemaStatus(): {
	appliedAt: number | null;
	failures: { kind: string; statement: string }[];
} {
	return {
		appliedAt: lastAppliedAt || null,
		failures: lastFailures,
	};
}

// Identifies the schema lock. Any fixed number works as long as every process
// agrees on it, so it is written here once rather than derived from anything
// that could differ between builds.
const schemaLockKey = 8577402;

// What the statements and migrations amount to, so a process can tell whether
// the store already holds exactly this schema. Any change to either list,
// including its order, changes the hash.
function schemaHash(): string {
	return createHash("sha256")
		.update(JSON.stringify({ statements, migrations }))
		.digest("hex");
}

// One row recording the hash of the last pass that applied every statement.
const stateTable = `CREATE TABLE IF NOT EXISTS platform_schema_state (
	id         INTEGER PRIMARY KEY CHECK (id = 1),
	hash       TEXT NOT NULL,
	applied_on TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export async function initPlatformSchema(): Promise<void> {
	// One initialiser at a time, across every process and every replica.
	//
	// Two callers run this in each process, because Next bundles instrumentation
	// separately from the route handlers and module state does not cross that
	// line, and every replica runs both. Nothing coordinated them.
	//
	// CREATE TABLE IF NOT EXISTS is not atomic: two sessions both find the table
	// missing and both create it, and one fails on the unique index behind the
	// type name. ADD COLUMN IF NOT EXISTS and ALTER TABLE OWNER TO race the same
	// way, as tuple concurrently updated and as a deadlock. applyAll logs each
	// failure and carries on by design, so the loser of the race did not fail to
	// start, it started against half a schema, and every read after that failed
	// with nothing to say why. That is the shape of having to start the app
	// several times before it works.
	//
	// Waiting rather than skipping: the cost is one initialiser at a time on a
	// path that runs once per module instance, and skipping would let a caller
	// carry on against a schema still being built.
	await withAdvisoryLock(schemaLockKey, async () => {
		// One cheap statement before fifty nine expensive ones. An unreachable
		// store fails every statement in turn otherwise, which logs the same
		// fault sixty times, takes sixty round trips to conclude, and repeats on
		// the next request because the memo is cleared on failure.
		await sql("SELECT 1");

		// Every process runs this, usually against a store that already holds
		// the same schema. A matching hash means the last full pass applied
		// every statement in these lists, so the pass is skipped.
		//
		// A state table that cannot be read is not a reason to stop. The full
		// pass runs instead, as it would with no record at all.
		const hash = schemaHash();
		const stored = await (async () => {
			await sql(stateTable);
			return await sql<{ hash: string }>(
				`SELECT hash FROM platform_schema_state WHERE id = 1`,
			);
		})().catch((error) => {
			console.warn("Schema state could not be read:", error);
			return [] as { hash: string }[];
		});
		if (stored[0]?.hash === hash) {
			lastFailures = [];
			lastAppliedAt = Date.now();
			return;
		}

		await applyAll("setup", statements);

		// Between the two, because a migration is an ALTER TABLE and that is the
		// statement ownership gates. A table this identity created a moment ago is
		// already its own, so this is for the ones an earlier identity created.
		//
		// Not allowed to stop the migrations either. Ownership is about who may
		// alter a table later, and failing to adopt one is not a reason to skip
		// adding a column to every other table.
		try {
			await adoptSchemaOwner();
		} catch (error) {
			console.error("Schema ownership could not be adopted:", error);
		}

		await applyAll("migration", migrations);
		lastAppliedAt = Date.now();

		// Recorded only after a pass with no failures, so a statement that did
		// not apply is tried again on the next start.
		if (lastFailures.length === 0) {
			await sql(
				`INSERT INTO platform_schema_state (id, hash, applied_on)
				 VALUES (1, $1, now())
				 ON CONFLICT (id) DO UPDATE
				 SET hash = EXCLUDED.hash, applied_on = EXCLUDED.applied_on`,
				[hash],
			).catch((error) => {
				console.warn("Schema state could not be recorded:", error);
			});
		}
	});
}

// Removes expired presence and cache rows. Cheap, and called on a timer
// rather than on the request path.
export async function sweepExpired(): Promise<void> {
	await sql(`DELETE FROM presence WHERE expires_on < now()`);
	// Arrivals are learned from over six weeks. Older ones say nothing more.
	await sql(
		`DELETE FROM table_arrivals WHERE arrived_on < now() - interval '60 days'`,
	);
	await sql(`DELETE FROM result_cache WHERE expires_on < now()`);
	// A card from a week ago is no longer what anyone is shown first.
	await sql(
		`DELETE FROM briefing_cards WHERE day < current_date - interval '7 days'`,
	);
	// Readings are learned from over five weeks. Older ones say nothing more.
	await sql(
		`DELETE FROM figure_observations
		 WHERE observed_on < now() - interval '45 days'`,
	);
	await sql(`DELETE FROM reader_access WHERE expires_on < now()`);
	await sql(`DELETE FROM reader_policy WHERE expires_on < now()`);

	// The chunks go with the job, by the foreign key.
	await sql(`DELETE FROM export_jobs WHERE expires_on < now()`);

	// An inbox is for what is recent. Read entries go after a quarter, unread
	// ones after a year, so something never opened is not lost the moment it
	// ages past the ones that were.
	await sql(
		`DELETE FROM notifications
		 WHERE (read_on IS NOT NULL AND created_on < now() - interval '90 days')
		    OR created_on < now() - interval '365 days'`,
	);
	await sql(
		`DELETE FROM alert_events WHERE fired_on < now() - interval '365 days'`,
	);
	await sql(
		`DELETE FROM page_alert_events WHERE fired_on < now() - interval '365 days'`,
	);
	// A scope nobody has been read for in a month belongs to access nobody
	// holds any more, or to a subscriber who stopped visiting. One claimed
	// and never checked is judged by when it was claimed.
	await sql(
		`DELETE FROM page_alert_state
		 WHERE coalesce(last_checked_on, next_check_on)
		       < now() - interval '30 days'`,
	);
	await sql(`DELETE FROM sheet_presence WHERE expires_on < now()`);
	// A recording older than a day is never used, so it is not kept.
	await sql(
		`DELETE FROM alert_access WHERE captured_on < now() - interval '2 days'`,
	);

	// A job whose replica went away mid-run is otherwise "running" for ever,
	// and the page waiting on it never stops waiting.
	//
	// Silence is the signal, not elapsed time. A job that has written a batch
	// recently is working however long it has been going, and one that has
	// written nothing for ten minutes is not coming back.
	// A sync whose replica went away mid-walk is otherwise "running" for ever,
	// and the administration page says so on every visit. Same reading as the
	// export jobs above: silence rather than elapsed time, because a large
	// catalogue takes a while and a dead run stopped the moment it died.
	await sql(
		`UPDATE sync_runs
		 SET finished_on = now(),
		     current = NULL,
		     error = 'The sync stopped before it finished.'
		 WHERE finished_on IS NULL
		   AND coalesce(progress_on, started_on) < now() - interval '10 minutes'`,
	);

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
