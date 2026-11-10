// A readable name from an address, for places that know someone only by their
// email. Takes the part before the @, splits it on dots, underscores and
// hyphens, drops the digits a directory adds to tell two people apart, and
// capitalises each word. Two such people then read the same, while their
// addresses, which are what everything matches on, stay different.
export function displayNameFromEmail(email: string): string {
	const localPart = email.split("@")[0] ?? email;
	const words = localPart
		.split(/[._-]+/)
		.map((word) => word.replace(/\d+$/, ""))
		.filter((word) => word.length > 0);
	// An address made only of digits keeps them, since there is no name to show instead.
	const shown = words.length > 0 ? words.join(" ") : localPart;
	return shown
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
