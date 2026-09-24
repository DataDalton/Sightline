"use client";

import { useState } from "react";
import styles from "./Admin.module.css";

// Events per day.
//
// The bars used to be an unlabelled row with the only explanation on a native
// tooltip over the container, so the height meant nothing, the period was not
// stated, and neither end was marked as the recent one.
//
// The window buttons beside the heading do not apply to this. The series is the
// last thirty days at minimum whatever the window says, because one day of bars
// is not a shape, so the range it actually covers is written on the chart
// rather than inferred from a control that does not drive it.
//
// Every day in the range arrives with a bar, quiet ones included, so the width
// of the plot is time and the gap between two tall bars is how long the lull
// lasted.

interface Day {
	day: string;
	events: number;
	users: number;
}

// Dates arrive as plain days with no zone. Parsed and read back in UTC, so a
// reader west of Greenwich is not shown each bar labelled as the day before.
//
// The leading day is taken rather than the whole value, because appending a
// time to something that already carries one produces a string no parser
// accepts, and the result of that is every label on the chart reading Invalid
// Date.
function label(day: string): string {
	const at = new Date(`${day.slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(at.getTime())) return day;
	return at.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	});
}

export function DailyActivity({ daily }: { daily: Day[] }) {
	// The day under the pointer, read out in the subheading. A readout in a
	// fixed place rather than a tooltip that follows the pointer: the bars are
	// a few pixels wide, and a panel opening over them covers the neighbours
	// being compared against.
	const [hover, setHover] = useState<Day | null>(null);

	if (daily.length === 0) return null;

	const peak = Math.max(1, ...daily.map((d) => d.events));
	const total = daily.reduce((sum, d) => sum + d.events, 0);
	const first = daily[0];
	const last = daily[daily.length - 1];

	const summary = `${daily.length} days to ${label(last.day)}, ${total.toLocaleString()} events, peaking at ${peak.toLocaleString()}`;

	return (
		<figure className={styles.chart}>
			<figcaption className={styles.chartHead}>
				<h3 className={styles.chartTitle}>Events per day</h3>
				<p className={styles.chartSub}>
					{hover
						? `${label(hover.day)}: ${hover.events.toLocaleString()} events, ${hover.users} ${
								hover.users === 1 ? "person" : "people"
							}`
						: summary}
				</p>
			</figcaption>

			<div
				className={styles.chartPlot}
				onMouseLeave={() => setHover(null)}
				// One label for the whole series. The bars are not reachable
				// one at a time on purpose: ninety tab stops to read a shape is
				// worse than the sentence that describes it.
				role="img"
				aria-label={`Events per day. ${summary}.`}
			>
				{/* Carries the peak value, so a bar's height reads as a number
				    rather than only as taller than its neighbour. */}
				<div className={styles.chartPeak} aria-hidden="true">
					<span>{peak.toLocaleString()}</span>
				</div>

				{daily.map((d) => (
					<div
						key={d.day}
						className={`${styles.chartBar} ${
							hover?.day === d.day ? styles.chartBarOn : ""
						}`}
						style={{
							height: `${Math.max(2, (d.events / peak) * 100)}%`,
						}}
						onMouseEnter={() => setHover(d)}
					/>
				))}
			</div>

			<div className={styles.chartAxis} aria-hidden="true">
				<span>{label(first.day)}</span>
				<span>{label(last.day)}</span>
			</div>
		</figure>
	);
}
