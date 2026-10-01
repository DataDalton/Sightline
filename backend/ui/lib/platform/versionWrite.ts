import type { PoolClient } from "pg";
import { diffSnapshots, type Snapshot } from "./versionDiff";

// Writes one version of a report with its change summary.
//
// The summary compares the new snapshot with the one before it, and is worked
// out here, inside the transaction that writes the version, so the history
// list reads stored summaries rather than every snapshot it shows. The
// version before is read under the same report lock the save holds, so no
// other version can land between the two.
//
// Round tripped through JSON so the snapshot compared is the one stored,
// which is what a later comparison of the stored rows would read.
export async function writeVersion(
	client: PoolClient,
	input: {
		reportId: string;
		version: number;
		label?: string | null;
		snapshot: Snapshot;
		createdBy: string;
	},
): Promise<void> {
	const text = JSON.stringify(input.snapshot);
	const previous = await client.query<{ snapshot: Snapshot }>(
		`SELECT snapshot FROM report_versions
		 WHERE report_id = $1 AND version < $2
		 ORDER BY version DESC LIMIT 1`,
		[input.reportId, input.version],
	);
	const changes = diffSnapshots(
		previous.rows[0]?.snapshot ?? null,
		JSON.parse(text) as Snapshot,
	);

	await client.query(
		`INSERT INTO report_versions
		   (report_id, version, label, snapshot, created_by, changes)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb)
		 ON CONFLICT (report_id, version) DO NOTHING`,
		[
			input.reportId,
			input.version,
			input.label ?? null,
			text,
			input.createdBy,
			JSON.stringify(changes),
		],
	);
}
