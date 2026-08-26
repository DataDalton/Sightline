"use client";

import { useState } from "react";
import useSWR from "swr";
import { Select } from "../components/shared/Select";
import { TabStrip } from "../components/shared/TabStrip";
import styles from "./Admin.module.css";
import roles from "./Roles.module.css";

// Answering an access review, in the two directions one is asked.
//
// The lists elsewhere on this page are the input to the question rather than
// the answer: turning assignments, grants, settings groups and catalogue
// reachability into "can this person open that" meant reading four of them and
// running the resolver in your head.

interface Route {
	kind: string;
	subjectType: "user" | "group" | "anyone";
	subjectId: string;
	permission: string;
	via: string;
	scope: string | null;
	conditional: boolean;
	grantedBy: string | null;
	grantedOn: string | null;
}

interface ReportAnswer {
	report?: {
		reportId: string;
		title: string;
		isPersonal: boolean;
		ownerEmail: string | null;
		routes: Route[];
		note: string | null;
	} | null;
}

interface SubjectAnswer {
	subject?: {
		subject: string;
		direct: {
			via: string;
			permission: string;
			scope: string;
			resource: string;
			grantedBy: string | null;
			grantedOn: string | null;
		}[];
		throughGroups: {
			group: string;
			via: string;
			permission: string;
			scope: string;
		}[];
		catalogueApplies: boolean;
	};
	probes?: { name: string; probedAt: number; matchedAt: number }[];
}

export function AccessReviewPane({
	reports,
}: {
	reports: { id: string; name: string }[];
}) {
	const [direction, setDirection] = useState<"report" | "person">("report");

	return (
		<>
			<div className={styles.paneNav}>
				<TabStrip
					label="Access review"
					value={direction}
					onChange={setDirection}
					tabs={[
						{ id: "report", label: "Who can open this" },
						{ id: "person", label: "What can this person open" },
					]}
				/>
			</div>

			{direction === "report" ? (
				<ByReport reports={reports} />
			) : (
				<ByPerson />
			)}
		</>
	);
}

// The same badge the role cards use, so a level means one thing across the
// whole section rather than being restyled per screen.
function permissionTag(permission: string) {
	const tone =
		permission === "admin"
			? roles.levelAdmin
			: permission === "edit"
				? roles.levelEdit
				: "";
	return <span className={`${roles.level} ${tone}`}>{permission}</span>;
}

function ByReport({ reports }: { reports: { id: string; name: string }[] }) {
	const [reportId, setReportId] = useState("");
	const { data, isLoading } = useSWR<ReportAnswer>(
		reportId
			? `/api/admin?section=reportAccess&reportId=${encodeURIComponent(reportId)}`
			: null,
	);

	const answer = data?.report;

	return (
		<>
			<div className={styles.fieldRow}>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Report</span>
					<Select
						value={reportId}
						onChange={setReportId}
						placeholder="Choose one"
						searchable={reports.length > 12}
						options={reports.map((r) => ({
							value: r.id,
							label: r.name,
						}))}
					/>
				</label>
			</div>

			{!reportId ? (
				<div className={styles.state}>
					Pick a report to see every route into it.
				</div>
			) : isLoading ? null : !answer ? (
				<div className={styles.state}>That report was not found.</div>
			) : (
				<>
					{answer.note && (
						<p className={styles.fieldHint}>{answer.note}</p>
					)}
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>Who</th>
									<th>Level</th>
									<th>Through</th>
									<th>Where</th>
									<th>Granted</th>
								</tr>
							</thead>
							<tbody>
								{answer.routes.map((route, i) => (
									<tr
										key={`${route.via}-${route.subjectId}-${i}`}
									>
										<td>
											{route.subjectId}
											{route.conditional && (
												<span
													className={styles.fieldHint}
												>
													{route.subjectType ===
													"group"
														? " if in this group"
														: ""}
												</span>
											)}
										</td>
										<td>
											{permissionTag(route.permission)}
										</td>
										<td>{route.via}</td>
										<td>{route.scope ?? "-"}</td>
										<td>
											{route.grantedBy
												? `${route.grantedBy}`
												: "-"}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{answer.routes.some((r) => r.conditional) && (
						<p className={styles.fieldHint}>
							Rows marked as conditional depend on group
							membership. Membership is resolved by asking the
							warehouse under each reader&rsquo;s own token, so it
							cannot be listed for somebody else from here.
						</p>
					)}
				</>
			)}
		</>
	);
}

function ByPerson() {
	const [draft, setDraft] = useState("");
	const [subject, setSubject] = useState("");
	const { data, isLoading } = useSWR<SubjectAnswer>(
		subject
			? `/api/admin?section=subjectAccess&subject=${encodeURIComponent(subject)}`
			: null,
	);

	const answer = data?.subject;
	const probes = new Map(
		(data?.probes ?? []).map((p) => [p.name.toLowerCase(), p]),
	);

	return (
		<>
			<div className={styles.fieldRow}>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Email</span>
					<input
						className={styles.input}
						value={draft}
						placeholder="person@example.com"
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") setSubject(draft.trim());
						}}
					/>
					<span className={styles.fieldHint}>
						Press Enter to look up.
					</span>
				</label>
			</div>

			{!subject ? (
				<div className={styles.state}>
					Enter an email to see everything that names them.
				</div>
			) : isLoading || !answer ? null : (
				<>
					<h4 className={roles.groupTitle}>Named directly</h4>
					{answer.direct.length === 0 ? (
						<div className={styles.state}>
							Nothing names {answer.subject}. Anything they can
							open comes through a group or through the catalogue.
						</div>
					) : (
						<div className={styles.tableWrap}>
							<table className={styles.table}>
								<thead>
									<tr>
										<th>Through</th>
										<th>Level</th>
										<th>Scope</th>
										<th>Resource</th>
									</tr>
								</thead>
								<tbody>
									{answer.direct.map((row, i) => (
										<tr
											key={`${row.via}-${row.resource}-${i}`}
										>
											<td>{row.via}</td>
											<td>
												{permissionTag(row.permission)}
											</td>
											<td>{row.scope}</td>
											<td>{row.resource}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}

					<h4 className={roles.groupTitle}>
						Also applies if they are in one of these groups
					</h4>
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>Group</th>
									<th>Level</th>
									<th>Through</th>
									<th>Where</th>
									<th>Ever matched</th>
								</tr>
							</thead>
							<tbody>
								{answer.throughGroups.map((row, i) => {
									const probe = probes.get(
										row.group.toLowerCase(),
									);
									return (
										<tr
											key={`${row.group}-${row.via}-${i}`}
										>
											<td>{row.group}</td>
											<td>
												{permissionTag(row.permission)}
											</td>
											<td>{row.via}</td>
											<td>{row.scope}</td>
											<td>
												{!probe
													? "Not probed"
													: probe.matchedAt
														? "Yes"
														: "Not seen"}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>

					{answer.catalogueApplies && (
						<p className={styles.fieldHint}>
							Reachability follows Unity Catalog, so this person
							also opens every report built on data they hold
							SELECT on, whether or not anything above names them.
						</p>
					)}
				</>
			)}
		</>
	);
}
