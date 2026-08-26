"use client";

import { useState } from "react";
import useSWR from "swr";
import { Modal } from "../components/shared/Modal";
import { Skeleton } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { Select } from "../components/shared/Select";
import admin from "./Admin.module.css";
import form from "../authoring/Authoring.module.css";
import styles from "./Roles.module.css";

interface RoleRecord {
	roleId: string;
	name: string;
	description: string | null;
	permission: "view" | "edit" | "admin";
	capabilities: string[];
	isBuiltin: boolean;
}

interface AssignmentRecord {
	assignmentId: string;
	roleId: string;
	roleName: string;
	subjectType: "group" | "user";
	subjectId: string;
	scopeType: "global" | "category" | "report";
	scopeId: string | null;
	grantedBy: string | null;
	grantedOn: string;
}

interface RolesResponse {
	roles: RoleRecord[];
	assignments: AssignmentRecord[];
	capabilities: string[];
}

interface ResourceResponse {
	categories: { id: string; name: string }[];
	reports: { id: string; name: string }[];
}

const capabilityInfo: Record<string, { label: string; area: string }> = {
	"report.create": { label: "Create reports", area: "Authoring" },
	"page.create": { label: "Add pages", area: "Authoring" },
	"report.publish": { label: "Publish personal pages", area: "Authoring" },
	"category.create": { label: "Create categories", area: "Navigation" },
	"category.manage": { label: "Rename and reorder", area: "Navigation" },
	"access.grant": { label: "Access and roles", area: "Administration" },
	"semantic.sync": { label: "Sources", area: "Administration" },
	"settings.manage": { label: "Platform settings", area: "Administration" },
};

const areaOrder = ["Authoring", "Navigation", "Administration"];

// What each level reaches, said once here rather than left for somebody to
// infer from the word.
const levels = [
	{ value: "view", name: "View", what: "Open what the role reaches" },
	{ value: "edit", name: "Edit", what: "And change it" },
	{ value: "admin", name: "Admin", what: "And decide who else can" },
] as const;

const levelClass: Record<string, string> = {
	view: "",
	edit: styles.levelEdit,
	admin: styles.levelAdmin,
};

type Draft = {
	roleId: string;
	name: string;
	description: string;
	permission: "view" | "edit" | "admin";
	capabilities: string[];
};

const emptyDraft: Draft = {
	roleId: "",
	name: "",
	description: "",
	permission: "view",
	capabilities: [],
};

