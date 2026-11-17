"use client";

import { useRef, useState } from "react";
import Link from "../components/AppLink";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import type { WorkConfig } from "../../lib/work/model";
import type { TimelineEntry, WorkSummary } from "../../lib/work/store";
import { describeFetchError } from "../../lib/swr";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { usePageTitle } from "../hooks/usePageTitle";
import { useUser } from "../context/UserContext";
import { RequestForm } from "./RequestForm";
import { useAsk } from "./WorkDialog";
import { BlockedIcon } from "./BlockedIcon";
import { TimelineIcon } from "../components/shared/TimelineIcon";
import timeline from "../components/shared/Timeline.module.css";
import { ReleaseSelect } from "./ReleaseControls";
import {
	columnLabel,
	effortLabel,
	initials,
	labelOf,
	personName,
	postJson,
	when,
} from "./labels";
import styles from "./Work.module.css";

// One request: what is asked, everything about it, and its whole history as one
// timeline of comments and changes, the way an issue reads on a code host.

interface Attachment {
	attachment_id: string;
	hash: string;
	file_name: string;
	content_type: string;
	size: number;
	width: number | null;
	height: number | null;
	uploaded_by: string;
	uploaded_on: string;
}

interface Detail {
	item: WorkSummary & {
		description: string;
		closedReason: string | null;
		duplicateOf: { key: string; title: string } | null;
		approvedBy: string | null;
		approvedOn: string | null;
		securityReviewedBy: string | null;
		securityReviewedOn: string | null;
		origin: Record<string, unknown>;
		release: {
			id: string;
			name: string;
			target: string | null;
			shippedOn: string | null;
		} | null;
		parent: { key: string; title: string } | null;
	};
	requesters: string[];
	watchers: string[];
	watching: boolean;
	meToo: boolean;
	links: {
		link_id: string;
		kind: string;
		target: string;
		detail: string | null;
		label: string | null;
		created_by: string;
	}[];
	criteria: {
		criterion_id: string;
		body: string;
		done_by: string | null;
		done_on: string | null;
	}[];
	attachments: Attachment[];
	children: WorkSummary[];
	dependsOn: WorkSummary[];
	blocks: WorkSummary[];
	timeline: TimelineEntry[];
	may: {
		engineer: boolean;
		devSecOps: boolean;
		editAsked: boolean;
		markSensitive: boolean;
	};
	config: WorkConfig;
}

const fieldWords: Record<string, string> = {
	title: "the title",
	workType: "the work type",
	priority: "the priority",
	effort: "the effort",
	layer: "the layer",
	domain: "the domain",
	target: "the target",
	assignees: "who is assigned",
	reviewer: "the reviewer",
	approver: "the approver",
	tags: "the tags",
	visibility: "who can see it",
	parent: "the parent",
	release: "the release",
};

const reactions: [string, string][] = [
	["+1", "Agree"],
	["-1", "Disagree"],
	["heart", "Thanks"],
	["eyes", "Looking"],
	["tada", "Done"],
	["confused", "Unclear"],
];

// Turns text with images and addresses into elements. An image reference is
// ![name](/api/work/files/<hash>), written when a file is pasted or dropped.
function RichText({
	text,
	attachments,
}: {
	text: string;
	attachments: Attachment[];
}) {
	const parts = text.split(
		/(!\[[^\]]*\]\(\/api\/work\/files\/[0-9a-f]{64}\)|https?:\/\/[^\s)]+)/g,
	);
	return (
		<div className={styles.rich}>
			{parts.map((part, index) => {
				const image =
					/^!\[([^\]]*)\]\(\/api\/work\/files\/([0-9a-f]{64})\)$/.exec(
						part,
					);
				if (image) {
					const file = attachments.find((a) => a.hash === image[2]);
					const src = `/api/work/files/${image[2]}`;
					return file?.content_type.startsWith("image/") ? (
						<a
							key={index}
							href={src}
							target="_blank"
							rel="noreferrer"
						>
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img
								src={src}
								alt={image[1]}
								loading="lazy"
								width={file.width ?? undefined}
								height={file.height ?? undefined}
								className={styles.richImage}
							/>
						</a>
					) : (
						<a
							key={index}
							href={src}
							target="_blank"
							rel="noreferrer"
							className={styles.fileLink}
						>
							{image[1] || "Attached file"}
						</a>
					);
				}
				if (/^https?:\/\//.test(part)) {
					return (
						<a
							key={index}
							href={part}
							target="_blank"
							rel="noreferrer"
						>
							{part}
						</a>
					);
				}
				return <span key={index}>{part}</span>;
			})}
		</div>
	);
}

