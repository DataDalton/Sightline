"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import type { WorkConfig } from "../../lib/work/model";
import type { WorkSummary } from "../../lib/work/store";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { columnLabel, effortLabel, postJson } from "./labels";
import { ReleaseSelect } from "./ReleaseControls";
import styles from "./Work.module.css";

// Making an item on the queue.
//
// For a reader it asks the data engineers for work. Each kind of work asks its
// own questions, and while they write, open requests that read alike are shown
// so they can add "me too" to one instead of filing the same thing twice.
//
// For an engineer it makes the item directly, in the column they choose, with
// its effort, target and who works it.
//
// Used from the queue, from the assistant and from a conversation about
// feedback, each of which can start it filled in.

export interface RequestDraft {
	title?: string;
	description?: string;
	workType?: string;
	sources?: string[];
	requesters?: string[];
	origin?: Record<string, unknown>;
	parentKey?: string;
	// The column a new item starts in, when made from that column.
	status?: string;
	// The release it joins, when made from that release's row on the board.
	releaseId?: string;
	// Asks for the work even when an engineer fills it in, so they are its
	// requester and it starts where any request does.
	asRequest?: boolean;
}

interface Choices {
	sources: { key: string; title: string }[];
}

export function RequestForm({
	config,
	draft = {},
	onClose,
	onCreated,
	engineer = false,
	me = "",
}: {
	config: WorkConfig;
	draft?: RequestDraft;
	onClose: () => void;
	onCreated: (key: string) => void;
	// Makes the item directly rather than asking for it.
	engineer?: boolean;
	// The signed-in person, assigned by default when an engineer makes one.
	me?: string;
}) {
	const { data: choices } = useSWR<Choices>("/api/changes?choices=1");
	const [workType, setWorkType] = useState(
		draft.workType ?? config.workTypes[0]?.id ?? "",
	);
	const [title, setTitle] = useState(draft.title ?? "");
	const [description, setDescription] = useState(draft.description ?? "");
	const [priority, setPriority] = useState("");
	const [domain, setDomain] = useState("");
	const [layer, setLayer] = useState("");
	const [source, setSource] = useState(draft.sources?.[0] ?? "");
	const [sensitive, setSensitive] = useState(false);
	const columns = config.columns.filter((c) => !c.hidden);
	const [status, setStatus] = useState(
		draft.status ?? columns[0]?.id ?? "new",
	);
	const [effort, setEffort] = useState("");
	const [target, setTarget] = useState("");
	const [release, setRelease] = useState(draft.releaseId ?? "");
	const [assignToMe, setAssignToMe] = useState(true);
	const [sending, setSending] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [similar, setSimilar] = useState<
		(WorkSummary & { likeness: number })[]
	>([]);
	const [joined, setJoined] = useState<string | null>(null);

	const type = config.workTypes.find((t) => t.id === workType);

	// Requests that read alike, looked for once the writing pauses.
	useEffect(() => {
		if (title.trim().length < 5 && description.trim().length < 15) {
			setSimilar([]);
			return;
		}
		const timer = setTimeout(() => {
			const params = new URLSearchParams({
				similar: "1",
				title,
				description: description.slice(0, 1500),
				sources: source,
			});
			void fetch(`/api/work?${params}`)
				.then((r) => (r.ok ? r.json() : { similar: [] }))
				.then(
					(answer: {
						similar: (WorkSummary & { likeness: number })[];
					}) => setSimilar(answer.similar ?? []),
				)
				.catch(() => setSimilar([]));
		}, 500);
		return () => clearTimeout(timer);
	}, [title, description, source]);

	const meToo = async (key: string) => {
		try {
			await postJson(`/api/work/${key}`, { action: "meToo", on: true });
			setJoined(key);
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
		}
	};

	const send = async () => {
		setSending(true);
		setFailure(null);
		try {
			const answer = await postJson("/api/work", {
				title,
				description,
				workType,
				priority: priority || null,
				...(engineer
					? {
							status,
							effort: effort || null,
							target: release ? null : target || null,
							releaseId: release || null,
							assignees: assignToMe && me ? [me] : [],
						}
					: {}),
				domain: domain || null,
				layer: layer || null,
				visibility: sensitive ? "restricted" : "normal",
				links: source ? [{ kind: "source", target: source }] : [],
				requesters: draft.requesters ?? [],
				origin: draft.origin ?? { kind: "form" },
				parentKey: draft.parentKey ?? null,
				asRequest: !engineer,
			});
			const item = answer.item as WorkSummary;
			onCreated(item.key);
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "It could not be sent.",
			);
		} finally {
			setSending(false);
		}
	};

	if (joined) {
		return (
			<Modal
				isOpen
				onClose={onClose}
				title="Added you to it"
				width="560px"
			>
				<p className={styles.lead}>
					You are on {joined} now, so you will hear when it moves and
					when it is done.
				</p>
				<div className={styles.formActions}>
					<button
						type="button"
						className={styles.secondary}
						onClick={onClose}
					>
						Close
					</button>
					<button
						type="button"
						className={styles.primary}
						onClick={() => onCreated(joined)}
					>
						Open {joined}
					</button>
				</div>
			</Modal>
		);
	}

	const option = (list: { id: string; label: string }[], none: string) => [
		{ value: "", label: none },
		...list.map((c) => ({ value: c.id, label: c.label })),
	];

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={engineer ? "New item" : "Request work"}
			width="820px"
		>
			<div className={styles.form}>
				<label className={styles.field}>
					<span>Title</span>
					<input
						className={styles.input}
						value={title}
						maxLength={200}
						autoFocus
						placeholder={
							engineer
								? "A short line saying what the work is"
								: "A short line saying what is needed"
						}
						onChange={(e) => setTitle(e.target.value)}
					/>
				</label>

				<div className={styles.formGrid}>
					<label className={styles.field}>
						<span>Type</span>
						<Select
							value={workType}
							ariaLabel="Type"
							onChange={setWorkType}
							options={config.workTypes.map((t) => ({
								value: t.id,
								label: t.label,
							}))}
						/>
					</label>
					<label className={styles.field}>
						<span>Priority</span>
						<Select
							value={priority}
							ariaLabel="Priority"
							onChange={setPriority}
							options={option(
								config.priorities,
								engineer
									? "Not set"
									: "Let the engineers decide",
							)}
						/>
					</label>
					<label className={styles.field}>
						<span>Dataset</span>
						<Select
							value={source}
							ariaLabel="Dataset"
							searchable
							onChange={setSource}
							options={[
								{ value: "", label: "None in particular" },
								...(choices?.sources ?? []).map((s) => ({
									value: s.key,
									label: s.title,
								})),
							]}
						/>
					</label>
					{config.domains.length > 0 && (
						<label className={styles.field}>
							<span>Domain</span>
							<Select
								value={domain}
								ariaLabel="Domain"
								onChange={setDomain}
								options={option(config.domains, "Not sure")}
							/>
						</label>
					)}
					{config.layers.length > 0 && (
						<label className={styles.field}>
							<span>Layer</span>
							<Select
								value={layer}
								ariaLabel="Layer"
								onChange={setLayer}
								options={option(config.layers, "Not sure")}
							/>
						</label>
					)}
				</div>

				<label className={styles.field}>
					<span>Details</span>
					<textarea
						className={styles.input}
						rows={6}
						value={description}
						placeholder={
							(type?.prompts ?? []).join("\n") ||
							(engineer
								? "What the work is, and anything worth knowing"
								: "What is needed, and why")
						}
						onChange={(e) => setDescription(e.target.value)}
					/>
				</label>

				{engineer && (
					<div className={styles.formGrid}>
						<label className={styles.field}>
							<span>Column</span>
							<Select
								value={status}
								ariaLabel="Column"
								onChange={setStatus}
								options={columns.map((c) => ({
									value: c.id,
									label: c.label,
								}))}
							/>
						</label>
						<label className={styles.field}>
							<span>Effort</span>
							<Select
								value={effort}
								ariaLabel="Effort"
								onChange={setEffort}
								options={[
									{ value: "", label: "Not sized" },
									...config.efforts.map((e) => ({
										value: e.id,
										label: effortLabel(config, e.id),
									})),
								]}
							/>
						</label>
						<label className={styles.field}>
							<span>Release</span>
							<ReleaseSelect
								value={release}
								onChange={setRelease}
							/>
						</label>
						<label className={styles.field}>
							<span>Target</span>
							<input
								type="date"
								className={styles.input}
								value={target}
								disabled={Boolean(release)}
								title={
									release ? "Set by its release" : undefined
								}
								onChange={(e) => setTarget(e.target.value)}
							/>
						</label>
					</div>
				)}

				<div className={styles.checks}>
					{engineer && me && (
						<Toggle
							checked={assignToMe}
							onChange={setAssignToMe}
							label="Assign it to me"
						/>
					)}
					<Toggle
						checked={sensitive}
						onChange={setSensitive}
						label={
							engineer
								? "Sensitive, seen only by the engineers and the people on it"
								: "Sensitive, seen only by you, the people you add and the engineers"
						}
					/>
				</div>

				{similar.length > 0 && (
					<div className={styles.similar}>
						<span className={styles.similarHead}>
							{engineer
								? "Items already on the board that read alike"
								: "These may already ask for the same thing"}
						</span>
						{similar.map((item) => (
							<div key={item.id} className={styles.similarRow}>
								<a
									href={`/work/${item.key}`}
									target="_blank"
									rel="noreferrer"
									className={styles.similarTitle}
								>
									{item.key} {item.title}
								</a>
								<span className={styles.meta}>
									{columnLabel(config, item.status)},{" "}
									{item.requesters}{" "}
									{item.requesters === 1
										? "person"
										: "people"}{" "}
									asking
								</span>
								{!engineer && (
									<button
										type="button"
										className={styles.secondary}
										onClick={() => void meToo(item.key)}
									>
										Me too
									</button>
								)}
							</div>
						))}
					</div>
				)}

				{failure && <p className={styles.failure}>{failure}</p>}
				<div className={styles.formActions}>
					<button
						type="button"
						className={styles.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={styles.primary}
						disabled={sending || !title.trim()}
						onClick={() => void send()}
					>
						{engineer
							? sending
								? "Creating"
								: "Create item"
							: sending
								? "Sending"
								: "Send request"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
