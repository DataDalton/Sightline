// How administration says when something happened.
//
// Two formatters used to live here, one on the sync note and one on every
// table cell, and they disagreed about both wording and resolution. The same
// moment read as "3h ago" in a row and "less than an hour ago" in a note, and
// neither said what the clock had read.

const minute = 60000;
const hour = 60 * minute;
const day = 24 * hour;

export function daysSince(iso: string): number {
	return (Date.now() - new Date(iso).getTime()) / day;
}

// How long ago, at the resolution somebody can act on. Reported only to the
// hour, a run read the same the moment it finished as it did fifty minutes
// later, which is the one distinction the person who just pressed the button
// needs.
export function ago(iso: string): string {
	const elapsed = Date.now() - new Date(iso).getTime();
	if (elapsed < minute) return "just now";
	if (elapsed < hour) {
		const minutes = Math.floor(elapsed / minute);
		return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
	}
	if (elapsed < day) {
		const hours = Math.floor(elapsed / hour);
		return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
	}
	const days = Math.floor(elapsed / day);
	return days === 1 ? "yesterday" : `${days} days ago`;
}

// The wall clock reading, dated once it is from a different day. This is what
// an action gets matched against: somebody who pressed a button knows when they
// pressed it, and an elapsed time alone leaves them working it out.
export function clock(iso: string): string {
	const at = new Date(iso);
	const time = at.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
	const now = new Date();
	const sameDay =
		at.getFullYear() === now.getFullYear() &&
		at.getMonth() === now.getMonth() &&
		at.getDate() === now.getDate();
	if (sameDay) return time;
	const date = at.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	});
	return `${time} on ${date}`;
}

// Both halves, because either one alone leaves a question open.
export function describe(iso: string): string {
	return `at ${clock(iso)}, ${ago(iso)}`;
}