// A text box that takes pasted or dropped files, uploads each to the request,
// and writes a reference to it where the cursor is.
function Composer({
	itemKey,
	value,
	onChange,
	placeholder,
	rows = 4,
	onUploaded,
}: {
	itemKey: string;
	value: string;
	onChange: (next: string) => void;
	placeholder: string;
	rows?: number;
	onUploaded: () => void;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	const [uploading, setUploading] = useState(0);
	const [failure, setFailure] = useState<string | null>(null);

	const upload = async (file: File) => {
		setUploading((n) => n + 1);
		setFailure(null);
		try {
			// The size in pixels, read from the file without changing it, so the
			// page can keep room for the image while it loads.
			let width: number | null = null;
			let height: number | null = null;
			if (file.type.startsWith("image/")) {
				const bitmap = await createImageBitmap(file).catch(() => null);
				width = bitmap?.width ?? null;
				height = bitmap?.height ?? null;
				bitmap?.close();
			}
			const response = await fetch(`/api/work/${itemKey}/attachments`, {
				method: "POST",
				headers: {
					"Content-Type": file.type || "application/octet-stream",
					"X-File-Name": encodeURIComponent(file.name || "pasted"),
					...(width ? { "X-Width": String(width) } : {}),
					...(height ? { "X-Height": String(height) } : {}),
				},
				body: file,
			});
			const answer = (await response.json().catch(() => ({}))) as {
				attachment?: { hash: string; fileName: string };
				error?: string;
			};
			if (!response.ok || !answer.attachment)
				throw new Error(answer.error ?? "It could not be attached.");
			const reference = `![${answer.attachment.fileName}](/api/work/files/${answer.attachment.hash})`;
			const at = area.current?.selectionStart ?? value.length;
			onChange(`${value.slice(0, at)}${reference}${value.slice(at)}`);
			onUploaded();
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "It could not be attached.",
			);
		} finally {
			setUploading((n) => n - 1);
		}
	};

	return (
		<div className={styles.composer}>
			<textarea
				ref={area}
				className={styles.input}
				rows={rows}
				value={value}
				placeholder={placeholder}
				onChange={(e) => onChange(e.target.value)}
				onPaste={(e) => {
					const files = [...e.clipboardData.files];
					if (files.length === 0) return;
					e.preventDefault();
					for (const file of files) void upload(file);
				}}
				onDrop={(e) => {
					const files = [...e.dataTransfer.files];
					if (files.length === 0) return;
					e.preventDefault();
					for (const file of files) void upload(file);
				}}
			/>
			<span className={styles.hint}>
				{uploading > 0
					? "Attaching"
					: "Paste or drop a screenshot or file to attach it. Mention somebody with @ and their email."}
			</span>
			{failure && <span className={styles.failure}>{failure}</span>}
		</div>
	);
}

function eventText(entry: TimelineEntry, config: WorkConfig): string {
	const data = entry.data ?? {};
	const show = (field: string, value: unknown): string => {
		if (value === null || value === undefined || value === "")
			return "nothing";
		if (Array.isArray(value))
			return value.length
				? value
						.map((v) =>
							field === "assignees"
								? personName(String(v))
								: String(v),
						)
						.join(", ")
				: "nobody";
		const text = String(value);
		if (field === "workType") return labelOf(config.workTypes, text);
		if (field === "priority") return labelOf(config.priorities, text);
		if (field === "effort") return effortLabel(config, text);
		if (field === "domain") return labelOf(config.domains, text);
		if (field === "layer") return labelOf(config.layers, text);
		if (field === "reviewer" || field === "approver")
			return personName(text);
		if (field === "visibility")
			return text === "restricted" ? "sensitive" : "normal";
		return text;
	};
	switch (entry.kind) {
		case "created":
			return `asked for this${(data.origin as { kind?: string })?.kind && (data.origin as { kind: string }).kind !== "form" ? ` from ${(data.origin as { kind: string }).kind}` : ""}`;
		case "moved":
			return `moved this from ${columnLabel(config, String(data.from))} to ${columnLabel(config, String(data.to))}${data.why ? `. ${data.why}` : ""}`;
		case "changed":
			return `changed ${fieldWords[String(data.field)] ?? data.field} from ${show(String(data.field), data.from)} to ${show(String(data.field), data.to)}${data.why ? `, as ${data.why}` : ""}`;
		case "described":
			return "edited the description";
		case "closed":
			return data.as === "duplicate"
				? `closed this as a duplicate of ${data.duplicateOf}`
				: `declined this${data.reason ? `. ${data.reason}` : ""}`;
		case "merged":
			return `closed ${data.from} as a duplicate of this, bringing ${(data.people as string[] | undefined)?.length ?? 0} people over`;
		case "reopened":
			return "reopened this";
		case "blocked":
			return `marked this blocked${data.by ? ` by ${data.by}` : ""}. ${data.reason ?? ""}`;
		case "unblocked":
			return "unblocked this";
		case "approved":
			return "approved this";
		case "securityReviewed":
			return "signed off the security review";
		case "linked":
			return data.kind === "update"
				? `linked the update "${data.label}"${data.detail === "resolves" ? ", which resolves this" : ""}`
				: data.kind === "dependsOn"
					? `marked this as depending on "${data.label}"`
					: `linked ${data.kind} ${data.label ?? data.target}`;
		case "unlinked":
			return `removed the link to ${data.label ?? data.target}`;
		case "criterionAdded":
			return `added the criterion "${data.body}"`;
		case "criterionDone":
			return `ticked "${data.body}"`;
		case "criterionUndone":
			return `unticked "${data.body}"`;
		case "criterionRemoved":
			return `removed the criterion "${data.body}"`;
		case "meToo":
			return "asked for this too";
		case "meTooRemoved":
			return "no longer asks for this";
		case "attached":
			return `attached ${data.fileName}`;
		case "detached":
			return `removed the attachment ${data.fileName}`;
		case "commentEdited":
			return "edited a comment";
		case "commentRemoved":
			return "removed a comment";
		case "reminded":
			return `reminded the people on this, after ${data.days} days in ${columnLabel(config, String(data.status))}`;
		default:
			return entry.kind ?? "";
	}
}

