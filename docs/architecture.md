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

An answer is kept until the data behind it changes, not until a timer runs
out. Each source is checked for new data on its own interval: live, every 30
minutes, hourly, every 6, 12 or 24 hours, weekly, or a custom interval. The
platform default applies when a source names none.

A check reads the history of each table the source reads, never its rows. A
metric view is checked through the tables it reads, recorded by the catalogue
sync, and a table is its own. A commit that changed data, such as a write, a
merge or a delete, clears every source built on that table, and the next
person to open one of its pages gets new figures. Commits that leave the rows
as they were, such as compaction, cleaning up old files, or setting a property
or comment, are ignored. A table dropped and made again restarts its version
count, which is recognised as a change, and so is a history too long to read
back to the last version seen. When nothing changed, nothing is queried
again, however long an answer has been kept.

- **Live** sources are checked every few seconds, 15 by default, and their
  open pages ask again on the same interval while the tab is visible. The
  answer they get is the cached one until a check finds new data, so a page
  follows the data without re-running its queries for nothing.
- Checks run only while the warehouse is already running, so watching never
  starts it. A reader who meets an answer from a source that has gone too long
  without a check gets it at once and a check is asked for, which runs
  whatever the warehouse is doing.
- Every replica learns of a change within a few seconds and stops serving the
  older answer, wherever it is held.
- A watched source's answers are still dropped after a day, or after its own
  interval if that is longer, in case a change is ever missed.
- A source whose tables cannot be checked, such as an ordinary view or one
  whose history cannot be read, is refreshed on its interval as a timer
  instead. Once the interval passes, the next reader gets the old answer at
  once while a fresh query runs, unless "Serve while refreshing" is off. The
  source's edit dialog says which kind it is, and why.

Identical requests that arrive together share one warehouse query. When a
reader opens the app, the landing pages they are likely to open next are
queried ahead of them, except on live sources, and a new report's queries run
when it is created.

## What a page costs to open

The document carries its own data. The server resolves the shell, the
navigation and the report definition while rendering and hands them down as
SWR fallback data, so the first paint already has them. Visuals still fetch
their own rows, because those depend on filters the browser owns.

Seeding is bounded. A replica that is not warm yet renders without it and lets
the browser ask, because a shell with placeholders beats a blank page waiting
on a first database connection.
