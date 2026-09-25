"use client";

import { useEffect, useState } from "react";
import { useAssistant } from "./AssistantContext";
import styles from "./Assist.module.css";

// Pointing at part of the page to ask about it, like a browser's element
// inspector.
//
// While it is on, whatever is under the pointer is outlined and named, and a
// click adds it to the next question instead of doing what a click there
// normally does. A visual snaps to its whole frame, since the chart is what
// somebody means rather than one bar of it. The text taken includes what a
// screen reader gets, which for a chart is a table of the numbers it draws, so
// pointing at a chart hands over its figures and not only its title.
//
// The assistant's own panel is never picked, and clicks inside it work as
// normal, so the question can be typed while picking.

const maxText = 6000;

function isAssistant(el: Element): boolean {
	return Boolean(el.closest("[data-assistant-ui]"));
}

function targetOf(el: Element | null): HTMLElement | null {
	if (!el || isAssistant(el)) return null;

	const visual = el.closest<HTMLElement>("[data-visual-id]");
	if (visual) return visual;

	// Outside a visual, the nearest block that holds some text and is big
	// enough to mean something: a heading, a filter, a panel. Never the whole
	// page, which would be pointing at everything.
	let node: HTMLElement | null = el as HTMLElement;
	while (node && node !== document.body && node.tagName !== "MAIN") {
		const rect = node.getBoundingClientRect();
		const text = node.innerText?.trim() ?? "";
		if (text.length > 0 && rect.width >= 40 && rect.height >= 16) {
			return node;
		}
		node = node.parentElement;
	}
	return null;
}

function labelOf(el: HTMLElement): string {
	if (el.dataset.visualTitle) return el.dataset.visualTitle;
	const heading = el.querySelector("h1, h2, h3, h4");
	const text = (heading?.textContent ?? el.innerText ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.slice(0, 60) || el.tagName.toLowerCase();
}

export function PagePicker() {
	const { picking, setPicking, attach, setPanelOpen } = useAssistant();
	const [hover, setHover] = useState<{ rect: DOMRect; label: string } | null>(
		null,
	);

	useEffect(() => {
		if (!picking) {
			setHover(null);
			return;
		}

		let current: HTMLElement | null = null;

		const move = (e: PointerEvent) => {
			const target = targetOf(
				document.elementFromPoint(e.clientX, e.clientY),
			);
			current = target;
			setHover(
				target
					? {
							rect: target.getBoundingClientRect(),
							label: labelOf(target),
						}
					: null,
			);
		};

		// Swallowed on the way down, so a click on a bar or a filter chip
		// picks it rather than also drilling or opening a menu.
		const block = (e: Event) => {
			const el = e.target instanceof Element ? e.target : null;
			if (!el || isAssistant(el)) return;
			e.preventDefault();
			e.stopPropagation();
		};

		const pick = (e: MouseEvent) => {
			const el = e.target instanceof Element ? e.target : null;
			if (!el || isAssistant(el)) return;
			e.preventDefault();
			e.stopPropagation();
			const target = current ?? targetOf(el);
			if (!target) return;
			attach({
				label: labelOf(target),
				visualId: target.dataset.visualId ?? null,
				text: (target.innerText ?? "").trim().slice(0, maxText),
			});
			setPicking(false);
			setPanelOpen(true);
		};

		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setPicking(false);
			}
		};

		const refresh = () => {
			if (current) {
				setHover({
					rect: current.getBoundingClientRect(),
					label: labelOf(current),
				});
			}
		};

		document.documentElement.classList.add(styles.pickingPage);
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerdown", block, true);
		window.addEventListener("mousedown", block, true);
		window.addEventListener("mouseup", block, true);
		window.addEventListener("click", pick, true);
		window.addEventListener("keydown", key, true);
		window.addEventListener("scroll", refresh, true);

		return () => {
			document.documentElement.classList.remove(styles.pickingPage);
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerdown", block, true);
			window.removeEventListener("mousedown", block, true);
			window.removeEventListener("mouseup", block, true);
			window.removeEventListener("click", pick, true);
			window.removeEventListener("keydown", key, true);
			window.removeEventListener("scroll", refresh, true);
		};
	}, [picking, attach, setPicking, setPanelOpen]);

	if (!picking) return null;

	return (
		<>
			<div className={styles.pickBanner} data-assistant-ui role="status">
				Click any part of the page to add it to your question
				<button
					type="button"
					className={styles.pickCancel}
					onClick={() => setPicking(false)}
				>
					Cancel (Esc)
				</button>
			</div>
			{hover && (
				<div
					className={styles.pickOutline}
					style={{
						top: hover.rect.top,
						left: hover.rect.left,
						width: hover.rect.width,
						height: hover.rect.height,
					}}
					aria-hidden="true"
				>
					<span className={styles.pickLabel}>{hover.label}</span>
				</div>
			)}
		</>
	);
}