export default function WorkItemView({ itemKey }: { itemKey: string }) {
	const router = useRouter();
	const key = `/api/work/${encodeURIComponent(itemKey)}`;
	const { data, error, mutate } = useSWR<Detail>(key, {
		refreshInterval: 15_000,
	});
	usePageTitle(data ? `${itemKey} ${data.item.title}` : itemKey);
	const [failure, setFailure] = useState<string | null>(null);
	const [comment, setComment] = useState("");
	const [replyTo, setReplyTo] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	const [describing, setDescribing] = useState(false);
	const [description, setDescription] = useState("");
	const [comparing, setComparing] = useState<string | null>(null);
	const [show, setShow] = useState<"all" | "comments" | "changes">("all");
	const [addingChild, setAddingChild] = useState(false);
	const { ask, confirm, dialog } = useAsk();

	if (error)
		return (
			<div className={styles.page}>
				<p className={styles.empty}>
					{describeFetchError(error, "request")}
				</p>
			</div>
		);
	if (!data) return <div className={styles.page} />;
	const { item, config, may } = data;

	const act = async (body: Record<string, unknown>) => {
		setFailure(null);
		try {
			await postJson(key, body);
			await mutate();
			return true;
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
			return false;
		}
	};
	const update = (patch: Record<string, unknown>) =>
		act({ action: "update", ...patch });

	const comments = data.timeline.filter((entry) => entry.type === "comment");
	const shown = data.timeline.filter((entry) =>
		show === "all"
			? true
			: show === "comments"
				? entry.type === "comment"
				: entry.type === "event",
	);
	const choice = (list: { id: string; label: string }[], none = "None") => [
		{ value: "", label: none },
		...list.map((c) => ({ value: c.id, label: c.label })),
	];
	const updates = data.links.filter((l) => l.kind === "update");
	const related = data.links.filter((l) => l.kind !== "update");

	return (
		<div className={styles.page}>
			<div className={styles.crumbs}>
				<Link href="/work">Requests</Link>
				{item.parent && (
					<>
						<span aria-hidden="true">/</span>
						<Link href={`/work/${item.parent.key}`}>
							{item.parent.key} {item.parent.title}
						</Link>
					</>
				)}
			</div>
			<header className={styles.itemHeader}>
				<div className={styles.itemTitleRow}>
					<span className={styles.keyLarge}>{item.key}</span>
					<h1 className={styles.itemTitle}>{item.title}</h1>
				</div>
				<div className={styles.itemBadges}>
					<span className={styles.statusBadge}>
						{item.closedAs
							? item.closedAs === "duplicate"
								? "Duplicate"
								: "Declined"
							: columnLabel(config, item.status)}
					</span>
					{item.blocked && (
						<span className={styles.blocked}>
							<BlockedIcon />
							Blocked: {item.blockedReason}
						</span>
					)}
					{item.visibility === "restricted" && (
						<span className={styles.badge}>Sensitive</span>
					)}
					<span className={styles.meta}>
						Asked by {data.requesters.map(personName).join(", ")}{" "}
						{when(item.createdOn)}
					</span>
				</div>
				<div className={styles.itemActions}>
					<button
						type="button"
						className={styles.secondary}
						onClick={() =>
							void act({ action: "meToo", on: !data.meToo })
						}
					>
						{data.meToo ? "You asked for this" : "Me too"}
					</button>
					<button
						type="button"
						className={styles.secondary}
						aria-pressed={data.watching}
						onClick={() =>
							void act({ action: "watch", on: !data.watching })
						}
					>
						{data.watching ? "Watching" : "Watch"}
					</button>
					{may.engineer && !item.closedAs && (
						<>
							{item.blocked ? (
								<button
									type="button"
									className={styles.secondary}
									onClick={() =>
										void act({ action: "unblock" })
									}
								>
									Unblock
								</button>
							) : (
								<button
									type="button"
									className={styles.secondary}
									onClick={async () => {
										const answer = await ask({
											title: "Mark blocked",
											fields: [
												{
													name: "reason",
													label: "What is it waiting on?",
													kind: "textarea",
												},
												{
													name: "by",
													label: "The request it waits for",
													kind: "request",
													optional: true,
													exclude: [item.key],
												},
											],
											submit: "Mark blocked",
										});
										if (answer)
											void act({
												action: "block",
												...answer,
											});
									}}
								>
									Mark blocked
								</button>
							)}
							<button
								type="button"
								className={styles.secondary}
								onClick={async () => {
									const answer = await ask({
										title: "Close as a duplicate",
										fields: [
											{
												name: "duplicateOf",
												label: "The request it duplicates",
												kind: "request",
												exclude: [item.key],
											},
										],
										submit: "Close as duplicate",
									});
									if (answer)
										void act({
											action: "close",
											as: "duplicate",
											duplicateOf: answer.duplicateOf,
											reason: "",
										});
								}}
							>
								Close as duplicate
							</button>
							<button
								type="button"
								className={styles.danger}
								onClick={async () => {
									const answer = await ask({
										title: "Decline this request",
										fields: [
											{
												name: "reason",
												label: "Why it is declined",
												kind: "textarea",
												placeholder:
													"The people who asked are told this",
											},
										],
										submit: "Decline",
										danger: true,
									});
									if (answer)
										void act({
											action: "close",
											as: "declined",
											reason: answer.reason,
										});
								}}
							>
								Decline
							</button>
						</>
					)}
					{may.engineer &&
						(item.closedAs || item.status === "done") && (
							<button
								type="button"
								className={styles.secondary}
								onClick={() => void act({ action: "reopen" })}
							>
								Reopen
							</button>
						)}
				</div>
				{item.closedAs && (
					<p className={styles.closedNote}>
						{item.closedAs === "duplicate" && item.duplicateOf ? (
							<>
								Closed as a duplicate of{" "}
								<Link href={`/work/${item.duplicateOf.key}`}>
									{item.duplicateOf.key}{" "}
									{item.duplicateOf.title}
								</Link>
								.
							</>
						) : (
							<>Declined. {item.closedReason}</>
						)}
					</p>
				)}
			</header>

			{failure && <p className={styles.failure}>{failure}</p>}

			<div className={styles.itemLayout}>
				<main className={styles.itemMain}>
					<section className={styles.panel}>
						<div className={styles.panelHead}>
							<h2>Description</h2>
							{(may.editAsked || may.engineer) && !describing && (
								<button
									type="button"
									className={styles.link}
									onClick={() => {
										setDescription(item.description);
										setDescribing(true);
									}}
								>
									Edit
								</button>
							)}
						</div>
						{describing ? (
							<>
								<Composer
									itemKey={itemKey}
									value={description}
									onChange={setDescription}
									placeholder="What is needed, and why"
									rows={8}
									onUploaded={() => void mutate()}
								/>
								<div className={styles.formActions}>
									<button
										type="button"
										className={styles.secondary}
										onClick={() => setDescribing(false)}
									>
										Cancel
									</button>
									<button
										type="button"
										className={styles.primary}
										onClick={async () => {
											if (await update({ description }))
												setDescribing(false);
										}}
									>
										Save
									</button>
								</div>
							</>
						) : item.description ? (
							<RichText
								text={item.description}
								attachments={data.attachments}
							/>
						) : (
							<p className={styles.empty}>No description yet.</p>
						)}
					</section>

					<section className={styles.panel}>
						<div className={styles.panelHead}>
							<h2>Acceptance criteria</h2>
							{(may.engineer || may.editAsked) && (
								<button
									type="button"
									className={styles.link}
									onClick={async () => {
										const answer = await ask({
											title: "Add a criterion",
											fields: [
												{
													name: "text",
													label: "What the work must meet",
													kind: "text",
													placeholder:
														"Such as: totals match the finance figure for March",
												},
											],
											submit: "Add",
										});
										if (answer)
											void act({
												action: "criteria",
												add: answer.text,
											});
									}}
								>
									Add
								</button>
							)}
						</div>
						{data.criteria.length === 0 ? (
							<p className={styles.empty}>
								None yet. These are ticked while the work is
								validated.
							</p>
						) : (
							<ul className={styles.criteria}>
								{data.criteria.map((c) => (
									<li key={c.criterion_id}>
										<label className={styles.check}>
											<input
												type="checkbox"
												checked={Boolean(c.done_on)}
												onChange={(e) =>
													void act({
														action: "criteria",
														criterionId:
															c.criterion_id,
														done: e.target.checked,
													})
												}
											/>
											<span>{c.body}</span>
										</label>
										{c.done_by && (
											<span className={styles.meta}>
												{personName(c.done_by)},{" "}
												{when(c.done_on)}
											</span>
										)}
										{may.engineer && (
											<button
												type="button"
												className={styles.link}
												onClick={() =>
													void act({
														action: "criteria",
														criterionId:
															c.criterion_id,
														remove: true,
													})
												}
											>
												Remove
											</button>
										)}
									</li>
								))}
							</ul>
						)}
					</section>

					<section className={styles.panel}>
						<div className={styles.panelHead}>
							<h2>Sub-tasks</h2>
							{may.engineer && (
								<button
									type="button"
									className={styles.link}
									onClick={() => setAddingChild(true)}
								>
									Add a sub-task
								</button>
							)}
						</div>
						{data.children.length === 0 ? (
							<p className={styles.empty}>
								None. Larger work splits into sub-tasks, each
								tracked on its own.
							</p>
						) : (
							<ul className={styles.relatedList}>
								{data.children.map((child) => (
									<li key={child.id}>
										<Link href={`/work/${child.key}`}>
											{child.key} {child.title}
										</Link>
										<span className={styles.meta}>
											{child.closedAs
												? "Closed"
												: columnLabel(
														config,
														child.status,
													)}
											{child.effort
												? `, ${effortLabel(config, child.effort)}`
												: ""}
										</span>
									</li>
								))}
							</ul>
						)}
						{(data.dependsOn.length > 0 ||
							data.blocks.length > 0) && (
							<div className={styles.dependencies}>
								{data.dependsOn.length > 0 && (
									<div>
										<span className={styles.meta}>
											Depends on
										</span>
										{data.dependsOn.map((d) => (
											<Link
												key={d.id}
												href={`/work/${d.key}`}
											>
												{d.key} {d.title}
											</Link>
										))}
									</div>
								)}
								{data.blocks.length > 0 && (
									<div>
										<span className={styles.meta}>
											Blocks
										</span>
										{data.blocks.map((d) => (
											<Link
												key={d.id}
												href={`/work/${d.key}`}
											>
												{d.key} {d.title}
											</Link>
										))}
									</div>
								)}
							</div>
						)}
					</section>

					<section className={styles.panel}>
						<div className={styles.panelHead}>
							<h2>Activity</h2>
							<Select
								value={show}
								ariaLabel="Show"
								onChange={(v) => setShow(v as typeof show)}
								options={[
									{ value: "all", label: "Everything" },
									{
										value: "comments",
										label: "Comments only",
									},
									{ value: "changes", label: "Changes only" },
								]}
							/>
						</div>
						<ol className={timeline.list}>
							{shown.map((entry) =>
								entry.type === "event" ? (
									<li
										key={entry.id}
										className={`${timeline.event} ${styles.event}`}
									>
										<TimelineIcon kind={entry.kind ?? ""} />
										<span>
											<strong>
												{personName(entry.actor)}
											</strong>{" "}
											{eventText(entry, config)}{" "}
											<span className={styles.meta}>
												{when(entry.at)}
											</span>
											{entry.kind === "described" && (
												<button
													type="button"
													className={styles.link}
													onClick={() =>
														setComparing(
															comparing ===
																entry.id
																? null
																: entry.id,
														)
													}
												>
													{comparing === entry.id
														? "Hide changes"
														: "See changes"}
												</button>
											)}
										</span>
										{comparing === entry.id && (
											<div className={styles.compare}>
												<div>
													<span
														className={styles.meta}
													>
														Before
													</span>
													<RichText
														text={String(
															entry.data
																?.before ?? "",
														)}
														attachments={
															data.attachments
														}
													/>
												</div>
												<div>
													<span
														className={styles.meta}
													>
														After
													</span>
													<RichText
														text={String(
															entry.data?.after ??
																"",
														)}
														attachments={
															data.attachments
														}
													/>
												</div>
											</div>
										)}
									</li>
								) : (
									<li
										key={entry.id}
										className={`${timeline.comment} ${entry.replyTo ? timeline.reply : ""}`}
									>
										<span
											className={timeline.avatar}
											aria-hidden="true"
										>
											{initials(entry.actor)}
										</span>
										<div className={timeline.card}>
											<div className={timeline.cardHead}>
												<strong>
													{personName(entry.actor)}
												</strong>
												<span className={styles.meta}>
													{when(entry.at)}
													{entry.editedOn
														? ", edited"
														: ""}
												</span>
												{entry.replyTo && (
													<span
														className={styles.meta}
													>
														replying to{" "}
														{personName(
															comments.find(
																(c) =>
																	c.id ===
																	entry.replyTo,
															)?.actor ?? "",
														)}
													</span>
												)}
											</div>
											{entry.removed ? (
												<p className={styles.empty}>
													This comment was removed.
												</p>
											) : editing === entry.id ? (
												<>
													<Composer
														itemKey={itemKey}
														value={editText}
														onChange={setEditText}
														placeholder="Comment"
														onUploaded={() =>
															void mutate()
														}
													/>
													<div
														className={
															styles.formActions
														}
													>
														<button
															type="button"
															className={
																styles.secondary
															}
															onClick={() =>
																setEditing(null)
															}
														>
															Cancel
														</button>
														<button
															type="button"
															className={
																styles.primary
															}
															onClick={async () => {
																if (
																	await act({
																		action: "editComment",
																		commentId:
																			entry.id,
																		body: editText,
																	})
																)
																	setEditing(
																		null,
																	);
															}}
														>
															Save
														</button>
													</div>
												</>
											) : (
												<RichText
													text={entry.body ?? ""}
													attachments={
														data.attachments
													}
												/>
											)}
											{!entry.removed && (
												<div
													className={
														styles.commentActions
													}
												>
													{reactions.map(
														([id, label]) => {
															const people =
																entry
																	.reactions?.[
																	id
																] ?? [];
															return (
																<button
																	key={id}
																	type="button"
																	className={`${styles.reaction} ${people.length ? styles.reactionOn : ""}`}
																	title={
																		people
																			.map(
																				personName,
																			)
																			.join(
																				", ",
																			) ||
																		label
																	}
																	onClick={() =>
																		void act(
																			{
																				action: "react",
																				commentId:
																					entry.id,
																				reaction:
																					id,
																			},
																		)
																	}
																>
																	{label}
																	{people.length
																		? ` ${people.length}`
																		: ""}
																</button>
															);
														},
													)}
													<button
														type="button"
														className={styles.link}
														onClick={() =>
															setReplyTo(entry.id)
														}
													>
														Reply
													</button>
													<button
														type="button"
														className={styles.link}
														onClick={() => {
															setEditing(
																entry.id,
															);
															setEditText(
																entry.body ??
																	"",
															);
														}}
													>
														Edit
													</button>
													<button
														type="button"
														className={styles.link}
														onClick={async () => {
															if (
																await confirm({
																	title: "Remove this comment?",
																	body: "The comment is replaced with a note that it was removed.",
																	confirm:
																		"Remove",
																})
															)
																void act({
																	action: "removeComment",
																	commentId:
																		entry.id,
																});
														}}
													>
														Remove
													</button>
												</div>
											)}
										</div>
									</li>
								),
							)}
						</ol>
						<div className={styles.newComment}>
							{replyTo && (
								<span className={styles.meta}>
									Replying to{" "}
									{personName(
										comments.find((c) => c.id === replyTo)
											?.actor ?? "",
									)}{" "}
									<button
										type="button"
										className={styles.link}
										onClick={() => setReplyTo(null)}
									>
										Cancel
									</button>
								</span>
							)}
							<Composer
								itemKey={itemKey}
								value={comment}
								onChange={setComment}
								placeholder="Add to the discussion"
								onUploaded={() => void mutate()}
							/>
							<div className={styles.formActions}>
								<button
									type="button"
									className={styles.primary}
									disabled={!comment.trim()}
									onClick={async () => {
										if (
											await act({
												action: "comment",
												body: comment,
												replyTo,
											})
										) {
											setComment("");
											setReplyTo(null);
										}
									}}
								>
									Comment
								</button>
							</div>
						</div>
					</section>
				</main>

				<aside className={styles.itemSide}>
					<SideField label="Status">
						{may.engineer && !item.closedAs ? (
							<Select
								value={item.status}
								ariaLabel="Status"
								onChange={(to) =>
									void act({ action: "move", to })
								}
								options={config.columns.map((c) => ({
									value: c.id,
									label: c.label,
								}))}
							/>
						) : (
							<span>
								{item.closedAs
									? "Closed"
									: columnLabel(config, item.status)}
							</span>
						)}
					</SideField>
					<SideField label="Work type">
						<Select
							value={item.workType ?? ""}
							disabled={!(may.engineer || may.editAsked)}
							ariaLabel="Work type"
							onChange={(v) =>
								void update({ workType: v || null })
							}
							options={choice(config.workTypes)}
						/>
					</SideField>
					<SideField label="Priority">
						<Select
							value={item.priority ?? ""}
							disabled={!(may.engineer || may.editAsked)}
							ariaLabel="Priority"
							onChange={(v) =>
								void update({ priority: v || null })
							}
							options={choice(config.priorities)}
						/>
					</SideField>
					<SideField label="Effort">
						<Select
							value={item.effort ?? ""}
							disabled={!may.engineer}
							ariaLabel="Effort"
							onChange={(v) => void update({ effort: v || null })}
							options={[
								{ value: "", label: "Not sized" },
								...config.efforts.map((e) => ({
									value: e.id,
									label: effortLabel(config, e.id),
								})),
							]}
						/>
					</SideField>
					{config.layers.length > 0 && (
						<SideField label="Layer">
							<Select
								value={item.layer ?? ""}
								disabled={!(may.engineer || may.editAsked)}
								ariaLabel="Layer"
								onChange={(v) =>
									void update({ layer: v || null })
								}
								options={choice(config.layers)}
							/>
						</SideField>
					)}
					{config.domains.length > 0 && (
						<SideField label="Domain">
							<Select
								value={item.domain ?? ""}
								disabled={!(may.engineer || may.editAsked)}
								ariaLabel="Domain"
								onChange={(v) =>
									void update({ domain: v || null })
								}
								options={choice(config.domains)}
							/>
						</SideField>
					)}
					{(may.engineer || item.release) && (
						<SideField label="Release">
							{may.engineer ? (
								<ReleaseSelect
									value={item.release?.id ?? ""}
									disabled={Boolean(item.release?.shippedOn)}
									onChange={(releaseId) =>
										void update({
											releaseId: releaseId || null,
										})
									}
								/>
							) : (
								<span>{item.release?.name}</span>
							)}
						</SideField>
					)}
					<SideField label="Target">
						{may.engineer ? (
							<input
								type="date"
								className={styles.input}
								value={item.target ?? ""}
								disabled={Boolean(item.release)}
								onChange={(e) =>
									void update({
										target: e.target.value || null,
									})
								}
							/>
						) : (
							<span>{item.target ?? "Not set"}</span>
						)}
						{item.release && (
							<span className={styles.meta}>
								Set by its release
							</span>
						)}
					</SideField>
					<PeopleField
						label="Assigned"
						people={item.assignees}
						editable={may.engineer}
						onChange={(next) => void update({ assignees: next })}
					/>
					<PersonField
						label="Reviewer"
						person={item.reviewer}
						editable={may.engineer}
						onChange={(next) => void update({ reviewer: next })}
					/>
					<PersonField
						label="Approver"
						person={item.approver}
						editable={may.engineer}
						onChange={(next) => void update({ approver: next })}
					/>
					{item.approver && (
						<SideField label="Approval">
							{item.approvedOn ? (
								<span>
									Approved by{" "}
									{personName(item.approvedBy ?? "")}{" "}
									{when(item.approvedOn)}
								</span>
							) : (
								<button
									type="button"
									className={styles.secondary}
									onClick={() =>
										void act({ action: "approve" })
									}
								>
									Approve
								</button>
							)}
						</SideField>
					)}
					{(may.devSecOps || item.securityReviewedOn) && (
						<SideField label="Security review">
							{item.securityReviewedOn ? (
								<span>
									Signed off by{" "}
									{personName(item.securityReviewedBy ?? "")}{" "}
									{when(item.securityReviewedOn)}
								</span>
							) : (
								<button
									type="button"
									className={styles.secondary}
									onClick={() =>
										void act({ action: "securityReview" })
									}
								>
									Sign off
								</button>
							)}
						</SideField>
					)}
					<SideField label="Tags">
						<input
							className={styles.input}
							defaultValue={item.tags.join(", ")}
							disabled={!(may.engineer || may.editAsked)}
							placeholder="Comma separated"
							onBlur={(e) => {
								const next = e.target.value
									.split(",")
									.map((t) => t.trim())
									.filter(Boolean);
								if (next.join(",") !== item.tags.join(","))
									void update({ tags: next });
							}}
						/>
					</SideField>
					<SideField label="Visibility">
						<Toggle
							checked={item.visibility === "restricted"}
							disabled={!may.markSensitive}
							onChange={(on) =>
								void update({
									visibility: on ? "restricted" : "normal",
								})
							}
							label="Sensitive, kept to the people who asked and the engineers"
						/>
					</SideField>
					<SideField label="Parent">
						{may.engineer ? (
							<input
								className={styles.input}
								defaultValue={item.parent?.key ?? ""}
								placeholder="Key of a larger request"
								onBlur={(e) => {
									if (
										e.target.value !==
										(item.parent?.key ?? "")
									)
										void update({
											parentKey: e.target.value || null,
										});
								}}
							/>
						) : (
							<span>
								{item.parent
									? `${item.parent.key} ${item.parent.title}`
									: "None"}
							</span>
						)}
					</SideField>

					<SideField label="Related">
						<ul className={styles.relatedList}>
							{related.map((link) => (
								<li key={link.link_id}>
									<RelatedLink link={link} />
									{may.engineer && (
										<button
											type="button"
											className={styles.link}
											onClick={() =>
												void act({
													action: "unlink",
													linkId: link.link_id,
												})
											}
										>
											Remove
										</button>
									)}
								</li>
							))}
						</ul>
						{(may.engineer || may.editAsked) && (
							<div className={styles.inlineActions}>
								<button
									type="button"
									className={styles.link}
									onClick={async () => {
										const answer = await ask({
											title: "Add an address",
											fields: [
												{
													name: "target",
													label: "Address",
													kind: "text",
													placeholder: "https://",
												},
												{
													name: "label",
													label: "Label",
													kind: "text",
													optional: true,
													placeholder:
														"Such as: the pull request",
												},
											],
											submit: "Add",
										});
										if (answer)
											void act({
												action: "link",
												kind: "url",
												target: answer.target,
												label: answer.label,
											});
									}}
								>
									Add an address
								</button>
								<button
									type="button"
									className={styles.link}
									onClick={async () => {
										const answer = await ask({
											title: "Add a dependency",
											fields: [
												{
													name: "target",
													label: "The request this depends on",
													kind: "request",
													exclude: [item.key],
												},
											],
											submit: "Add",
										});
										if (answer)
											void act({
												action: "link",
												kind: "dependsOn",
												target: answer.target,
											});
									}}
								>
									Add a dependency
								</button>
								<button
									type="button"
									className={styles.link}
									onClick={async () => {
										const answer = await ask({
											title: "Add a dataset",
											fields: [
												{
													name: "target",
													label: "Dataset",
													kind: "dataset",
												},
											],
											submit: "Add",
										});
										if (answer)
											void act({
												action: "link",
												kind: "source",
												target: answer.target,
											});
									}}
								>
									Add a dataset
								</button>
							</div>
						)}
					</SideField>

					<SideField label="Updates">
						{updates.length === 0 ? (
							<span className={styles.meta}>
								Not linked to an update yet. Linking one that
								resolves this moves it to Done once it is out.
							</span>
						) : (
							<ul className={styles.relatedList}>
								{updates.map((link) => (
									<li key={link.link_id}>
										<a
											href={`/status?tab=updates&open=${link.target}`}
										>
											{link.label ?? "An update"}
										</a>
										<span className={styles.meta}>
											{link.detail === "resolves"
												? "Resolves this"
												: "Related"}
										</span>
									</li>
								))}
							</ul>
						)}
						{may.engineer && (
							<UpdatePicker
								onPick={(updateId, resolves) =>
									void act({
										action: "link",
										kind: "update",
										target: updateId,
										detail: resolves
											? "resolves"
											: "relates",
									})
								}
							/>
						)}
					</SideField>

					<SideField label="Attachments">
						{data.attachments.length === 0 ? (
							<span className={styles.meta}>
								Paste or drop files into the description or a
								comment.
							</span>
						) : (
							<ul className={styles.relatedList}>
								{data.attachments.map((a) => (
									<li key={a.attachment_id}>
										<a
											href={`/api/work/files/${a.hash}`}
											target="_blank"
											rel="noreferrer"
										>
											{a.file_name}
										</a>
										<span className={styles.meta}>
											{Math.max(
												1,
												Math.round(a.size / 1024),
											)}{" "}
											KB
										</span>
										<button
											type="button"
											className={styles.link}
											onClick={() =>
												void act({
													action: "detach",
													attachmentId:
														a.attachment_id,
												})
											}
										>
											Remove
										</button>
									</li>
								))}
							</ul>
						)}
					</SideField>

					<SideField label="People">
						<span className={styles.meta}>
							Asking: {data.requesters.map(personName).join(", ")}
						</span>
						<span className={styles.meta}>
							Watching:{" "}
							{data.watchers.map(personName).join(", ") ||
								"nobody"}
						</span>
					</SideField>
				</aside>
			</div>

			{dialog}
			{addingChild && (
				<ChildForm
					config={config}
					parentKey={item.key}
					engineer={may.engineer}
					onClose={() => setAddingChild(false)}
					onCreated={(created) => {
						setAddingChild(false);
						router.push(`/work/${created}`);
					}}
				/>
			)}
		</div>
	);
}

