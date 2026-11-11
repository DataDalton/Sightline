"use client";

import dynamic from "next/dynamic";
import type { SourceMeta } from "../visuals/types";
import { useState } from "react";
import Link from "./AppLink";
import useSWR from "swr";
import { suggestionsKey } from "../../lib/query/requestKey";
import { Modal } from "./shared/Modal";
import { Select } from "./shared/Select";
import form from "../authoring/Authoring.module.css";

// Loaded when somebody asks, since it brings every visual with it.
const CompareVersions = dynamic(
	() => import("../editor/CompareVersions").then((m) => m.CompareVersions),
	{ ssr: false },
);

// Suggested changes and publish requests, either all of those waiting for the person
// signed in or the ones on a single report.

interface Suggestion {
	suggestionId: string;
	reportTitle: string;
	reportSlug: string;
	authorEmail: string;
	note: string | null;
	summary: string[];
	createdOn: string;
	movedOn: boolean;
}

interface PublishRequest {
	requestId: string;
	reportTitle: string;
	reportSlug: string;
	categoryId: string;
	categoryName: string | null;
	requestedBy: string;
	note: string | null;
	createdOn: string;
}

interface Waiting {
	suggestions: Suggestion[];
	publishRequests: PublishRequest[];
	myOpen: { suggestions: Suggestion[]; publishRequests: PublishRequest[] };
	draftsToRead?: PublishRequest[];
	categories: { id: string; name: string }[];
}

async function decide(body: Record<string, unknown>): Promise<string | null> {
	const response = await fetch("/api/requests", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.ok) return null;
	const detail = await response.json().catch(() => null);
	return detail?.error ?? "That decision was not recorded.";
}

