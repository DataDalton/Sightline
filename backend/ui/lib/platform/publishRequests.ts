import { sql } from "../data/lakebase";
import { cachedDefinition } from "./definitionCache";

// Personal pages somebody has asked to have made official.
//
// A page stays personal until a Report Publisher decides, so nothing about the
// page changes while it waits. The open list is held for everybody, because whoever
// can decide needs to be able to open the page, and that is folded into their
// rights when they are worked out. See lib/platform/access.

export interface OpenPublishRequest {
	requestId: string;
	reportId: string;
	categoryId: string;
	requestedBy: string;
	note: string | null;
	createdOn: string;
}

export async function openPublishRequests(): Promise<OpenPublishRequest[]> {
	return cachedDefinition("access-index:publish", async () => {
		const rows = await sql<{
			request_id: string;
			report_id: string;
			category_id: string;
			requested_by: string;
			note: string | null;
			created_on: string;
		}>(
			`SELECT request_id::text AS request_id, report_id::text AS report_id,
			        category_id, requested_by, note, created_on
			 FROM publish_requests
			 WHERE status = 'open'
			 ORDER BY created_on`,
		);
		return rows.map((row) => ({
			requestId: row.request_id,
			reportId: row.report_id,
			categoryId: row.category_id,
			requestedBy: row.requested_by,
			note: row.note,
			createdOn: row.created_on,
		}));
	});
}
