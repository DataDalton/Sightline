import { describePeriod } from "../alerts/anomaly";
import { formatCompact, type FormatHint } from "../format";
import type { Card, Driver } from "./card";

// The briefing in words. Pure, so each sentence can be tested.

const months = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

// The period a card describes, as a reader would name it.
export function periodLabel(period: string, spacing: number): string {
	const at = new Date(`${period}T00:00:00Z`);
	if (Number.isNaN(at.getTime())) return period;
	if (spacing >= 28)
		return `${months[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
	if (spacing >= 7)
		return `Week of ${describePeriod(period).replace(/^\w+ /, "")}`;
	return describePeriod(period);
}

// What the movement is compared with, in words.
export function usualLabel(spacing: number): string {
	if (spacing <= 1) return "the same weekday in recent weeks";
	if (spacing >= 28) return "recent months";
	return "recent periods";
}

export type Tone = "good" | "bad" | "neutral";

// Whether a movement is good news. Only a report's own target says which way
// is better, so a figure without one is neither.
export function toneOf(
	card: Pick<Card, "againstUsual">,
	better: "higher" | "lower" | null,
): Tone {
	const move = card.againstUsual ?? 0;
	if (!better || Math.abs(move) < 0.02) return "neutral";
	const up = move > 0;
	return up === (better === "higher") ? "good" : "bad";
}

// "18% above usual", "in line with usual".
export function movementText(
	card: Pick<Card, "againstUsual" | "usual">,
): string {
	const move = card.againstUsual;
	if (move === null || card.usual === null) return "No usual range yet";
	const pct = Math.round(Math.abs(move) * 100);
	if (pct < 2) return "In line with usual";
	// Past a few times usual a percentage stops reading as a size.
	if (move >= 2) return `${(1 + move).toFixed(1).replace(/\.0$/, "")}× usual`;
	return `${pct}% ${move > 0 ? "above" : "below"} usual`;
}

// "Mostly Joint Replacement (Division), +1.2M, 70% of the change". A member
// carrying under half the change led it rather than made it.
export function driverText(driver: Driver, hint: FormatHint): string {
	const sign = driver.change > 0 ? "+" : "-";
	const amount = `${sign}${formatCompact(Math.abs(driver.change), hint)}`;
	const share =
		driver.share !== null && driver.share > 0 && driver.share <= 1.5
			? `, ${Math.round(Math.min(driver.share, 1) * 100)}% of the change`
			: "";
	const lead =
		driver.share !== null && driver.share < 0.5 ? "Led by" : "Mostly";
	return `${lead} ${driver.member} (${driver.dimension}), ${amount}${share}`;
}

function count(n: number, one: string, many: string): string {
	return `${n === 1 ? "One" : n} ${n === 1 ? one : many}`;
}

// The sentence at the top of the page.
export function headline(options: {
	unusual: number;
	moving: number;
	late: number;
	fired: number;
	reading: boolean;
}): string {
	const { unusual, moving, late, fired, reading } = options;
	const parts: string[] = [];
	if (unusual > 0)
		parts.push(
			`${count(unusual, "figure", "figures")} ${unusual === 1 ? "is" : "are"} outside ${unusual === 1 ? "its" : "their"} usual range`,
		);
	if (fired > 0)
		parts.push(`${count(fired, "alert", "alerts").toLowerCase()} fired`);
	if (late > 0)
		parts.push(
			`${count(late, "source is", "sources are").toLowerCase()} running late`,
		);
	if (parts.length === 0) {
		if (reading) return "Reading your figures";
		return moving > 0
			? `Nothing unusual. ${count(moving, "figure is", "figures are")} on the move`
			: "Everything is within its usual range";
	}
	const sentence =
		parts.length === 1
			? parts[0]
			: `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
	return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
