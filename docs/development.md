# Development

- [Against a workspace](#against-a-workspace)
- [The offline demo](#the-offline-demo)
- [Tests](#tests)
- [Repository layout](#repository-layout)

Commands run from the repository root, which forwards them to `backend/ui`.
`npm install` there installs both.

## Against a workspace

```bash
cp backend/ui/.env.example backend/ui/.env   # then fill it in
npm install
npm run dev
```

The app opens at `http://localhost:3000`. Queries run as whoever the local
Databricks credentials belong to, so another user's row filtering is not
reproduced. The module that does this refuses to load in a deployed app.

## The offline demo

```bash
npm run dev2              # keeps whatever the last run left
npm run dev2 -- --reset   # starts again from the sample data
```

Runs the whole platform at `http://localhost:3001` with no Databricks
workspace, no login and nothing in `.env`. It needs Node 20.12 or newer,
internet on the first run, and ports 3001 and 55432 free. Run it or `npm run
dev` at one time, not both, because they build into the same `.next` folder.

- **Postgres** comes from the `embedded-postgres` package, installed on first
  run into `backend/ui/.demo/runtime` rather than the project, so the deployed
  app never downloads it. Everything the demo writes lives under `.demo`, which
  git ignores. It runs on Windows x64, macOS and Linux, and not as root on
  Linux.
- **The warehouse** is sample tables in that Postgres. Queries the platform
  would send to Databricks are rewritten into Postgres in `lib/demo/dialect.ts`
  and run as the signed-in person, so group checks answer for them.
- **The content** is generated on first start: a fictional retailer with two
  years of data up to today across sales, support, marketing, finance,
  operations, people and web traffic, seven categories of multi-page reports
  built from the page templates, ten people in nine groups, category
  maintainers, a few conversations, a sample sheet, two months of reading
  history and a scheduled page. The web traffic source is live, and a few
  visits for today arrive every 20 seconds, so its pages can be watched
  updating. The demo's tables have no Delta history, so a table's count of
  rows written stands in for its version. See
  `lib/demo/datasets.ts` and `lib/demo/content.ts`.
- **Signed in** as Dalton Murray, an administrator.

Demo mode only switches on outside a deployed app, whatever the environment
says. Catalogue sync is refused in it, since there is no catalogue.

### Pictures for the documentation

```bash
npm run dev2          # in one terminal
npm run screenshots   # in another
```

Photographs a set of demo pages into `docs/images` at twice the pixel density,
using an installed Chrome or Edge through its debugging protocol, so no
browser package is added. Set `CHROME_PATH` when neither is found where they
usually install. The pages are listed at the top of
`backend/ui/scripts/screenshots.mjs`.

## Tests

```bash
cd backend/ui
npm test
npm run typecheck
```

The tests cover what can be checked without a browser or a warehouse, among
them:

- **Queries**: the builder including NOT, OR and the recorded-access
  restriction, CSV encoding, and the demo's SQL rewriting.
- **Layout and visuals**: the saved-view overlay, layout arithmetic, template
  building and validation, conditional formatting, brush geometry and version
  diffing.
- **The semantic layer**: row filter group discovery, metric view calculation
  parsing and field usage lookup.
- **Explore**: condition parsing and the address encoding.
- **The assistant**: refusing every malformed or out of catalogue query, the
  streamed response format, and how streamed events build the transcript.
- **Alerts**: when each condition fires or stays quiet, message wording,
  schedules across a daylight saving change, and mapping a filter's columns
  onto fields.
- **Push**: encryption checked byte for byte against RFC 8291, and the
  signature against its own public key.
- **Sheets**: the formula language including errors, cycles and column
  functions, and pivot totals taken from the warehouse.
- **Messaging and contacts**: who can see a conversation, who is told, and how
  maintainers are listed.

## Repository layout

```text
app.yaml          Databricks Apps configuration
backend/ui/
  app/            Routes, the reader, the editor, admin, the dictionary,
                  explore, sheets, the assistant, the inbox, messages and
                  alerts
  lib/            Query building, the semantic layer, auth, platform tables,
                  the assistant, alert checks, push delivery, messaging, the
                  sheet formula language, and the offline demo
  public/         The service worker and the offline page
  scripts/        The demo launcher and the documentation screenshots
docs/             This documentation and the logo
```
