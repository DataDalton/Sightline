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
  pages, visuals, saved views, edit history, settings, the usage log and the
  access it keeps of its own. A Databricks App has no disk that survives a
  restart, so none of this can live on the container. Databricks Lakebase is
  managed Postgres and is the supported option there. A plain `DATABASE_URL`
  works anywhere else.
- **A SQL warehouse** answers every data query, live. Nothing is copied into
  Postgres except cached results.

### Every query runs as the person who asked

Data queries run under each caller's own forwarded token, so Unity Catalog
applies that person's row filters and column masks for the real user rather
than for the application.

That removes a whole class of bug. Application code cannot forget to apply a
predicate, because there is no unfiltered result for it to forget about.

One path does run as the application, in `lib/data/appSession.ts`, and it exists
for questions that are not about anybody in particular. Which groups a row
filter branches on is a property of the catalogue, not of the reader, and the
answer has to be the same on every replica or the cache is partitioned
differently depending on who happened to ask first.

That path needs `SELECT`, so the service principal can read data it never
returns. The separation is therefore structural rather than a matter of
privilege: `queryAsApp` is called only from catalogue metadata code, and no
route that serves a dataset can reach it. Read that file before changing who
calls it.

### Who can open what

Reachability comes from Unity Catalog. A `SELECT` grant on the data a report is
built from is already a statement that the grantee should see that report, so
the platform asks the catalogue under the reader's own token instead of keeping
a second list that says the same thing and goes stale.

Explicit grants still exist for the cases the catalogue cannot express, and they
merge with what the catalogue says rather than replacing it. The stronger of the
two wins, so catalogue access implies view and somebody handed edit keeps edit.

The answer is held in three tiers, because they differ by a factor of a hundred:
in memory per replica, in Postgres across replicas, and in the warehouse where
the real question lives. A reader waits for the warehouse once, then the answer
is refreshed behind whatever request happened to need it.

Reachability is all this decides. Which rows come back is still Unity Catalog's,
on the real query, under the same token.

### Caching without leaking

Results are cached, and a cache hit skips the warehouse entirely, which means
it also skips the row filter. So a cached answer may only be served to someone
who provably sees the same rows.

Each caller resolves to a **policy class**: the set of groups that decide their
row visibility. Two readers share a cached result only when every one of those
groups agrees for both.

The platform discovers that set itself. It walks the row filters on each source,
reads the body of the function each one names, and collects the groups those
bodies branch on. The walk runs on the application's own schedule under its own
identity, so a filter somebody edits is picked up without anyone maintaining a
list or remembering to press anything.

Where the walk cannot see an answer it says so rather than inferring one. A
filtered source whose groups are unknown is **not cached at all**, for anybody,
because an empty result and a source with no filter look identical from the
outside and only one of those is safe to act on. **Administration -> Audit ->
Cache partitioning** reports which sources are in that state and why, and lists
every group it found in a filter.

Metric view definitions are the expensive half of the walk, a few hundred
milliseconds and up to 110KB of YAML each, so the tables they resolve to are
written down and reused. The filters on those tables are re-read every walk,
because that is the part that has to stay current.

### What a page costs to open

The document carries its own data. A page used to arrive, then its bundle, then
React hydrated, and only then did the browser start asking who the reader was,
what the navigation held and what the report contained. Four sequential trips
before anything appeared, three of them spent discovering things the server
already knew while it was rendering.

Now the server component resolves them and hands them down as SWR fallback data,
so the first paint has the shell, the navigation and the report definition
already in it. The visuals still fetch their own rows, because those depend on
filters the client owns.

Seeding is bounded. A replica that is not warm yet renders the page without it
and lets the client ask, because a shell with placeholders beats a blank browser
waiting on a first database connection.

### Taking data out

Export runs behind the request rather than inside it. Asking for one records a
job and returns; the work streams rows out of the warehouse in batches and
writes them to Postgres as it goes, so nothing ever holds the whole file, the
reader can leave the page, and the result can be collected from a replica that
had nothing to do with producing it.

One export is capped at 50,000 rows. That is a statement about what an export is
for, which is a spreadsheet somebody works with. A file that reaches the ceiling
says so rather than ending on a round number.

Every export writes an audit row naming who took what before the query runs, so
an attempt that fails is still on record. **Administration -> Audit -> Export
audit** lists them.

### The dictionary

