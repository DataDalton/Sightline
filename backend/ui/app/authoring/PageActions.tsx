"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { Modal } from "../components/shared/Modal";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { useUser } from "../context/UserContext";
import { Select } from "../components/shared/Select";
import styles from "./Authoring.module.css";

// What can be done with a page somebody built for themselves.
//
// Two different people see two different things here. Its owner can name who
// else sees it, or remove it. An editor can take one that has been shared and
// put it in a category, which is the whole point of letting readers build:
// they do the finding, and an editor decides what the team keeps.

interface Share {
	email: string;
	grantedOn: string;
}

export function PageActions({
	reportId,
	title,
	isPersonal,
	ownerEmail,
	onChanged,
}: {
	reportId: string;
	title: string;
	isPersonal: boolean;
	ownerEmail: string;
	onChanged: () => void;
}) {
	const { user } = useUser();
	const router = useRouter();
	const [sharing, setSharing] = useState(false);
	const [publishing, setPublishing] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	const [removeFailure, setRemoveFailure] = useState<string | null>(null);

	if (!isPersonal || !user) return null;

	const mine = ownerEmail.toLowerCase() === user.email.toLowerCase();
	const canPublish =
		user.capabilities?.includes("report.makeOfficial") ?? false;

	// An administrator acts on any personal page. Offering the actions to
	// somebody who can already open and edit the page but cannot share or
	// remove it would leave them able to read what is there and not to do
	// anything about it.
	const acting = mine || user.canAdminister;

	return (
		<>
			{!mine && acting && (
				<span
					className={styles.borrowedTag}
					title={`Built by ${ownerEmail}`}
				>
					{ownerEmail}
				</span>
			)}

			{acting && (
				<button
					type="button"
					className={styles.openButton}
					onClick={() => setSharing(true)}
				>
					Share
				</button>
			)}

			{/* Offered to an editor on somebody else's page as well as on their
			    own. Publishing is about whether the team should keep it, which
			    is not a question about who wrote it. */}
			{(canPublish || mine) && (
				<button
					type="button"
					className={styles.openButton}
					onClick={() => setPublishing(true)}
				>
					{canPublish ? "Publish" : "Ask to publish"}
				</button>
			)}

			{acting && (
				<button
					type="button"
					className={styles.openButton}
					disabled={removing}
					onClick={() => {
						setRemoveFailure(null);
						setConfirmingRemove(true);
					}}
				>
					{removing ? "Removing" : "Remove"}
				</button>
			)}

			{confirmingRemove && (
				<ConfirmDialog
					title="Remove this page"
					body={
						<>
							<strong>{title}</strong> will be removed. Anyone it
							is shared with loses it.
							{removeFailure && (
								<div className={styles.failure}>
									{removeFailure}
								</div>
							)}
						</>
					}
					confirmLabel="Remove"
					busy={removing}
					onConfirm={async () => {
						setRemoving(true);
						setRemoveFailure(null);
						try {
							const response = await fetch("/api/personal", {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									action: "remove",
									reportId,
								}),
							});
							if (!response.ok) {
								const detail = await response
									.json()
									.catch(() => null);
								setRemoveFailure(
									detail?.error ??
										"Could not remove this page",
								);
								return;
							}
							// Nothing left to look at, so back to where pages
							// are listed rather than a page that no longer
							// resolves.
							setConfirmingRemove(false);
							router.push("/");
						} catch (error) {
							setRemoveFailure(
								error instanceof Error
									? error.message
									: "Could not remove this page",
							);
						} finally {
							setRemoving(false);
						}
					}}
					onCancel={() => setConfirmingRemove(false)}
				/>
			)}

			{sharing && (
				<ShareDialog
					reportId={reportId}
					title={title}
					onClose={() => {
						setSharing(false);
						onChanged();
					}}
				/>
			)}

			{publishing && (
				<PublishDialog
					reportId={reportId}
					title={title}
					direct={canPublish}
					onClose={() => setPublishing(false)}
				/>
			)}
		</>
	);
}

