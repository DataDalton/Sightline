import { isDatabricksApp, resolveWarehousePath } from "../runtime";
import type { QueryParams, Row } from "./types";

// Warehouse access for local development only.
//
// A deployed app queries under each caller's forwarded token so Unity Catalog
// filters rows for that person. On a developer machine there is no forwarded
// token, so without this there is no way to exercise the data path at all.
//
// This runs queries as whoever the local Databricks credentials belong to,
// which means it does NOT reproduce another user's row filtering. It is a
// development affordance, never a substitute for on-behalf-of access.
//
// The guard below is deliberately absolute: in a Databricks App this module
// refuses to run. Falling back to shared credentials in production would run
// every user's query as one identity and hand them rows they are not entitled
// to, which is the precise failure the on-behalf-of design exists to prevent.

function assertLocalOnly(): void {
	if (isDatabricksApp) {
		throw new Error(
			"Local warehouse credentials are not available in a deployed app. " +
				"Queries must run under the caller's forwarded token.",
		);
	}
}

// Databricks parameter markers are :name; the statement API takes them as a
// typed list. Types are inferred from the JavaScript value, which matches how
// the SQL driver behaves for the same input.
function toStatementParameters(params?: QueryParams) {
	if (!params) return undefined;
	return Object.entries(params).map(([name, value]) => {
		if (value === null || value === undefined) {
			// The API omits value entirely to mean NULL rather than accepting
			// a null literal.
			return { name };
		}
		if (typeof value === "number") {
			return Number.isInteger(value)
				? { name, value: String(value), type: "INT" }
				: { name, value: String(value), type: "DOUBLE" };
		}
		if (typeof value === "boolean") {
			return { name, value: String(value), type: "BOOLEAN" };
		}
		return { name, value: String(value) };
	});
}

export async function queryLocally(
	sql: string,
	params?: QueryParams,
): Promise<Row[]> {
	assertLocalOnly();

	// Resolved per query, so a warehouse changed in the administration
	// settings applies here the same way it does on the deployed path.
	const warehouseId = resolveWarehousePath().split("/").pop();
	if (!warehouseId) {
		throw new Error(
			"No SQL warehouse configured. Set one in Administration -> " +
				"Configuration, or set DATABRICKS_HTTP_PATH for local development.",
		);
	}

	const { WorkspaceClient } = await import("@databricks/sdk-experimental");
	const workspace = new WorkspaceClient({});

	const response = await workspace.statementExecution.executeStatement({
		warehouse_id: warehouseId,
		statement: sql,
		wait_timeout: "50s",
		parameters: toStatementParameters(params),
	});

	if (response.status?.state !== "SUCCEEDED") {
		throw new Error(
			response.status?.error?.message ??
				`Statement ${response.status?.state ?? "failed"}`,
		);
	}

	// The statement API returns positional arrays plus a column manifest,
	// rather than the row objects the SQL driver produces. Callers expect the
	// latter, so the shapes are reconciled here.
	const columns = response.manifest?.schema?.columns ?? [];
	const data = response.result?.data_array ?? [];

	return data.map((values) => {
		const row: Row = {};
		columns.forEach((column, i) => {
			row[column.name ?? `col${i}`] = values[i];
		});
		return row;
	});
}
