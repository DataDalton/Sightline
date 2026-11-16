import type { Choice, WorkConfig } from "../../lib/work/model";
import { displayNameFromEmail } from "../../lib/auth/names";

// Words for what the work queue stores as ids.

export function labelOf(list: Choice[], id: string | null | undefined): string {
	if (!id) return "";
	return list.find((choice) => choice.id === id)?.label ?? id;
}

export function columnLabel(config: WorkConfig, status: string): string {
	return (
		config.columns.find((column) => column.id === status)?.label ?? status
	);
}

export function effortLabel(config: WorkConfig, id: string | null): string {
	const effort = config.efforts.find((choice) => choice.id === id);
	if (!effort) return "";
	return effort.hint && /\d/.test(effort.hint)
		? `${effort.label} (${effort.hint})`
		: effort.label;
}

export function personName(email: string): string {
	if (email.toLowerCase() === "assistant") return "Assistant";
	return displayNameFromEmail(email);
}

export function initials(email: string): string {
	const name = personName(email);
	return name
		.split(" ")
		.map((word) => word[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

export function when(iso: string | null | undefined): string {
	if (!iso) return "";
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return "";
	const minutes = Math.floor((Date.now() - then) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
	return new Date(then).toLocaleDateString();
}

export function daysSince(iso: string): number {
	return Math.max(
		0,
		Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000),
	);
}

export async function postJson(
	url: string,
	body: unknown,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const answer = (await response.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	if (!response.ok) {
		throw new Error(
			typeof answer.error === "string"
				? answer.error
				: "That did not work.",
		);
	}
	return answer;
}
