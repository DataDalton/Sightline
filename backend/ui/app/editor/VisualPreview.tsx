"use client";

import { VisualRender } from "./VisualRender";
import {
	behaviourCaptions,
	behaviourFor,
} from "../../lib/visuals/previewBehaviour";
import type { VisualTypeDefinition } from "../../lib/visuals/catalog";
import styles from "./VisualPreview.module.css";

// A closer look at a visual, beside the card being pointed at.
//
// The card's own drawing is 64 by 40 and has to read at a glance in a grid of
// thirty-five of them, so it can only say what shape a thing is. That is the
// wrong thing to decide from: at that size a chart is four bars and no axis,
// and every table is three grey lines.
//
// This is the same visual drawn at reading size, in a card, the way it will
// appear on a page. The visual and nothing else: the point is what an author is
// about to add, and anything drawn beside it is something they did not ask for
// and have to look past.

export function VisualPreview({
	definition,
	box,
}: {
	definition: VisualTypeDefinition;
	// Viewport coordinates, so nothing above it can clip it and it stays put
	// against the card it belongs to.
	box: { left: number; top: number };
}) {
	const { dimensions: d, measures: m } = definition.encoding;

	return (
		<div
			className={styles.panel}
			style={{ left: box.left, top: box.top }}
			role="presentation"
		>
			{/* A card on a page, because that is what it will be. The title bar
			    is the frame every visual gets, so a preview without one is a
			    preview of something narrower than what gets added. */}
			<div className={styles.card}>
				<span className={styles.cardTitle}>{definition.label}</span>
				<VisualRender type={definition.type} />
			</div>

			<p className={styles.guidance}>{definition.guidance}</p>
			{/* What a reader can do with it, which is not visible in a picture
			    of it: a bar chart and a pie chart both narrow the page when a
			    mark is clicked, a line chart is brushed instead, and a KPI row
			    does nothing because it is the thing that reacts. */}
			<p className={styles.behaviour}>
				{behaviourCaptions[behaviourFor(definition.type)]}
			</p>

			<div className={styles.needs}>
				{d.min > 0 && (
					<span className={styles.need}>
						{d.min === 1 ? "1 dimension" : `${d.min} dimensions`}
						{d.max > d.min && ` up to ${d.max}`}
					</span>
				)}
				{m.min > 0 && (
					<span className={styles.need}>
						{m.min === 1 ? "1 measure" : `${m.min} measures`}
						{m.max > m.min && ` up to ${m.max}`}
					</span>
				)}
				{d.min === 0 && m.min === 0 && (
					<span className={styles.need}>No fields required</span>
				)}
			</div>
		</div>
	);
}