Every field on every source a reader can see, with the definition written on
the source itself, its type and, for a metric view, the expression that
calculates it. Opening a field shows which reports use it and how: as a
dimension, a measure, a filter or a sort. That is the list to read before
renaming or retiring anything, and a filter is the reference most easily
missed. Fields no visual uses are listed on their own.

Definitions come from the catalogue rather than a copy kept here, so a comment
edited on the view is what the dictionary shows. Calculations are read from the
view definition under the reader's own token, which needs the same `SELECT` the
data does. Usage lists only reports the reader can open.

### Exploring without a report

`/explore` is a table built from one search bar. Type a dataset, then the
columns wanted, then conditions:

| Typed | Means |
| --- | --- |
| `Category = Hardware` | equals, also `is`, `!=`, `>`, `>=`, `<`, `<=` |
| `Category in Hardware, Software` | any of the values, `not in` for none of them |
| `Customer contains North` | also `starts with` and `ends with` |
| `Region is empty` | blank, also `is not empty` |
| `not Status = DRAFT` | keeps every row the condition does not match, blanks included |
| `or Region = East` | joins this condition to the last with OR |
| `(Category = Hardware` ... `or Category = Software)` | groups conditions, nested as deep as needed |

Brackets are read first, then AND before OR, so `A and B or C` is either both A
and B, or C, while `A and (B or C)` is A with either B or C. Brackets show either
side of the filters they group, and clicking one removes it and its pair.

Everything inside one OR, or under a NOT, has to be the same kind of field,
dimensions or measures, because a dimension is tested per row before grouping
and a totalled measure after it. AND has no such limit, so `Region = West and
(Revenue > 1000000 or Units > 50)` works. Every field in the list also has a
Filter button, and the bar has one of its own.

The table follows the bar as it changes, through the same query endpoint every
report uses, so row filters, caching and the export audit all apply. The
exploration is written into the address, so a reload comes back to it and the
address can be shared. It can also be saved by name under **Saved views**. A
saved view holds the question rather than the answer, so opening it shows the
data as it is now. Saved views are private to whoever saved them.

### The data assistant

Off unless a model endpoint is configured. When it is, an **Ask** button sits
on every page and opens a panel, and `/assist` is the same conversation at full
width.

It works the way an analyst does: finds the dataset, reads the field
definitions, runs queries, reads the rows, runs more, then writes up what it
found with charts where they add something. Each step is shown as it happens,
with how long it took, how many rows came back and the first of them. It is told
which report and page are open, and anything on the page can be pointed at and
added to the question, which for a chart hands over the numbers it draws.

What it can do is bounded by the same layer everything else uses:

- The model never writes SQL. It asks for a query in the same small shape a
  visual does, and every field name is checked against the source, by kind,
  before anything runs. A name the source does not have is refused, not
  guessed at.
- Every query runs through the ordinary executor under the asking person's
  token. It sees their rows and nobody else's, and it is only told about
  sources they can read.
- Figures are to be reported as they came back, and it is told not to state a
  number it did not query.

The model is shown field names and definitions, the rows its queries return,
and whatever was pointed at. Conversations are saved per person so they can be
reopened, and each person can give it standing instructions and ask it to
remember things. None of that is visible to anybody else, administrators
included.

### Sheets

A sheet is a live table from one dataset with the reader's own columns on
top, for the work people used to export to a spreadsheet for. The rows come
from the same search bar as Explore and are read again whenever the sheet is
opened, so it stays current. The dataset is never changed.

- **Formula columns** are worked out from each row with a small spreadsheet
  language: columns by name in square brackets, arithmetic and comparison, `&`
  to join text, and functions such as `IF`, `ROUND`, `IFERROR` and `COALESCE`.
  `SHARE`, `RANK`, `PREVIOUS`, `RUNNING` and `TOTAL` look down the whole
  column. Formulas may read each other, and a loop reads as `#CYCLE!` rather
  than hanging.
- **Notes columns** hold text typed beside a row, kept with the sheet and tied
  to the row's grouping values, so a note stays with its row across refreshes.
- **Pivot** lays out fields down the side, one across the top and measures in
  the cells. Every total is asked of the warehouse at its own grain rather than
  added up from the cells, so an average's total is the average.
- The grid selects and copies ranges, moves with the keyboard, sorts, resizes,
  freezes columns and formats numbers, and sums what is selected.

