"use client";

import { useState } from "react";
import useSWR from "swr";
import { Select } from "../components/shared/Select";
import { capabilityInfo, capabilityLabel, areaOrder } from "./capabilityLabels";
import admin from "./Admin.module.css";
import form from "../authoring/Authoring.module.css";
import styles from "./Roles.module.css";

// One person's or group's rights in one place, where each came from, and the changes
// that have no role around them: one permission, an exception, or a label.

interface RightSource {
	kind: "role" | "rule" | "single" | "everyone";
	name: string;
	where: string;
	expiresOn: string | null;
}

interface Right {
	capability: string;
	sources: RightSource[];
	exceptions: {
		where: string;
		expiresOn: string | null;
		reason: string | null;
	}[];
}

interface Grant {
	grantId: string;
	capability: string;
	effect: "allow" | "deny";
	scopeType: string;
	scopeId: string | null;
	reason: string | null;
	expiresOn: string | null;
	grantedBy: string | null;
}

interface Rule {
	ruleId: string;
	attribute: string;
	value: string;
	roleId: string;
	roleName: string;
	scopeType: string;
	scopeId: string | null;
}

interface RightsResponse {
	roles: { roleId: string; name: string }[];
	rules: Rule[];
	subject?: string;
	grants?: Grant[];
	attributes?: { attribute: string; value: string }[];
	matchedRules?: Rule[];
	rights?: Right[];
	history?: {
		action: string;
		changedBy: string;
		changedOn: string;
		detail: string | null;
	}[];
}

interface Resources {
	categories: { id: string; name: string }[];
	reports: { id: string; name: string }[];
	pages?: { id: string; name: string }[];
}

// Picks what a right applies to. A tag is typed, since any word can be one, and a
// category or report is chosen by name.
function ScopeTarget({
	scopeType,
	scopeId,
	onChange,
	resources,
}: {
	scopeType: string;
	scopeId: string;
	onChange: (value: string) => void;
	resources: Resources | undefined;
}) {
	if (scopeType === "global") return null;
	if (scopeType === "tag" || scopeType === "source") {
		return (
			<label className={form.field}>
				<span className={form.label}>
					{scopeType === "tag" ? "Tag" : "Source key"}
				</span>
				<input
					className={form.input}
					value={scopeId}
					onChange={(e) => onChange(e.target.value)}
				/>
			</label>
		);
	}
	const choices =
		scopeType === "category"
			? (resources?.categories ?? [])
			: scopeType === "page"
				? (resources?.pages ?? [])
				: (resources?.reports ?? []);
	return (
		<label className={form.field}>
			<span className={form.label}>
				{scopeType === "category"
					? "Category"
					: scopeType === "page"
						? "Page"
						: "Report"}
			</span>
			<Select
				value={scopeId}
				onChange={onChange}
				placeholder="Choose one"
				searchable={choices.length > 12}
				options={choices.map((choice) => ({
					value: choice.id,
					label: choice.name,
				}))}
			/>
		</label>
	);
}

const scopeOptions = [
	{ value: "global", label: "Everywhere" },
	{ value: "category", label: "One category" },
	{ value: "tag", label: "A tag" },
	{ value: "report", label: "One report" },
	{ value: "page", label: "One page" },
	{ value: "source", label: "One source" },
];

const subjectOptions = [
	{ value: "user", label: "A person" },
	{ value: "group", label: "A group" },
	{ value: "service_principal", label: "A service principal" },
];

const actionWords: Record<string, string> = {
	assign_role: "Assigned a role",
	revoke_role: "Removed a role",
	add_exception: "Added an exception",
	grant_permission: "Gave a permission",
	remove_permission: "Removed a permission or exception",
	set_attribute: "Set a label",
	remove_attribute: "Removed a label",
};

function day(iso: string | null): string {
	return iso ? new Date(iso).toLocaleDateString() : "";
}

function whereText(
	scopeType: string,
	scopeId: string | null,
	resources: Resources | undefined,
): string {
	if (scopeType === "global") return "Everywhere";
	const found = [
		...(resources?.categories ?? []),
		...(resources?.reports ?? []),
		...(resources?.pages ?? []),
	].find((choice) => choice.id === scopeId);
	return `${scopeType} ${found?.name ?? scopeId}`;
}