// Which half to render. Both when nothing is asked for, so the component still
// stands on its own; one at a time when a tab strip is deciding.
export default function RolesPane({
	show = "both",
}: {
	show?: "roles" | "assignments" | "both";
}) {
	const { data, isLoading, mutate } =
		useSWR<RolesResponse>("/api/admin/roles");
	const { data: resources } = useSWR<ResourceResponse>("/api/admin/access");

	// Whether a probe has ever come back true for each group this replica
	// tracks. Group names are matched exactly and case sensitively, and nothing
	// validates one at the point somebody types it here, so a misspelling
	// produces a row that looks correct and grants nothing.
	const { data: probeData } = useSWR<{
		probes?: { name: string; probedAt: number; matchedAt: number }[];
	}>("/api/admin?section=probes");
	const probes = new Map(
		(probeData?.probes ?? []).map((p) => [p.name.toLowerCase(), p]),
	);

	// Said carefully. A group nobody has matched is the shape of a typo, but a
	// correctly named group that nobody in it has signed in under yet looks
	// exactly the same, so this reports what was observed rather than a verdict.
	const resolution = (a: AssignmentRecord) => {
		if (a.subjectType === "user") return "Named directly";
		const probe = probes.get(a.subjectId.toLowerCase());
		if (!probe) {
			return (
				<span
					className={styles.scope}
					title="Nothing has caused this group to be probed on this instance yet."
				>
					Not probed
				</span>
			);
		}
		if (!probe.matchedAt) {
			return (
				<span
					className={admin.warnText}
					title="This group has been probed and has never matched anybody who signed in. Check the spelling and the case against the account group."
				>
					Never matched
				</span>
			);
		}
		return "Matched";
	};
	const showSkeleton = useDeferredLoading(isLoading);

	const [editing, setEditing] = useState<Draft | null>(null);
	const [assigning, setAssigning] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const roles = data?.roles ?? [];
	const assignments = data?.assignments ?? [];
	const known = data?.capabilities ?? [];

	const post = async (body: Record<string, unknown>, whenWrong: string) => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/admin/roles", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? whenWrong);
				return false;
			}
			await mutate();
			return true;
		} catch (error) {
			setFailure(error instanceof Error ? error.message : whenWrong);
			return false;
		} finally {
			setBusy(false);
		}
	};

	const named = (id: string | null) => {
		if (!id) return null;
		return (
			resources?.categories.find((c) => c.id === id)?.name ??
			resources?.reports.find((r) => r.id === id)?.name ??
			id
		);
	};

	return (
		<div className={styles.pane}>
			{show !== "assignments" && (
				<section className={styles.group}>
					<div className={styles.groupHead}>
						<div>
							<h3 className={styles.groupTitle}>Roles</h3>
							<p className={styles.groupBlurb}>
								A level on the resources in scope, plus what
								else the holder may do.
							</p>
						</div>
					</div>

					<div className={styles.cards}>
						{roles.map((role) => (
							<div key={role.roleId} className={styles.card}>
								<div className={styles.cardHead}>
									<span className={styles.cardName}>
										{role.name}
									</span>
									<span
										className={`${styles.level} ${levelClass[role.permission]}`}
									>
										{role.permission}
									</span>
								</div>

								{role.description && (
									<p className={styles.cardDescription}>
										{role.description}
									</p>
								)}

								<div className={styles.chips}>
									{role.capabilities.length === 0 ? (
										<span
											className={`${styles.chip} ${styles.chipNone}`}
										>
											No extra permissions
										</span>
									) : (
										role.capabilities.map((c) => (
											<span
												key={c}
												className={styles.chip}
												title={c}
											>
												{capabilityInfo[c]?.label ?? c}
											</span>
										))
									)}
								</div>

								<div className={styles.cardActions}>
									{role.isBuiltin ? (
										<span className={styles.builtin}>
											Built in
										</span>
									) : (
										<>
											<button
												type="button"
												className={admin.linkButton}
												disabled={busy}
												onClick={() =>
													setEditing({
														roleId: role.roleId,
														name: role.name,
														description:
															role.description ??
															"",
														permission:
															role.permission,
														capabilities:
															role.capabilities,
													})
												}
											>
												Edit
											</button>
											<button
												type="button"
												className={admin.linkButton}
												disabled={busy}
												onClick={() =>
													void post(
														{
															action: "deleteRole",
															roleId: role.roleId,
														},
														"Could not remove that role",
													)
												}
											>
												Remove
											</button>
										</>
									)}
								</div>
							</div>
						))}

						{showSkeleton &&
							Array.from({ length: 3 }, (_, i) => (
								<div
									key={`loading-${i}`}
									className={styles.card}
								>
									<Skeleton height={18} />
									<Skeleton height={12} />
									<Skeleton height={12} />
								</div>
							))}

						{!isLoading && (
							<button
								type="button"
								className={styles.newCard}
								onClick={() => setEditing(emptyDraft)}
							>
								<span
									className={styles.plus}
									aria-hidden="true"
								>
									+
								</span>
								New role
							</button>
						)}
					</div>
				</section>
			)}

			{show !== "roles" && (
				<section className={styles.group}>
					<div className={styles.groupHead}>
						<div>
							<h3 className={styles.groupTitle}>
								Who holds what
							</h3>
							<p className={styles.groupBlurb}>
								Everywhere, or inside a single category or
								report.
							</p>
						</div>
						<button
							type="button"
							className={form.openButton}
							onClick={() => setAssigning(true)}
						>
							Assign a role
						</button>
					</div>

					{assignments.length === 0 && !isLoading ? (
						<p className={styles.empty}>Nobody holds a role yet.</p>
					) : (
						<div className={admin.tableWrap}>
							<table className={admin.table}>
								<thead>
									<tr>
										<th>Holder</th>
										<th>Role</th>
										<th>Where</th>
										<th>Resolves</th>
										<th>Assigned by</th>
										<th />
									</tr>
								</thead>
								<tbody>
									{assignments.map((a) => (
										<tr key={a.assignmentId}>
											<td>
												<span className={styles.holder}>
													<span
														className={admin.badge}
														title={
															a.subjectType ===
															"user"
																? "One person"
																: "Everyone in this group"
														}
													>
														{a.subjectType ===
														"user"
															? "person"
															: "group"}
													</span>
													{a.subjectId}
												</span>
											</td>
											<td>{a.roleName}</td>
											<td>
												{a.scopeType === "global" ? (
													"Everywhere"
												) : (
													<>
														{named(a.scopeId)}
														<div
															className={
																styles.scope
															}
														>
															{a.scopeType}
														</div>
													</>
												)}
											</td>
											<td>{resolution(a)}</td>
											<td>{a.grantedBy ?? "-"}</td>
											<td>
												<button
													type="button"
													className={admin.linkButton}
													disabled={busy}
													onClick={() =>
														void post(
															{
																action: "revoke",
																assignmentId:
																	a.assignmentId,
															},
															"Could not revoke",
														)
													}
												>
													Revoke
												</button>
											</td>
										</tr>
									))}
									{showSkeleton &&
										Array.from({ length: 3 }, (_, row) => (
											<tr key={`loading-a-${row}`}>
												{Array.from(
													{ length: 5 },
													(_, col) => (
														<td key={col}>
															<Skeleton
																height={12}
															/>
														</td>
													),
												)}
											</tr>
										))}
								</tbody>
							</table>
						</div>
					)}
				</section>
			)}

			{failure && <div className={admin.saveError}>{failure}</div>}

			{editing && (
				<RoleDialog
					draft={editing}
					known={known}
					existing={roles.some((r) => r.roleId === editing.roleId)}
					busy={busy}
					onSave={async (next) => {
						const ok = await post(
							{ action: "saveRole", ...next },
							"Could not save that role",
						);
						if (ok) setEditing(null);
					}}
					onClose={() => setEditing(null)}
				/>
			)}

			{assigning && (
				<AssignDialog
					roles={roles}
					resources={resources}
					busy={busy}
					onAssign={async (next) => {
						const ok = await post(
							{ action: "assign", ...next },
							"Could not assign that role",
						);
						if (ok) setAssigning(false);
					}}
					onClose={() => setAssigning(false)}
				/>
			)}
		</div>
	);
}

