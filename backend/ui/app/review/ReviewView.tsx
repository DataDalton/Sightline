"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { displayNameFromEmail } from "../../lib/auth/names";
import type { SharedTurn } from "../../lib/feedback/sharedLog";
import { describeFetchError } from "../../lib/swr";
import { EmptyState } from "../components/shared/EmptyState";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { usePageTitle } from "../hooks/usePageTitle";
import styles from "./Review.module.css";

// Reading conversations that are not one's own, for the two reviewer roles and
// the administrators who decide their requests. See lib/review.
//
// A request names people and a period, never a conversation. Titles are part
// of what is protected, so they show only once access is approved.

type Kind = "groupChats" | "assistant";

type Scope =
	| { kind: "conversation"; id: string }
	| { kind: "person"; email: string; from?: string; to?: string }
	| { kind: "people"; emails: string[]; from?: string; to?: string }
	| { kind: "everyone"; from?: string; to?: string };

interface Grant {
	request_id: string;
	requester_email: string;
	kind: Kind;
	scope: Scope;
	reason_category: string;
	reason: string;
	duration_days: number;
	security: boolean;
	state: "pending" | "approved" | "declined" | "revoked";
	self_granted: boolean;
	decided_by: string | null;
	decided_on: string | null;
	decision_note: string | null;
	expires_on: string | null;
	created_on: string;
	views: number;
}

interface Reading {
	viewer: string;
	kind: string;
	target_id: string;
	owner_email: string | null;
	viewed_on: string;
	request_id: string;
	title: string | null;
}

interface Overview {
	mayRequest: { groupChats: boolean; assistant: boolean };
	decides: boolean;
	mine: Grant[];
	all: Grant[];
	views: Reading[];
}

type Tab = "mine" | "waiting" | "all" | "log";

const kindLabels: Record<Kind, string> = {
	groupChats: "Group conversations",
	assistant: "Assistant conversations",
};

const reasonLabels: Record<string, string> = {
	quality: "Quality review",
	complaint: "A complaint",
	security: "Security investigation",
	other: "Something else",
};

const periods = [
	{ id: "7", label: "Last 7 days" },
	{ id: "30", label: "Last 30 days" },
	{ id: "90", label: "Last 90 days" },
	{ id: "all", label: "Any time" },
	{ id: "dates", label: "Dates" },
];

const lengths = [1, 3, 7, 14, 30];

// Icons for the empty tabs, in the 24 unit box the shared empty state draws.
const icons = {
	lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
	inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
	list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
	eye: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
};

function name(email: string | null | undefined): string {
	return email ? displayNameFromEmail(email) : "";
}

function day(iso: string | null): string {
	return iso
		? new Date(iso).toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			})
		: "";
}

function moment(iso: string | null): string {
	return iso
		? new Date(iso).toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			})
		: "";
}

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function scopeText(scope: Scope): string {
	const range =
		scope.kind !== "conversation" && (scope.from || scope.to)
			? `, ${scope.from ? day(scope.from) : "the start"} to ${scope.to ? day(scope.to) : "now"}`
			: "";
	if (scope.kind === "conversation") return "One conversation";
	if (scope.kind === "person") return `${name(scope.email)}${range}`;
	if (scope.kind === "people")
		return `${scope.emails.map(name).join(", ")}${range}`;
	return `Everyone${range}`;
}

function live(grant: Grant): boolean {
	return (
		grant.state === "approved" &&
		Boolean(grant.expires_on) &&
		new Date(grant.expires_on as string).getTime() > Date.now()
	);
}

function stateText(grant: Grant): string {
	if (grant.state === "approved") return live(grant) ? "Approved" : "Expired";
	return grant.state[0].toUpperCase() + grant.state.slice(1);
}

async function post(body: Record<string, unknown>): Promise<void> {
	const response = await fetch("/api/review", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const answer = (await response.json().catch(() => ({}))) as {
			error?: string;
		};
		throw new Error(answer.error ?? "That did not work.");
	}
}