function SuggestionCard({
	suggestion,
	onDone,
	withLink,
	onPreview,
}: {
	suggestion: Suggestion;
	onDone: () => void;
	withLink: boolean;
	onPreview?: () => void;
}) {
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const act = async (decision: "approve" | "decline") => {
		setBusy(true);
		const problem = await decide({
			kind: "suggestion",
			id: suggestion.suggestionId,
			decision,
			note,
		});
		setBusy(false);
		setFailure(problem);
		if (!problem) onDone();
	};
	return (
		<div className={form.form}>
			<strong>
				{withLink ? (
					<Link href={`/r/${suggestion.reportSlug}`}>
						{suggestion.reportTitle}
					</Link>
				) : (
					suggestion.reportTitle
				)}
			</strong>
			<span className={form.hint}>
				From {suggestion.authorEmail},{" "}
				{new Date(suggestion.createdOn).toLocaleDateString()}
			</span>
			{suggestion.note && <p>{suggestion.note}</p>}
			<ul>
				{suggestion.summary.map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
			{suggestion.movedOn && (
				<span className={form.hint}>
					The report has changed since this was drafted. Approving it
					may overwrite what changed.
				</span>
			)}
			<input
				className={form.input}
				value={note}
				placeholder="A note back, if you want one"
				onChange={(e) => setNote(e.target.value)}
			/>
			{failure && <div className={form.failure}>{failure}</div>}
			<div className={form.actions}>
				{onPreview && (
					<button
						type="button"
						className={form.secondary}
						onClick={onPreview}
					>
						Preview
					</button>
				)}
				<button
					type="button"
					className={form.secondary}
					disabled={busy}
					onClick={() => void act("decline")}
				>
					Decline
				</button>
				<button
					type="button"
					className={form.primary}
					disabled={busy}
					onClick={() => void act("approve")}
				>
					Approve
				</button>
			</div>
		</div>
	);
}

function PublishCard({
	request,
	categories,
	onDone,
}: {
	request: PublishRequest;
	categories: { id: string; name: string }[];
	onDone: () => void;
}) {
	const [categoryId, setCategoryId] = useState(request.categoryId);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const act = async (decision: "approve" | "decline") => {
		setBusy(true);
		const problem = await decide({
			kind: "publish",
			id: request.requestId,
			decision,
			categoryId,
			note,
		});
		setBusy(false);
		setFailure(problem);
		if (!problem) onDone();
	};
	return (
		<div className={form.form}>
			<strong>
				<Link href={`/r/${request.reportSlug}`}>
					{request.reportTitle}
				</Link>
			</strong>
			<span className={form.hint}>
				{request.requestedBy} asked to publish this,{" "}
				{new Date(request.createdOn).toLocaleDateString()}
			</span>
			{request.note && <p>{request.note}</p>}
			<Select
				value={categoryId}
				onChange={setCategoryId}
				options={categories.map((c) => ({
					value: c.id,
					label: c.name,
				}))}
			/>
			<input
				className={form.input}
				value={note}
				placeholder="A note back, if you want one"
				onChange={(e) => setNote(e.target.value)}
			/>
			{failure && <div className={form.failure}>{failure}</div>}
			<div className={form.actions}>
				<button
					type="button"
					className={form.secondary}
					disabled={busy}
					onClick={() => void act("decline")}
				>
					Decline
				</button>
				<button
					type="button"
					className={form.primary}
					disabled={busy}
					onClick={() => void act("approve")}
				>
					Publish
				</button>
			</div>
		</div>
	);
}

// Listed on My pages, and shown only when something is there.
export function WaitingForYou({ titleClass }: { titleClass: string }) {
	const { data, mutate } = useSWR<Waiting>("/api/requests");
	if (!data) return null;
	const refresh = () => void mutate();
	const mine = [
		...data.myOpen.suggestions.map((s) => ({
			key: s.suggestionId,
			kind: "suggestion",
			title: s.reportTitle,
			what: "Change suggested",
		})),
		...data.myOpen.publishRequests.map((r) => ({
			key: r.requestId,
			kind: "publish",
			title: r.reportTitle,
			what: "Waiting to be published",
		})),
	];
	const toRead = data.draftsToRead ?? [];
	if (
		data.suggestions.length === 0 &&
		data.publishRequests.length === 0 &&
		toRead.length === 0 &&
		mine.length === 0
	) {
		return null;
	}
	return (
		<>
			{(data.suggestions.length > 0 ||
				data.publishRequests.length > 0) && (
				<>
					<div className={titleClass}>Waiting for you</div>
					{data.suggestions.map((suggestion) => (
						<SuggestionCard
							key={suggestion.suggestionId}
							suggestion={suggestion}
							onDone={refresh}
							withLink
						/>
					))}
					{data.publishRequests.map((request) => (
						<PublishCard
							key={request.requestId}
							request={request}
							categories={data.categories}
							onDone={refresh}
						/>
					))}
				</>
			)}
			{toRead.length > 0 && (
				<>
					<div className={titleClass}>Drafts for your categories</div>
					{toRead.map((draft) => (
						<div key={draft.requestId} className={form.hint}>
							<Link href={`/r/${draft.reportSlug}`}>
								{draft.reportTitle}
							</Link>
							, from {draft.requestedBy}. A Report Publisher
							decides whether it is published.
						</div>
					))}
				</>
			)}
			{mine.length > 0 && (
				<>
					<div className={titleClass}>Waiting on someone else</div>
					{mine.map((item) => (
						<div key={item.key} className={form.hint}>
							<strong>{item.title}</strong>, {item.what}.{" "}
							<button
								type="button"
								className={form.secondary}
								onClick={async () => {
									await decide({
										kind: item.kind,
										id: item.key,
										decision: "withdraw",
									});
									refresh();
								}}
							>
								Withdraw
							</button>
						</div>
					))}
				</>
			)}
		</>
	);
}

// The suggestions on one report, opened from its header.
export function ReportSuggestions({
	slug,
	reportId,
	sources,
	startOpen,
	buttonClass,
}: {
	slug: string;
	reportId: string;
	sources: Record<string, SourceMeta>;
	startOpen: boolean;
	buttonClass: string;
}) {
	const [previewing, setPreviewing] = useState<string | null>(null);
	const { data, mutate } = useSWR<{ suggestions: Suggestion[] }>(
		suggestionsKey(slug),
	);
	const [open, setOpen] = useState(startOpen);
	const suggestions = data?.suggestions ?? [];
	if (suggestions.length === 0) return null;
	return (
		<>
			<button
				type="button"
				className={buttonClass}
				onClick={() => setOpen(true)}
			>
				Suggestions ({suggestions.length})
			</button>
			{open && (
				<Modal
					isOpen
					onClose={() => setOpen(false)}
					title="Suggested changes"
					width="600px"
				>
					{suggestions.map((suggestion) => (
						<SuggestionCard
							key={suggestion.suggestionId}
							suggestion={suggestion}
							withLink={false}
							onDone={() => void mutate()}
							onPreview={() =>
								setPreviewing(suggestion.suggestionId)
							}
						/>
					))}
				</Modal>
			)}
			{previewing && (
				<CompareVersions
					slug={slug}
					reportId={reportId}
					sources={sources}
					version={0}
					versions={[]}
					suggestionId={previewing}
					onClose={() => setPreviewing(null)}
				/>
			)}
		</>
	);
}
