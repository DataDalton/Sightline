"use client";

import { useState } from "react";
import useSWR from "swr";
import form from "../authoring/Authoring.module.css";
import updates from "../updates/Updates.module.css";
import styles from "./Admin.module.css";

// The kinds of update people can post, and the saved starting points for them.

interface Answer {
	types: {
		typeId: string;
		label: string;
		color: string;
		impact: string;
		isBuiltin: boolean;
	}[];
	templates: { templateId: string; name: string; type: string }[];
	canModerate: boolean;
}

async function post(body: Record<string, unknown>) {
	const response = await fetch("/api/changes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const detail = await response.json().catch(() => null);
	if (!response.ok) throw new Error(detail?.error ?? "That did not work.");
}

interface Aliases {
	aliases: {
		alias: string;
		kind: "github" | "principal";
		email: string | null;
		displayName: string | null;
	}[];
	unmatched: string[];
}

// One name to set: a GitHub name matched to a person, or a name for an automation.
function AliasRow({
	kind,
	alias,
	email: startEmail,
	displayName: startName,
	saved,
	onSave,
	onRemove,
}: {
	kind: "github" | "principal";
	alias: string;
	email?: string | null;
	displayName?: string | null;
	saved: boolean;
	onSave: (input: { email: string; displayName: string }) => void;
	onRemove?: () => void;
}) {
	const [email, setEmail] = useState(startEmail ?? "");
	const [displayName, setDisplayName] = useState(startName ?? "");
	return (
		<div className={updates.typeRow}>
			<span className={updates.typeRowName}>
				{kind === "github" ? `github:${alias}` : alias}
			</span>
			{kind === "github" && (
				<input
					className={form.input}
					value={email}
					placeholder="Their email in the app"
					aria-label={`Email for ${alias}`}
					onChange={(e) => setEmail(e.target.value)}
				/>
			)}
			<input
				className={form.input}
				value={displayName}
				placeholder={
					kind === "github"
						? "Name to show, if not from the email"
						: "Name to show, such as Changelog"
				}
				aria-label={`Name to show for ${alias}`}
				onChange={(e) => setDisplayName(e.target.value)}
			/>
			<button
				type="button"
				className={styles.linkButton}
				onClick={() => onSave({ email, displayName })}
			>
				{saved ? "Save" : "Match"}
			</button>
			{onRemove && (
				<button
					type="button"
					className={styles.linkButton}
					onClick={onRemove}
				>
					Remove
				</button>
			)}
		</div>
	);
}

function AuthorNames({
	act,
}: {
	act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
	const { data, mutate } = useSWR<Aliases>("/api/changes?aliases=1");
	const [principalId, setPrincipalId] = useState("");
	const [principalName, setPrincipalName] = useState("");
	if (!data) return null;
	const save = async (body: Record<string, unknown>) => {
		if (await act({ action: "saveAlias", ...body })) await mutate();
	};
	const remove = async (alias: string) => {
		if (await act({ action: "removeAlias", alias })) await mutate();
	};
	const github = data.aliases.filter((alias) => alias.kind === "github");
	const principals = data.aliases.filter(
		(alias) => alias.kind === "principal",
	);
	return (
		<>
			<header className={styles.sectionHead}>
				<h2 className={styles.sectionTitle}>Authors from GitHub</h2>
				<p className={styles.paneBlurb}>
					An automation can credit authors by GitHub name. Matching a
					name to somebody&apos;s email shows them by their own name,
					on entries already posted as well as new ones. Names not
					matched yet are listed first.
				</p>
			</header>
			{data.unmatched.length === 0 && github.length === 0 ? (
				<p className={updates.meta}>
					No GitHub names on any update yet.
				</p>
			) : (
				<div className={updates.typeTable}>
					{data.unmatched.map((login) => (
						<AliasRow
							key={`unmatched-${login}`}
							kind="github"
							alias={login}
							saved={false}
							onSave={(input) =>
								void save({
									kind: "github",
									alias: login,
									...input,
								})
							}
						/>
					))}
					{github.map((alias) => (
						<AliasRow
							key={alias.alias}
							kind="github"
							alias={alias.alias}
							email={alias.email}
							displayName={alias.displayName}
							saved
							onSave={(input) =>
								void save({
									kind: "github",
									alias: alias.alias,
									...input,
								})
							}
							onRemove={() => void remove(alias.alias)}
						/>
					))}
				</div>
			)}

			<header className={styles.sectionHead}>
				<h2 className={styles.sectionTitle}>Automations that post</h2>
				<p className={styles.paneBlurb}>
					A service principal posts under its ID. Give it a name, and
					that name shows wherever it posted.
				</p>
			</header>
			{principals.length > 0 && (
				<div className={updates.typeTable}>
					{principals.map((alias) => (
						<AliasRow
							key={alias.alias}
							kind="principal"
							alias={alias.alias}
							displayName={alias.displayName}
							saved
							onSave={(input) =>
								void save({
									kind: "principal",
									alias: alias.alias,
									displayName: input.displayName,
								})
							}
							onRemove={() => void remove(alias.alias)}
						/>
					))}
				</div>
			)}
			<div className={form.row}>
				<label className={form.field}>
					<span className={form.label}>Service principal ID</span>
					<input
						className={form.input}
						value={principalId}
						onChange={(e) => setPrincipalId(e.target.value)}
					/>
				</label>
				<label className={form.field}>
					<span className={form.label}>Name to show</span>
					<input
						className={form.input}
						value={principalName}
						placeholder="Such as Changelog"
						onChange={(e) => setPrincipalName(e.target.value)}
					/>
				</label>
				<button
					type="button"
					className={styles.actionPrimary}
					disabled={!principalId.trim() || !principalName.trim()}
					onClick={async () => {
						await save({
							kind: "principal",
							alias: principalId.trim(),
							displayName: principalName.trim(),
						});
						setPrincipalId("");
						setPrincipalName("");
					}}
				>
					Name it
				</button>
			</div>
		</>
	);
}

export default function UpdateTypesPane() {
	const { data, mutate } = useSWR<Answer>("/api/changes");
	const [label, setLabel] = useState("");
	const [color, setColor] = useState("#6aa9ff");
	const [failure, setFailure] = useState<string | null>(null);
	const act = async (body: Record<string, unknown>) => {
		setFailure(null);
		try {
			await post(body);
			await mutate();
			return true;
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
			return false;
		}
	};
	if (!data) return null;
	if (!data.canModerate) {
		return <p>You do not hold the right to look after update types.</p>;
	}
	const typeName = (typeId: string) =>
		data.types.find((type) => type.typeId === typeId)?.label ?? typeId;
	return (
		<>
			<div className={updates.typeTable}>
				{data.types.map((type) => (
					<div key={type.typeId} className={updates.typeRow}>
						<span
							className={updates.typeSwatch}
							style={{ background: type.color }}
							aria-hidden="true"
						/>
						<span className={updates.typeRowName}>
							{type.label}
						</span>
						<span className={updates.meta}>
							{type.isBuiltin ? "Built in" : "Added here"},
							usually {type.impact}
						</span>
						{!type.isBuiltin && (
							<button
								type="button"
								className={styles.linkButton}
								onClick={() =>
									void act({
										action: "removeType",
										typeId: type.typeId,
									})
								}
							>
								Remove
							</button>
						)}
					</div>
				))}
			</div>

			<div className={form.row}>
				<label className={form.field}>
					<span className={form.label}>New type</span>
					<input
						className={form.input}
						value={label}
						placeholder="Such as Pipeline change"
						onChange={(e) => setLabel(e.target.value)}
					/>
				</label>
				<label className={form.field}>
					<span className={form.label}>Colour on its badge</span>
					<input
						type="color"
						className={form.input}
						value={color}
						onChange={(e) => setColor(e.target.value)}
					/>
				</label>
				<button
					type="button"
					className={styles.actionPrimary}
					disabled={!label.trim()}
					onClick={async () => {
						const ok = await act({
							action: "saveType",
							label,
							color,
						});
						if (ok) setLabel("");
					}}
				>
					Add type
				</button>
			</div>

			<header className={styles.sectionHead}>
				<h2 className={styles.sectionTitle}>Templates</h2>
				<p className={styles.paneBlurb}>
					Saved from New update, and chosen under Start from. An
					automation uses one by sending its name as template when it
					posts.
				</p>
			</header>
			{data.templates.length === 0 ? (
				<p className={updates.meta}>No templates saved yet.</p>
			) : (
				<div className={updates.typeTable}>
					{data.templates.map((template) => (
						<div
							key={template.templateId}
							className={updates.typeRow}
						>
							<span className={updates.typeRowName}>
								{template.name}
							</span>
							<span className={updates.meta}>
								{typeName(template.type)}
							</span>
							<button
								type="button"
								className={styles.linkButton}
								onClick={() =>
									void act({
										action: "removeTemplate",
										templateId: template.templateId,
									})
								}
							>
								Remove
							</button>
						</div>
					))}
				</div>
			)}
			<AuthorNames act={act} />
			{failure && <p role="alert">{failure}</p>}
		</>
	);
}