export default function ReviewView() {
	usePageTitle("Conversation review");
	const { data, error, mutate } = useSWR<Overview>("/api/review");
	const [tab, setTab] = useState<Tab>("mine");
	const [asking, setAsking] = useState(false);
	const [browsing, setBrowsing] = useState<Grant | null>(null);
	const [deciding, setDeciding] = useState<{
		grant: Grant;
		decision: "approve" | "decline" | "revoke";
	} | null>(null);

	if (error) {
		return (
			<div className={styles.page}>
				<p className={styles.empty}>
					{describeFetchError(error, "review")}
				</p>
			</div>
		);
	}
	if (!data) return <div className={styles.page} />;
	const canAsk = data.mayRequest.groupChats || data.mayRequest.assistant;
	const pending = data.all.filter((grant) => grant.state === "pending");
	const tabs: [Tab, string][] = [
		["mine", "Your access"],
		...(data.decides
			? ([
					[
						"waiting",
						pending.length
							? `Waiting (${pending.length})`
							: "Waiting",
					],
					["all", "All requests"],
					["log", "Reading log"],
				] as [Tab, string][])
			: []),
	];

	return (
		<div className={styles.page}>
			<header className={styles.header}>
				<h1 className={styles.title}>Conversation review</h1>
				<p className={styles.subtitle}>
					Reading other people&apos;s conversations with a reason and
					an administrator&apos;s approval. Every reading is recorded,
					and the people concerned are told unless it is a security
					investigation.
				</p>
			</header>

			{!canAsk && !data.decides ? (
				<EmptyState icon={icons.lock} title="Not available to you">
					Reading other people&apos;s conversations needs one of the
					two reviewer roles. An administrator can give you one.
				</EmptyState>
			) : (
				<>
					<div className={styles.bar}>
						<button
							type="button"
							className={styles.primary}
							onClick={() => setAsking(true)}
						>
							Ask to read conversations
						</button>
						<div className={styles.tabs} role="tablist">
							{tabs.map(([id, label]) => (
								<button
									key={id}
									type="button"
									role="tab"
									aria-selected={tab === id}
									className={`${styles.tab} ${tab === id ? styles.tabOn : ""}`}
									onClick={() => setTab(id)}
								>
									{label}
								</button>
							))}
						</div>
					</div>

					{tab === "mine" &&
						(data.mine.length === 0 ? (
							<EmptyState
								icon={icons.lock}
								title="No access yet"
								action={
									<button
										type="button"
										className={styles.primary}
										onClick={() => setAsking(true)}
									>
										Ask to read conversations
									</button>
								}
							>
								Ask for the people and the period you need. Once
								an administrator approves it, the conversations
								open from here until your access ends.
							</EmptyState>
						) : (
							<GrantList
								grants={data.mine}
								onBrowse={setBrowsing}
								showRequester={false}
							/>
						))}
					{tab === "waiting" &&
						(pending.length === 0 ? (
							<EmptyState
								icon={icons.inbox}
								title="Nothing waiting"
							>
								Requests to read conversations appear here for
								you to approve or decline, and you are told when
								one arrives.
							</EmptyState>
						) : (
							<GrantList
								grants={pending}
								showRequester
								onDecide={(grant, decision) =>
									setDeciding({ grant, decision })
								}
							/>
						))}
					{tab === "all" &&
						(data.all.length === 0 ? (
							<EmptyState
								icon={icons.list}
								title="No requests yet"
							>
								Every request anyone makes is kept here with its
								reason and what was decided, including access
								administrators grant themselves.
							</EmptyState>
						) : (
							<GrantList
								grants={data.all}
								showRequester
								onDecide={(grant, decision) =>
									setDeciding({ grant, decision })
								}
							/>
						))}
					{tab === "log" && <ReadingLog readings={data.views} />}
				</>
			)}

			{asking && (
				<AskDialog
					overview={data}
					onClose={() => setAsking(false)}
					onDone={() => {
						setAsking(false);
						setTab("mine");
						void mutate();
					}}
				/>
			)}
			{deciding && (
				<DecideDialog
					grant={deciding.grant}
					decision={deciding.decision}
					onClose={() => setDeciding(null)}
					onDone={() => {
						setDeciding(null);
						void mutate();
					}}
				/>
			)}
			{browsing && (
				<Browse grant={browsing} onClose={() => setBrowsing(null)} />
			)}
		</div>
	);
}

