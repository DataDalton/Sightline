"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import useSWR from "swr";
import Link from "../../components/AppLink";
import { TabStrip } from "../../components/shared/TabStrip";
import { useUser } from "../../context/UserContext";
import { maxGuideLength, parseGuide } from "../../../lib/guide/markdown";
import { guideFileProblem, guideFileType } from "../../../lib/guide/fileRules";
import type { GuideView } from "../../../lib/guide/store";
import { diffLines } from "../../../lib/guide/diff";
import { GuideMarkdown } from "./GuideMarkdown";
import { GuideReader } from "./GuideReader";
import styles from "./Guide.module.css";

// A report's guide, beside the report rather than over it, so a reader can
// read about a chart while looking at it.
//
// Three views: the guide its maintainers wrote with the files attached to it,
// the meaning of every field the report uses, and where its data comes from
// with who looks after it and what changed lately. The last two are worked
// out from the report each time, so they are right even when nobody wrote a
// word.

type TabId = "guide" | "terms" | "data";

const anchorPrefix = "guide-";

// How often the saved guide is read again while somebody edits it.
const editCheckMs = 20_000;

function day(value: string | null | undefined): string {
	if (!value) return "";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
			});
}

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKind(contentType: string): string {
	if (contentType.startsWith("image/")) return "Image";
	if (contentType === "application/pdf") return "PDF";
	if (contentType === "text/markdown") return "Markdown";
	if (contentType === "text/csv") return "CSV";
	if (contentType.startsWith("text/")) return "Text";
	if (contentType.includes("spreadsheet") || contentType.includes("excel"))
		return "Spreadsheet";
	if (contentType.includes("presentation")) return "Slides";
	if (contentType.includes("wordprocessing")) return "Document";
	return "File";
}

