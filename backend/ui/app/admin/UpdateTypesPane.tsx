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
			{failure && <p role="alert">{failure}</p>}
		</>
	);
}
