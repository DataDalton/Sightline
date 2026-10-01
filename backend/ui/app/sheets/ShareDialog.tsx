"use client";

import { useState } from "react";
import useSWR from "swr";
import type { Share } from "../../lib/sheets/store";
import { Modal } from "../components/shared/Modal";
import styles from "./Sheets.module.css";

// Sharing a sheet with named people. Each of them sees their own rows of the
// data, as with a report, and the notes on those rows. Boards share the same
// way through their own address, with their own words.

export function ShareDialog({
	sheetId,
	isOwner,
	onClose,
	sharesUrl,
	title = "Share this sheet",
	hint = "Each person sees the rows their own access allows, and the notes on those rows. They are told in their inbox.",
}: {
	sheetId: string;
	isOwner: boolean;
	onClose: () => void;
	// Where the shares are read and changed, when it is not a sheet's.
	sharesUrl?: string;
	title?: string;
	hint?: string;
}) {
	const key = sharesUrl ?? `/api/sheets/${sheetId}/shares`;
	const { data, mutate } = useSWR<{ shares: Share[] }>(key);
	const [email, setEmail] = useState("");
	const [permission, setPermission] = useState<"view" | "edit">("view");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const send = async (method: "POST" | "DELETE", body: unknown) => {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(key, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const result = await response.json().catch(() => null);
			if (!response.ok) {
				setError(result?.error ?? "That did not work.");
				return false;
			}
			await mutate(result, false);
			return true;
		} catch {
			setError("That did not work. Check the connection and try again.");
			return false;
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal isOpen onClose={onClose} title={title} width="520px">
			<div className={styles.form}>
				<p className={styles.fieldHint}>{hint}</p>
				{isOwner && (
					<form
						className={styles.shareRow}
						onSubmit={async (e) => {
							e.preventDefault();
							if (await send("POST", { email, permission }))
								setEmail("");
						}}
					>
						<input
							className={styles.input}
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="name@example.com"
							aria-label="Email address"
							required
						/>
						<select
							className={styles.input}
							value={permission}
							onChange={(e) =>
								setPermission(e.target.value as "view" | "edit")
							}
							aria-label="What they can do"
						>
							<option value="view">Can view</option>
							<option value="edit">Can edit</option>
						</select>
						<button
							type="submit"
							className={styles.primary}
							disabled={busy || !email.trim()}
						>
							Share
						</button>
					</form>
				)}
				{error && <p className={styles.formError}>{error}</p>}
				<ul className={styles.shareList}>
					{(data?.shares ?? []).length === 0 && (
						<li className={styles.fieldHint}>
							Not shared with anybody yet.
						</li>
					)}
					{(data?.shares ?? []).map((s) => (
						<li key={s.email} className={styles.shareItem}>
							<span>
								{s.email}
								<span className={styles.shareRole}>
									{s.permission === "edit"
										? "Can edit"
										: "Can view"}
								</span>
							</span>
							{isOwner && (
								<button
									type="button"
									className={styles.linkButton}
									onClick={() =>
										void send("DELETE", { email: s.email })
									}
									disabled={busy}
								>
									Remove
								</button>
							)}
						</li>
					))}
				</ul>
			</div>
		</Modal>
	);
}
