"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sanitizeHtml } from "../../lib/visuals/sanitize";
import { paletteTokens } from "../../lib/visuals/style";
import { readThemeColors } from "./colors";
import styles from "./TextPanel.module.css";

// A text panel: a note, caveat or definition placed beside the numbers.
//
// Content is sanitised on the way in and again on the way out, because it is
// authored by one person and read by everyone else. See lib/visuals/sanitize.
//
// Editing uses contentEditable with execCommand. That API is deprecated and
// its replacement is not settled, but every browser still implements it and
// the alternative is shipping a document model and selection engine for what
// is a caption. The formatting produced is normalised by the sanitiser, so the
// inconsistencies between browsers do not reach storage.

interface TextPanelProps {
	html: string;
	editable?: boolean;
	onChange?: (html: string) => void;
	placeholder?: string;
}

const fontSizes = [
	{ label: "Small", value: "2" },
	{ label: "Normal", value: "3" },
	{ label: "Large", value: "5" },
	{ label: "Huge", value: "6" },
];

const blockFormats = [
	{ label: "Paragraph", value: "p" },
	{ label: "Heading 1", value: "h1" },
	{ label: "Heading 2", value: "h2" },
	{ label: "Heading 3", value: "h3" },
	{ label: "Quote", value: "blockquote" },
];

