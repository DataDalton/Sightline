// Runtime environment. This is the only module that reads process.env, and it
// reads just the values that must exist before the platform can reach its own
// configuration table.
//
// In a Databricks App none of these come from a .env file. The platform
// injects DATABRICKS_HOST, DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET,
// DATABRICKS_APP_NAME and DATABRICKS_WORKSPACE_ID automatically, and the SQL
// warehouse id arrives from a resource binding declared in app.yaml. The only
// values the deployment declares are the catalog and schema holding the
// platform tables, because something has to say where to look.
//
// Everything else is operational configuration and lives in the settings
// table, editable in-app without a redeploy. See lib/settings.ts.

import { bareHostname } from "./hostname";

function env(name: string, fallback = ""): string {
	return process.env[name]?.trim() || fallback;
}

// True when running inside Databricks Apps rather than on a developer machine.
//
// The signal is DATABRICKS_APP_PORT, which only the Apps runtime sets. Client
// id was the obvious candidate and is wrong: local development against a
// service principal sets it too, which would make a developer machine claim to
// be a deployment, disable the local identity fallback and trip the startup
// guards below.
export const isDatabricksApp = Boolean(process.env.DATABRICKS_APP_PORT?.trim());

// --- Injected by Databricks Apps -------------------------------------------

export const workspaceHost = (() => {
	// WAREHOUSE_HOST is checked first and exists for local development.
	// Setting DATABRICKS_HOST in the environment switches the Databricks SDK
	// onto its CLI credential strategy, which shells out and fails on a stale
	// OAuth refresh token. Keeping the hostname under a different name lets
	// the SDK use its own resolution while the SQL driver still gets a host.
	const host = env("WAREHOUSE_HOST") || env("DATABRICKS_HOST");
	if (!host) return "";
	return host.startsWith("http") ? host : `https://${host}`;
})();

export const appIdentity = {
	name: env("DATABRICKS_APP_NAME", "sightline"),
	workspaceId: env("DATABRICKS_WORKSPACE_ID"),
	clientId: env("DATABRICKS_CLIENT_ID"),
	clientSecret: env("DATABRICKS_CLIENT_SECRET"),
};

// Hostname without scheme, which is the form the SQL driver expects.
export const serverHostname = bareHostname(workspaceHost);

// SQL warehouse HTTP path as the deployment declares it. In Databricks Apps
// this comes from a warehouse resource binding: declare the resource in
// app.yaml and expose its id as DATABRICKS_SQL_WAREHOUSE_ID. Locally, set
// DATABRICKS_HTTP_PATH directly.
export const warehouseHttpPath = (() => {
	const explicit = env("DATABRICKS_HTTP_PATH");
	if (explicit) return explicit;
	const warehouseId = env("DATABRICKS_SQL_WAREHOUSE_ID");
	return warehouseId ? `/sql/1.0/warehouses/${warehouseId}` : "";
})();

// Personal access token. Local development only. Never set in Databricks Apps,
// where the injected service principal credentials are used instead.
export const localAccessToken = env("DATABRICKS_TOKEN");

// The columnar cache is memory-only. A Databricks App has no durable local
// disk: the container filesystem is ephemeral, every replica starts empty, and
// anything written locally is lost on restart and invisible to the others. A
// file path would survive a reload but not a restart, so it buys nothing and
// hides a correctness trap.
export const analyticsCachePath = ":memory:";

// --- Lakebase: the transactional store -------------------------------------
//
// Managed Postgres inside Databricks, bound to the app as a resource. This is
// where everything the app writes at request latency lives: reports, saved
// views, access policy, presence, collaboration ops and the shared result
// cache. Delta is an analytical store, with file-per-commit writes and no
// point updates, so it is the wrong shape for any of that.
//
// Databricks injects these on resource binding and creates a Postgres role
// matching the app service principal. There is no password: the driver
// authenticates with an OAuth token it rotates on a one hour lifetime.