function RoleDialog({
	draft,
	known,
	existing,
	busy,
	onSave,
	onClose,
}: {
	draft: Draft;
	known: string[];
	existing: boolean;
	busy: boolean;
	onSave: (draft: Draft) => void;
	onClose: () => void;
}) {
	const [value, setValue] = useState(draft);

	const toggle = (capability: string) =>
		setValue((v) => ({
			...v,
			capabilities: v.capabilities.includes(capability)
				? v.capabilities.filter((c) => c !== capability)
				: [...v.capabilities, capability],
		}));

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={existing ? `Edit ${draft.name}` : "New role"}
			// Wide enough for the three capability columns to sit side by side
			// rather than wrapping to one.
			width="700px"
		>
			<div className={form.form}>
				<label className={form.field}>
					<span className={form.label}>Name</span>
					<input
						className={form.input}
						value={value.name}
						placeholder="Regional editor"
						onChange={(e) =>
							setValue((v) => ({
								...v,
								name: e.target.value,
								// The id follows the name until the role has
								// been saved, after which it is fixed.
								roleId: existing
									? v.roleId
									: e.target.value
											.toLowerCase()
											.replace(/[^a-z0-9]+/g, "-")
											.replace(/^-+|-+$/g, "")
											.slice(0, 40),
							}))
						}
						autoFocus
					/>
				</label>

				<div className={form.field}>
					<span className={form.label}>Level</span>
					<div className={styles.levels}>
						{levels.map((level) => {
							const on = value.permission === level.value;
							return (
								<button
									key={level.value}
									type="button"
									className={`${styles.levelCard} ${
										on ? styles.levelCardOn : ""
									}`}
									onClick={() =>
										setValue((v) => ({
											...v,
											permission:
												level.value as Draft["permission"],
										}))
									}
									aria-pressed={on}
								>
									<span className={styles.levelCardName}>
										{level.name}
									</span>
									<span className={styles.levelCardWhat}>
										{level.what}
									</span>
								</button>
							);
						})}
					</div>
				</div>

				<label className={form.field}>
					<span className={form.label}>Description</span>
					<input
						className={form.input}
						value={value.description}
						placeholder="What this role is for"
						onChange={(e) =>
							setValue((v) => ({
								...v,
								description: e.target.value,
							}))
						}
					/>
				</label>

				<div className={form.field}>
					<span className={form.label}>Can also</span>
					<div className={styles.areas}>
						{areaOrder.map((area) => {
							const inArea = known.filter(
								(c) =>
									(capabilityInfo[c]?.area ??
										"Administration") === area,
							);
							if (inArea.length === 0) return null;
							return (
								<div key={area} className={styles.area}>
									<span className={styles.areaName}>
										{area}
									</span>
									{inArea.map((capability) => {
										const on =
											value.capabilities.includes(
												capability,
											);
										return (
											<button
												key={capability}
												type="button"
												className={`${styles.capability} ${
													on
														? styles.capabilityOn
														: ""
												}`}
												onClick={() =>
													toggle(capability)
												}
												aria-pressed={on}
												title={capability}
											>
												<span
													className={`${styles.check} ${
														on ? styles.checkOn : ""
													}`}
													aria-hidden="true"
												>
													{on ? "✓" : ""}
												</span>
												<span
													className={
														styles.capabilityName
													}
												>
													{capabilityInfo[capability]
														?.label ?? capability}
												</span>
											</button>
										);
									})}
								</div>
							);
						})}
					</div>
				</div>

				<div className={form.actions}>
					<button
						type="button"
						className={form.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={form.primary}
						disabled={
							busy || !value.name.trim() || !value.roleId.trim()
						}
						onClick={() => onSave(value)}
					>
						{busy ? "Saving" : existing ? "Save" : "Create"}
					</button>
				</div>
			</div>
		</Modal>
	);
}