export default function ProfilesPane() {
	const [draft, setDraft] = useState("");
	const [subject, setSubject] = useState("");
	const [subjectType, setSubjectType] = useState("user");
	const [failure, setFailure] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const { data, mutate } = useSWR<RightsResponse>(
		`/api/admin/rights${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`,
		{ keepPreviousData: false },
	);

	const { data: resources } = useSWR<Resources>("/api/admin/access");

	const post = async (body: Record<string, unknown>): Promise<boolean> => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/admin/rights", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? "Could not make that change.");
				return false;
			}
			await mutate();
			return true;
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not make that change.",
			);
			return false;
		} finally {
			setBusy(false);
		}
	};

	const onSubject = { subjectType, subjectId: subject };

	return (
		<div className={styles.pane}>
			<section className={styles.group}>
				<div className={form.row}>
					<label className={form.field}>
						<span className={form.label}>Looking at</span>
						<Select
							value={subjectType}
							onChange={setSubjectType}
							options={subjectOptions}
						/>
					</label>
					<label className={form.field}>
						<span className={form.label}>
							{subjectType === "group"
								? "Group name"
								: subjectType === "user"
									? "Email"
									: "Application id"}
						</span>
						<input
							className={form.input}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") setSubject(draft.trim());
							}}
							onBlur={() => setSubject(draft.trim())}
						/>
						<span className={form.hint}>
							Shows what names them directly. Groups they belong
							to add to this, and the app can only see those for
							the person signed in.
						</span>
					</label>
				</div>
			</section>

			{failure && <div className={admin.saveError}>{failure}</div>}

			{subject && data?.rights && (
				<>
					<section className={styles.group}>
						<div className={styles.groupHead}>
							<div>
								<h3 className={styles.groupTitle}>
									Rights, and where each comes from
								</h3>
							</div>
						</div>
						<div className={admin.tableWrap}>
							<table className={admin.table}>
								<thead>
									<tr>
										<th>Permission</th>
										<th>From</th>
										<th>Exception</th>
									</tr>
								</thead>
								<tbody>
									{data.rights.map((right) => (
										<tr key={right.capability}>
											<td>
												{capabilityLabel(
													right.capability,
												)}
											</td>
											<td>
												{right.sources.map(
													(source, i) => (
														<div key={i}>
															{source.name}
															<span
																className={
																	styles.scope
																}
															>
																{" "}
																{source.where}
																{source.expiresOn
																	? `, ends ${day(source.expiresOn)}`
																	: ""}
															</span>
														</div>
													),
												)}
											</td>
											<td>
												{right.exceptions.map(
													(held, i) => (
														<div
															key={i}
															className={
																admin.warnText
															}
														>
															Removed{" "}
															{held.where.toLowerCase()}
															{held.expiresOn
																? ` until ${day(held.expiresOn)}`
																: ""}
														</div>
													),
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>

					<SinglePermissions
						resources={resources}
						grants={data.grants ?? []}
						busy={busy}
						onAdd={(input) =>
							post({ action: "grant", ...onSubject, ...input })
						}
						onRemove={(grantId) =>
							post({ action: "ungrant", grantId, ...onSubject })
						}
					/>

					<Labels
						attributes={data.attributes ?? []}
						busy={busy}
						onSet={(attribute, value) =>
							post({
								action: "setAttribute",
								attribute,
								value,
								...onSubject,
							})
						}
						onRemove={(attribute) =>
							post({
								action: "removeAttribute",
								attribute,
								...onSubject,
							})
						}
					/>

					<section className={styles.group}>
						<div className={styles.groupHead}>
							<h3 className={styles.groupTitle}>History</h3>
						</div>
						{(data.history ?? []).length === 0 ? (
							<p className={styles.empty}>
								Nothing recorded for them yet.
							</p>
						) : (
							<div className={admin.tableWrap}>
								<table className={admin.table}>
									<thead>
										<tr>
											<th>When</th>
											<th>What</th>
											<th>By</th>
										</tr>
									</thead>
									<tbody>
										{(data.history ?? []).map((row, i) => (
											<tr key={i}>
												<td>{day(row.changedOn)}</td>
												<td>
													{actionWords[row.action] ??
														row.action}
												</td>
												<td>{row.changedBy}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>
				</>
			)}

			<AttributeRules
				resources={resources}
				rules={data?.rules ?? []}
				roles={data?.roles ?? []}
				busy={busy}
				onAdd={(input) => post({ action: "saveRule", ...input })}
				onRemove={(ruleId) => post({ action: "removeRule", ruleId })}
			/>
		</div>
	);
}

function SinglePermissions({
	resources,
	grants,
	busy,
	onAdd,
	onRemove,
}: {
	resources: Resources | undefined;
	grants: Grant[];
	busy: boolean;
	onAdd: (input: Record<string, unknown>) => Promise<boolean>;
	onRemove: (grantId: string) => void;
}) {
	const [capability, setCapability] = useState("");
	const [effect, setEffect] = useState("allow");
	const [scopeType, setScopeType] = useState("global");
	const [scopeId, setScopeId] = useState("");
	const [expiresOn, setExpiresOn] = useState("");
	const [reason, setReason] = useState("");

	const options = areaOrder.flatMap((area) =>
		Object.entries(capabilityInfo)
			.filter(([, info]) => info.area === area)
			.map(([value, info]) => ({
				value,
				label: info.label,
				group: area,
			})),
	);

	return (
		<section className={styles.group}>
			<div className={styles.groupHead}>
				<div>
					<h3 className={styles.groupTitle}>
						One permission, or an exception
					</h3>
					<p className={styles.groupBlurb}>
						With no role around it. An exception takes a permission
						away and wins over anything they hold.
					</p>
				</div>
			</div>

			{grants.length > 0 && (
				<div className={admin.tableWrap}>
					<table className={admin.table}>
						<thead>
							<tr>
								<th>Permission</th>
								<th>Effect</th>
								<th>Where</th>
								<th>Ends</th>
								<th>By</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{grants.map((grant) => (
								<tr key={grant.grantId}>
									<td>{capabilityLabel(grant.capability)}</td>
									<td>
										{grant.effect === "deny"
											? "Exception"
											: "Given"}
									</td>
									<td>
										{whereText(
											grant.scopeType,
											grant.scopeId,
											resources,
										)}
									</td>
									<td>{day(grant.expiresOn) || "-"}</td>
									<td>{grant.grantedBy ?? "-"}</td>
									<td>
										<button
											type="button"
											className={admin.linkButton}
											disabled={busy}
											onClick={() =>
												onRemove(grant.grantId)
											}
										>
											Remove
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<div className={form.row}>
				<label className={form.field}>
					<span className={form.label}>Permission</span>
					<Select
						value={capability}
						onChange={setCapability}
						placeholder="Choose one"
						searchable
						options={options}
					/>
				</label>
				<label className={form.field}>
					<span className={form.label}>Effect</span>
					<Select
						value={effect}
						onChange={setEffect}
						options={[
							{ value: "allow", label: "Give it" },
							{ value: "deny", label: "Take it away" },
						]}
					/>
				</label>
			</div>
			<div className={form.row}>
				<label className={form.field}>
					<span className={form.label}>Where</span>
					<Select
						value={scopeType}
						onChange={(next) => {
							setScopeType(next);
							setScopeId("");
						}}
						options={scopeOptions}
					/>
				</label>
				<ScopeTarget
					scopeType={scopeType}
					scopeId={scopeId}
					onChange={setScopeId}
					resources={resources}
				/>
				<label className={form.field}>
					<span className={form.label}>Ends on, if it should</span>
					<input
						type="date"
						className={form.input}
						value={expiresOn}
						onChange={(e) => setExpiresOn(e.target.value)}
					/>
				</label>
			</div>
			<label className={form.field}>
				<span className={form.label}>Why</span>
				<input
					className={form.input}
					value={reason}
					onChange={(e) => setReason(e.target.value)}
				/>
			</label>
			<div className={form.actions}>
				<button
					type="button"
					className={form.primary}
					disabled={
						busy ||
						!capability ||
						(scopeType !== "global" && !scopeId.trim())
					}
					onClick={async () => {
						const ok = await onAdd({
							capability,
							effect,
							scopeType,
							scopeId: scopeId.trim() || null,
							expiresOn: expiresOn || null,
							reason: reason.trim() || null,
						});
						if (ok) {
							setCapability("");
							setReason("");
							setExpiresOn("");
						}
					}}
				>
					{effect === "deny" ? "Take it away" : "Give it"}
				</button>
			</div>
		</section>
	);
}

function Labels({
	attributes,
	busy,
	onSet,
	onRemove,
}: {
	attributes: { attribute: string; value: string }[];
	busy: boolean;
	onSet: (attribute: string, value: string) => Promise<boolean>;
	onRemove: (attribute: string) => void;
}) {
	const [attribute, setAttribute] = useState("");
	const [value, setValue] = useState("");
	return (
		<section className={styles.group}>
			<div className={styles.groupHead}>
				<div>
					<h3 className={styles.groupTitle}>Labels</h3>
					<p className={styles.groupBlurb}>
						Anything you want to grant rights from, such as
						Department = Finance.
					</p>
				</div>
			</div>
			<div className={styles.chips}>
				{attributes.map((held) => (
					<span key={held.attribute} className={styles.chip}>
						{held.attribute} = {held.value}{" "}
						<button
							type="button"
							className={admin.linkButton}
							disabled={busy}
							onClick={() => onRemove(held.attribute)}
						>
							Remove
						</button>
					</span>
				))}
			</div>
			<div className={form.row}>
				<label className={form.field}>
					<span className={form.label}>Label</span>
					<input
						className={form.input}
						value={attribute}
						placeholder="Department"
						onChange={(e) => setAttribute(e.target.value)}
					/>
				</label>
				<label className={form.field}>
					<span className={form.label}>Value</span>
					<input
						className={form.input}
						value={value}
						placeholder="Finance"
						onChange={(e) => setValue(e.target.value)}
					/>
				</label>
			</div>
			<div className={form.actions}>
				<button
					type="button"
					className={form.primary}
					disabled={busy || !attribute.trim() || !value.trim()}
					onClick={async () => {
						if (await onSet(attribute, value)) {
							setAttribute("");
							setValue("");
						}
					}}
				>
					Set label
				</button>
			</div>
		</section>
	);
}

function AttributeRules({
	resources,
	rules,
	roles,
	busy,
	onAdd,
	onRemove,
}: {
	resources: Resources | undefined;
	rules: Rule[];
	roles: { roleId: string; name: string }[];
	busy: boolean;
	onAdd: (input: Record<string, unknown>) => Promise<boolean>;
	onRemove: (ruleId: string) => void;
}) {
	const [attribute, setAttribute] = useState("");
	const [value, setValue] = useState("");
	const [roleId, setRoleId] = useState("");
	const [scopeType, setScopeType] = useState("global");
	const [scopeId, setScopeId] = useState("");

	return (
		<section className={styles.group}>
			<div className={styles.groupHead}>
				<div>
					<h3 className={styles.groupTitle}>Rules</h3>
					<p className={styles.groupBlurb}>
						Everyone carrying a label holds a role, without
						assigning it to each of them.
					</p>
				</div>
			</div>
			{rules.length > 0 && (
				<div className={admin.tableWrap}>
					<table className={admin.table}>
						<thead>
							<tr>
								<th>Label</th>
								<th>Role</th>
								<th>Where</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{rules.map((rule) => (
								<tr key={rule.ruleId}>
									<td>
										{rule.attribute} = {rule.value}
									</td>
									<td>{rule.roleName}</td>
									<td>
										{whereText(
											rule.scopeType,
											rule.scopeId,
											resources,
										)}
									</td>
									<td>
										<button
											type="button"
											className={admin.linkButton}
											disabled={busy}
											onClick={() =>
												onRemove(rule.ruleId)
											}
										>
											Remove
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<div className={form.row}>
				<label className={form.field}>
					<span className={form.label}>Label</span>
					<input
						className={form.input}
						value={attribute}
						onChange={(e) => setAttribute(e.target.value)}
					/>
				</label>
				<label className={form.field}>
					<span className={form.label}>Value</span>
					<input
						className={form.input}
						value={value}
						onChange={(e) => setValue(e.target.value)}
					/>
				</label>
				<label className={form.field}>
					<span className={form.label}>Role</span>
					<Select
						value={roleId}
						onChange={setRoleId}
						placeholder="Choose one"
						options={roles.map((role) => ({
							value: role.roleId,
							label: role.name,
						}))}
					/>
				</label>
			</div>
			<div className={form.row}>
				<label className={form.field}>
					<span className={form.label}>Where</span>
					<Select
						value={scopeType}
						onChange={(next) => {
							setScopeType(next);
							setScopeId("");
						}}
						options={scopeOptions}
					/>
				</label>
				<ScopeTarget
					scopeType={scopeType}
					scopeId={scopeId}
					onChange={setScopeId}
					resources={resources}
				/>
			</div>
			<div className={form.actions}>
				<button
					type="button"
					className={form.primary}
					disabled={
						busy ||
						!attribute.trim() ||
						!value.trim() ||
						!roleId ||
						(scopeType !== "global" && !scopeId.trim())
					}
					onClick={async () => {
						const ok = await onAdd({
							attribute,
							value,
							roleId,
							scopeType,
							scopeId: scopeId.trim() || null,
						});
						if (ok) {
							setAttribute("");
							setValue("");
						}
					}}
				>
					Add rule
				</button>
			</div>
		</section>
	);
}