export const lakebase = {
	// No default. A connection target is a fact about a deployment, and a
	// guess here would be one installation's address shipped to every other.
	host: bareHostname(env("PGHOST")),
	port: parseInt(env("PGPORT", "5432"), 10),
	// The postgres database is owned by cloud_admin and grants no CREATE, so
	// the platform lives in a database the workspace owns.
	database: env("PGDATABASE"),
	// Dedicated schema rather than public, so the platform tables are isolated
	// from anything else in this database and can be renamed or dropped as a
	// unit.
	schema: env("PGSCHEMA", "sightline"),
	// Databricks database instance name. Credentials are minted against this,
	// not against the host.
	instanceName: env("LAKEBASE_INSTANCE"),
	// Service principal client id in a deployed app, a user email locally.
	// The instance needs a Postgres role of this name with LOGIN, which is what
	// binding the instance as an app resource provisions. Without that role a
	// valid token is still refused, because there is nothing to log in as.
	user: env("PGUSER", appIdentity.clientId),
	sslMode: env("PGSSLMODE", "require"),
	// Local development escape hatch: a plain connection string bypasses the
	// Databricks OAuth flow so the app runs against any Postgres.
	localUrl: env("DATABASE_URL"),
};

export const hasLakebase = Boolean(lakebase.host || lakebase.localUrl);

// What a deployment is missing, or null when it has everything.
//
// Checked when the platform starts serving, not while this module is evaluated.
// `next build` imports every route to collect page data, and a build container
// has the app environment without the resource bindings, which arrive at run
// time: a check at module scope fails the build over a database the builder
// never uses.
//
// A container that starts without these cannot serve anything, so the first
// request still fails loudly, where a request can see it.
export function missingDeploymentConfig(): string[] {
	if (!isDatabricksApp) return [];

	return [
		["PGHOST", lakebase.host],
		["PGDATABASE", lakebase.database],
		["LAKEBASE_INSTANCE", lakebase.instanceName],
	]
		.filter(([, value]) => !value)
		.map(([name]) => name);
}

export function assertDeploymentConfigured(): void {
	const missing = missingDeploymentConfig();
	if (missing.length === 0) return;

	throw new Error(
		`Missing deployment configuration: ${missing.join(", ")}. ` +
			"Declare these in app.yaml and bind a database resource: a Databricks " +
			"App does not read .env, container storage does not survive a restart, " +
			"and Delta cannot serve the write rate the platform tables need.",
	);
}

// --- Observability ---------------------------------------------------------
// Databricks injects these when app observability is enabled, so traces and
// logs export without the platform defining its own transport.

export const otel = {
	endpoint: env("OTEL_EXPORTER_OTLP_ENDPOINT"),
	serviceName: env("OTEL_SERVICE_NAME", appIdentity.name),
	enabled: Boolean(env("OTEL_EXPORTER_OTLP_ENDPOINT")),
};

// --- Identity headers ------------------------------------------------------
// Fixed by the Databricks Apps proxy, not deployment-specific, so they are
// constants rather than settings.

export const emailHeader = "X-Forwarded-Email";
export const accessTokenHeader = "X-Forwarded-Access-Token";

// Development fallback identity. Only ever active outside Databricks Apps: in
// a deployed app the platform always sets the forwarded headers, so a request
// without them is rejected rather than served as a local user.
export const allowLocalIdentity = !isDatabricksApp;
export const localIdentityEmail = env(
	"LOCAL_IDENTITY_EMAIL",
	"developer@localhost",
);

// The warehouse to run a query against, resolved per call.
//
// Read at call time rather than at module load, because an administrator can
// change it and a module-level constant would go on pointing at whatever the
// container started with until it was restarted. That is the difference
// between a setting and a decoration.
//
// The settings module is imported inline: it reads its values from the
// database this module describes how to reach, so importing it at the top
// would be a cycle. It falls back to what the deployment declared, which is
// also what answers before the first settings load completes.
export function resolveWarehousePath(): string {
	let configured = "";
	try {
		const { settings } =
			require("./settings") as typeof import("./settings");
		configured = settings().warehouseId;
	} catch {
		// Asked before settings are available. The deployment's value stands.
	}

	return configured ? `/sql/1.0/warehouses/${configured}` : warehouseHttpPath;
}

// This process, named.
//
// Every counter under Platform > Health describes whichever replica served the
// request, so refreshing the page changes the numbers and nothing says why. A
// name per process makes that visible: two refreshes reporting two different
// instance ids is the answer, and a one-instance problem stops looking like an
// everything problem.
//
// Generated rather than read from the environment. Databricks Apps does not
// expose a replica identifier, and a random name that lives as long as the
// process is exactly what is being identified.
export const instanceId = `${process.pid.toString(36)}-${Math.random()
	.toString(36)
	.slice(2, 8)}`;

export const instanceStartedAt = Date.now();