function AssignDialog({
	roles,
	resources,
	busy,
	onAssign,
	onClose,
}: {
	roles: RoleRecord[];
	resources: ResourceResponse | undefined;
	busy: boolean;
	onAssign: (input: Record<string, unknown>) => void;
	onClose: () => void;
}) {
	const [roleId, setRoleId] = useState("");
	const [subjectType, setSubjectType] = useState<"group" | "user">("group");
	const [subjectId, setSubjectId] = useState("");
	const [scopeType, setScopeType] = useState<
		"global" | "category" | "report"
	>("global");
	const [scopeId, setScopeId] = useState("");

	const scopeChoices =
		scopeType === "category"
			? (resources?.categories ?? [])
			: scopeType === "report"
				? (resources?.reports ?? [])
				: [];

	const ready =
		roleId !== "" &&
		subjectId.trim() !== "" &&
		(scopeType === "global" || scopeId !== "");

	return (
		<Modal isOpen onClose={onClose} title="Assign a role" width="620px">
			<div className={form.form}>
				<div className={form.row}>
					<label className={form.field}>
						<span className={form.label}>Role</span>
						<Select
							value={roleId}
							onChange={setRoleId}
							placeholder="Choose one"
							options={roles.map((r) => ({
								value: r.roleId,
								label: r.name,
								note: r.permission,
							}))}
						/>
					</label>

					<label className={form.field}>
						<span className={form.label}>Held by</span>
						<Select
							value={subjectType}
							onChange={(v) =>
								setSubjectType(v as "group" | "user")
							}
							options={[
								{ value: "group", label: "A group" },
								{ value: "user", label: "One person" },
							]}
						/>
					</label>
				</div>

				<label className={form.field}>
					<span className={form.label}>
						{subjectType === "group" ? "Group name" : "Email"}
					</span>
					<input
						className={form.input}
						value={subjectId}
						placeholder={
							subjectType === "group"
								? "Exact account group name"
								: "person@example.com"
						}
						onChange={(e) => setSubjectId(e.target.value)}
					/>
					{subjectType === "group" && (
						<span className={form.hint}>
							Case sensitive, matched exactly as written.
						</span>
					)}
				</label>

				<div className={form.row}>
					<label className={form.field}>
						<span className={form.label}>Where</span>
						<Select
							value={scopeType}
							onChange={(v) => {
								setScopeType(v as typeof scopeType);
								setScopeId("");
							}}
							options={[
								{ value: "global", label: "Everywhere" },
								{ value: "category", label: "One category" },
								{ value: "report", label: "One report" },
							]}
						/>
					</label>

					{scopeType !== "global" && (
						<label className={form.field}>
							<span className={form.label}>
								{scopeType === "category"
									? "Category"
									: "Report"}
							</span>
							<Select
								value={scopeId}
								onChange={setScopeId}
								placeholder="Choose one"
								searchable={scopeChoices.length > 12}
								options={scopeChoices.map((c) => ({
									value: c.id,
									label: c.name,
								}))}
							/>
						</label>
					)}
				</div>

				<div className={form.actions}>
					<button
						type="button"
						className={form.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={form.primary}
						disabled={busy || !ready}
						onClick={() =>
							onAssign({
								roleId,
								subjectType,
								subjectId,
								scopeType,
								scopeId: scopeId || null,
							})
						}
					>
						{busy ? "Assigning" : "Assign"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
