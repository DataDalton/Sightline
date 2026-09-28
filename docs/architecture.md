# Architecture

How Sightline answers a question, who it answers it for, and how it keeps
answers current without handing one reader another reader's rows.

- [The pieces](#the-pieces)
- [Every query runs as the person who
  asked](#every-query-runs-as-the-person-who-asked)
- [Who can open what](#who-can-open-what)
- [Caching without leaking](#caching-without-leaking)
- [How current an answer is](#how-current-an-answer-is)
- [What a page costs to open](#what-a-page-costs-to-open)

## The pieces

- **Next.js** serves the application and its API routes.
- **Postgres** holds everything the platform knows about itself: reports,
  pages, visuals, saved views, edit history, settings, the usage log and its
  own access records. A Databricks App has no disk that survives a restart, so
  none of this lives on the container. Databricks Lakebase is the supported
  option there, and a plain `DATABASE_URL` works anywhere else.
- **A SQL warehouse** answers every data query. Nothing is copied into Postgres
  except cached results.

## Every query runs as the person who asked

Data queries run under each caller's own forwarded token, so Unity Catalog
applies that person's row filters and column masks. Application code cannot
forget a predicate, because there is no unfiltered result to forget it on.

One path runs as the application, in `lib/data/appSession.ts`, for questions
that are about the catalogue rather than any reader. Which groups a row filter
branches on has to be the same answer on every replica, or the cache would be
partitioned by whoever asked first.

That path needs `SELECT`, so the service principal can read data it never
returns. The separation is structural rather than a matter of privilege.
`queryAsApp` is called only from catalogue metadata code, and no route that
serves a dataset can reach it. Read that file before changing who calls it.

## Who can open what

Reachability comes from Unity Catalog. A `SELECT` grant on the data a report
is built from already says the grantee should see that report, so the platform
asks the catalogue under the reader's token instead of keeping a second list
that goes stale.

Explicit grants cover what the catalogue cannot express, and merge with it
rather than replacing it. The stronger of the two wins, so catalogue access
implies view and somebody handed edit keeps edit.

The answer is held in memory per replica, in Postgres across replicas, and in
the warehouse where the real question lives. A reader waits for the warehouse
once, and the answer is then refreshed behind later requests.

Reachability is all this decides. Which rows come back is still Unity
Catalog's, on the real query, under the same token.

## Caching without leaking

A cache hit skips the warehouse, and so skips the row filter. A cached answer
may therefore only be served to someone who provably sees the same rows.

Each caller resolves to a policy class, the set of groups that decide their
row visibility. Two readers share a cached result only when every one of those
groups agrees for both. A source with no row filter shares one answer across
everybody.

The platform finds those groups itself. It walks the row filters on each
source, reads the body of the function each one names, and collects the groups
those bodies branch on. The walk runs on the application's own schedule under
its own identity, so an edited filter is picked up without anyone maintaining
a list.

Where the walk cannot see an answer it says so rather than inferring one. A
filtered source whose groups are unknown is not cached at all, because an
empty result and a source with no filter look identical from outside and only
one of them is safe. Administration > Audit > Cache partitioning reports
which sources are in that state and why, and lists every group found in a
filter.

Metric view definitions are the slow part of the walk, so the tables they
resolve to are recorded and reused. The filters on those tables are re-read
every walk, because that part has to stay current.

## How current an answer is

Results are cached in three tiers:

| Tier | Where | Notes |
| --- | --- | --- |
| L1 | Memory on each replica | Fastest. Lost on restart, bounded by size rather than count |
| L2 | `result_cache` in Postgres | Shared across replicas and restarts, so a cold replica does not go straight to the warehouse |
| L3 | The SQL warehouse | The only authoritative answer |

How long an answer is reused depends on the source:

- **On a schedule** (the default). Answers are reused for the source's own reuse
  time, or the platform's when that is zero, an hour by default. Once that
  passes, the next reader gets the old answer at once and a fresh query runs
  behind the request, so the reader after them gets new data. The "Serve while
  refreshing" switch under Administration > Platform turns that off.
- **Streams in continuously** (live). Answers are reused only for the live
  interval, 15 seconds by default, and never served past it. Open pages ask
  again on that interval while the tab is visible, so charts follow the data
  without a reload, and each visual is labelled as live. Live sources are not
  warmed ahead of readers, since an answer fetched early expires before anyone
  arrives. Set this per source in the source's edit dialog, and the interval
  under Administration > Platform > Caching.

Identical requests that arrive together share one warehouse query. When a
reader opens the app, the landing pages they are likely to open next are
queried ahead of them, and a new report's queries run when it is created.

Nothing yet clears a scheduled source's cache when its table is reloaded. A
page can show pre-load figures until the entry expires, so set the reuse time
to match how often the data lands, or mark the source live.

## What a page costs to open

The document carries its own data. The server resolves the shell, the
navigation and the report definition while rendering and hands them down as
SWR fallback data, so the first paint already has them. Visuals still fetch
their own rows, because those depend on filters the browser owns.

Seeding is bounded. A replica that is not warm yet renders without it and lets
the browser ask, because a shell with placeholders beats a blank page waiting
on a first database connection.