function ChildForm({
	config,
	parentKey,
	engineer,
	onClose,
	onCreated,
}: {
	config: WorkConfig;
	parentKey: string;
	engineer: boolean;
	onClose: () => void;
	onCreated: (key: string) => void;
}) {
	const { user } = useUser();
	return (
		<RequestForm
			config={config}
			engineer={engineer}
			me={user?.email ?? ""}
			draft={{
				origin: { kind: "subTask", parent: parentKey },
				parentKey,
			}}
			onClose={onClose}
			onCreated={onCreated}
		/>
	);
}

function SideField({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className={styles.sideField}>
			<span className={styles.sideLabel}>{label}</span>
			{children}
		</div>
	);
}

function PeopleField({
	label,
	people,
	editable,
	onChange,
}: {
	label: string;
	people: string[];
	editable: boolean;
	onChange: (next: string[]) => void;
}) {
	return (
		<SideField label={label}>
			{people.length === 0 ? (
				<span className={styles.meta}>Nobody</span>
			) : (
				<span className={styles.peopleList}>
					{people.map((person) => (
						<span key={person} className={styles.person}>
							<span className={styles.avatar}>
								{initials(person)}
							</span>
							{personName(person)}
							{editable && (
								<button
									type="button"
									className={styles.link}
									aria-label={`Remove ${personName(person)}`}
									onClick={() =>
										onChange(
											people.filter((p) => p !== person),
										)
									}
								>
									Remove
								</button>
							)}
						</span>
					))}
				</span>
			)}
			{editable && (
				<PersonSelect
					value=""
					placeholder="Add somebody"
					exclude={people}
					onChange={(person) =>
						person && onChange([...people, person])
					}
				/>
			)}
		</SideField>
	);
}