Sheets are shared with named people, to view or to edit, and each person sees
their own rows of the data under their own access, as with a report. Notes are
returned only for the rows in that person's answer, and written only to a row
they can see, so a note's row cannot show somebody a value their filter hides.
Everyone with a sheet open sees who else has, and which cell each has
selected, and a change made by one reaches the others within a few seconds. A
change made from an out of date copy is refused and reloaded rather than
silently overwriting the other one.

**Download** returns the sheet as CSV with its formulas worked out on the
server, up to the query ceiling, and is recorded in the export audit like any
other export. A note beginning with `=` is written as text so a spreadsheet
program does not run it.

### Alerts and the inbox

An alert watches one measure, either as a total or for each value of a field,
narrowed by the same conditions Explore writes. It says something when the
value goes above or below a line, when it rises or falls by more than a
percentage since the last check, or when it changes at all. A line is reported
once when it is crossed, not on every check it stays crossed, and optionally
again when the value is back. When several values cross at once the alert sends
one message listing them.

Alerts are made from **Alerts**, or from **Explore** with the numbers already
on screen, and the dialog shows the current value before anything is saved.
Checks land on the hour, hourly, daily, on weekdays or weekly, in the owner's
own time zone, so a warehouse that stops when idle is started once for every
alert due at that hour.

A check needs somebody's authority to query, and a person's token only exists
while they are using the app. So:

- On a dataset that shows everybody the same rows, with no row filter and no
  column mask, a check runs on its schedule as the app. That is the same answer
  the owner would get, for the same reason the result cache shares one answer
  between every reader of such a dataset. It runs only while the owner has been
  seen able to read the dataset within the last day, so a withdrawn grant stops
  their alerts no later than it stops everything else.
- On a row-filtered dataset, the app records what the owner can see while they
  are using it. A row filter decides each row from a few of that row's columns,
  so the app asks, under the owner's own token, for every combination of those
  columns they can see. A scheduled check then runs as the app, narrowed to
  exactly those combinations, which returns the owner's rows. The recording is
  taken again at most hourly while they are here and is not used once it is a
  day old. A value that appears after it was taken is left out until the next
  one, which errs towards showing less.
- That needs every column the filter reads to be a field of the dataset as it
  stands, with the filter on the table the dataset reads rather than on a
  joined one, no column mask, and no more than 500 combinations for the person.
  The filter walk works this out for each dataset. Anything else is checked
  under the owner's own token while they are using the app, and the alert says
  so. Exposing a filter's columns as fields on the dataset is what moves it
  from one to the other.

Everything anybody is told lands in their **Inbox**: alerts, pages shared with
them, and announcements an administrator sends. A bell in the header carries
the unread count. Entries can be marked read or unread and cleared, and each
one opens the page it is about. An alert's message opens Explore on the numbers
it read.

### On a phone, and installed

Every page works at phone width. A tab bar at the foot of the screen carries
Home, Explore, the assistant, the inbox and the menu, dialogs rise from the
bottom, tables become cards, and an opened visual takes the screen.

The app can be installed, from the browser's install button on a desktop or
Android, or with **Add to Home Screen** on iPhone and iPad, where **Install on
this device** in the account menu shows the steps. Installed, it opens in its
own window with its unread count on its icon. A service worker keeps the
build's assets on the device so it opens quickly, and shows a page saying so
when there is no connection. It keeps nothing else: every page and every answer
is specific to the person and their access, so none of it is stored on the
device.

With push turned on by an administrator, anyone can have their inbox sent to
their phone or computer from **Inbox -> Settings**, choosing which kinds, and
seeing and removing the devices that receive them. On iPhone and iPad a push
only reaches the installed app.

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

## Administration

At `/admin`, for anyone in an administrator group. One list down the side, in
five groups, and each pane has its own address so it can be linked.

| Group | What is there |
| --- | --- |
| Activity | Adoption, cost and failures over a window. Which reports are opened, by whom, and where warehouse time goes |
| Access | Roles and what they allow, who holds what, direct grants, an access review for one person and one report, and the groups that hold access before any role does |
| Audit | Every recorded change, every export, and cache partitioning |
| Content | Registered sources and the catalogue sync, categories, and personal pages |
| Platform | What this replica holds, where it is connected, branding, the warehouse, cache budgets, the assistant endpoint, and notifications |

Every category has an editor role of its own, named after it, such as "Sales
Performance - Editor". Whoever holds one builds and maintains the reports in that
category and nowhere else, with what the Editor role grants. The platform keeps
these roles itself. Each one is created with its category, renamed when it is
renamed and retired when it is removed, and nobody can change or delete one by
hand, so they cannot drift from each other or from the Editor role. They are
listed under **Access -> Roles** with who holds each, and an assignment of one
always applies in its own category whatever scope the request named. Scoped
assignments of other roles remain for anything these do not cover.

