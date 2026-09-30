// Muting a page alert, apart from the rest of lib/alerts/pageRules so the
// browser can read it without the hashing the scope keys need.

export type MuteChoice = "day" | "week" | "forever" | "off";

export const muteChoices: MuteChoice[] = ["off", "day", "week", "forever"];

export const muteLabel: Record<MuteChoice, string> = {
	off: "Not muted",
	day: "Mute for a day",
	week: "Mute for a week",
	forever: "Mute until turned back on",
};

// Stored for a mute that lasts until the subscriber lifts it. Postgres reads
// it as a timestamp later than every other.
export const mutedForever = "infinity";

const dayMs = 24 * 60 * 60 * 1000;

export function isMuteChoice(value: unknown): value is MuteChoice {
	return muteChoices.includes(value as MuteChoice);
}

// The muted_until value a choice stores, or null for not muted.
export function muteUntil(choice: MuteChoice, now = new Date()): string | null {
	switch (choice) {
		case "off":
			return null;
		case "day":
			return new Date(now.getTime() + dayMs).toISOString();
		case "week":
			return new Date(now.getTime() + 7 * dayMs).toISOString();
		case "forever":
			return mutedForever;
	}
}

// Whether a subscriber is muted at the given moment. Postgres writes an
// endless mute as "infinity" whichever way it was stored.
export function isMuted(
	mutedUntil: string | null | undefined,
	now = new Date(),
): boolean {
	if (!mutedUntil) return false;
	if (mutedUntil === mutedForever) return true;
	const until = Date.parse(mutedUntil);
	return Number.isFinite(until) && until > now.getTime();
}

// When a mute ends, in words, or null when it does not end on its own.
export function describeMute(
	mutedUntil: string | null,
	locale?: string,
): string | null {
	if (!mutedUntil || mutedUntil === mutedForever) return null;
	const until = new Date(mutedUntil);
	if (!Number.isFinite(until.getTime())) return null;
	return until.toLocaleString(locale, {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit",
	});
}
