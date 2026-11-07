"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Select } from "../components/shared/Select";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Hint, Section, SectionGroup } from "./PanelSection";
import styles from "./Editor.module.css";

// Who looks after this report and who can edit it, decided from the report by whoever is
// responsible for it rather than through administration. Tags and taking a report back read
// the same answer and sit in the Report panel.

interface Holder {
	assignmentId: string;
	roleName: string;
	subjectType: string;
	subjectId: string;
	expiresOn: string | null;
	isMaintainer: boolean;
}

interface ReportAccess {
	categoryId: string | null;
	tags: string[];
	reportPolicy: string | null;
	categoryPolicy: string | null;
	platformPolicy: string;
	effective: string;
	holders: Holder[];
	categoryHolders: Holder[];
	pages: { pageId: string; title: string }[];
	pageHolders: (Holder & { pageTitle: string })[];
	canDelegate: boolean;
	canSetCategoryPolicy: boolean;
	canTakeBack: boolean;
	assignableRoles: {
		roleId: string;
		name: string;
		description: string | null;
	}[];
}

const policyWords: Record<string, string> = {
	maintainers: "Maintainers only",
	any: "Any Editor",
};

function useReportAccess(slug: string) {
	const address = `/api/report/${encodeURIComponent(slug)}/access`;
	const { data, mutate } = useSWR<ReportAccess>(address);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const act = async (body: Record<string, unknown>): Promise<boolean> => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch(address, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const detail = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(detail?.error ?? "That did not work.");
				return false;
			}
			await mutate(detail, { revalidate: false });
			return true;
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
			return false;
		} finally {
			setBusy(false);
		}
	};
	return { data, busy, failure, act };
}

function HolderRow({
	holder,
	place,
	canRemove,
	busy,
	onRemove,
}: {
	holder: Holder;
	place?: string;
	canRemove: boolean;
	busy: boolean;
	onRemove: () => void;
}) {
	return (
		<div className={styles.listRow}>
			<div className={styles.listRowLine}>
				<span className={styles.listRowWords}>
					<strong>{holder.subjectId}</strong>
					<span className={styles.panelAbout}>
						{holder.roleName}
						{place ? `, ${place}` : ""}
						{holder.expiresOn
							? `, until ${new Date(holder.expiresOn).toLocaleDateString()}`
							: ""}
					</span>
				</span>
				{canRemove && (
					<button
						type="button"
						className={styles.rowAction}
						disabled={busy}
						onClick={onRemove}
					>
						Remove
					</button>
				)}
			</div>
		</div>
	);
}

export function ReportAccessPanel({
	slug,
	reportTitle,
	onClose,
}: {
	slug: string;
	reportTitle: string;
	onClose: () => void;
}) {
	const { data, busy, failure, act } = useReportAccess(slug);
	const [subjectId, setSubjectId] = useState("");
	const [holderPage, setHolderPage] = useState("");
	const [subjectType, setSubjectType] = useState("user");
	const [roleId, setRoleId] = useState("maintainer");

	const inherited = data
		? policyWords[data.categoryPolicy ?? data.platformPolicy]
		: "";
	const removeHolder = (holder: Holder) =>
		void act({ action: "remove", assignmentId: holder.assignmentId });
	const nobody =
		data &&
		data.holders.length === 0 &&
		data.pageHolders.length === 0 &&
		data.categoryHolders.length === 0;

	return (
		<div className={styles.panel}>
			<div className={styles.panelHead}>
				<span className={styles.panelKind}>Access</span>
				<span className={styles.panelSubject}>{reportTitle}</span>
				<button
					type="button"
					className={styles.panelBack}
					onClick={onClose}
					aria-label="Close"
				>
					×
				</button>
			</div>
			<div className={styles.panelBody}>
				{data && (
					<SectionGroup compactHints>
						<Section id="access-editing" title="Who can edit">
							<p
								className={`${styles.panelAbout} ${styles.panelLead}`}
							>
								{data.effective}
							</p>
							{data.canDelegate && (
								<div className={styles.field}>
									<label className={styles.fieldLabel}>
										This report
									</label>
									<Select
										value={data.reportPolicy ?? ""}
										disabled={busy}
										onChange={(value) =>
											void act({
												action: "setPolicy",
												value: value || null,
											})
										}
										options={[
											{
												value: "",
												label: `Same as above it (${inherited})`,
											},
											{
												value: "maintainers",
												label: policyWords.maintainers,
											},
											{
												value: "any",
												label: policyWords.any,
											},
										]}
									/>
								</div>
							)}
							{data.canSetCategoryPolicy && (
								<div className={styles.field}>
									<label className={styles.fieldLabel}>
										Everything in this category
									</label>
									<Select
										value={data.categoryPolicy ?? ""}
										disabled={busy}
										onChange={(value) =>
											void act({
												action: "setPolicy",
												level: "category",
												value: value || null,
											})
										}
										options={[
											{
												value: "",
												label: `Same as the platform (${policyWords[data.platformPolicy]})`,
											},
											{
												value: "maintainers",
												label: policyWords.maintainers,
											},
											{
												value: "any",
												label: policyWords.any,
											},
										]}
									/>
								</div>
							)}
						</Section>

						<Section
							id="access-people"
							title="People"
							count={data.holders.length}
						>
							<div className={styles.deckSections}>
								{data.canDelegate &&
									data.assignableRoles.length > 0 && (
										<div className={styles.field}>
											<label
												className={styles.fieldLabel}
											>
												Add someone
											</label>
											<div className={styles.panelForm}>
												<Select
													value={subjectType}
													disabled={busy}
													onChange={setSubjectType}
													options={[
														{
															value: "user",
															label: "A person",
														},
														{
															value: "group",
															label: "A group",
														},
													]}
												/>
												<input
													type="text"
													className={styles.input}
													value={subjectId}
													disabled={busy}
													placeholder={
														subjectType === "user"
															? "person@example.com"
															: "Exact group name"
													}
													onChange={(e) =>
														setSubjectId(
															e.target.value,
														)
													}
												/>
												<Select
													value={roleId}
													disabled={busy}
													onChange={setRoleId}
													options={data.assignableRoles.map(
														(role) => ({
															value: role.roleId,
															label: role.name,
														}),
													)}
												/>
												<Select
													value={holderPage}
													disabled={busy}
													onChange={setHolderPage}
													ariaLabel="Where this applies"
													options={[
														{
															value: "",
															label: "The whole report",
														},
														...data.pages.map(
															(page) => ({
																value: page.pageId,
																label: `Only the page ${page.title}`,
															}),
														),
													]}
												/>
												<button
													type="button"
													className={styles.panelAdd}
													disabled={
														busy ||
														!subjectId.trim() ||
														!roleId
													}
													onClick={async () => {
														const ok = await act({
															action: "add",
															roleId,
															subjectType,
															subjectId,
															...(holderPage
																? {
																		level: "page",
																		pageId: holderPage,
																	}
																: {}),
														});
														if (ok)
															setSubjectId("");
													}}
												>
													Add
												</button>
											</div>
											<Hint>
												You can only give out what you
												hold yourself.
											</Hint>
										</div>
									)}
								<div className={styles.panelForm}>
									{data.holders.map((holder) => (
										<HolderRow
											key={holder.assignmentId}
											holder={holder}
											canRemove={data.canDelegate}
											busy={busy}
											onRemove={() =>
												removeHolder(holder)
											}
										/>
									))}
									{data.pageHolders.map((holder) => (
										<HolderRow
											key={holder.assignmentId}
											holder={holder}
											place={`on ${holder.pageTitle}`}
											canRemove={data.canDelegate}
											busy={busy}
											onRemove={() =>
												removeHolder(holder)
											}
										/>
									))}
									{data.categoryHolders.map((holder) => (
										<HolderRow
											key={holder.assignmentId}
											holder={holder}
											place="from its category"
											canRemove={
												data.canSetCategoryPolicy
											}
											busy={busy}
											onRemove={() =>
												removeHolder(holder)
											}
										/>
									))}
									{nobody && (
										<p className={styles.panelEmpty}>
											Nobody yet, so administrators answer
											for it.
										</p>
									)}
								</div>
							</div>
						</Section>
						{failure && (
							<div className={styles.panelError}>{failure}</div>
						)}
					</SectionGroup>
				)}
			</div>
		</div>
	);
}

