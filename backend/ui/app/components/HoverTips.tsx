"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./HoverTips.module.css";

// Every title in the app, drawn as a proper tooltip.
//
// The browser's own one waits about a second, cannot be styled and does not appear
// for a keyboard user. The app already says what each control does in its title, so
// this reads those rather than asking every control to adopt a component. Anything
// given a title from now on is covered without further work.
//
// The attribute is lifted off the element while the tip shows, so the browser does
// not draw its own on top, and put back afterwards.

const openDelayMs = 300;
const gap = 8;
const maxTipWidth = 300;

interface Shown {
	text: string;
	// The middle of the element the tip belongs to, in screen coordinates.
	centre: number;
	top?: number;
	bottom?: number;
}

export function HoverTips() {
	const [shown, setShown] = useState<Shown | null>(null);
	const held = useRef<{ element: Element; title: string } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tip = useRef<HTMLDivElement | null>(null);

	// A tip is only as wide as its words, so it is measured once drawn and centred
	// under its element from that width, kept inside the window.
	useLayoutEffect(() => {
		const drawn = tip.current;
		if (!shown || !drawn) return;
		const width = drawn.offsetWidth;
		const left = Math.max(
			gap,
			Math.min(shown.centre - width / 2, window.innerWidth - width - gap),
		);
		drawn.style.left = `${left}px`;
	}, [shown]);

	useEffect(() => {
		const release = () => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
			const current = held.current;
			if (current?.element.isConnected) {
				current.element.setAttribute("title", current.title);
			}
			held.current = null;
			setShown(null);
		};

		const open = (element: Element) => {
			const title = element.getAttribute("title")?.trim();
			if (!title) return;
			element.removeAttribute("title");
			held.current = { element, title };
			timer.current = setTimeout(() => {
				const box = element.getBoundingClientRect();
				const centre = box.left + box.width / 2;
				setShown(
					box.bottom > window.innerHeight * 0.75
						? {
								text: title,
								centre,
								bottom: window.innerHeight - box.top + gap,
							}
						: { text: title, centre, top: box.bottom + gap },
				);
			}, openDelayMs);
		};

		// An svg title is a label for assistive tools rather than a tooltip, and
		// has no attribute to read.
		const owner = (target: EventTarget | null): Element | null =>
			target instanceof Element ? target.closest("[title]") : null;

		const onOver = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			const element = owner(event.target);
			if (!element || held.current?.element === element) return;
			release();
			open(element);
		};
		const onOut = (event: PointerEvent) => {
			const current = held.current?.element;
			if (!current) return;
			const into = event.relatedTarget;
			if (into instanceof Node && current.contains(into)) return;
			release();
		};
		const onFocus = (event: FocusEvent) => {
			const element = owner(event.target);
			if (!element || held.current?.element === element) return;
			release();
			open(element);
		};

		document.addEventListener("pointerover", onOver);
		document.addEventListener("pointerout", onOut);
		document.addEventListener("focusin", onFocus);
		document.addEventListener("focusout", release);
		// A click usually changes what the control means, and a scroll moves it
		// out from under a tip fixed to the screen.
		document.addEventListener("pointerdown", release);
		window.addEventListener("scroll", release, true);
		return () => {
			release();
			document.removeEventListener("pointerover", onOver);
			document.removeEventListener("pointerout", onOut);
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("focusout", release);
			document.removeEventListener("pointerdown", release);
			window.removeEventListener("scroll", release, true);
		};
	}, []);

	if (!shown) return null;
	return createPortal(
		<div
			ref={tip}
			className={styles.tip}
			role="tooltip"
			style={{
				left: 0,
				top: shown.top,
				bottom: shown.bottom,
				maxWidth: maxTipWidth,
			}}
		>
			{shown.text}
		</div>,
		document.body,
	);
}