function PersonField({
	label,
	person,
	editable,
	onChange,
}: {
	label: string;
	person: string | null;
	editable: boolean;
	onChange: (next: string | null) => void;
}) {
	return (
		<SideField label={label}>
			<span>
				{person ? (
					personName(person)
				) : (
					<span className={styles.meta}>Nobody</span>
				)}
			</span>
			{editable && (
				<PersonSelect
					value={person ?? ""}
					placeholder="Nobody"
					allowNone
					onChange={(next) => onChange(next || null)}
				/>
			)}
		</SideField>
	);
}

function RelatedLink({ link }: { link: Detail["links"][number] }) {
	if (link.kind === "url")
		return (
			<a href={link.target} target="_blank" rel="noreferrer">
				{link.label || link.target}
			</a>
		);
	if (link.kind === "report")
		return (
			<Link href={`/r/${link.target}`}>{link.label ?? link.target}</Link>
		);
	const kind =
		{ source: "Dataset", field: "Field", page: "Page", visual: "Visual" }[
			link.kind
		] ?? link.kind;
	return (
		<span>
			{kind}: {link.label ?? link.target}
			{link.detail ? ` on ${link.detail}` : ""}
		</span>
	);
}

// Choosing an update to link, from the ones this person can see.
function UpdatePicker({
	onPick,
}: {
	onPick: (updateId: string, resolves: boolean) => void;
}) {
	const [open, setOpen] = useState(false);
	const [resolves, setResolves] = useState(true);
	const { data } = useSWR<{ updates: { updateId: string; title: string }[] }>(
		open ? "/api/changes?list=1&limit=50" : null,
	);
	if (!open) {
		return (
			<button
				type="button"
				className={styles.link}
				onClick={() => setOpen(true)}
			>
				Link an update
			</button>
		);
	}
	return (
		<div className={styles.picker}>
			<Select
				value=""
				ariaLabel="Update"
				placeholder="Choose an update"
				searchable
				onChange={(updateId) => {
					onPick(updateId, resolves);
					setOpen(false);
				}}
				options={(data?.updates ?? []).map((u) => ({
					value: u.updateId,
					label: u.title,
				}))}
			/>
			<Toggle
				checked={resolves}
				onChange={setResolves}
				label="It resolves this"
			/>
		</div>
	);
}

// Chooses somebody from the people who have signed in.
function PersonSelect({
	value,
	placeholder,
	exclude = [],
	allowNone = false,
	onChange,
}: {
	value: string;
	placeholder: string;
	exclude?: string[];
	allowNone?: boolean;
	onChange: (email: string) => void;
}) {
	const { data } = useSWR<{ people: { email: string; name: string }[] }>(
		"/api/changes?people=1",
	);
	const left = new Set(exclude.map((e) => e.toLowerCase()));
	return (
		<Select
			value={value}
			searchable
			ariaLabel={placeholder}
			placeholder={placeholder}
			onChange={onChange}
			options={[
				...(allowNone ? [{ value: "", label: "Nobody" }] : []),
				...(data?.people ?? [])
					.filter((p) => !left.has(p.email.toLowerCase()))
					.map((p) => ({
						value: p.email,
						label: p.name,
						note: p.email,
					})),
			]}
		/>
	);
}