function Icon({ path, size = 14 }: { path: string; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}

const icons = {
	close: "M18 6L6 18M6 6l12 12",
	file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
	upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
	remove: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
	link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
	check: "M20 6L9 17l-5-5",
	spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
	edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
	widen: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
	narrow: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
	top: "M18 15l-6-6-6 6",
};

export function GuidePanel({
	slug,
	reportTitle,
	open,
	initialSection,
	onClose,
	onSaved,
}: {
	slug: string;
	reportTitle: string;
	open: boolean;
	// A section named in the address, opened and scrolled to.
	initialSection: string | null;
	onClose: () => void;
	// The report changed underneath, so its definition should be read again.
	onSaved: () => void;
}) {
	const base = `/api/report/${encodeURIComponent(slug)}/guide`;
	const [editing, setEditing] = useState(false);
	// While somebody edits, the saved guide is read again now and then and
	// whenever they come back to the tab, so a change saved meanwhile by
	// somebody else or by the assistant is noticed before they save over it.
	const { data, error, isLoading, mutate } = useSWR<GuideView>(
		open ? base : null,
		{ refreshInterval: editing ? editCheckMs : 0, revalidateOnFocus: true },
	);
	const { user } = useUser();
	const [tab, setTab] = useState<TabId>("guide");
	const [text, setText] = useState("");
	// The saved text the edit began from, and so the text a save replaces.
	const [startedFrom, setStartedFrom] = useState("");
	// Showing what changed underneath: what the other person changed, or this
	// person's text against theirs.
	const [comparing, setComparing] = useState<"theirs" | "mine" | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [termFilter, setTermFilter] = useState("");
	// A wider panel for long reading, with the sections down the left. Kept in
	// this reader's browser.
	const [wide, setWide] = useState(() => {
		try {
			return window.localStorage.getItem("guide.wide") === "1";
		} catch {
			return false;
		}
	});
	// Offered once the reader has scrolled a screen or more.
	const [farDown, setFarDown] = useState(false);
	// Files dragged over the panel. Counted, because entering a child of the
	// panel fires a leave on the panel itself before the enter on the child.
	const [dropping, setDropping] = useState(false);
	const dragDepth = useRef(0);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const headingRef = useRef<HTMLHeadingElement | null>(null);
	const panelRef = useRef<HTMLElement | null>(null);
	const textRef = useRef<HTMLTextAreaElement | null>(null);
	const uploadRef = useRef<HTMLInputElement | null>(null);
	const importRef = useRef<HTMLInputElement | null>(null);

	const blocks = useMemo(
		() => parseGuide(editing ? text : (data?.guide ?? "")),
		[editing, text, data?.guide],
	);
	const canDraft = Boolean(user?.capabilities?.includes("assistant.use"));
	const changedText = editing && text !== startedFrom;
	const latest = data?.guide ?? "";
	const changedUnderneath =
		editing && Boolean(data) && latest !== startedFrom;
	const comparison = useMemo(
		() =>
			comparing === "theirs"
				? diffLines(startedFrom, latest)
				: comparing === "mine"
					? diffLines(latest, text)
					: [],
		[comparing, startedFrom, latest, text],
	);

	useEffect(() => {
		try {
			window.localStorage.setItem("guide.wide", wide ? "1" : "0");
		} catch {
			// A browser that keeps nothing opens narrow each time.
		}
	}, [wide]);

	useEffect(() => {
		const root = bodyRef.current;
		if (!open || !root) return;
		const watch = () => setFarDown(root.scrollTop > root.clientHeight);
		watch();
		root.addEventListener("scroll", watch, { passive: true });
		return () => root.removeEventListener("scroll", watch);
	}, [open, data]);

	// The heading takes focus on opening, so a keyboard or screen reader lands
	// in the panel rather than behind it.
	useEffect(() => {
		if (open) headingRef.current?.focus();
	}, [open]);

	// A click anywhere outside closes it, as other panels do, unless it would
	// throw away unsaved writing. The Guide button is left to toggle it.
	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (!target || panelRef.current?.contains(target)) return;
			if (target.closest("[data-guide-toggle]")) return;
			if (changedText) return;
			onClose();
		};
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, [open, changedText, onClose]);

	// Escape closes, unless it would throw away unsaved writing.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || changedText) return;
			if (editing) setEditing(false);
			else onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, editing, changedText, onClose]);

	if (!open) return null;

	const fileHref = (name: string) => {
		const file = data?.files.find(
			(f) => f.fileName.toLowerCase() === name.toLowerCase(),
		);
		return file ? `${base}/files/${file.hash}` : null;
	};
	const onAnchor = (id: string) => {
		setTab("guide");
		const target = bodyRef.current?.querySelector(
			`#${CSS.escape(anchorPrefix + id)}`,
		);
		target?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	const post = async (body: Record<string, unknown>) => {
		const response = await fetch(base, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const detail = (await response.json().catch(() => null)) as {
			error?: string;
		} | null;
		if (!response.ok) {
			throw new Error(detail?.error ?? "That did not work.");
		}
	};

	const run = async (label: string, work: () => Promise<void>) => {
		setBusy(label);
		setProblem(null);
		try {
			await work();
		} catch (failure) {
			setProblem(
				failure instanceof Error
					? failure.message
					: "That did not work.",
			);
		} finally {
			setBusy(null);
		}
	};

	const startEditing = () => {
		setText(data?.guide ?? "");
		setStartedFrom(data?.guide ?? "");
		setComparing(null);
		setPreviewing(false);
		setEditing(true);
		setTab("guide");
	};

	const save = () =>
		run("Saving", async () => {
			const response = await fetch(base, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "save",
					guide: text,
					startedFrom,
				}),
			});
			if (response.status === 409) {
				// Changed since the edit began. Their text is read so the notice
				// above the editor can say who and offer the choices, and this
				// person's text stays as it is.
				await mutate();
				return;
			}
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(
					detail?.error ?? "The guide could not be saved.",
				);
			}
			setEditing(false);
			setComparing(null);
			await mutate();
			onSaved();
		});

	// Takes the latest saved guide and drops this person's edit.
	const takeTheirs = () => {
		setText(latest);
		setStartedFrom(latest);
		setComparing(null);
	};

	// Keeps this person's text, so saving replaces what was changed meanwhile.
	const keepMine = () => {
		setStartedFrom(latest);
		setComparing(null);
	};

	const changedBy =
		data?.editedBy === "Assistant"
			? "The assistant"
			: (data?.editedBy ?? "Somebody");
	const changedAt = data?.editedOn
		? new Date(data.editedOn).toLocaleTimeString("en-US", {
				hour: "numeric",
				minute: "2-digit",
			})
		: null;

	const draft = () =>
		run("Writing the guide", async () => {
			await post({ action: "draft" });
			await mutate();
			onSaved();
		});

	const markReviewed = () =>
		run("Saving", async () => {
			await post({ action: "reviewed" });
			await mutate();
		});

	const upload = (files: FileList | null) =>
		run("Attaching", async () => {
			for (const file of Array.from(files ?? [])) {
				const type = guideFileType(file.name, file.type);
				const refused = guideFileProblem({
					size: file.size,
					type,
					name: file.name,
				});
				if (refused) throw new Error(`${file.name}: ${refused}`);
				const response = await fetch(`${base}/files`, {
					method: "POST",
					headers: {
						"Content-Type": type,
						"X-File-Name": encodeURIComponent(file.name),
					},
					body: file,
				});
				if (!response.ok) {
					const detail = (await response
						.json()
						.catch(() => null)) as {
						error?: string;
					} | null;
					throw new Error(
						`${file.name}: ${detail?.error ?? "it could not be attached."}`,
					);
				}
			}
			await mutate();
		});

	// Only files, only for someone who can attach them, and not while busy.
	const acceptsDrop = (event: DragEvent) =>
		Boolean(data?.canEdit) &&
		busy === null &&
		Array.from(event.dataTransfer.types).includes("Files");

	const removeFile = (fileId: string) =>
		run("Removing", async () => {
			await post({ action: "removeFile", fileId });
			await mutate();
		});

	// Markdown from a file replaces what is in the editor. Cancel brings the
	// saved guide back.
	const importMarkdown = async (files: FileList | null) => {
		const file = files?.[0];
		if (!file) return;
		const content = await file.text();
		setText(content.slice(0, maxGuideLength));
		setPreviewing(false);
	};

	// A link to an attached file, put where the cursor is.
	const insertFileLink = (name: string) => {
		const area = textRef.current;
		const link = `[${name}](file:${name})`;
		if (!area) {
			setText((current) => `${current}${current ? "\n" : ""}${link}`);
			return;
		}
		const start = area.selectionStart ?? text.length;
		const end = area.selectionEnd ?? text.length;
		const next = `${text.slice(0, start)}${link}${text.slice(end)}`;
		setText(next.slice(0, maxGuideLength));
		requestAnimationFrame(() => {
			area.focus();
			area.selectionStart = area.selectionEnd = start + link.length;
		});
	};

	const terms = (data?.definitions ?? []).filter((term) => {
		const q = termFilter.trim().toLowerCase();
		return (
			!q ||
			term.label.toLowerCase().includes(q) ||
			(term.description ?? "").toLowerCase().includes(q)
		);
	});
	const measures = terms.filter((term) => term.kind === "measure");
	const dimensions = terms.filter((term) => term.kind === "dimension");

	return (
		<aside
			ref={panelRef}
			className={`${styles.panel} ${wide ? styles.panelWide : ""}`}
			aria-labelledby="guide-panel-title"
			onDragEnter={(event) => {
				if (!acceptsDrop(event)) return;
				event.preventDefault();
				dragDepth.current += 1;
				setDropping(true);
			}}
			onDragOver={(event) => {
				if (!acceptsDrop(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(event) => {
				if (!acceptsDrop(event)) return;
				dragDepth.current = Math.max(0, dragDepth.current - 1);
				if (dragDepth.current === 0) setDropping(false);
			}}
			onDrop={(event) => {
				if (!acceptsDrop(event)) return;
				event.preventDefault();
				dragDepth.current = 0;
				setDropping(false);
				setTab("guide");
				void upload(event.dataTransfer.files);
			}}
		>
			{dropping && (
				<div className={styles.dropCover} aria-hidden="true">
					<div className={styles.dropCard}>
						<span className={styles.dropIcon}>
							<Icon path={icons.upload} size={22} />
						</span>
						<span className={styles.dropTitle}>
							Drop to attach to the guide
						</span>
						<span className={styles.dropHint}>
							Images, PDFs, text, Markdown, CSV and Office files,
							up to 25 MB each. A file with the same name as one
							already attached replaces it.
						</span>
					</div>
				</div>
			)}
			<header className={styles.head}>
				<div className={styles.headText}>
					<span className={styles.eyebrow}>Guide</span>
					<h2
						id="guide-panel-title"
						ref={headingRef}
						tabIndex={-1}
						className={styles.title}
					>
						{reportTitle}
					</h2>
				</div>
				<div className={styles.headActions}>
					<button
						type="button"
						className={styles.iconButton}
						onClick={() => setWide((held) => !held)}
						aria-pressed={wide}
						aria-label={
							wide
								? "Narrow the guide"
								: "Widen the guide for reading"
						}
						title={
							wide
								? "Narrow the guide"
								: "Widen the guide for reading"
						}
					>
						<Icon
							path={wide ? icons.narrow : icons.widen}
							size={16}
						/>
					</button>
					{data?.canEdit && !editing && data.guide && (
						<button
							type="button"
							className={styles.secondary}
							onClick={startEditing}
						>
							<Icon path={icons.edit} />
							Edit
						</button>
					)}
					<button
						type="button"
						className={styles.iconButton}
						onClick={() => {
							if (changedText) return;
							onClose();
						}}
						disabled={changedText}
						title={
							changedText
								? "Save or cancel the edit first"
								: "Close"
						}
						aria-label="Close the guide"
					>
						<Icon path={icons.close} size={16} />
					</button>
				</div>
			</header>

			{!editing && (
				<div className={styles.tabs}>
					<TabStrip<TabId>
						label="Guide views"
						value={tab}
						onChange={setTab}
						tabs={[
							{ id: "guide", label: "Guide" },
							{
								id: "terms",
								label: "Terms",
								count: data?.definitions.length,
							},
							{ id: "data", label: "About the data" },
						]}
					/>
				</div>
			)}

			<div className={styles.body} ref={bodyRef}>
				{problem && (
					<div className={styles.problem} role="alert">
						{problem}
					</div>
				)}
				{isLoading && !data && (
					<p className={styles.muted}>Loading the guide</p>
				)}
				{error && !data && (
					<p className={styles.muted}>
						The guide could not be loaded.
					</p>
				)}

				{data && editing && (
					<div className={styles.editor}>
						{changedUnderneath && (
							<div className={styles.conflict} role="alert">
								<p className={styles.conflictText}>
									<strong>{changedBy}</strong> changed this
									guide{changedAt ? ` at ${changedAt}` : ""}{" "}
									while it was open here. Saving now would
									replace their change.
								</p>
								<div className={styles.conflictActions}>
									<button
										type="button"
										className={styles.secondary}
										aria-pressed={comparing !== null}
										onClick={() =>
											setComparing((current) =>
												current ? null : "theirs",
											)
										}
									>
										{comparing
											? "Hide changes"
											: "View changes"}
									</button>
									<button
										type="button"
										className={styles.secondary}
										onClick={takeTheirs}
									>
										Use theirs
									</button>
									<button
										type="button"
										className={styles.secondary}
										onClick={keepMine}
									>
										Keep mine
									</button>
								</div>
								{comparing && (
									<div className={styles.compare}>
										<div
											className={styles.segmented}
											role="group"
											aria-label="Which comparison"
										>
											<button
												type="button"
												aria-pressed={
													comparing === "theirs"
												}
												className={
													comparing === "theirs"
														? styles.segmentOn
														: styles.segment
												}
												onClick={() =>
													setComparing("theirs")
												}
											>
												What they changed
											</button>
											<button
												type="button"
												aria-pressed={
													comparing === "mine"
												}
												className={
													comparing === "mine"
														? styles.segmentOn
														: styles.segment
												}
												onClick={() =>
													setComparing("mine")
												}
											>
												Mine against theirs
											</button>
										</div>
										<ol className={styles.diff}>
											{comparison.every(
												(line) => line.kind === "same",
											) ? (
												<li className={styles.diffNone}>
													No difference.
												</li>
											) : (
												comparison.map((line, n) => (
													<li
														key={n}
														className={
															line.kind ===
															"added"
																? styles.diffAdded
																: line.kind ===
																	  "removed"
																	? styles.diffRemoved
																	: styles.diffSame
														}
													>
														<span
															className={
																styles.diffMark
															}
															aria-label={
																line.kind ===
																"added"
																	? "Added"
																	: line.kind ===
																		  "removed"
																		? "Removed"
																		: undefined
															}
														>
															{line.kind ===
															"added"
																? "+"
																: line.kind ===
																	  "removed"
																	? "−"
																	: ""}
														</span>
														{line.text}
													</li>
												))
											)}
										</ol>
									</div>
								)}
							</div>
						)}
						<div className={styles.editorBar}>
							<div
								className={styles.segmented}
								role="group"
								aria-label="Editor view"
							>
								<button
									type="button"
									aria-pressed={!previewing}
									className={
										!previewing
											? styles.segmentOn
											: styles.segment
									}
									onClick={() => setPreviewing(false)}
								>
									Write
								</button>
								<button
									type="button"
									aria-pressed={previewing}
									className={
										previewing
											? styles.segmentOn
											: styles.segment
									}
									onClick={() => setPreviewing(true)}
								>
									Preview
								</button>
							</div>
							<button
								type="button"
								className={styles.secondary}
								onClick={() => importRef.current?.click()}
							>
								<Icon path={icons.upload} />
								Import Markdown
							</button>
							<input
								ref={importRef}
								type="file"
								accept=".md,.markdown,.txt,text/markdown,text/plain"
								hidden
								onChange={(event) => {
									void importMarkdown(event.target.files);
									event.target.value = "";
								}}
							/>
						</div>
						{previewing ? (
							<div className={styles.preview}>
								{blocks.length > 0 ? (
									<GuideMarkdown
										blocks={blocks}
										idPrefix={anchorPrefix}
										fileHref={fileHref}
										onAnchor={onAnchor}
									/>
								) : (
									<p className={styles.muted}>
										Nothing written yet.
									</p>
								)}
							</div>
						) : (
							<textarea
								ref={textRef}
								className={styles.textarea}
								value={text}
								maxLength={maxGuideLength}
								onChange={(event) =>
									setText(event.target.value)
								}
								aria-label="Guide text in Markdown"
								placeholder={
									"## What this report is for\n\n## Which figure to quote\n\n## How to read it\n\n## Things to know"
								}
								spellCheck
							/>
						)}
						<p className={styles.hint}>
							Markdown. # for a heading, **bold**, - for a list,
							[words](https://...) for a link, [words](#heading)
							for a section of this guide, and
							[words](file:Name.pdf) for an attached file.{" "}
							{text.length.toLocaleString()} of{" "}
							{maxGuideLength.toLocaleString()} characters.
						</p>
						{data.files.length > 0 && (
							<div className={styles.insertFiles}>
								<span className={styles.hint}>
									Link a file:
								</span>
								{data.files.map((file) => (
									<button
										key={file.fileId}
										type="button"
										className={styles.chip}
										onClick={() =>
											insertFileLink(file.fileName)
										}
									>
										<Icon path={icons.link} size={12} />
										{file.fileName}
									</button>
								))}
							</div>
						)}
						<div className={styles.editorActions}>
							<button
								type="button"
								className={styles.secondary}
								onClick={() => {
									setEditing(false);
									setProblem(null);
								}}
								disabled={busy !== null}
							>
								Cancel
							</button>
							<button
								type="button"
								className={styles.primary}
								onClick={() => void save()}
								disabled={busy !== null || !changedText}
							>
								{busy === "Saving" ? "Saving" : "Save"}
							</button>
						</div>
					</div>
				)}

				{data && !editing && tab === "guide" && (
					<>
						{data.changedSince.length > 0 && (
							<div className={styles.stale} role="status">
								<p>
									Since this guide was last reviewed
									{data.reviewedOn
										? ` on ${day(data.reviewedOn)}`
										: ""}
									,{" "}
									{data.changedSince
										.map(
											(change) =>
												`${change.field} was ${change.what}`,
										)
										.join(", ")}
									. Passages about{" "}
									{data.changedSince.length === 1
										? "it"
										: "them"}{" "}
									may be out of date.
								</p>
								{data.canEdit && (
									<button
										type="button"
										className={styles.secondary}
										onClick={() => void markReviewed()}
										disabled={busy !== null}
									>
										<Icon path={icons.check} />
										Mark reviewed
									</button>
								)}
							</div>
						)}

						{data.guide ? (
							<>
								{(data.reviewedOn || data.canEdit) && (
									<div className={styles.reviewed}>
										<span>
											{data.reviewedOn
												? `Last reviewed ${day(data.reviewedOn)}${data.reviewedBy ? ` by ${data.reviewedBy}` : ""}`
												: "Not reviewed yet"}
										</span>
										{data.canEdit &&
											data.changedSince.length === 0 && (
												<button
													type="button"
													className={
														styles.textButton
													}
													onClick={() =>
														void markReviewed()
													}
													disabled={busy !== null}
												>
													Mark reviewed
												</button>
											)}
									</div>
								)}
								<GuideReader
									blocks={blocks}
									slug={slug}
									scrollRoot={bodyRef}
									wide={wide}
									initialSection={initialSection}
									fileHref={fileHref}
								/>
							</>
						) : (
							<div className={styles.empty}>
								<p className={styles.emptyTitle}>
									No guide yet
								</p>
								<p className={styles.muted}>
									{data.canEdit
										? "Say what this report is for, which figure to quote and how to read it. Terms and About the data are filled in from the report already."
										: "Its maintainers have not written one. Terms and About the data still say what the report uses and where its data comes from."}
								</p>
								{data.canEdit && (
									<div className={styles.emptyActions}>
										<button
											type="button"
											className={styles.primary}
											onClick={startEditing}
										>
											<Icon path={icons.edit} />
											Write the guide
										</button>
										{canDraft && (
											<button
												type="button"
												className={styles.secondary}
												onClick={() => void draft()}
												disabled={busy !== null}
											>
												<Icon path={icons.spark} />
												{busy === "Writing the guide"
													? "Writing the guide"
													: "Draft it with the assistant"}
											</button>
										)}
									</div>
								)}
							</div>
						)}

						{(data.files.length > 0 || data.canEdit) && (
							<section
								className={styles.files}
								aria-label="Files"
							>
								<div className={styles.sectionHead}>
									<h3 className={styles.sectionTitle}>
										Files
									</h3>
									{data.files.length > 0 && (
										<span className={styles.fileCount}>
											{data.files.length}
										</span>
									)}
								</div>
								{data.canEdit && (
									<input
										ref={uploadRef}
										type="file"
										multiple
										hidden
										onChange={(event) => {
											void upload(event.target.files);
											event.target.value = "";
										}}
									/>
								)}
								{data.files.length === 0 ? (
									data.canEdit ? (
										<button
											type="button"
											className={styles.dropZone}
											onClick={() =>
												uploadRef.current?.click()
											}
											disabled={busy !== null}
										>
											<span
												className={styles.dropZoneIcon}
											>
												<Icon
													path={icons.upload}
													size={18}
												/>
											</span>
											<span
												className={styles.dropZoneTitle}
											>
												{busy === "Attaching"
													? "Attaching"
													: "Drop files here or choose them"}
											</span>
											<span
												className={styles.dropZoneHint}
											>
												Slides, a model, a validation
												write-up or anything else
												readers should have. Images,
												PDFs, text, Markdown, CSV and
												Office files, up to 25 MB each.
											</span>
										</button>
									) : null
								) : (
									<ul className={styles.fileList}>
										{data.files.map((file) => (
											<li
												key={file.fileId}
												className={styles.fileRow}
											>
												<span
													className={styles.fileIcon}
												>
													<Icon
														path={icons.file}
														size={16}
													/>
												</span>
												<a
													href={`${base}/files/${file.hash}`}
													target="_blank"
													rel="noopener noreferrer"
													className={styles.fileName}
												>
													{file.fileName}
												</a>
												<span
													className={styles.fileMeta}
												>
													{fileKind(file.contentType)}
													, {size(file.size)},{" "}
													{day(file.uploadedOn)}
												</span>
												{data.canEdit && (
													<button
														type="button"
														className={
															styles.iconButton
														}
														onClick={() =>
															void removeFile(
																file.fileId,
															)
														}
														disabled={busy !== null}
														aria-label={`Remove ${file.fileName}`}
														title="Remove"
													>
														<Icon
															path={icons.remove}
														/>
													</button>
												)}
											</li>
										))}
									</ul>
								)}
								{data.files.length > 0 && data.canEdit && (
									<button
										type="button"
										className={`${styles.dropZone} ${styles.dropZoneSlim}`}
										onClick={() =>
											uploadRef.current?.click()
										}
										disabled={busy !== null}
									>
										<Icon path={icons.upload} size={14} />
										<span className={styles.dropZoneTitle}>
											{busy === "Attaching"
												? "Attaching"
												: "Drop more files or choose them"}
										</span>
									</button>
								)}
							</section>
						)}
					</>
				)}

				{data && !editing && tab === "terms" && (
					<>
						<input
							type="search"
							className={styles.search}
							placeholder="Find a term"
							value={termFilter}
							onChange={(event) =>
								setTermFilter(event.target.value)
							}
							aria-label="Find a term"
						/>
						{terms.length === 0 && (
							<p className={styles.muted}>No term matches.</p>
						)}
						{[
							{ label: "Figures", items: measures },
							{
								label: "Ways to break them down",
								items: dimensions,
							},
						]
							.filter((group) => group.items.length > 0)
							.map((group) => (
								<section
									key={group.label}
									className={styles.termGroup}
								>
									<h3 className={styles.sectionTitle}>
										{group.label}
									</h3>
									<dl className={styles.terms}>
										{group.items.map((term) => (
											<div
												key={`${term.sourceKey}:${term.name}`}
												className={styles.term}
											>
												<dt>{term.label}</dt>
												<dd>
													{term.description ??
														"No definition has been written."}
												</dd>
											</div>
										))}
									</dl>
								</section>
							))}
					</>
				)}

				{data && !editing && tab === "data" && (
					<>
						<section className={styles.termGroup}>
							<h3 className={styles.sectionTitle}>
								Where the data comes from
							</h3>
							{data.sources.map((source) => (
								<div
									key={source.sourceKey}
									className={styles.source}
								>
									<Link
										href={`/dictionary?source=${encodeURIComponent(source.sourceKey)}`}
										className={styles.link}
									>
										{source.title}
									</Link>
									{source.description && (
										<p className={styles.paragraph}>
											{source.description}
										</p>
									)}
									{source.dataChangedOn && (
										<p className={styles.muted}>
											Data last changed{" "}
											{day(source.dataChangedOn)}
										</p>
									)}
								</div>
							))}
						</section>
						<section className={styles.termGroup}>
							<h3 className={styles.sectionTitle}>
								Who looks after it
							</h3>
							{data.maintainers.length === 0 ? (
								<p className={styles.muted}>Nobody is named.</p>
							) : (
								<ul className={styles.plainList}>
									{data.maintainers.map((person) => (
										<li
											key={`${person.kind}:${person.name}`}
										>
											{person.name}
											{person.kind === "group" && (
												<span className={styles.muted}>
													{" "}
													(group)
												</span>
											)}
										</li>
									))}
								</ul>
							)}
						</section>
						<section className={styles.termGroup}>
							<h3 className={styles.sectionTitle}>
								Recent changes to its data
							</h3>
							{data.changes.length === 0 ? (
								<p className={styles.muted}>
									No updates about its data in the last three
									months.
								</p>
							) : (
								<ul className={styles.plainList}>
									{data.changes.map((change) => (
										<li key={change.updateId}>
											<Link
												href={`/status?tab=updates&open=${encodeURIComponent(change.updateId)}`}
												className={styles.link}
											>
												{change.title}
											</Link>
											<span className={styles.muted}>
												{" "}
												{day(change.postedOn)}
											</span>
										</li>
									))}
								</ul>
							)}
						</section>
					</>
				)}
			</div>
			{farDown && (
				<button
					type="button"
					className={styles.backToTop}
					onClick={() =>
						bodyRef.current?.scrollTo({
							top: 0,
							behavior: "smooth",
						})
					}
					aria-label="Back to the top"
					title="Back to the top"
				>
					<Icon path={icons.top} size={16} />
				</button>
			)}
		</aside>
	);
}