// --- Asking ------------------------------------------------------------------

function AskDialog({
	overview,
	onClose,
	onDone,
}: {
	overview: Overview;
	onClose: () => void;
	onDone: () => void;
}) {
	const kinds = (["groupChats", "assistant"] as Kind[]).filter(
		(kind) => overview.mayRequest[kind] || overview.decides,
	);
	const { data: known } = useSWR<{
		people: { email: string; name: string }[];
	}>("/api/changes?people=1");
	const [kind, setKind] = useState<Kind>(kinds[0] ?? "groupChats");
	const [whose, setWhose] = useState<"people" | "everyone">("people");
	const [people, setPeople] = useState<string[]>([]);
	const [period, setPeriod] = useState("30");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [reasonCategory, setReasonCategory] = useState("quality");
	const [reason, setReason] = useState("");
	const [days, setDays] = useState(7);
	const [security, setSecurity] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const choosable = useMemo(
		() =>
			(known?.people ?? [])
				.filter((person) => !people.includes(person.email))
				.map((person) => ({
					value: person.email,
					label: person.name,
					note: person.email,
				})),
		[known, people],
	);

	const range =
		period === "dates"
			? { from: from || undefined, to: to || undefined }
			: period === "all"
				? {}
				: { from: daysAgo(Number(period)) };
	const ready =
		reason.trim().length >= 10 &&
		(whose === "everyone" || people.length > 0);

	const send = async (action: "request" | "selfGrant") => {
		setBusy(true);
		setFailure(null);
		try {
			await post({
				action,
				kind,
				scope:
					whose === "everyone"
						? { kind: "everyone", ...range }
						: { kind: "people", emails: people, ...range },
				reasonCategory,
				reason,
				durationDays: days,
				security: reasonCategory === "security" && security,
			});
			onDone();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			isOpen
			onClose={onClose}
			title="Ask to read conversations"
			width="720px"
		>
			<div className={styles.form}>
				{kinds.length > 1 && (
					<div className={styles.field}>
						<span className={styles.label}>Conversations</span>
						<Segmented
							value={kind}
							onChange={(next) => setKind(next as Kind)}
							options={kinds.map((k) => ({
								value: k,
								label: kindLabels[k],
							}))}
						/>
					</div>
				)}

				<div className={styles.field}>
					<span className={styles.label}>Whose</span>
					<Segmented
						value={whose}
						onChange={(next) => setWhose(next as typeof whose)}
						options={[
							{ value: "people", label: "Chosen people" },
							{ value: "everyone", label: "Everyone" },
						]}
					/>
					{whose === "people" && (
						<div className={styles.people}>
							{people.map((email) => (
								<span key={email} className={styles.personChip}>
									{name(email)}
									<button
										type="button"
										aria-label={`Remove ${name(email)}`}
										onClick={() =>
											setPeople(
												people.filter(
													(p) => p !== email,
												),
											)
										}
									>
										<svg
											viewBox="0 0 24 24"
											width="12"
											height="12"
											aria-hidden="true"
										>
											<path
												d="M6 6l12 12M18 6L6 18"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
											/>
										</svg>
									</button>
								</span>
							))}
							<span className={styles.personPicker}>
								<Select
									value=""
									searchable
									ariaLabel="Add a person"
									placeholder={
										people.length
											? "Add another person"
											: "Choose a person"
									}
									onChange={(email) =>
										email && setPeople([...people, email])
									}
									options={choosable}
								/>
							</span>
						</div>
					)}
				</div>

				<div className={styles.field}>
					<span className={styles.label}>From when</span>
					<Segmented
						value={period}
						onChange={setPeriod}
						options={periods.map((p) => ({
							value: p.id,
							label: p.label,
						}))}
					/>
					{period === "dates" && (
						<div className={styles.dates}>
							<input
								type="date"
								className={styles.input}
								aria-label="From"
								value={from}
								onChange={(e) => setFrom(e.target.value)}
							/>
							<span className={styles.meta}>to</span>
							<input
								type="date"
								className={styles.input}
								aria-label="To"
								value={to}
								onChange={(e) => setTo(e.target.value)}
							/>
						</div>
					)}
				</div>

				<div className={styles.twoUp}>
					<label className={styles.field}>
						<span className={styles.label}>Why</span>
						<Select
							value={reasonCategory}
							ariaLabel="Why"
							onChange={setReasonCategory}
							options={Object.entries(reasonLabels).map(
								([value, label]) => ({ value, label }),
							)}
						/>
					</label>
					<label className={styles.field}>
						<span className={styles.label}>Access lasts</span>
						<Select
							value={String(days)}
							ariaLabel="Access lasts"
							onChange={(v) => setDays(Number(v))}
							options={lengths.map((n) => ({
								value: String(n),
								label: n === 1 ? "1 day" : `${n} days`,
							}))}
						/>
					</label>
				</div>

				<label className={styles.field}>
					<span className={styles.label}>The reason</span>
					<textarea
						className={styles.input}
						rows={3}
						value={reason}
						placeholder="A sentence or two the approver and the audit can read"
						onChange={(e) => setReason(e.target.value)}
					/>
				</label>

				{reasonCategory === "security" && (
					<div className={styles.switchRow}>
						<Toggle
							checked={security}
							onChange={setSecurity}
							ariaLabel="Do not tell the people concerned"
						/>
						<div className={styles.switchText}>
							<span className={styles.switchTitle}>
								Do not tell the people concerned
							</span>
							<span className={styles.meta}>
								Only for a security investigation, and recorded
								as such.
							</span>
						</div>
					</div>
				)}

				{failure && <p className={styles.failure}>{failure}</p>}
				<div className={styles.actions}>
					<button
						type="button"
						className={styles.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					{overview.decides && (
						<button
							type="button"
							className={styles.secondary}
							disabled={busy || !ready}
							onClick={() => void send("selfGrant")}
						>
							Grant to myself
						</button>
					)}
					{overview.mayRequest[kind] && (
						<button
							type="button"
							className={styles.primary}
							disabled={busy || !ready}
							onClick={() => void send("request")}
						>
							Send for approval
						</button>
					)}
				</div>
			</div>
		</Modal>
	);
}

function Segmented({
	value,
	onChange,
	options,
}: {
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
}) {
	return (
		<div className={styles.segmented} role="group">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					className={styles.segment}
					aria-pressed={value === option.value}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

// --- Requests ----------------------------------------------------------------

function GrantList({
	grants,
	onBrowse,
	showRequester,
	onDecide,
}: {
	grants: Grant[];
	onBrowse?: (grant: Grant) => void;
	showRequester: boolean;
	onDecide?: (
		grant: Grant,
		decision: "approve" | "decline" | "revoke",
	) => void;
}) {
	return (
		<ul className={styles.list}>
			{grants.map((grant) => (
				<li key={grant.request_id} className={styles.row}>
					<div className={styles.rowMain}>
						<span className={styles.rowTitle}>
							{kindLabels[grant.kind]} of {scopeText(grant.scope)}
						</span>
						<span className={styles.meta}>
							{[
								showRequester
									? `Asked by ${name(grant.requester_email)}`
									: null,
								reasonLabels[grant.reason_category] ??
									grant.reason_category,
								grant.security ? "people not told" : null,
								grant.self_granted
									? "granted to themselves"
									: null,
								`${grant.duration_days} ${grant.duration_days === 1 ? "day" : "days"}`,
								day(grant.created_on),
							]
								.filter(Boolean)
								.join(" · ")}
						</span>
						<span className={styles.reason}>{grant.reason}</span>
						{grant.decided_by && (
							<span className={styles.meta}>
								{stateText(grant)} by {name(grant.decided_by)}{" "}
								{day(grant.decided_on)}
								{grant.decision_note
									? `. ${grant.decision_note}`
									: ""}
								{live(grant)
									? `. Open until ${moment(grant.expires_on)}`
									: ""}
								{grant.views > 0
									? `. Read ${grant.views} ${grant.views === 1 ? "time" : "times"}`
									: ""}
							</span>
						)}
					</div>
					<span
						className={`${styles.state} ${styles[`state_${live(grant) ? "live" : grant.state}`] ?? ""}`}
					>
						{stateText(grant)}
					</span>
					<div className={styles.rowActions}>
						{onBrowse && live(grant) && (
							<button
								type="button"
								className={styles.primary}
								onClick={() => onBrowse(grant)}
							>
								Open conversations
							</button>
						)}
						{onDecide && grant.state === "pending" && (
							<>
								<button
									type="button"
									className={styles.secondary}
									onClick={() => onDecide(grant, "decline")}
								>
									Decline
								</button>
								<button
									type="button"
									className={styles.primary}
									onClick={() => onDecide(grant, "approve")}
								>
									Approve
								</button>
							</>
						)}
						{onDecide && live(grant) && (
							<button
								type="button"
								className={styles.secondary}
								onClick={() => onDecide(grant, "revoke")}
							>
								Revoke
							</button>
						)}
					</div>
				</li>
			))}
		</ul>
	);
}

function DecideDialog({
	grant,
	decision,
	onClose,
	onDone,
}: {
	grant: Grant;
	decision: "approve" | "decline" | "revoke";
	onClose: () => void;
	onDone: () => void;
}) {
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const verb = { approve: "Approve", decline: "Decline", revoke: "Revoke" }[
		decision
	];

	const decide = async () => {
		setBusy(true);
		setFailure(null);
		try {
			await post({ action: decision, requestId: grant.request_id, note });
			onDone();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal isOpen onClose={onClose} title={`${verb} access`} width="560px">
			<div className={styles.form}>
				<div className={styles.summary}>
					<span className={styles.rowTitle}>
						{kindLabels[grant.kind]} of {scopeText(grant.scope)}
					</span>
					<span className={styles.meta}>
						Asked by {name(grant.requester_email)} ·{" "}
						{reasonLabels[grant.reason_category]} ·{" "}
						{grant.duration_days}{" "}
						{grant.duration_days === 1 ? "day" : "days"}
					</span>
					<span className={styles.reason}>{grant.reason}</span>
				</div>
				<label className={styles.field}>
					<span className={styles.label}>
						{decision === "approve"
							? "A note for them, if any"
							: "Why"}
					</span>
					<textarea
						className={styles.input}
						rows={3}
						value={note}
						onChange={(e) => setNote(e.target.value)}
					/>
				</label>
				{failure && <p className={styles.failure}>{failure}</p>}
				<div className={styles.actions}>
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
						disabled={
							busy || (decision !== "approve" && !note.trim())
						}
						onClick={() => void decide()}
					>
						{verb}
					</button>
				</div>
			</div>
		</Modal>
	);
}

function ReadingLog({ readings }: { readings: Reading[] }) {
	if (readings.length === 0) {
		return (
			<EmptyState icon={icons.eye} title="Nothing has been read">
				Each time someone opens a conversation under their access, it is
				recorded here with who read it and whose it was.
			</EmptyState>
		);
	}
	return (
		<div className={styles.tableWrap}>
			<table className={styles.table}>
				<thead>
					<tr>
						<th>When</th>
						<th>Read by</th>
						<th>Conversation</th>
						<th>Belongs to</th>
						<th>Kind</th>
					</tr>
				</thead>
				<tbody>
					{readings.map((reading, index) => (
						<tr key={index}>
							<td>{moment(reading.viewed_on)}</td>
							<td>{name(reading.viewer)}</td>
							<td>{reading.title ?? "A removed conversation"}</td>
							<td>{name(reading.owner_email)}</td>
							<td>
								{kindLabels[reading.kind as Kind] ??
									reading.kind}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

// --- Reading -----------------------------------------------------------------

interface Listed {
	id: string;
	owner: string;
	title: string;
	modified_on: string;
	questions: number | null;
}

type Opened =
	| { kind: "assistant"; owner: string; title: string; turns: SharedTurn[] }
	| {
			kind: "groupChats";
			thread: {
				thread: { subject: string; members: { name: string }[] };
				messages: {
					id: string;
					authorName: string;
					body: string;
					createdOn: string;
				}[];
			};
	  };

function Browse({ grant, onClose }: { grant: Grant; onClose: () => void }) {
	const { data } = useSWR<{ conversations: Listed[] }>(
		`/api/review?grant=${grant.request_id}`,
	);
	const [openId, setOpenId] = useState<string | null>(null);
	const { data: opened, error } = useSWR<Opened>(
		openId ? `/api/review?grant=${grant.request_id}&open=${openId}` : null,
	);
	return (
		<Modal
			isOpen
			onClose={onClose}
			title={`${kindLabels[grant.kind]} of ${scopeText(grant.scope)}`}
			width="1100px"
		>
			<div className={styles.browse}>
				<ul className={styles.browseList}>
					{(data?.conversations ?? []).map((item) => (
						<li key={item.id}>
							<button
								type="button"
								aria-pressed={openId === item.id}
								className={`${styles.browseItem} ${openId === item.id ? styles.browseItemOn : ""}`}
								onClick={() => setOpenId(item.id)}
							>
								<span className={styles.rowTitle}>
									{item.title}
								</span>
								<span className={styles.meta}>
									{name(item.owner)} ·{" "}
									{moment(item.modified_on)}
								</span>
							</button>
						</li>
					))}
					{data && data.conversations.length === 0 && (
						<li className={styles.empty}>
							No conversations in this period.
						</li>
					)}
				</ul>
				<div className={styles.reader}>
					{!openId && (
						<p className={styles.empty}>
							Choose a conversation. Opening it is recorded.
						</p>
					)}
					{error && (
						<p className={styles.failure}>
							{describeFetchError(error, "conversation")}
						</p>
					)}
					{opened?.kind === "assistant" &&
						opened.turns.map((turn, index) =>
							turn.role === "user" ? (
								<p key={index} className={styles.asked}>
									{turn.content}
								</p>
							) : (
								<div key={index} className={styles.answer}>
									{turn.steps.map((step, i) => (
										<span key={i} className={styles.meta}>
											{step.label}
											{step.summary
												? `, ${step.summary}`
												: ""}
										</span>
									))}
									{turn.answer && <p>{turn.answer}</p>}
								</div>
							),
						)}
					{opened?.kind === "groupChats" && (
						<>
							<p className={styles.meta}>
								{opened.thread.thread.members
									.map((m) => m.name)
									.join(", ")}
							</p>
							{opened.thread.messages.map((message) => (
								<div key={message.id} className={styles.answer}>
									<span className={styles.meta}>
										{message.authorName} ·{" "}
										{moment(message.createdOn)}
									</span>
									<p>{message.body}</p>
								</div>
							))}
						</>
					)}
				</div>
			</div>
		</Modal>
	);
}
