import { types } from "pg";
import { getPool } from "../data/lakebase";
import type { QueryParams, Row } from "../data/types";
import { localIdentityEmail } from "../runtime";
import { toPostgres } from "./dialect";

// The demonstration's warehouse. Runs what the platform would send to a
// Databricks SQL warehouse against sample tables in the local Postgres, as the
// person asking, so group checks answer for them.
//
// Results are shaped the way the statement execution API returns them. Dates
// come back as text rather than as Date objects, which the rest of the
// platform has never had to handle.

const dateOid = 1082;
const timestampOid = 1114;
const timestampTzOid = 1184;

function parserFor(oid: number, format?: string): (value: string) => unknown {
	if (oid === dateOid) return (value) => value;
	if (oid === timestampOid) {
		return (value) => new Date(`${value.replace(" ", "T")}Z`).toISOString();
	}
	if (oid === timestampTzOid) return (value) => new Date(value).toISOString();
	return types.getTypeParser(oid, format as "text");
}

export async function queryDemo(
	statement: string,
	params?: QueryParams,
	asEmail?: string,
): Promise<Row[]> {
	const { text, values } = toPostgres(statement, params ?? {});
	const pool = await getPool();
	const client = await pool.connect();
	try {
		await client.query("BEGIN READ ONLY");
		// Read by is_member and is_account_group_member, see lib/demo/seed.
		await client.query("SELECT set_config('demo.user', $1, true)", [
			(asEmail ?? localIdentityEmail).toLowerCase(),
		]);
		const result = await client.query({
			text,
			values,
			types: { getTypeParser: parserFor as never },
		});
		await client.query("COMMIT");
		return result.rows as Row[];
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}