Whoever holds a category's editor role is also who readers take questions to.
The category page shows them in a panel, and every report in it shows them as
an **Ask** button beside its title. Asking opens a message addressed to all of
them, or to the one person or group pressed, and sends it through the
application rather than by email. It lands in their inbox under
**Conversations**, and both sides reply there. Every message is also a
notification, so it reaches a phone the way an alert does.

A group is asked as one conversation that everyone in it shares. Who is in the
group is read when each person looks, so somebody who joins the team sees what
was already asked, and somebody who leaves stops seeing it. Every member who
has ever used the application is notified, from the groups they were in the
last time they signed in. Somebody who has never used it is not.

Only the maintainers of a category someone can open can be written to this
way, and one person can start a limited number of conversations an hour.
Nothing is shown for a category with no editor assigned.

**Notifications** turns alerts and pushes on or off, sets how many alerts one
person may keep, shows how many alerts and devices there are and which alerts
are failing and why, sends an announcement to everyone who used the app in the
last 90 days, and replaces the push keys.

The catalogue sync refreshes what the platform knows about its sources, and walks
the row filters again. It runs to completion on the server, so leaving the page
does not stop it, and the Sources pane shows when it last finished and who ran
it.

## Deploying

`app.yaml` sits at the repository root, which is where Databricks Apps reads it
from. It holds names, never values: each entry points at a resource bound to the
app, and the value lives in that resource. A resource that is bound but not
named here never reaches the container.

Configuration lives in several places, and they hold different things:

| Where | What |
| --- | --- |
| `app.yaml` | Which bound resources become which environment variables |
| The app's configuration in Databricks | The resource bindings themselves, the user authorization scopes, the bootstrap admin group |
| The Lakebase instance | A login role for the service principal, and ownership of the platform schema |
| Unity Catalog | What each reader may select, and what the service principal may read to walk the filters |
| Model serving | Who may query the assistant's endpoint, when it is used |
| **Administration** in the app | Name, description, logo, SQL warehouse, cache budgets, assistant endpoint, alerts and push notifications, editor and admin groups, extra policy groups |

Connection targets have to be known **before** the platform can read its own
settings table, so they cannot live in it. A field for the database connection
would be a way to lock the platform out of the database holding the field.

Everything in the last row is changed without a redeploy and reaches every
replica within a refresh interval.

### The platform schema

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

### Catalogue privileges

Two principals need grants, for different reasons.

**Readers**, by group rather than per person:

```sql
GRANT USE CATALOG ON CATALOG <catalog> TO `<reader group>`;
GRANT SELECT ON SCHEMA <catalog>.<schema> TO `<reader group>`;
```

They also need `CAN USE` on the SQL warehouse. Unity Catalog decides what they
may read, the warehouse is what runs the query, and a reader holding one without
the other gets an empty platform rather than an error that explains itself.

**The service principal**, so it can walk the row filters:

```sql
GRANT SELECT ON CATALOG <catalog> TO `<app service principal client id>`;
```

Nothing less works, and nothing less fails loudly. `BROWSE`, `USE SCHEMA` and
`EXECUTE` on the filter functions all leave the walk blind. `SHOW CREATE TABLE`
on a metric view is gated behind `SELECT`, and `information_schema.row_filters`
returns **zero rows** rather than an error to a principal without it, which is
indistinguishable from a source that carries no filter. Cache partitioning
reports the shortfall rather than assuming its way past it, so the symptom is
reports that are never cached, not reports that leak.

After granting, run the catalogue sync under **Administration -> Content ->
Sources**. **Administration -> Audit -> Cache partitioning** should then read
"Answers are partitioned" and list each group with the reason "found in a row
filter". Only groups named in an access rule, and none from a filter, means the
walk still cannot read the filters.

The grant lets the service principal read data, which is why the separation
described under "Every query runs as the person who asked" is structural. The
principal's queries are catalogue metadata only.

### On behalf of the user

Not optional. Without user authorization there is no identity to query as, and
every report returns an access error.

Scopes are granted on the app record rather than in `app.yaml`, and read back
as `user_api_scopes`. `app.yaml` lists them for reference only.

