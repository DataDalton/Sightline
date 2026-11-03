# Deploying

Sightline runs as a Databricks App. This covers what has to be configured, and
where.

- [Where configuration lives](#where-configuration-lives)
- [The platform schema](#the-platform-schema)
- [Catalogue privileges](#catalogue-privileges)
- [On behalf of the user](#on-behalf-of-the-user)
- [The data assistant](#the-data-assistant)
- [Notifications](#notifications)

## Where configuration lives

`app.yaml` sits at the repository root, where Databricks Apps reads it. It
holds names, never values. Each entry points at a resource bound to the app,
and the value lives in that resource. A resource bound but not named there
never reaches the container.

| Where | What |
| --- | --- |
| `app.yaml` | Which bound resources become which environment variables |
| The app's configuration in Databricks | The resource bindings, the user authorization scopes, the bootstrap admin group |
| The Lakebase instance | A login role for the service principal, and ownership of the platform schema |
| Unity Catalog | What each reader may select, and what the service principal may read to walk the filters |
| Model serving or AI Gateway | Who may query the assistant's model, when it is used |
| Administration in the app | Name, description, logo, SQL warehouse, caching, assistant endpoint, alerts and push, editor and admin groups, extra policy groups |

Connection targets must be known before the platform can read its own settings
table, so they cannot live in it. Everything in the last row changes without a
redeploy and reaches every replica within a refresh interval.

## The platform schema

The app runs `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF
NOT EXISTS` on every start, so it owns its schema. Postgres checks ownership
before it reads an `ALTER TABLE` subcommand, and skips any `search_path` entry
the role cannot use, so a role without `USAGE` sees the tables as missing
rather than forbidden. Give the schema to a role that both a human and the
service principal belong to.

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

Owning through a group role means adding another principal later is a `GRANT`
rather than an ownership migration.

Bind the Lakebase instance as a database resource even though `app.yaml` reads
nothing from it. Binding provisions the service principal's Postgres role.
Without it the app mints a valid token that the database refuses with `28P01`,
because no role of that name exists.

## Catalogue privileges

Two principals need grants, for different reasons.

Readers, by group:

```sql
GRANT USE CATALOG ON CATALOG <catalog> TO `<reader group>`;
GRANT SELECT ON SCHEMA <catalog>.<schema> TO `<reader group>`;
```

They also need `CAN USE` on the SQL warehouse. A reader holding one without the
other gets an empty platform rather than an error that explains itself.

The service principal, to walk the row filters:

```sql
GRANT SELECT ON CATALOG <catalog> TO `<app service principal client id>`;
```

Nothing less works, and nothing less fails loudly. `BROWSE`, `USE SCHEMA` and
`EXECUTE` on the filter functions all leave the walk blind. `SHOW CREATE TABLE`
on a metric view needs `SELECT`, and `information_schema.row_filters` returns
zero rows rather than an error without it, which looks the same as a source
with no filter. Cache partitioning reports the shortfall rather than assuming
past it, so the symptom is reports that are never cached, not reports that
leak.

After granting, run the catalogue sync under Administration > Content >
Sources. Administration > Audit > Cache partitioning should then read
"Answers are partitioned" and list each group with the reason "found in a row
filter". Only access rule groups, and none from a filter, means the walk still
cannot read the filters.

The same grant lets the app check sources for new data, which reads each
table's history with `DESCRIBE HISTORY` and never its rows. Whether the
warehouse is running is asked of the workspace, which needs `CAN USE` on the
warehouse and never starts it. The versions seen are in `source_checks`.

This grant lets the service principal read data, which is why the separation
in [every query runs as the person who
asked](architecture.md#every-query-runs-as-the-person-who-asked) is structural.

## On behalf of the user

Required. Without user authorization there is no identity to query as, and
every report returns an access error.

Scopes are granted on the app record, not in `app.yaml`, and read back as
`user_api_scopes`. `app.yaml` lists them for reference only.

| Scope | For |
| --- | --- |
| `sql` | Every data query, and the membership probe that resolves a policy class |
| `model-serving` | The assistant's model calls to a serving endpoint, made as the person asking. Only needed when the assistant uses one |
| `ai-gateway` | The assistant's model calls to an AI Gateway model, made as the person asking. Only needed when the assistant uses one |

Set them under the app's User authorization in the workspace, or:

```bash
databricks apps update <name> --json '{"user_api_scopes": ["sql", "model-serving", "ai-gateway"]}'
```

`databricks apps get <name>` reports the effective list. A change applies at
the next sign in, because scopes are baked into the token, and readers are
asked to consent again. `/api/user` reports `canQueryAsUser`, which in a deployed
app is true exactly when the token arrived.

## The data assistant

The model is set under Administration > Platform > Assistant, in one of two
ways. Changing either changes the model with no redeploy, and clearing both
removes the assistant, its navigation entry and its routes.

| Model | Endpoint name | Full address | Model |
| --- | --- | --- | --- |
| A serving endpoint in this workspace | The endpoint's name | Empty | Empty |
| An AI Gateway model | Empty | `https://<workspace>/ai-gateway/mlflow/v1/chat/completions` | The model's three part name, `<catalog>.<schema>.<model>` |
| A model hosted elsewhere | Empty | Its chat completions address | Only if that service serves several models from one address |

A serving endpoint's address is built from the workspace the app is connected
to, so its name is enough. Any `llm/v1/chat` endpoint works. A gateway serves
several models from one address and picks by the Model field, which is sent
with every request. Use the gateway's `/chat/completions` address, because the
assistant sends the chat shape, which the `/responses` address does not take.

It also needs:

- **An identity for the call.** Each model call goes out under the token of
  the person asking and never as the app. The scope that reaches the model has
  to be granted, `model-serving` for a serving endpoint and `ai-gateway` for
  a gateway model. Without it the call is refused and the assistant says it
  cannot answer. The data queries it runs are made as the person asking too,
  under `sql`.
- **Permission on the model for every reader.** The app's service principal
  needs none, because it never calls the model.
  - A serving endpoint needs `CAN QUERY` for the reader groups. Built in
    `databricks-*` endpoints are often open to every workspace user already,
    so check first.
  - A gateway model is a Unity Catalog object, so the reader groups need
    `EXECUTE` on it plus `USE CATALOG` and `USE SCHEMA` on its parents.
    Those two make the catalog and schema visible to them, so put the model in
    a schema they can already use rather than granting them a new one.

Conversations, standing instructions and memories are stored per person in
`assistant_conversations` and `assistant_profiles`. Saved Explore views are in
`explore_views`, and sheets in `sheets`, `sheet_shares`, `sheet_cells` and
`sheet_presence`.

## Notifications

The inbox and alerts need nothing beyond the platform schema. They use
`notifications`, `alert_rules` and `alert_events`, and what each person was
recorded seeing of a row-filtered dataset is in `alert_access`. The filter walk
writes, per dataset, which fields its filters decide on and whether a column
is masked, using the `SELECT` it already has. Conversations use `threads`,
`thread_members`, `thread_messages` and `thread_reads`, and the groups each
person was last found in are in `member_groups`. Scheduled pages are in
`deliveries`, and share the alert runner, its rules and its recordings. Which
page a reader opened and what they did with a visual are in `usage_events`,
beside the rest of the usage log.

Pushes are off until turned on under Administration > Platform >
Notifications. Turning them on generates the signing key pair and stores it
in `push_keys`. Keep that row, because every device subscribed against its
public half and a new pair means everyone turns pushes on again. Devices are in
`push_subscriptions`, and each person's choices in `notification_prefs`.

A push goes from the app to the push service of the subscribing browser, run
by Google, Apple, Mozilla or Microsoft, which delivers it. The app needs
outbound HTTPS to `*.googleapis.com`, `*.push.apple.com`,
`*.push.services.mozilla.com` and `*.notify.windows.com`, and posts nowhere
else whatever address a browser supplies. Messages are encrypted to the device,
so the push service cannot read them. A device the service reports gone is
forgotten, and one that keeps failing is dropped.

The manifest and service worker are served behind the same sign in as
everything else. The manifest is requested with credentials, because without
the session cookie the sign in intercepts it and install fails silently.
