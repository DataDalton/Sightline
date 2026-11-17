"use client";

import { useEffect, useRef, useState } from "react";
import Link from "../components/AppLink";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import type { WorkConfig } from "../../lib/work/model";
import type { TimelineEntry, WorkSummary } from "../../lib/work/store";
import { DatePicker } from "../components/shared/DatePicker";
import { AttachButton, filesFrom, uploadAttachment } from "./Attach";
import { Select } from "../components/shared/Select";
import { TabStrip } from "../components/shared/TabStrip";
import { useTabParam } from "../hooks/useTabParam";
import { LoadError } from "../components/shared/ErrorState";
import { SkeletonText } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { Toggle } from "../components/shared/Toggle";
import { usePageTitle } from "../hooks/usePageTitle";
import { useUser } from "../context/UserContext";
import { RequestForm } from "./RequestForm";
import { useAsk } from "./WorkDialog";
import { BlockedIcon } from "./BlockedIcon";
import { LinkIcon } from "./LinkIcon";
import { SideGroup } from "./SideGroup";
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
	// Attached on purpose, or pasted into the discussion.
	section: "files" | "discussion";
	// Where the discussion shows a pasted file. Null when nothing posted
	// shows it, such as a paste still in an unsent comment.
	foundIn:
		| { kind: "comment"; commentId: string; author: string; at: string }
		| { kind: "description" }
		| null;
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
	dependsOn: (WorkSummary & { linkId: string | null })[];
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
];