| Scope | For |
| --- | --- |
| `sql` | Every data query, and the membership probe that resolves a policy class. Without it every query fails |
| `model-serving` | The assistant's model calls, made as the person asking. Only needed when the assistant is configured |

Set both under the app's **User authorization** in the workspace, or:

```bash
databricks apps update <name> --json '{"user_api_scopes": ["sql", "model-serving"]}'
```

`databricks apps get <name>` reports the effective list. A change takes effect
at the next sign in, because the scopes are baked into the token, and readers
are asked to consent again.

`/api/user` reports `canQueryAsUser`, which is true exactly when the token
arrived.

### The data assistant

Name a serving endpoint under **Administration -> Platform -> Assistant**. The
name is enough: the address is built from the workspace the app is already
connected to. A full address can be given instead for a model hosted
elsewhere. Any endpoint with the `llm/v1/chat` task works, and changing the name
changes the model with no redeploy. Clearing it removes the assistant, its
navigation entry and its routes.

Two things have to be true for it to work:

- **The endpoint is queryable.** Grant `CAN QUERY` on it to the reader groups,
  and to the app's service principal. Built in `databricks-*` endpoints are
  often open to every workspace user already, so check the endpoint's
  permissions first.
- **The call has an identity.** With `model-serving` granted, each
  model call goes out as the person asking. Without it the app's service
  principal carries the call instead. Either way the data queries it runs are
  made as the person asking, under `sql`.

The assistant's conversations, standing instructions and saved memories are kept
in the platform schema, per person, in `assistant_conversations` and
`assistant_profiles`. Saved Explore views are in `explore_views`, and sheets
in `sheets`, `sheet_shares`, `sheet_cells` and `sheet_presence`.

### Notifications

The inbox and alerts need nothing beyond the platform schema. They are in
`notifications`, `alert_rules` and `alert_events`, and what each person was
recorded seeing of a row-filtered dataset is in `alert_access`. The filter walk
writes, per dataset, which fields its filters decide on and whether a column is
masked, which needs the same `SELECT` the walk already has.

Pushes to phones and computers are off until turned on under **Administration
-> Platform -> Notifications**. Turning them on generates the key pair pushes
are signed with and stores it in `push_keys`. Keep that row: every device
subscribed against its public half, and a new pair means everybody turns
pushes on again. Devices are in `push_subscriptions`, and what each person
wants pushed in `notification_prefs`.

A push is sent from the app to the push service of the browser that subscribed,
run by Google, Apple, Mozilla or Microsoft, which delivers it to the device. The
app therefore needs outbound HTTPS to `*.googleapis.com`, `*.push.apple.com`,
`*.push.services.mozilla.com` and `*.notify.windows.com`. It posts to nothing
else, whatever address a browser hands it. The message is encrypted to the
device, so the push service carries it without being able to read it. A device
that the service reports gone is forgotten, and one that keeps failing is
dropped.

The manifest and the service worker are served by the app behind the same sign
in as everything else. The manifest is requested with credentials, because
without the session cookie the sign in intercepts it and the install fails
without saying why.

## Tests

```bash
npm test
```

Covers the query builder including NOT, OR and the recorded-access restriction, the saved-view overlay, layout
arithmetic, conditional formatting, brush selection geometry, version diffing,
row filter group discovery, metric view calculation parsing, field usage
lookup, hostname parsing, CSV encoding and the SVG sanitiser. For Explore it
covers condition parsing and the address encoding. For the assistant it covers
the refusal of every malformed or out of catalogue query, the streamed response
format as a Databricks endpoint sends it, and how streamed events build the
transcript. For alerts it covers when each condition fires and when it stays
quiet, the wording of what it sends, schedules across a daylight saving
change, reading a filter's columns out of the catalogue and mapping them onto
fields. Push encryption is checked byte for byte against the worked example in
RFC 8291, and the push signature against its own public key. For sheets it
covers the formula language, including errors, cycles and the functions that
read down a column, and pivot layout with totals taken from the warehouse.

## Repository layout

```text
backend/ui/
  app/          Routes, the reader, the editor, the admin section,
                the dictionary, explore, sheets, the assistant, the
                inbox and alerts
  lib/          Query building, semantic layer, auth, platform tables,
                the assistant's agent and its query validation,
                alert checks, push delivery, and the sheet formula
                language
  public/       The service worker and the offline page
  scripts/      Maintenance and the manifest importer
examples/       A worked import manifest
docs/           Logo and documentation assets
```

## Licence

MIT.