export function TextPanel({
	html,
	editable = false,
	onChange,
	placeholder,
}: TextPanelProps) {
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const [active, setActive] = useState<Record<string, boolean>>({});

	// The link popover, and the selection it applies to.
	//
	// Opening the popover moves focus into its input, which collapses the
	// selection in the text. So the range is kept and put back before the
	// command runs, otherwise the link would be applied to nothing.
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkUrl, setLinkUrl] = useState("");
	const savedRangeRef = useRef<Range | null>(null);
	const linkRef = useRef<HTMLDivElement | null>(null);

	// Sanitised for display. An editor sees the same content it will publish,
	// so nothing appears in the editor that would be stripped on save.
	const safe = useMemo(() => sanitizeHtml(html ?? ""), [html]);

	// The editable surface is uncontrolled: writing to innerHTML on every
	// keystroke would move the caret to the end of the document. It is seeded
	// once and only reset when the incoming value differs from what is there.
	useEffect(() => {
		const surface = surfaceRef.current;
		if (!surface || !editable) return;
		if (surface.innerHTML !== safe) surface.innerHTML = safe;
	}, [safe, editable]);

	const refreshActiveState = useCallback(() => {
		if (typeof document === "undefined") return;
		const query = (command: string) => {
			try {
				return document.queryCommandState(command);
			} catch {
				return false;
			}
		};
		setActive({
			bold: query("bold"),
			italic: query("italic"),
			underline: query("underline"),
			strikeThrough: query("strikeThrough"),
			insertUnorderedList: query("insertUnorderedList"),
			insertOrderedList: query("insertOrderedList"),
		});
	}, []);

	const emit = useCallback(() => {
		const surface = surfaceRef.current;
		if (!surface || !onChange) return;
		onChange(sanitizeHtml(surface.innerHTML));
	}, [onChange]);

	const run = useCallback(
		(command: string, value?: string) => {
			const surface = surfaceRef.current;
			if (!surface) return;
			surface.focus();
			try {
				document.execCommand(command, false, value);
			} catch {
				// A command the browser does not support is a no-op rather
				// than an error the author has to interpret.
			}
			refreshActiveState();
			emit();
		},
		[emit, refreshActiveState],
	);

	const restoreSelection = useCallback(() => {
		const surface = surfaceRef.current;
		const range = savedRangeRef.current;
		if (!surface) return null;
		surface.focus();
		if (!range) return null;
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		return selection;
	}, []);

	const openLink = useCallback(() => {
		const selection = window.getSelection();
		const range =
			selection && selection.rangeCount > 0
				? selection.getRangeAt(0).cloneRange()
				: null;
		savedRangeRef.current = range;

		// A selection already inside a link edits that link rather than making
		// a second one on top of it.
		const node = range?.commonAncestorContainer;
		const element =
			node?.nodeType === Node.ELEMENT_NODE
				? (node as Element)
				: (node?.parentElement ?? null);
		const anchor = element?.closest("a");
		setLinkUrl(anchor?.getAttribute("href") ?? "");
		setLinkOpen(true);
	}, []);

	const applyLink = useCallback(() => {
		const raw = linkUrl.trim();
		if (!raw) return;

		// A pasted address usually arrives without a scheme. Assuming https is
		// what the author meant; anything the sanitiser will not accept is
		// rejected here rather than silently dropped on save.
		const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
		if (!/^(https?:|mailto:)/i.test(url)) return;

		const selection = restoreSelection();
		if (selection && !selection.isCollapsed) {
			run("createLink", url);
		} else {
			// Nothing selected, so there is no text to turn into a link. The
			// address becomes the text, which is what a reader expects from
			// pasting a link into a note.
			const escaped = url
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/"/g, "&quot;");
			run("insertHTML", `<a href="${escaped}">${escaped}</a>`);
		}

		setLinkOpen(false);
		savedRangeRef.current = null;
	}, [linkUrl, restoreSelection, run]);

	const removeLink = useCallback(() => {
		restoreSelection();
		run("unlink");
		setLinkOpen(false);
		savedRangeRef.current = null;
	}, [restoreSelection, run]);

	useEffect(() => {
		if (!linkOpen) return;
		const onDown = (e: MouseEvent) => {
			if (linkRef.current && !linkRef.current.contains(e.target as Node)) {
				setLinkOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setLinkOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [linkOpen]);

	// Pasted content carries whatever markup its source produced, so it is
	// sanitised before insertion rather than after.
	const onPaste = useCallback(
		(event: React.ClipboardEvent<HTMLDivElement>) => {
			event.preventDefault();
			const pastedHtml = event.clipboardData.getData("text/html");
			const pastedText = event.clipboardData.getData("text/plain");

			if (pastedHtml) {
				document.execCommand(
					"insertHTML",
					false,
					sanitizeHtml(pastedHtml),
				);
			} else {
				document.execCommand("insertText", false, pastedText);
			}
			emit();
		},
		[emit],
	);

	const swatches = useMemo(() => {
		if (typeof window === "undefined") return [];
		const colors = readThemeColors();
		return [
			{ label: "Default", value: colors.text },
			...paletteTokens.slice(0, 8).map((token, i) => ({
				label: token,
				value: colors.series[i] ?? colors.text,
			})),
			{ label: "Positive", value: colors.positive },
			{ label: "Negative", value: colors.negative },
		];
	}, []);

	if (!editable) {
		if (!safe.trim()) {
			return (
				<div className={styles.panel}>
					<span className={styles.empty}>
						{placeholder ?? "Empty text panel"}
					</span>
				</div>
			);
		}
		// Sanitised immediately above, and again whenever the value changes.
		return (
			<div className={styles.panel}>
				<div
					className={styles.content}
					dangerouslySetInnerHTML={{ __html: safe }}
				/>
			</div>
		);
	}

	return (
		<div className={styles.editor}>
			<div className={styles.toolbar} role="toolbar" aria-label="Text formatting">
				<div className={styles.group}>
					<select
						className={styles.select}
						aria-label="Paragraph style"
						onChange={(e) => run("formatBlock", `<${e.target.value}>`)}
						defaultValue="p"
					>
						{blockFormats.map((f) => (
							<option key={f.value} value={f.value}>
								{f.label}
							</option>
						))}
					</select>
					<select
						className={styles.select}
						aria-label="Font size"
						onChange={(e) => run("fontSize", e.target.value)}
						defaultValue="3"
					>
						{fontSizes.map((f) => (
							<option key={f.value} value={f.value}>
								{f.label}
							</option>
						))}
					</select>
				</div>

				<div className={styles.group}>
					<button
						type="button"
						className={`${styles.tool} ${active.bold ? styles.toolActive : ""}`}
						onClick={() => run("bold")}
						aria-label="Bold"
						aria-pressed={active.bold ?? false}
					>
						<strong>B</strong>
					</button>
					<button
						type="button"
						className={`${styles.tool} ${active.italic ? styles.toolActive : ""}`}
						onClick={() => run("italic")}
						aria-label="Italic"
						aria-pressed={active.italic ?? false}
					>
						<em>I</em>
					</button>
					<button
						type="button"
						className={`${styles.tool} ${active.underline ? styles.toolActive : ""}`}
						onClick={() => run("underline")}
						aria-label="Underline"
						aria-pressed={active.underline ?? false}
					>
						<u>U</u>
					</button>
					<button
						type="button"
						className={`${styles.tool} ${active.strikeThrough ? styles.toolActive : ""}`}
						onClick={() => run("strikeThrough")}
						aria-label="Strikethrough"
						aria-pressed={active.strikeThrough ?? false}
					>
						<s>S</s>
					</button>
				</div>

				<div className={styles.group}>
					<div className={styles.swatches}>
						{swatches.map((swatch) => (
							<button
								key={swatch.label}
								type="button"
								className={styles.swatch}
								style={{ background: swatch.value }}
								title={`Text colour: ${swatch.label}`}
								aria-label={`Text colour ${swatch.label}`}
								onClick={() => run("foreColor", swatch.value)}
							/>
						))}
					</div>
				</div>

				<div className={styles.group}>
					<button
						type="button"
						className={`${styles.tool} ${active.insertUnorderedList ? styles.toolActive : ""}`}
						onClick={() => run("insertUnorderedList")}
						aria-label="Bulleted list"
					>
						•
					</button>
					<button
						type="button"
						className={`${styles.tool} ${active.insertOrderedList ? styles.toolActive : ""}`}
						onClick={() => run("insertOrderedList")}
						aria-label="Numbered list"
					>
						1.
					</button>
				</div>

				<div className={styles.group}>
					<button
						type="button"
						className={styles.tool}
						onClick={() => run("justifyLeft")}
						aria-label="Align left"
					>
						≡
					</button>
					<div className={styles.linkWrap} ref={linkRef}>
						<button
							type="button"
							className={`${styles.tool} ${linkOpen ? styles.toolActive : ""}`}
							onClick={() => (linkOpen ? setLinkOpen(false) : openLink())}
							aria-label="Insert link"
							aria-expanded={linkOpen}
							title="Link"
						>
							<svg
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								aria-hidden="true"
							>
								<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
								<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
							</svg>
						</button>

						{linkOpen && (
							<div className={styles.linkPopover}>
								<input
									type="url"
									className={styles.linkInput}
									placeholder="Paste a link"
									value={linkUrl}
									// eslint-disable-next-line jsx-a11y/no-autofocus
									autoFocus
									onChange={(e) => setLinkUrl(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											applyLink();
										}
									}}
								/>
								<div className={styles.linkActions}>
									<button
										type="button"
										className={styles.linkApply}
										onClick={applyLink}
										disabled={!linkUrl.trim()}
									>
										Apply
									</button>
									<button
										type="button"
										className={styles.linkRemove}
										onClick={removeLink}
									>
										Remove
									</button>
								</div>
							</div>
						)}
					</div>
					<button
						type="button"
						className={styles.tool}
						onClick={() => run("removeFormat")}
						aria-label="Clear formatting"
						title="Clear formatting"
					>
						✕
					</button>
				</div>
			</div>

			<div
				ref={surfaceRef}
				className={`${styles.surface} ${styles.content}`}
				contentEditable
				suppressContentEditableWarning
				role="textbox"
				aria-multiline="true"
				aria-label="Text panel content"
				data-placeholder={placeholder}
				onInput={emit}
				onBlur={emit}
				onPaste={onPaste}
				onKeyUp={refreshActiveState}
				onMouseUp={refreshActiveState}
			/>
		</div>
	);
}