// A comment's first line as plain words, for a folded thread. A picture reads
// as its name in brackets.
function excerpt(body: string): string {
	return (
		body
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[$1]")
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

// "Dalton is looking", "Dalton and Casey are looking", "Dalton and 2 others
// are looking".
function lookingText(people: string[]): string {
	const names = people.map(personName);
	if (names.length === 1) return `${names[0]} is looking`;
	if (names.length === 2) return `${names[0]} and ${names[1]} are looking`;
	return `${names[0]} and ${names.length - 1} others are looking`;
}

// Where this browser keeps whether the details are open on a narrow screen.
const detailsOpenKey = "work.detailsOpen";

// How deep replies indent before they line up under the last level.
const maxReplyDepth = 3;

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

// The files a box refers to, drawn under it as small pictures, so a pasted
// screenshot is seen as a screenshot rather than as the reference that stands
// for it. Removing one takes its reference out of the text.
function AttachedPreview({
	text,
	attachments,
	onChange,
}: {
	text: string;
	attachments: Attachment[];
	onChange: (next: string) => void;
}) {
	const references = [
		...text.matchAll(
			/!\[([^\]]*)\]\(\/api\/work\/files\/([0-9a-f]{64})\)/g,
		),
	];
	if (references.length === 0) return null;
	return (
		<ul className={styles.previews} aria-label="Attached">
			{references.map((match, index) => {
				const [whole, name, hash] = match;
				const file = attachments.find((a) => a.hash === hash);
				// Drawn as a picture unless the request says it is not one,
				// since a file just pasted may not be in its list yet.
				const picture = !file || file.content_type.startsWith("image/");
				return (
					<li key={`${hash}-${index}`} className={styles.preview}>
						{picture ? (
							// eslint-disable-next-line @next/next/no-img-element
							<img
								src={`/api/work/files/${hash}`}
								alt={name}
								className={styles.previewImage}
							/>
						) : (
							<span className={styles.previewFile}>
								{name || "Attached file"}
							</span>
						)}
						<button
							type="button"
							className={styles.previewRemove}
							aria-label={`Remove ${name || "the attachment"}`}
							onClick={() =>
								onChange(
									text
										.replace(whole, "")
										.replace(/\n{3,}/g, "\n\n")
										.trim(),
								)
							}
						>
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.5"
								strokeLinecap="round"
								aria-hidden="true"
							>
								<path d="M18 6L6 18M6 6l12 12" />
							</svg>
						</button>
					</li>
				);
			})}
		</ul>
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
	attachments,
	onUploaded,
}: {
	itemKey: string;
	value: string;
	onChange: (next: string) => void;
	placeholder: string;
	rows?: number;
	attachments: Attachment[];
	onUploaded: () => void;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	// The text as it is now, so a reference lands in what the box holds when
	// the upload finishes rather than in what it held when it started.
	const latest = useRef(value);
	latest.current = value;
	const [uploading, setUploading] = useState(0);
	const [failure, setFailure] = useState<string | null>(null);

	const upload = async (file: File) => {
		setUploading((n) => n + 1);
		setFailure(null);
		try {
			const reference = await uploadAttachment(itemKey, file, true);
			const text = latest.current;
			const at = area.current?.selectionStart ?? text.length;
			const next = `${text.slice(0, at)}${reference}${text.slice(at)}`;
			latest.current = next;
			onChange(next);
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

	// One at a time, so each reference goes in after the one before it.
	const uploadAll = async (files: File[]) => {
		for (const file of files) await upload(file);
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
					const files = filesFrom(e.clipboardData);
					if (files.length === 0) return;
					e.preventDefault();
					void uploadAll(files);
				}}
				onDrop={(e) => {
					const files = filesFrom(e.dataTransfer);
					if (files.length === 0) return;
					e.preventDefault();
					void uploadAll(files);
				}}
			/>
			<div className={styles.composerFoot}>
				<AttachButton
					disabled={uploading > 0}
					onFiles={(files) => void uploadAll(files)}
				/>
				<span className={styles.hint}>
					{uploading > 0
						? "Attaching"
						: "Paste or drop a screenshot to attach it. Mention somebody with @ and their email."}
				</span>
			</div>
			<AttachedPreview
				text={value}
				attachments={attachments}
				onChange={onChange}
			/>
			{failure && <span className={styles.failure}>{failure}</span>}
		</div>
	);
}

// How close together two changes have to be to read as one.
const mergeWindowMs = 10 * 60 * 1000;

// One line for a run of changes one person made to one field in a row, such as
// adding and removing assignees while deciding, reading from the first value
// to the last. A run that ends where it started says nothing and is left out.
// Only changes with no reason given are merged, so an explained change keeps
// its own line.
function mergeRuns(entries: TimelineEntry[]): TimelineEntry[] {
	const subject = (entry: TimelineEntry) =>
		entry.type !== "event" || entry.data?.why
			? null
			: entry.kind === "changed"
				? `changed:${String(entry.data?.field)}`
				: entry.kind === "moved"
					? "moved"
					: entry.kind === "threadLooking" ||
						  entry.kind === "threadNotLooking"
						? `looking:${String(entry.data?.commentId)}`
						: null;
	const merged: TimelineEntry[] = [];
	for (const entry of entries) {
		const last = merged[merged.length - 1];
		const key = subject(entry);
		if (
			key &&
			last &&
			subject(last) === key &&
			last.actor === entry.actor &&
			new Date(entry.at).getTime() - new Date(last.at).getTime() <=
				mergeWindowMs
		) {
			merged[merged.length - 1] = {
				...entry,
				data: {
					...entry.data,
					from: last.data?.from,
					firstKind: last.data?.firstKind ?? last.kind,
				},
			};
			continue;
		}
		merged.push(entry);
	}
	return merged.filter((entry) => {
		const key = subject(entry);
		if (!key) return true;
		// Looking toggles carry no values, so a run that ends on the kind it
		// began with is the change, and one that ends on the other undoes it.
		if (key.startsWith("looking:"))
			return (entry.data?.firstKind ?? entry.kind) === entry.kind;
		return (
			JSON.stringify(entry.data?.from ?? null) !==
			JSON.stringify(entry.data?.to ?? null)
		);
	});
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
		case "threadLooking":
			return `is looking at ${personName(String(data.author))}'s comment`;
		case "threadNotLooking":
			return `stopped looking at ${personName(String(data.author))}'s comment`;
		case "threadResolved":
			return `resolved ${personName(String(data.author))}'s comment`;
		case "threadReopened":
			return `reopened ${personName(String(data.author))}'s comment${data.byReply ? " by replying" : ""}`;
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
	const [replyText, setReplyText] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	const [describing, setDescribing] = useState(false);
	const [description, setDescription] = useState("");
	const [comparing, setComparing] = useState<string | null>(null);
	const [show, setShow] = useState<"all" | "comments" | "changes">("all");
	const [addingChild, setAddingChild] = useState(false);
	const { ask, confirm, dialog } = useAsk();
	const [tab, setTab] = useTabParam(
		"tab",
		["discussion", "attachments", "related"] as const,
		"discussion",
	);
	// Files added from the Attachments tab, which belong to the request
	// rather than to any one comment.
	const [attaching, setAttaching] = useState(false);
	const [attachFailure, setAttachFailure] = useState<string | null>(null);
	// Whether the details are open where they fold, on a narrow screen. Read
	// after mount, so the server render and the first client render agree.
	const [detailsOpen, setDetailsOpen] = useState(false);
	useEffect(() => {
		try {
			setDetailsOpen(
				window.localStorage.getItem(detailsOpenKey) === "true",
			);
		} catch {
			// Blocked storage starts folded.
		}
	}, []);
	const toggleDetails = () =>
		setDetailsOpen((open) => {
			try {
				window.localStorage.setItem(detailsOpenKey, String(!open));
			} catch {
				// Without storage the choice lasts until the page is left.
			}
			return !open;
		});
	// Resolved threads the reader has unfolded.
	const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
	// Which part of the Attachments tab shows.
	const [attachmentView, setAttachmentView] = useState<
		"both" | "files" | "discussion"
	>("both");
	// Whether the update picker is open in the Related tab.
	const [linkingUpdate, setLinkingUpdate] = useState(false);
	const { user } = useUser();
	const isMine = (email: string) =>
		Boolean(user?.email) &&
		email.toLowerCase() === user?.email.toLowerCase();
	// Only a wait long enough to notice draws a placeholder.
	const showSkeleton = useDeferredLoading(!data && !error);

	if (error && !data)
		return (
			<div className={styles.page}>
				<LoadError
					error={error}
					subject="request"
					onRetry={() => void mutate()}
				/>
			</div>
		);
	if (!data)
		return (
			<div className={styles.page}>
				{showSkeleton && <SkeletonText lines={8} />}
			</div>
		);
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

	const addAddress = async () => {
		const answer = await ask({
			title: "Add a link",
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
					placeholder: "Such as: the pull request",
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
	};

	const addDependency = async () => {
		const answer = await ask({
			title: "Add a dependency",
			fields: [
				{
					name: "target",
					label: "The request this depends on",
					kind: "request",
					exclude: [itemKey],
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
	};

	const addDataset = async () => {
		const answer = await ask({
			title: "Add a dataset",
			fields: [{ name: "target", label: "Dataset", kind: "dataset" }],
			submit: "Add",
		});
		if (answer)
			void act({ action: "link", kind: "source", target: answer.target });
	};

	const attachFiles = async (files: File[]) => {
		setAttaching(true);
		setAttachFailure(null);
		try {
			for (const file of files)
				await uploadAttachment(itemKey, file, false);
		} catch (error) {
			setAttachFailure(
				error instanceof Error
					? error.message
					: "It could not be attached.",
			);
		} finally {
			setAttaching(false);
			await mutate();
		}
	};

	const react = (entry: TimelineEntry, reaction: string) =>
		act({ action: "react", commentId: entry.id, reaction });
	const unfold = (commentId: string, open: boolean) =>
		setUnfolded((held) => {
			const next = new Set(held);
			if (open) next.add(commentId);
			else next.delete(commentId);
			return next;
		});

	const comments = data.timeline.filter((entry) => entry.type === "comment");
	// Replies by the comment they answer. A reply whose comment is not on
	// the page any more stands on its own rather than disappearing.
	const commentIds = new Set(comments.map((c) => c.id));
	const repliesTo = new Map<string, TimelineEntry[]>();
	for (const c of comments) {
		if (!c.replyTo || !commentIds.has(c.replyTo)) continue;
		repliesTo.set(c.replyTo, [...(repliesTo.get(c.replyTo) ?? []), c]);
	}
	const isNestedReply = (entry: TimelineEntry) =>
		entry.type === "comment" &&
		Boolean(entry.replyTo) &&
		commentIds.has(entry.replyTo ?? "");
	const shown = mergeRuns(data.timeline)
		// An upload is not an event, and a removed comment already says so
		// where it stood, so neither needs a line of its own.
		.filter(
			(entry) =>
				!(
					entry.type === "event" &&
					(entry.kind === "attached" ||
						entry.kind === "commentRemoved")
				),
		)
		.filter((entry) => !isNestedReply(entry))
		.filter((entry) =>
			show === "all"
				? true
				: show === "comments"
					? entry.type === "comment"
					: entry.type === "event",
		);
	// One comment with the replies to it beneath, each reply indented under
	// what it answers. Past a few levels replies stay at the same depth, so a
	// long exchange does not run off the side of the page.
	const renderComment = (
		entry: TimelineEntry,
		depth: number,
	): React.ReactNode => {
		const replies = repliesTo.get(entry.id) ?? [];
		const thread = depth === 0 && !entry.removed;
		const resolved = thread && Boolean(entry.resolvedOn);
		const looking = entry.looking ?? [];
		if (resolved && !unfolded.has(entry.id)) {
			return (
				<li
					key={entry.id}
					id={`comment-${entry.id}`}
					className={timeline.comment}
				>
					<span className={timeline.avatar} aria-hidden="true">
						{initials(entry.actor)}
					</span>
					<div className={styles.resolvedLine}>
						<svg
							className={styles.resolvedMark}
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M20 6L9 17l-5-5" />
						</svg>
						<strong>{personName(entry.actor)}</strong>
						<span className={styles.resolvedExcerpt}>
							{excerpt(entry.body ?? "")}
						</span>
						<span className={styles.meta}>
							Resolved by {personName(entry.resolvedBy ?? "")}{" "}
							{when(entry.resolvedOn ?? "")}
							{replies.length > 0
								? `, ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`
								: ""}
						</span>
						<button
							type="button"
							className={styles.link}
							onClick={() => unfold(entry.id, true)}
						>
							Show
						</button>
					</div>
				</li>
			);
		}
		return (
			<li
				key={entry.id}
				id={`comment-${entry.id}`}
				className={timeline.comment}
			>
				<span className={timeline.avatar} aria-hidden="true">
					{initials(entry.actor)}
				</span>
				<div className={timeline.card}>
					<div className={timeline.cardHead}>
						<strong>{personName(entry.actor)}</strong>
						<span className={styles.meta}>
							{when(entry.at)}
							{entry.editedOn ? ", edited" : ""}
						</span>
						{resolved && (
							<span className={styles.threadFlag}>
								Resolved by {personName(entry.resolvedBy ?? "")}
								<button
									type="button"
									className={styles.link}
									onClick={() => unfold(entry.id, false)}
								>
									Hide
								</button>
							</span>
						)}
						{thread && !resolved && looking.length > 0 && (
							<span
								className={`${styles.threadFlag} ${styles.threadLooking}`}
								title={looking.map(personName).join(", ")}
							>
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
									<circle cx="12" cy="12" r="3" />
								</svg>
								{lookingText(looking)}
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
								attachments={data.attachments}
								onUploaded={() => void mutate()}
							/>
							<div className={styles.formActions}>
								<button
									type="button"
									className={styles.secondary}
									onClick={() => setEditing(null)}
								>
									Cancel
								</button>
								<button
									type="button"
									className={styles.primary}
									onClick={async () => {
										if (
											await act({
												action: "editComment",
												commentId: entry.id,
												body: editText,
											})
										)
											setEditing(null);
									}}
								>
									Save
								</button>
							</div>
						</>
					) : (
						<RichText
							text={entry.body ?? ""}
							attachments={data.attachments}
						/>
					)}
					{!entry.removed && (
						<div className={styles.commentActions}>
							<span className={styles.reactionGroup}>
								{reactions.map(([id, label]) => {
									const people = entry.reactions?.[id] ?? [];
									return (
										<button
											key={id}
											type="button"
											className={`${styles.reaction} ${people.length ? styles.reactionOn : ""}`}
											aria-pressed={people.some(isMine)}
											title={
												people
													.map(personName)
													.join(", ") || label
											}
											onClick={() =>
												void react(entry, id)
											}
										>
											{label}
											{people.length
												? ` ${people.length}`
												: ""}
										</button>
									);
								})}
							</span>
							<span
								className={styles.actionDivider}
								aria-hidden="true"
							/>
							<CommentButton
								icon="reply"
								onClick={() => {
									setReplyTo(entry.id);
									setReplyText("");
								}}
							>
								Reply
							</CommentButton>
							{thread && !resolved && (
								<CommentButton
									icon="eye"
									pressed={looking.some(isMine)}
									onClick={() =>
										void act({
											action: "looking",
											commentId: entry.id,
											on: !looking.some(isMine),
										})
									}
								>
									{looking.some(isMine)
										? "Stop looking"
										: "I'm looking"}
								</CommentButton>
							)}
							{thread &&
								(isMine(entry.actor) || may.engineer) && (
									<CommentButton
										icon={resolved ? "reopen" : "check"}
										onClick={async () => {
											if (
												await act({
													action: "resolve",
													commentId: entry.id,
													on: !resolved,
												})
											)
												unfold(entry.id, false);
										}}
									>
										{resolved ? "Unresolve" : "Resolve"}
									</CommentButton>
								)}
							<span className={styles.ownActions}>
								{isMine(entry.actor) && (
									<CommentButton
										icon="pencil"
										quiet
										onClick={() => {
											setEditing(entry.id);
											setEditText(entry.body ?? "");
										}}
									>
										Edit
									</CommentButton>
								)}
								{(isMine(entry.actor) || may.engineer) && (
									<CommentButton
										icon="trash"
										quiet
										danger
										onClick={async () => {
											if (
												await confirm({
													title: "Remove this comment?",
													body: "The comment is replaced with a note that it was removed.",
													confirm: "Remove",
												})
											)
												void act({
													action: "removeComment",
													commentId: entry.id,
												});
										}}
									>
										Remove
									</CommentButton>
								)}
							</span>
						</div>
					)}
				</div>
				{(replies.length > 0 || replyTo === entry.id) && (
					<ol
						className={
							depth < maxReplyDepth
								? timeline.replies
								: timeline.repliesLevel
						}
					>
						{replyTo === entry.id && (
							<li className={timeline.replyBox}>
								<Composer
									itemKey={itemKey}
									value={replyText}
									onChange={setReplyText}
									placeholder={`Reply to ${personName(entry.actor)}`}
									rows={3}
									attachments={data.attachments}
									onUploaded={() => void mutate()}
								/>
								<div className={styles.formActions}>
									<button
										type="button"
										className={styles.secondary}
										onClick={() => setReplyTo(null)}
									>
										Cancel
									</button>
									<button
										type="button"
										className={styles.primary}
										disabled={!replyText.trim()}
										onClick={async () => {
											if (
												await act({
													action: "comment",
													body: replyText,
													replyTo: entry.id,
												})
											) {
												setReplyText("");
												setReplyTo(null);
											}
										}}
									>
										Reply
									</button>
								</div>
							</li>
						)}
						{replies.map((child) =>
							renderComment(child, depth + 1),
						)}
					</ol>
				)}
			</li>
		);
	};

	// The folded details' one line: priority, effort, who is on it and when
	// it is due.
	const detailsSummary = [
		item.priority
			? config.priorities.find((p) => p.id === item.priority)?.label
			: null,
		item.effort ? effortLabel(config, item.effort) : null,
		item.assignees.length > 0
			? item.assignees.map(personName).join(", ")
			: "Nobody assigned",
		item.target
			? new Date(`${item.target}T00:00:00Z`).toLocaleDateString("en-US", {
					month: "short",
					day: "numeric",
					timeZone: "UTC",
				})
			: null,
	]
		.filter(Boolean)
		.join(" · ");
	// The archive setting's days when this request is done and past them.
	const archiveAfter = config.rules.archiveDoneAfterDays;
	const archivedDays =
		!item.closedAs &&
		item.status === "done" &&
		archiveAfter !== null &&
		Date.now() - new Date(item.statusSince).getTime() >
			archiveAfter * 86_400_000
			? archiveAfter
			: null;
	// Whoever opened the request stands in when nobody is on its list.
	const askers =
		data.requesters.length > 0 ? data.requesters : [item.createdBy];
	const attachedFiles = data.attachments.filter((a) => a.section === "files");
	const pastedFiles = data.attachments.filter(
		(a) => a.section === "discussion" && a.foundIn,
	);
	// Opens the discussion at the comment that shows a pasted file, and marks
	// the comment briefly so the eye finds it.
	const showWherePosted = (found: NonNullable<Attachment["foundIn"]>) => {
		setTab("discussion");
		if (found.kind === "description") {
			document
				.querySelector("main")
				?.scrollTo({ top: 0, behavior: "smooth" });
			return;
		}
		// The discussion renders after the tab changes, so this waits for the
		// comment to appear, giving up after a second.
		const startedAt = performance.now();
		const reach = () => {
			const comment = document.getElementById(
				`comment-${found.commentId}`,
			);
			if (!comment) {
				if (performance.now() - startedAt < 1000)
					requestAnimationFrame(reach);
				return;
			}
			comment.scrollIntoView({ block: "center", behavior: "smooth" });
			if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
				comment.animate(
					[
						{ boxShadow: "0 0 0 2px var(--brand)" },
						{ boxShadow: "0 0 0 2px transparent" },
					],
					{ duration: 1800, easing: "ease-out" },
				);
		};
		requestAnimationFrame(reach);
	};
	// Everything under this request in tree order, each with how deep it sits.
	// A sub-task whose parent is not in the list starts a branch of its own.
	const known = new Set(data.children.map((child) => child.id));
	const subTaskRows: { child: WorkSummary; depth: number }[] = [];
	const placeUnder = (parentId: string | null, depth: number) => {
		for (const child of data.children) {
			const parent =
				child.parentId && known.has(child.parentId)
					? child.parentId
					: null;
			if ((parent ?? null) !== parentId) continue;
			subTaskRows.push({ child, depth });
			placeUnder(child.id, depth + 1);
		}
	};
	placeUnder(null, 0);
	const childrenDone = data.children.filter(
		(child) => child.status === "done" || child.closedAs,
	).length;
	const labelOf = (
		list: { id: string; label: string }[],
		id: string | null,
	) => list.find((entry) => entry.id === id)?.label ?? null;
	const classificationSummary =
		[
			labelOf(config.workTypes, item.workType),
			labelOf(config.layers, item.layer),
			labelOf(config.domains, item.domain),
			...item.tags,
		]
			.filter(Boolean)
			.join(" · ") || "Not set";
	const signOffSummary = [
		item.approver
			? item.approvedOn
				? "Approved"
				: "Awaiting approval"
			: "No approver",
		item.securityReviewedOn ? "Security signed off" : null,
		item.visibility === "restricted" ? "Sensitive" : "Visible to all",
	]
		.filter(Boolean)
		.join(" · ");
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
					{archivedDays !== null && (
						<span
							className={styles.badge}
							title={`Done for over ${archivedDays} days, so it is off the board. The Archived filter on Requests finds it.`}
						>
							Archived
						</span>
					)}
					{item.visibility === "restricted" && (
						<span className={styles.badge}>Sensitive</span>
					)}
					<span className={styles.meta}>
						Asked by {askers.map(personName).join(", ")}{" "}
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
					<TabStrip
						label="Request"
						value={tab}
						onChange={setTab}
						tabs={[
							{ id: "discussion", label: "Discussion" },
							{
								id: "attachments",
								label: "Attachments",
								count: attachedFiles.length,
							},
							{
								id: "related",
								label: "Related",
								count:
									related.length +
									updates.length +
									data.dependsOn.length +
									data.blocks.length,
							},
						]}
					/>

					{tab === "discussion" && (
						<>
							<section className={styles.panel}>
								<div className={styles.panelHead}>
									<h2>Description</h2>
									{(may.editAsked || may.engineer) &&
										!describing && (
											<button
												type="button"
												className={styles.link}
												onClick={() => {
													setDescription(
														item.description,
													);
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
											attachments={data.attachments}
											onUploaded={() => void mutate()}
										/>
										<div className={styles.formActions}>
											<button
												type="button"
												className={styles.secondary}
												onClick={() =>
													setDescribing(false)
												}
											>
												Cancel
											</button>
											<button
												type="button"
												className={styles.primary}
												onClick={async () => {
													if (
														await update({
															description,
														})
													)
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
									<p className={styles.empty}>
										No description yet.
									</p>
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
										None yet. These are ticked while the
										work is validated.
									</p>
								) : (
									<ul className={styles.criteria}>
										{data.criteria.map((c) => (
											<li key={c.criterion_id}>
												<label className={styles.check}>
													<input
														type="checkbox"
														checked={Boolean(
															c.done_on,
														)}
														onChange={(e) =>
															void act({
																action: "criteria",
																criterionId:
																	c.criterion_id,
																done: e.target
																	.checked,
															})
														}
													/>
													<span>{c.body}</span>
												</label>
												{c.done_by && (
													<span
														className={styles.meta}
													>
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
									<h2>Activity</h2>
									<Select
										value={show}
										ariaLabel="Show"
										onChange={(v) =>
											setShow(v as typeof show)
										}
										options={[
											{
												value: "all",
												label: "Everything",
											},
											{
												value: "comments",
												label: "Comments only",
											},
											{
												value: "changes",
												label: "Changes only",
											},
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
												<TimelineIcon
													kind={entry.kind ?? ""}
												/>
												<span>
													<strong>
														{personName(
															entry.actor,
														)}
													</strong>{" "}
													{eventText(entry, config)}{" "}
													<span
														className={styles.meta}
													>
														{when(entry.at)}
													</span>
													{entry.kind ===
														"described" && (
														<button
															type="button"
															className={
																styles.link
															}
															onClick={() =>
																setComparing(
																	comparing ===
																		entry.id
																		? null
																		: entry.id,
																)
															}
														>
															{comparing ===
															entry.id
																? "Hide changes"
																: "See changes"}
														</button>
													)}
												</span>
												{comparing === entry.id && (
													<div
														className={
															styles.compare
														}
													>
														<div>
															<span
																className={
																	styles.meta
																}
															>
																Before
															</span>
															<RichText
																text={String(
																	entry.data
																		?.before ??
																		"",
																)}
																attachments={
																	data.attachments
																}
															/>
														</div>
														<div>
															<span
																className={
																	styles.meta
																}
															>
																After
															</span>
															<RichText
																text={String(
																	entry.data
																		?.after ??
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
											renderComment(entry, 0)
										),
									)}
								</ol>
								<div className={styles.newComment}>
									<Composer
										itemKey={itemKey}
										value={comment}
										onChange={setComment}
										placeholder="Add to the discussion"
										attachments={data.attachments}
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
													})
												) {
													setComment("");
												}
											}}
										>
											Comment
										</button>
									</div>
								</div>
							</section>
						</>
					)}

					{tab === "attachments" && (
						<section className={styles.panel}>
							<div className={styles.panelHead}>
								<h2>Attachments</h2>
								<div className={styles.addActions}>
									<div
										className={styles.segmented}
										role="group"
										aria-label="Which attachments"
									>
										{(
											[
												["both", "Both"],
												["files", "Files"],
												[
													"discussion",
													"From the discussion",
												],
											] as const
										).map(([value, label]) => (
											<button
												key={value}
												type="button"
												className={styles.segment}
												aria-pressed={
													attachmentView === value
												}
												onClick={() =>
													setAttachmentView(value)
												}
											>
												{label}
											</button>
										))}
									</div>
									<AttachButton
										disabled={attaching}
										onFiles={(files) =>
											void attachFiles(files)
										}
									/>
								</div>
							</div>
							{attachFailure && (
								<p className={styles.failure}>
									{attachFailure}
								</p>
							)}
							{attachmentView !== "discussion" && (
								<div className={styles.attachmentSection}>
									<h3 className={styles.attachmentHeading}>
										Files
										<span className={styles.count}>
											{attachedFiles.length}
										</span>
									</h3>
									{attachedFiles.length === 0 ? (
										<p className={styles.empty}>
											No files attached. Attach adds a
											file to the request itself.
										</p>
									) : (
										<ul className={styles.attachmentGrid}>
											{attachedFiles.map((a) => (
												<AttachmentCard
													key={a.attachment_id}
													attachment={a}
													onRemove={() =>
														void act({
															action: "detach",
															attachmentId:
																a.attachment_id,
														})
													}
												/>
											))}
										</ul>
									)}
								</div>
							)}
							{attachmentView !== "files" && (
								<div className={styles.attachmentSection}>
									<h3 className={styles.attachmentHeading}>
										From the discussion
										<span className={styles.count}>
											{pastedFiles.length}
										</span>
									</h3>
									{pastedFiles.length === 0 ? (
										<p className={styles.empty}>
											Nothing pasted into the discussion
											yet. Screenshots pasted into a
											comment or the description gather
											here.
										</p>
									) : (
										<ul className={styles.attachmentGrid}>
											{pastedFiles.map((a) => (
												<AttachmentCard
													key={a.attachment_id}
													attachment={a}
													whereLabel={
														a.foundIn?.kind ===
														"comment"
															? `In ${personName(a.foundIn.author)}'s comment, ${when(a.foundIn.at)}`
															: "In the description"
													}
													onShowWhere={() =>
														a.foundIn &&
														showWherePosted(
															a.foundIn,
														)
													}
												/>
											))}
										</ul>
									)}
								</div>
							)}
						</section>
					)}

					{tab === "related" && (
						<>
							<section className={styles.panel}>
								<div className={styles.panelHead}>
									<h2>Related</h2>
									{(may.engineer || may.editAsked) && (
										<div className={styles.addActions}>
											<AddButton onClick={addAddress}>
												Link
											</AddButton>
											<AddButton onClick={addDependency}>
												Dependency
											</AddButton>
											<AddButton onClick={addDataset}>
												Dataset
											</AddButton>
										</div>
									)}
								</div>
								{related.length +
									data.dependsOn.length +
									data.blocks.length ===
								0 ? (
									<p className={styles.empty}>
										Nothing linked yet. Add the pull
										request, a request this waits on, or the
										datasets it touches.
									</p>
								) : (
									<ul className={styles.linkRows}>
										{data.dependsOn.map((d) => (
											<LinkRow
												key={d.id}
												kind="dependsOn"
												label="Depends on"
												state={requestState(config, d)}
												onRemove={
													may.engineer && d.linkId
														? () =>
																void act({
																	action: "unlink",
																	linkId: d.linkId,
																})
														: undefined
												}
											>
												<Link href={`/work/${d.key}`}>
													<span
														className={
															styles.linkKey
														}
													>
														{d.key}
													</span>
													{d.title}
												</Link>
											</LinkRow>
										))}
										{data.blocks.map((d) => (
											<LinkRow
												key={d.id}
												kind="blocks"
												label="Blocks"
												state={requestState(config, d)}
											>
												<Link href={`/work/${d.key}`}>
													<span
														className={
															styles.linkKey
														}
													>
														{d.key}
													</span>
													{d.title}
												</Link>
											</LinkRow>
										))}
										{related.map((link) => (
											<LinkRow
												key={link.link_id}
												kind={link.kind}
												label={
													linkKindLabels[link.kind] ??
													link.kind
												}
												state={
													link.detail
														? `On ${link.detail}`
														: undefined
												}
												onRemove={
													may.engineer
														? () =>
																void act({
																	action: "unlink",
																	linkId: link.link_id,
																})
														: undefined
												}
											>
												<RelatedName link={link} />
											</LinkRow>
										))}
									</ul>
								)}
							</section>

							<section className={styles.panel}>
								<div className={styles.panelHead}>
									<h2>Updates</h2>
									{may.engineer && !linkingUpdate && (
										<div className={styles.addActions}>
											<AddButton
												onClick={() =>
													setLinkingUpdate(true)
												}
											>
												Link an update
											</AddButton>
										</div>
									)}
								</div>
								{linkingUpdate && (
									<UpdatePicker
										onCancel={() => setLinkingUpdate(false)}
										onPick={(updateId, resolves) => {
											setLinkingUpdate(false);
											void act({
												action: "link",
												kind: "update",
												target: updateId,
												detail: resolves
													? "resolves"
													: "relates",
											});
										}}
									/>
								)}
								{updates.length === 0 ? (
									<p className={styles.empty}>
										Not linked to an update yet. Linking one
										that resolves this moves it to Done once
										it is out.
									</p>
								) : (
									<ul className={styles.linkRows}>
										{updates.map((link) => (
											<LinkRow
												key={link.link_id}
												kind="update"
												label="Update"
												state={
													link.detail === "resolves"
														? "Resolves this"
														: "Related"
												}
												stateTone={
													link.detail === "resolves"
														? "brand"
														: undefined
												}
												onRemove={
													may.engineer
														? () =>
																void act({
																	action: "unlink",
																	linkId: link.link_id,
																})
														: undefined
												}
											>
												<Link
													href={`/status?tab=updates&open=${link.target}`}
												>
													{link.label ?? "An update"}
												</Link>
											</LinkRow>
										))}
									</ul>
								)}
							</section>
						</>
					)}
				</main>

				<aside className={styles.itemSide}>
					<button
						type="button"
						className={styles.sideFold}
						aria-expanded={detailsOpen}
						aria-controls="request-details"
						onClick={() => toggleDetails()}
					>
						<svg
							className={styles.sideGroupChevron}
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M9 6l6 6-6 6" />
						</svg>
						<span className={styles.sideGroupTitle}>Details</span>
						{!detailsOpen && (
							<span className={styles.sideGroupSummary}>
								{detailsSummary}
							</span>
						)}
					</button>
					<div
						id="request-details"
						className={styles.sideBody}
						data-open={detailsOpen || undefined}
					>
						<SideGroup id="planning" title="Planning">
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
							<div className={styles.sidePair}>
								<SideField label="Priority">
									<Select
										value={item.priority ?? ""}
										disabled={
											!(may.engineer || may.editAsked)
										}
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
										onChange={(v) =>
											void update({ effort: v || null })
										}
										options={[
											{ value: "", label: "Not sized" },
											...config.efforts.map((e) => ({
												value: e.id,
												label: effortLabel(
													config,
													e.id,
												),
											})),
										]}
									/>
								</SideField>
							</div>
							<div className={styles.sidePair}>
								{(may.engineer || item.release) && (
									<SideField label="Release">
										{may.engineer ? (
											<ReleaseSelect
												value={item.release?.id ?? ""}
												disabled={Boolean(
													item.release?.shippedOn,
												)}
												onChange={(releaseId) =>
													void update({
														releaseId:
															releaseId || null,
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
										<DatePicker
											size="form"
											value={item.target ?? ""}
											ariaLabel="Target"
											placeholder="No target"
											title={
												item.release
													? "Set by its release"
													: undefined
											}
											disabled={Boolean(item.release)}
											onChange={(next) =>
												void update({
													target: next || null,
												})
											}
										/>
									) : (
										<span>{item.target ?? "Not set"}</span>
									)}
								</SideField>
							</div>
						</SideGroup>

						<SideGroup id="people" title="People">
							<PeopleField
								label="Assigned"
								people={item.assignees}
								self={user?.email ?? null}
								editable={may.engineer}
								onChange={(next) =>
									void update({ assignees: next })
								}
							/>
							<PersonField
								label="Reviewer"
								person={item.reviewer}
								editable={may.engineer}
								onChange={(next) =>
									void update({ reviewer: next })
								}
							/>
							<SideField label="Following">
								<span className={styles.sideNote}>
									Asked by {askers.map(personName).join(", ")}
								</span>
								<span className={styles.sideNote}>
									Watched by{" "}
									{data.watchers.map(personName).join(", ") ||
										"nobody"}
								</span>
							</SideField>
						</SideGroup>

						<SideGroup id="hierarchy" title="Hierarchy">
							<SideField label="Parent">
								{may.engineer ? (
									<ParentSelect
										itemId={item.id}
										itemKey={itemKey}
										value={item.parent?.key ?? ""}
										onChange={(next) =>
											void update({
												parentKey: next || null,
											})
										}
									/>
								) : (
									<span>
										{item.parent
											? `${item.parent.key} ${item.parent.title}`
											: "None"}
									</span>
								)}
							</SideField>
							<SideField
								label="Sub-tasks"
								count={
									data.children.length > 0
										? `${childrenDone} of ${data.children.length} done`
										: undefined
								}
							>
								{data.children.length > 0 && (
									<>
										<div
											className={styles.progress}
											role="progressbar"
											aria-label="Sub-tasks done"
											aria-valuemin={0}
											aria-valuemax={data.children.length}
											aria-valuenow={childrenDone}
										>
											<span
												style={{
													width: `${(childrenDone / data.children.length) * 100}%`,
												}}
											/>
										</div>
										<ul className={styles.subTasks}>
											{subTaskRows.map(
												({ child, depth }) => {
													const finished =
														child.status ===
															"done" ||
														Boolean(child.closedAs);
													return (
														<li key={child.id}>
															<Link
																href={`/work/${child.key}`}
																className={
																	styles.subTask
																}
																style={{
																	paddingLeft: `calc(var(--space-3) + ${depth * 18}px)`,
																}}
																data-done={
																	finished ||
																	undefined
																}
															>
																<span
																	className={
																		styles.subTaskDot
																	}
																	aria-hidden="true"
																/>
																<span
																	className={
																		styles.linkKey
																	}
																>
																	{child.key}
																</span>
																<span
																	className={
																		styles.subTaskTitle
																	}
																	title={
																		child.title
																	}
																>
																	{
																		child.title
																	}
																</span>
																<span
																	className={
																		styles.subTaskState
																	}
																>
																	{requestState(
																		config,
																		child,
																	)}
																</span>
															</Link>
														</li>
													);
												},
											)}
										</ul>
									</>
								)}
								{data.children.length === 0 &&
									!may.engineer && (
										<span className={styles.sideNote}>
											None
										</span>
									)}
								{may.engineer && (
									<button
										type="button"
										className={`${styles.secondary} ${styles.addLink}`}
										onClick={() => setAddingChild(true)}
									>
										<LinkIcon kind="plus" size={14} />
										Add a sub-task
									</button>
								)}
							</SideField>
						</SideGroup>

						<SideGroup
							id="classification"
							title="Classification"
							collapsible
							summary={classificationSummary}
						>
							<div className={styles.sidePair}>
								<SideField label="Work type">
									<Select
										value={item.workType ?? ""}
										disabled={
											!(may.engineer || may.editAsked)
										}
										ariaLabel="Work type"
										onChange={(v) =>
											void update({ workType: v || null })
										}
										options={choice(config.workTypes)}
									/>
								</SideField>
								{config.layers.length > 0 && (
									<SideField label="Layer">
										<Select
											value={item.layer ?? ""}
											disabled={
												!(may.engineer || may.editAsked)
											}
											ariaLabel="Layer"
											onChange={(v) =>
												void update({
													layer: v || null,
												})
											}
											options={choice(config.layers)}
										/>
									</SideField>
								)}
							</div>
							{config.domains.length > 0 && (
								<SideField label="Domain">
									<Select
										value={item.domain ?? ""}
										disabled={
											!(may.engineer || may.editAsked)
										}
										ariaLabel="Domain"
										onChange={(v) =>
											void update({ domain: v || null })
										}
										options={choice(config.domains)}
									/>
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
										if (
											next.join(",") !==
											item.tags.join(",")
										)
											void update({ tags: next });
									}}
								/>
							</SideField>
						</SideGroup>

						<SideGroup
							id="signOff"
							title="Sign-off"
							collapsible
							summary={signOffSummary}
						>
							<PersonField
								label="Approver"
								person={item.approver}
								editable={may.engineer}
								onChange={(next) =>
									void update({ approver: next })
								}
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
											onClick={async () => {
												if (
													await confirm({
														title: `Approve ${item.key}?`,
														body: "Your approval is recorded against your name, and the request can then move into work.",
														confirm: "Approve",
													})
												)
													void act({
														action: "approve",
													});
											}}
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
											{personName(
												item.securityReviewedBy ?? "",
											)}{" "}
											{when(item.securityReviewedOn)}
										</span>
									) : (
										<button
											type="button"
											className={styles.secondary}
											onClick={async () => {
												if (
													await confirm({
														title: `Sign off the security review for ${item.key}?`,
														body: "Your sign-off is recorded against your name, and the request can then move on to deploy.",
														confirm: "Sign off",
													})
												)
													void act({
														action: "securityReview",
													});
											}}
										>
											Sign off
										</button>
									)}
								</SideField>
							)}
							<SideField label="Visibility">
								<Toggle
									checked={item.visibility === "restricted"}
									disabled={!may.markSensitive}
									onChange={(on) =>
										void update({
											visibility: on
												? "restricted"
												: "normal",
										})
									}
									label="Sensitive, kept to the people who asked and the engineers"
								/>
							</SideField>
						</SideGroup>
					</div>
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
	count,
	children,
}: {
	label: string;
	// Shown at the right of the label, such as how many sub-tasks are done.
	count?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={styles.sideField}>
			{count ? (
				<span className={styles.sideLabelRow}>
					<span className={styles.sideLabel}>{label}</span>
					<span className={styles.sideGroupCount}>{count}</span>
				</span>
			) : (
				<span className={styles.sideLabel}>{label}</span>
			)}
			{children}
		</div>
	);
}

function PeopleField({
	label,
	people,
	self,
	editable,
	onChange,
}: {
	label: string;
	people: string[];
	// The reader, offered as one click when they are not on the list yet.
	self?: string | null;
	editable: boolean;
	onChange: (next: string[]) => void;
}) {
	const mayAddSelf =
		editable &&
		Boolean(self) &&
		!people.some((p) => p.toLowerCase() === self?.toLowerCase());
	const addSelf = mayAddSelf && self && (
		<button
			type="button"
			className={`${styles.link} ${styles.assignSelf}`}
			onClick={() => onChange([...people, self])}
		>
			Assign me
		</button>
	);
	return (
		<SideField label={label}>
			{people.length === 0 ? (
				<span className={styles.meta}>
					Nobody{addSelf ? ", " : ""}
					{addSelf}
				</span>
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
					{addSelf}
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
			{editable ? (
				<PersonSelect
					value={person ?? ""}
					placeholder="Nobody"
					allowNone
					onChange={(next) => onChange(next || null)}
				/>
			) : person ? (
				<span>{personName(person)}</span>
			) : (
				<span className={styles.meta}>Nobody</span>
			)}
		</SideField>
	);
}

const commentIcons: Record<string, string> = {
	reply: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v5",
	eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
	check: "M20 6L9 17l-5-5",
	reopen: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
	pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
	trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
};

// One of a comment's actions, as a small bordered button with its mark. Quiet
// ones, for editing the comment itself, show their border only on hover.
function CommentButton({
	icon,
	pressed,
	quiet,
	danger,
	onClick,
	children,
}: {
	icon: string;
	pressed?: boolean;
	quiet?: boolean;
	danger?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className={`${styles.commentButton} ${quiet ? styles.commentButtonQuiet : ""} ${danger ? styles.commentButtonDanger : ""}`}
			aria-pressed={pressed}
			onClick={onClick}
		>
			<svg
				width="13"
				height="13"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d={commentIcons[icon]} />
			</svg>
			{children}
		</button>
	);
}

// One file in the Attachments tab. A file from the discussion says where it
// was posted, and is removed by editing that comment rather than from here, so
// the discussion never points at a missing file.
function AttachmentCard({
	attachment: a,
	whereLabel,
	onShowWhere,
	onRemove,
}: {
	attachment: Attachment;
	whereLabel?: string;
	onShowWhere?: () => void;
	onRemove?: () => void;
}) {
	return (
		<li className={styles.attachmentCard}>
			<a
				href={`/api/work/files/${a.hash}`}
				target="_blank"
				rel="noreferrer"
				className={styles.attachmentThumb}
			>
				{a.content_type.startsWith("image/") ? (
					// eslint-disable-next-line @next/next/no-img-element
					<img
						src={`/api/work/files/${a.hash}`}
						alt={a.file_name}
						loading="lazy"
					/>
				) : (
					<span>
						{a.file_name.split(".").pop()?.toUpperCase() ?? "FILE"}
					</span>
				)}
			</a>
			<div className={styles.attachmentInfo}>
				<span title={a.file_name}>{a.file_name}</span>
				<span className={styles.meta}>
					{Math.max(1, Math.round(a.size / 1024))} KB
				</span>
			</div>
			{whereLabel && onShowWhere && (
				<button
					type="button"
					className={`${styles.link} ${styles.attachmentWhere}`}
					title="Show it in the discussion"
					onClick={onShowWhere}
				>
					{whereLabel}
				</button>
			)}
			{onRemove && (
				<button
					type="button"
					className={styles.link}
					onClick={onRemove}
				>
					Remove
				</button>
			)}
		</li>
	);
}

const linkKindLabels: Record<string, string> = {
	url: "Link",
	report: "Report",
	source: "Dataset",
	field: "Field",
	page: "Page",
	visual: "Visual",
};

// Where a linked request stands, read from its column or how it closed.
function requestState(config: WorkConfig, request: WorkSummary): string {
	return request.closedAs ? "Closed" : columnLabel(config, request.status);
}

// The name a link shows. An address without a label shows its host and path
// rather than the whole address.
function RelatedName({ link }: { link: Detail["links"][number] }) {
	if (link.kind === "url") {
		let shown = link.target;
		try {
			const address = new URL(link.target);
			shown = `${address.host}${address.pathname === "/" ? "" : address.pathname}`;
		} catch {
			// Not a full address, so it shows as written.
		}
		return (
			<a href={link.target} target="_blank" rel="noreferrer">
				{link.label || shown}
			</a>
		);
	}
	if (link.kind === "report")
		return (
			<Link href={`/r/${link.target}`}>{link.label ?? link.target}</Link>
		);
	return <>{link.label ?? link.target}</>;
}

// One thing a request points at, with its mark, its kind above its name, any
// state as a pill and a remove control at the end.
function LinkRow({
	kind,
	label,
	state,
	stateTone,
	onRemove,
	children,
}: {
	kind: string;
	label: string;
	state?: string;
	stateTone?: "brand";
	onRemove?: () => void;
	children: React.ReactNode;
}) {
	return (
		<li className={styles.linkRow}>
			<span className={styles.linkMark} data-kind={kind}>
				<LinkIcon kind={kind} />
			</span>
			<span className={styles.linkText}>
				<span className={styles.linkKind}>{label}</span>
				<span className={styles.linkName}>{children}</span>
			</span>
			{state ? (
				<span className={styles.linkState} data-tone={stateTone}>
					{state}
				</span>
			) : (
				<span />
			)}
			{onRemove ? (
				<button
					type="button"
					className={styles.linkRemove}
					aria-label={`Remove ${label.toLowerCase()}`}
					title="Remove"
					onClick={onRemove}
				>
					<LinkIcon kind="remove" size={14} />
				</button>
			) : (
				<span />
			)}
		</li>
	);
}

function AddButton({
	onClick,
	children,
}: {
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className={`${styles.secondary} ${styles.addLink}`}
			onClick={onClick}
		>
			<LinkIcon kind="plus" size={14} />
			{children}
		</button>
	);
}

// Choosing an update to link, from the ones this person can see.
function UpdatePicker({
	onPick,
	onCancel,
}: {
	onPick: (updateId: string, resolves: boolean) => void;
	onCancel: () => void;
}) {
	const [resolves, setResolves] = useState(true);
	const { data } = useSWR<{ updates: { updateId: string; title: string }[] }>(
		"/api/changes?list=1&limit=50",
	);
	return (
		<div className={styles.pickerBox}>
			<div className={styles.pickerChoice}>
				<Select
					value=""
					ariaLabel="Update"
					placeholder="Choose an update"
					searchable
					onChange={(updateId) => onPick(updateId, resolves)}
					options={(data?.updates ?? []).map((u) => ({
						value: u.updateId,
						label: u.title,
					}))}
				/>
			</div>
			<Toggle
				checked={resolves}
				onChange={setResolves}
				label="It resolves this"
			/>
			<button type="button" className={styles.link} onClick={onCancel}>
				Cancel
			</button>
		</div>
	);
}

// Chooses somebody from the people who have signed in.
// The larger request this one is part of, chosen from the open requests by key
// or title. Itself and anything already under it are left out, since either
// would make a loop.
function ParentSelect({
	itemId,
	itemKey,
	value,
	onChange,
}: {
	itemId: string;
	itemKey: string;
	value: string;
	onChange: (key: string) => void;
}) {
	const { data } = useSWR<{ items: WorkSummary[] }>("/api/work?archive=all");
	const items = data?.items ?? [];
	const under = new Set<string>([itemId]);
	// Grows until a pass adds nothing, so sub-tasks of sub-tasks are caught.
	for (let grew = true; grew; ) {
		grew = false;
		for (const candidate of items) {
			if (
				candidate.parentId &&
				under.has(candidate.parentId) &&
				!under.has(candidate.id)
			) {
				under.add(candidate.id);
				grew = true;
			}
		}
	}
	return (
		<Select
			value={value}
			searchable
			ariaLabel="Parent"
			placeholder="No parent"
			onChange={onChange}
			options={[
				{ value: "", label: "No parent" },
				...items
					.filter((c) => !under.has(c.id) && c.key !== itemKey)
					.map((c) => ({
						value: c.key,
						label: `${c.key} ${c.title}`,
					})),
			]}
		/>
	);
}

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
