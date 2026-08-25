import { resolveWarehousePath } from "../runtime";
import type { QueryParams, Row } from "./types";

// Warehouse access as the application itself, for catalogue metadata only.
//
// Every user-facing query runs under the caller forwarded token so Unity
// Catalog filters rows for that person. This does not, and must never be used
// for one: it runs as the app service principal, and a dataset query on this
// path would return one identity view of the data to everybody.
//
// It exists because some questions are not about anybody in particular. Which
// groups a row filter branches on is a property of the catalogue, not of the
// reader, and the answer has to be the same for every replica or the cache is
// partitioned differently depending on who happened to ask. Asking under a
// reader token would also mean the list changed with whoever was browsing.
//
// Reading a filter needs SELECT on the catalogue. SHOW CREATE TABLE on a metric
// view is gated behind it, and information_schema.row_filters answers an
// under-privileged principal with zero rows rather than an error, which reads
// as a source carrying no filter and is the one wrong answer that costs a
// reader somebody else rows.
//
// So the service principal can reach data it must never return, and what keeps
// on-behalf-of intact is which code calls this rather than what the principal
// is allowed. Call it from catalogue metadata only. Nothing that answers a
// dataset request may reach it.

// Databricks parameter markers are :name; the statement API takes them as a
// typed list. Types are inferred from the JavaScript value, matching how the
// SQL driver behaves for the same input.
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

export async function queryAsApp(
	sql: string,
	params?: QueryParams,
): Promise<Row[]> {
	const warehouseId = resolveWarehousePath().split("/").pop();
	if (!warehouseId) {
		throw new Error(
			"No SQL warehouse configured, so catalogue metadata cannot be read.",
		);
	}

	// Credentials come from the SDK default chain, which in a deployed app is
	// the injected service principal.
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