// In the Report panel's Details.
export function ReportTagsField({ slug }: { slug: string }) {
	const { data, busy, failure, act } = useReportAccess(slug);
	const [draft, setDraft] = useState("");
	if (!data) return null;
	return (
		<div className={styles.field}>
			<label className={styles.fieldLabel}>Tags</label>
			{data.tags.length > 0 && (
				<div className={styles.tagList}>
					{data.tags.map((tag) => (
						<span key={tag} className={styles.tagChip}>
							{tag}
							{data.canDelegate && (
								<button
									type="button"
									disabled={busy}
									aria-label={`Remove the tag ${tag}`}
									onClick={() =>
										void act({
											action: "setTags",
											tags: data.tags.filter(
												(held) => held !== tag,
											),
										})
									}
								>
									×
								</button>
							)}
						</span>
					))}
				</div>
			)}
			{data.canDelegate && (
				<input
					type="text"
					className={styles.input}
					value={draft}
					disabled={busy}
					placeholder="Add a tag, then press Enter"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={async (e) => {
						if (e.key !== "Enter" || !draft.trim()) return;
						const ok = await act({
							action: "setTags",
							tags: [...data.tags, draft],
						});
						if (ok) setDraft("");
					}}
				/>
			)}
			<Hint>
				Rights can be given on a tag, which reaches every report
				carrying it.
			</Hint>
			{failure && <div className={styles.panelError}>{failure}</div>}
		</div>
	);
}

// In the Report panel, beside deleting it.
export function TakeBackBlock({ slug }: { slug: string }) {
	const router = useRouter();
	const { data, busy, failure, act } = useReportAccess(slug);
	const [confirming, setConfirming] = useState(false);
	if (!data?.canTakeBack) return null;
	return (
		<div className={styles.panelDanger}>
			<span className={styles.fieldLabel}>Take back to a draft</span>
			<p className={styles.panelAbout}>
				It stops being official and goes back to the person who built
				it. Publishing it again returns it.
			</p>
			<button
				type="button"
				className={styles.panelAdd}
				disabled={busy}
				onClick={() => setConfirming(true)}
			>
				Take back to a draft
			</button>
			{failure && <div className={styles.panelError}>{failure}</div>}
			{confirming && (
				<ConfirmDialog
					title="Take this report back"
					body="It stops being official and goes back to the person who built it. Publishing it again returns it."
					confirmLabel="Take it back"
					busy={busy}
					onConfirm={async () => {
						const ok = await act({ action: "takeBack" });
						setConfirming(false);
						if (ok) router.refresh();
					}}
					onCancel={() => setConfirming(false)}
				/>
			)}
		</div>
	);
}
