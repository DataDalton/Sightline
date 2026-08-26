"use client";

import { useState } from "react";
import useSWR from "swr";
import { Select } from "../components/shared/Select";
import { SkeletonTable } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import styles from "./Admin.module.css";

// What the platform recorded somebody doing to it.
//
// Thirty-one places write to the activity log and, until this existed, two of
// them could be read back. Role grants, category creation, source registration,
// settings changes and administrative reads of somebody's private page were all
// recorded and then unreachable, which is the half of an access review that
// nobody could answer.

interface ActivityRecord {
	logId: string;
	recordType: string;
	recordId: string;
	action: string;
	fieldName: string | null;
	oldValue: string | null;
	newValue: string | null;
	changedBy: string;
	changedOn: string;
	notes: string | null;
}

interface Response {
	records?: ActivityRecord[];
	types?: { recordType: string; events: number }[];
	more?: boolean;
}

// Written by the code that logs them, so they read as identifiers. Turned into
// a phrase here rather than at the point of writing, because the log is also
// read by things that are not this screen.
const actionLabels: Record<string, string> = {
	administer_personal_page: "Opened a personal page as an administrator",
	create_report: "Created a report",
	move_report: "Moved a report",
	remove_report: "Removed a report",
	reorder_reports: "Reordered reports",
	create_category: "Created a category",
	update_category: "Changed a category",
	remove_category: "Removed a category",
	reorder_categories: "Reordered categories",
	create_role: "Created a role",
	update_role: "Changed a role",
	delete_role: "Deleted a role",
	assign_role: "Assigned a role",
	revoke_assignment: "Revoked an assignment",
	register_source: "Registered a source",
	remove_source: "Removed a source",
	update_source: "Changed a source",
	update_source_fields: "Relabelled source fields",
	update_settings: "Changed settings",
	sync: "Ran a catalogue sync",
	share_page: "Shared a page",
	unshare_page: "Stopped sharing a page",
	publish_page: "Published a page",
	requested: "Requested an export",
	completed: "Completed an export",
	failed: "Export failed",
};

function when(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const minutes = Math.floor(ms / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(iso).toLocaleDateString();
}

// What changed, in one line. The log stores an old and a new value per row and
// only some actions set both, so this shows whichever half exists rather than
// an arrow with nothing on one side of it.
function change(record: ActivityRecord): string | null {
	if (record.oldValue && record.newValue) {
		return `${record.oldValue} to ${record.newValue}`;
	}
	return record.newValue ?? record.oldValue ?? record.notes ?? null;
}

const pageSize = 100;

export function ActivityPane() {
	const [recordType, setRecordType] = useState("");
	const [actor, setActor] = useState("");
	const [days, setDays] = useState(30);
	const [page, setPage] = useState(0);

	const params = new URLSearchParams({
		section: "activity",
		days: String(days),
		limit: String(pageSize),
		offset: String(page * pageSize),
	});
	if (recordType) params.set("recordType", recordType);
	if (actor.trim()) params.set("actor", actor.trim());

	const { data, isLoading } = useSWR<Response>(`/api/admin?${params}`);
	const showSkeleton = useDeferredLoading(isLoading);

	const records = data?.records ?? [];
	const types = data?.types ?? [];

	// Any filter change starts at the top. Staying on page four of a list that
	// is now nine rows long shows nothing and reads as no results.
	const filter = (apply: () => void) => {
		apply();
		setPage(0);
	};

	return (
		<>
			<div className={styles.fieldRow}>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>What changed</span>
					<Select
						value={recordType}
						onChange={(v) => filter(() => setRecordType(v))}
						options={[
							{ value: "", label: "Everything" },
							...types.map((t) => ({
								value: t.recordType,
								label: t.recordType,
								note: `${t.events}`,
							})),
						]}
					/>
				</label>

				<label className={styles.field}>
					<span className={styles.fieldLabel}>Who</span>
					<input
						className={styles.input}
						value={actor}
						placeholder="Any"
						onChange={(e) => filter(() => setActor(e.target.value))}
					/>
				</label>

				<label className={styles.field}>
					<span className={styles.fieldLabel}>Window</span>
					<Select
						value={String(days)}
						onChange={(v) => filter(() => setDays(Number(v)))}
						options={[
							{ value: "1", label: "Last 24 hours" },
							{ value: "7", label: "Last 7 days" },
							{ value: "30", label: "Last 30 days" },
							{ value: "90", label: "Last 90 days" },
							{ value: "365", label: "Last year" },
						]}
					/>
				</label>
			</div>

			{showSkeleton ? (
				<SkeletonTable rows={8} columns={5} />
			) : isLoading ? null : records.length === 0 ? (
				<div className={styles.state}>
					Nothing was recorded in this window.
				</div>
			) : (
				<div className={styles.tableWrap}>
					<table className={styles.table}>
						<thead>
							<tr>
								<th>When</th>
								<th>Who</th>
								<th>Did what</th>
								<th>To</th>
								<th>Change</th>
							</tr>
						</thead>
						<tbody>
							{records.map((record) => (
								<tr key={record.logId}>
									<td title={record.changedOn}>
										{when(record.changedOn)}
									</td>
									<td>{record.changedBy}</td>
									<td>
										{actionLabels[record.action] ??
											record.action}
									</td>
									<td title={record.recordId}>
										{record.recordType}
									</td>
									<td>{change(record) ?? "-"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{(page > 0 || data?.more) && (
				<div className={styles.rowActions}>
					<button
						type="button"
						className={styles.linkButton}
						onClick={() => setPage((p) => Math.max(p - 1, 0))}
						disabled={page === 0}
					>
						Newer
					</button>
					<button
						type="button"
						className={styles.linkButton}
						onClick={() => setPage((p) => p + 1)}
						disabled={!data?.more}
					>
						Older
					</button>
				</div>
			)}
		</>
	);
}
