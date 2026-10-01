import { sql } from "../data/lakebase";
import { demoMode, isDatabricksApp, resolveWarehousePath } from "../runtime";

// Whether background work may send a statement to the SQL warehouse now.
//
// Background work is anything nobody is waiting on: looks at table history,
// reading a view's definition, the daily field sync. Each is a query, and a
// query starts a stopped warehouse, so each asks this first and waits for the
// warehouse to be up on a reader's account.

let warehouseState: {
	at: number;
	running: boolean;
	autoStopMinutes: number | null;
} | null = null;
let workspaceClient: unknown = null;

// Whether routine work may run, meaning the SQL warehouse is up and people
// are reading. The warehouse is asked about through the workspace rather than
// the warehouse, so asking never starts it. Assumed yes outside a deployment,
// and when the answer cannot be had, since work that was not needed costs
// less than an answer that stayed old.
export async function routineLooksAllowed(): Promise<boolean> {
	if (demoMode || !isDatabricksApp) return true;
	if (warehouseState && Date.now() - warehouseState.at < 15_000) {
		return warehouseState.running && (await readersActive());
	}
	let running = true;
	let autoStopMinutes: number | null = null;
	try {
		const id = resolveWarehousePath().split("/").pop();
		if (id) {
			const { WorkspaceClient } =
				await import("@databricks/sdk-experimental");
			workspaceClient ??= new WorkspaceClient({});
			const warehouse = await (
				workspaceClient as InstanceType<typeof WorkspaceClient>
			).warehouses.get({ id });
			running = warehouse.state === "RUNNING";
			autoStopMinutes =
				typeof warehouse.auto_stop_mins === "number" &&
				warehouse.auto_stop_mins > 0
					? warehouse.auto_stop_mins
					: null;
		}
	} catch {
		running = true;
	}
	warehouseState = { at: Date.now(), running, autoStopMinutes };
	return running && (await readersActive());
}

let readerState: { at: number; active: boolean } | null = null;

// Whether anybody has read data recently enough that the warehouse is up on
// their account. Background work is itself a query, so running it whenever
// the warehouse is up would keep it up for ever. It stops half the
// warehouse's idle window after the last reader, which lets the warehouse
// stop soon after they leave.
async function readersActive(): Promise<boolean> {
	if (readerState && Date.now() - readerState.at < 15_000) {
		return readerState.active;
	}
	const windowMinutes = Math.max(
		1,
		Math.floor((warehouseState?.autoStopMinutes ?? 10) / 2),
	);
	let active = true;
	try {
		const rows = await sql<{ active: boolean }>(
			`SELECT EXISTS (
			   SELECT 1 FROM usage_events
			   WHERE occurred_on > now() - make_interval(mins => $1)
			     AND event_type IN ('query', 'page_view', 'page_open')
			 ) AS active`,
			[windowMinutes],
		);
		active = rows[0]?.active ?? true;
	} catch {
		active = true;
	}
	readerState = { at: Date.now(), active };
	return active;
}
