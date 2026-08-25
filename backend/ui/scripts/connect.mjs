// One place the maintenance scripts get a database connection.
//
// Every script had its own copy of the same connection block, each carrying a
// host, a database and an email address as defaults. Six copies of one
// installation's address is both a maintenance problem and the sort of thing
// that should not be in a repository other people read, so there is one copy
// and it defaults to nothing.
//
// A missing value fails immediately and says which one. That is better than
// connecting somewhere unintended, which is the failure mode a default invites.

import { randomUUID } from "node:crypto";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import pg from "pg";

// The scripts read the same .env the development server does. They used to
// carry hardcoded fallbacks instead, which is why they appeared to work
// without it and why they each named one particular installation.
try {
	process.loadEnvFile(new URL("../.env", import.meta.url).pathname.slice(1));
} catch {
	// No .env is fine where the variables are already in the environment, such
	// as a deployment or a CI job. A missing value is reported below, by name.
}

function required(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`${name} is not set. The maintenance scripts read the same connection ` +
				`the app does; copy .env.example to .env and fill it in.`,
		);
	}
	return value;
}

export const sourceCatalog = () => required("SOURCE_CATALOG");
export const warehouseId = () => required("DATABRICKS_SQL_WAREHOUSE_ID");

export const workspace = new WorkspaceClient({});

// Runs a statement against the SQL warehouse and returns rows as objects.
export async function runSql(statement) {
	const response = await workspace.statementExecution.executeStatement({
		warehouse_id: warehouseId(),
		statement,
		wait_timeout: "50s",
	});
	if (response.status?.state !== "SUCCEEDED") {
		throw new Error(
			response.status?.error?.message ?? `statement ${response.status?.state}`,
		);
	}
	const columns = response.manifest?.schema?.columns ?? [];
	return (response.result?.data_array ?? []).map((values) => {
		const row = {};
		columns.forEach((c, i) => {
			row[c.name] = values[i];
		});
		return row;
	});
}

// Opens a connection to the platform's own database.
//
// The password is an OAuth token minted against the database instance and good
// for an hour, which is long enough for any of these scripts and short enough
// that nothing durable is being handed around.
export async function connect() {
	const credential = await workspace.database.generateDatabaseCredential({
		instance_names: [required("LAKEBASE_INSTANCE")],
		request_id: randomUUID(),
	});

	const client = new pg.Client({
		host: required("PGHOST"),
		port: parseInt(process.env.PGPORT ?? "5432", 10),
		database: required("PGDATABASE"),
		user: required("PGUSER"),
		password: credential.token,
		ssl: { rejectUnauthorized: true },
		options: `-c search_path=${process.env.PGSCHEMA ?? "sightline"},public`,
		connectionTimeoutMillis: 30000,
	});

	await client.connect();
	return client;
}