export function ShareDialog({
	reportId,
	title,
	onClose,
}: {
	reportId: string;
	title: string;
	onClose: () => void;
}) {
	const [shares, setShares] = useState<Share[] | null>(null);
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	// Resolves true when the server accepted the change, so a caller can keep
	// what was typed after a failure.
	const post = useCallback(
		async (
			body: Record<string, unknown>,
			whenWrong: string,
		): Promise<boolean> => {
			setBusy(true);
			setFailure(null);
			try {
				const response = await fetch("/api/personal", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...body, reportId }),
				});
				const detail = await response.json().catch(() => null);
				if (!response.ok) {
					setFailure(detail?.error ?? whenWrong);
					return false;
				}
				if (Array.isArray(detail?.shares)) setShares(detail.shares);
				return true;
			} catch (error) {
				setFailure(error instanceof Error ? error.message : whenWrong);
				return false;
			} finally {
				setBusy(false);
			}
		},
		[reportId],
	);

	// Loaded once the dialog opens rather than with the page, because most
	// pages are never shared and the list is only ever read here.
	useEffect(() => {
		void post(
			{ action: "shares" },
			"Could not read who this is shared with",
		);
	}, [post]);

	// The typed address is cleared only once it has been shared, so a failure
	// leaves it in place to correct or retry. The busy check covers Enter,
	// which does not pass through the disabled button.
	const share = async () => {
		if (busy || !email.trim()) return;
		if (await post({ action: "share", email }, "Could not share")) {
			setEmail("");
		}
	};

	return (
		<Modal isOpen onClose={onClose} title={`Share ${title}`} width="480px">
			<div className={styles.form}>
				<label className={styles.field}>
					<span className={styles.label}>Add someone</span>
					<div className={styles.actions}>
						<input
							className={styles.input}
							value={email}
							placeholder="person@example.com"
							onChange={(e) => setEmail(e.target.value)}
							onKeyDown={(e) => {
								if (e.key !== "Enter") return;
								e.preventDefault();
								void share();
							}}
							autoFocus
						/>
						<button
							type="button"
							className={styles.primary}
							disabled={busy || !email.trim()}
							onClick={() => void share()}
						>
							Share
						</button>
					</div>
				</label>

				{failure && <div className={styles.failure}>{failure}</div>}

				<div className={styles.field}>
					<span className={styles.label}>Shared with</span>
					{shares && shares.length === 0 && (
						<p className={styles.hint}>Nobody yet.</p>
					)}
					{shares?.map((share) => (
						<div key={share.email} className={styles.shareRow}>
							<span>{share.email}</span>
							<button
								type="button"
								className={styles.secondary}
								disabled={busy}
								onClick={() =>
									void post(
										{
											action: "unshare",
											email: share.email,
										},
										"Could not remove",
									)
								}
							>
								Remove
							</button>
						</div>
					))}
				</div>

				<div className={styles.actions}>
					<button
						type="button"
						className={styles.secondary}
						onClick={onClose}
					>
						Done
					</button>
				</div>
			</div>
		</Modal>
	);
}

function PublishDialog({
	reportId,
	title,
	direct,
	onClose,
}: {
	reportId: string;
	title: string;
	// Publishes straight away. Otherwise it asks a Report Publisher to.
	direct: boolean;
	onClose: () => void;
}) {
	const router = useRouter();
	const [note, setNote] = useState("");
	const { data } = useSWR<{ categories: { id: string; name: string }[] }>(
		direct ? "/api/authoring" : "/api/requests",
	);
	const [categoryId, setCategoryId] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const categories = data?.categories ?? [];

	const publish = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/personal", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: direct ? "publish" : "askToPublish",
					reportId,
					categoryId,
					note,
				}),
			});
			const detail = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(detail?.error ?? "Could not publish that page.");
				return;
			}
			onClose();
			// Same address, different standing. Refreshed rather than navigated,
			// because the page the author is looking at is the page that just
			// changed.
			router.refresh();
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not publish that page.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={direct ? `Publish ${title}` : `Ask to publish ${title}`}
			width="480px"
		>
			<div className={styles.form}>
				<label className={styles.field}>
					<span className={styles.label}>Category</span>
					<Select
						value={categoryId}
						onChange={setCategoryId}
						placeholder="Choose one"
						options={categories.map((c) => ({
							value: c.id,
							label: c.name,
						}))}
					/>
				</label>

				{!direct && (
					<label className={styles.field}>
						<span className={styles.label}>
							Why it should be official
						</span>
						<input
							className={styles.input}
							value={note}
							onChange={(e) => setNote(e.target.value)}
						/>
						<span className={styles.hint}>
							A Report Publisher decides. It stays your page until
							they do, and they can open it to look.
						</span>
					</label>
				)}

				{failure && <div className={styles.failure}>{failure}</div>}

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
						disabled={busy || !categoryId}
						onClick={publish}
					>
						{direct
							? busy
								? "Publishing"
								: "Publish"
							: busy
								? "Sending"
								: "Ask"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
