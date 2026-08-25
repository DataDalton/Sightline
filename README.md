<p align="center">
  <img src="docs/logo.svg" alt="Sightline" width="72" height="72">
</p>

<h1 align="center">Sightline</h1>

<p align="center">
  A self-serve reporting platform that runs as a Databricks App.<br>
  One shared definition per report, and everyone keeps their own view of it.
</p>

---

## What it is for

Reporting tools tend to force a choice. Either a central team owns every report
and each change is a ticket, or everyone builds their own and no two numbers
agree. Neither is what people actually want, which is usually "this report, but
with my columns".

So a report here has one definition that a central group edits and publishes to
everyone, and each reader keeps an arrangement on top of it: their columns,
their filters, their sizes, their sort. The two do not fight, because a saved
view records the **differences** against the report rather than a snapshot of
it. When an editor adds a measure, it appears for people who have personalised
as well as for people who have not. A reader only loses a column by hiding it
themselves.

## How it works

- **Next.js** serves the application and its API routes.
- **Postgres** holds everything the platform knows about itself: reports,
  pages, visuals, saved views, access policy, edit history, settings and the
  usage log. A Databricks App has no disk that survives a restart, so none of
  this can live on the container. Databricks Lakebase is managed Postgres and
  is the supported option there; a plain `DATABASE_URL` works anywhere else.
- **A SQL warehouse** answers every data query, live. Nothing is copied into
  Postgres except cached results.

### Every query runs as the person who asked

Data queries run under each caller's own forwarded token, so Unity Catalog
applies that person's row filters and column masks for the real user rather
than for the application. The service principal deliberately has **no path to
user-facing data**, it reaches platform metadata only.

That removes a whole class of bug. Application code cannot forget to apply a
predicate, because there is no unfiltered result for it to forget about.

### Caching without leaking

Results are cached, and a cache hit skips the warehouse entirely, which means
it also skips the row filter. So a cached answer may only be served to someone
who provably sees the same rows.

Each caller resolves to a **policy class**: the set of groups that decide their
row visibility. Two readers share a cached result only when every one of those
groups agrees for both. The groups are **discovered from the catalogue** rather
than configured, the platform reads the row filters on each source and probes
whatever groups they branch on, so the list follows a filter somebody edits
without anyone maintaining it.

## Getting started

```bash
cp backend/ui/.env.example backend/ui/.env   # then fill it in
cd backend/ui
npm install
npm run dev
```

Local development runs queries as whoever your Databricks credentials belong
to. It does **not** reproduce another user's row filtering, and the module that
does it refuses to load in a deployed app.

### Creating reports

Reports are edited in the app, but a migration needs bulk creation. The
importer reads a manifest describing sources, categories, reports, pages and
visuals:

```bash
node scripts/import.mjs ../../examples/manifest.example.json --dry-run
```

It validates against the same visual catalogue the editor uses, so a manifest
cannot create something the editor would refuse to save, and it reports every
problem at once with the path to each. Existing reports are left alone unless
`--replace` is passed, because by the time an import is re-run somebody has
usually edited what it would overwrite.

`examples/manifest.example.json` is a worked example.

## Deploying

`app.yaml` sits at the repository root, which is where Databricks Apps reads it
from. It holds names, never values: each entry points at a resource bound to the
app, and the value lives in that resource. A resource that is bound but not
named here never reaches the container.

Configuration lives in three places, and they hold different things:

| Where | What |
| --- | --- |
| `app.yaml` | Which bound resources become which environment variables |
| The app's configuration in Databricks | The resource bindings themselves, the user authorization scope, the bootstrap admin group |
| The Lakebase instance | A login role for the service principal, and ownership of the platform schema |
| **Administration -> Configuration** in the app | Name, description, logo, SQL warehouse, cache budgets, editor and admin groups, extra policy groups |

Connection targets have to be known **before** the platform can read its own
settings table, so they cannot live in it. A field for the database connection
would be a way to lock the platform out of the database holding the field.

The app runs `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` on every start, so it owns its schema rather than borrowing it. Postgres
checks ownership before it reads an `ALTER TABLE` subcommand, and it skips any
`search_path` entry the role cannot access, so a role without `USAGE` sees the
platform tables as nonexistent rather than as forbidden. Give the schema to a
role both a human and the service principal belong to:

```sql
CREATE ROLE sightline_owner;
GRANT sightline_owner TO "you@example.com";
GRANT sightline_owner TO "<app service principal client id>";

ALTER SCHEMA sightline OWNER TO sightline_owner;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'sightline' LOOP
    EXECUTE format('ALTER TABLE sightline.%I OWNER TO sightline_owner', r.tablename);
  END LOOP;
END $$;
```

Ownership through a group role rather than an individual means adding another
principal later is a `GRANT` rather than an ownership migration.

Bind the Lakebase instance as a database resource on the app even though
nothing in `app.yaml` reads from it. Binding is what provisions the Postgres
role for the service principal, and without that role the app mints a valid
token that the database refuses with `28P01`, because there is no role of that
name to log in as.

The user authorization scope is granted on the app record rather than in
`app.yaml`, and reads back as `user_api_scopes`. Without `sql` in that list the
app forwards no usable token and every query fails, whatever this file says.
`databricks apps get <name>` reports the effective list.

Everything in the last row is changed without a redeploy and reaches every
replica within a refresh interval.

### On behalf of the user

Not optional. Without user authorization there is no identity to query as, and
every report returns an access error. Declare the `sql` scope, and grant each
reader `SELECT` on the views they should see plus `CAN USE` on the warehouse -
by group, not per person.

`/api/user` reports `canQueryAsUser`, which is true exactly when the token
arrived.

## Tests

```bash
npm test
```

Covers the query builder, the saved-view overlay, layout arithmetic,
conditional formatting, brush selection geometry, version diffing, row filter
group discovery and the SVG sanitiser.

## Repository layout

```text
backend/ui/
  app/          Routes, the reader, the editor, the admin section
  lib/          Query building, semantic layer, auth, platform tables
  scripts/      Maintenance and the manifest importer
examples/       A worked import manifest
docs/           Logo and documentation assets
```

## Licence

MIT.
